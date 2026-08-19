/**
 * Specialist Orchestrator — supervised multi-specialist lifecycle management,
 * routing state machine, retry limits, aggregate budget broker, and terminal state resolution (epic #47, issue #56, ADR 0028).
 *
 * The orchestrator owns ALL sequencing, routing, retries, backtracking, budgets,
 * cancellation propagation, and terminal state transitions across specialists:
 *
 *   ProductSeed (+ optional discoveredGtin & gtinScope)
 *       │
 *       ▼
 *   [Discovery Specialist #49]
 *       │
 *       ├─► (needs_profile / profile_failed?) ──► [Profile Engineer Specialist #51]
 *       │                                                    │
 *       │                                                    ▼ (proposal_only: manual review required)
 *       │                                             Hold: NEEDS_REVIEW
 *       ▼
 *   [Deterministic Extraction Evidence Runner #52]
 *       │
 *       ▼
 *   [Resolver Specialist #53]
 *       │
 *       ▼
 *   [Curator Specialist #54]
 *       │
 *       ▼
 *   [Verifier Specialist #55]
 *       │
 *       ├── 'pass' (under budget) ────────► Terminal: COMPLETED
 *       ├── 'pass' (over budget) ─────────► Terminal: BUDGET_EXCEEDED
 *       ├── 'retry_curator' (retries < max) ──► Re-run Curator → Verifier
 *       ├── 'retry_resolver' (retries < max) ─► Re-run Resolver → Curator → Verifier
 *       ├── 'retry_discovery' (retries < max) ► Re-run Discovery → Pipeline
 *       └── 'human_review' / retries exhausted ► Terminal: NEEDS_REVIEW
 *
 * INVARIANTS:
 *   - Specialists NEVER invoke each other; ONLY the orchestrator dispatches work.
 *   - All inter-specialist data flows are schema-validated typed artifacts.
 *   - Loops stop deterministically at configured retry/dispatch/budget/step limits.
 *   - Whole-workflow absolute deadline derived at start (startedAt + deadlineMs) and propagated.
 *   - Concurrency-safe handle-based pre-spend reservations for tools, models, tokens, and cost.
 *   - Cancellation via AbortSignal immediately aborts execution and sets CANCELLED.
 *   - Policy snapshot is strictly immutable; runtime allowances are passed separately.
 *   - 14-digit GTINs are strictly case-scoped and never promoted as consumer GTINs.
 *   - Caller identifiers are normalized once and passed canonically across all phases.
 *   - Profile Engineer proposals require governance/manual review before activation.
 *   - Profile synthesis uses concurrency-safe workflow locks with real per-page selector evidence.
 *   - Missing and incompatible/stale profiles are reliably differentiated (v1 vs vN+1 repair).
 *   - Every phase transition and route is durably persisted with full invocation and artifact provenance.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import type { ProductSeed } from '../product-seed';
import {
  DiscoverySpecialist,
  type DiscoverySpecialistOutput,
} from '../specialists/discovery';
import {
  ProfileEngineerSpecialist,
  type ProfileEngineerProposal,
  type ProfileEngineerWorkflowLock,
  type ClaimProfileLockOptions,
} from '../specialists/profile-engineer';
import {
  ResolverSpecialist,
  type ResolvedFactSet,
  type IdentifierScope,
} from '../specialists/resolver';
import {
  CuratorSpecialist,
  type CuratedProductDraft,
  type ClassificationContext,
} from '../specialists/curator';
import {
  VerifierSpecialist,
  type VerificationReport,
} from '../specialists/verifier';
import {
  runDeterministicExtraction,
  type DeterministicExtractionRunnerOptions,
} from '../extraction/evidence-runner';
import type {
  ExtractionEvidenceBundle,
  ExtractionProfileBinding,
  ExtractionObservation,
} from '../extraction/evidence';
import type { SpecialistContext, SpecialistResult, SpecialistUsage, SpecialistRuntimeAllowance } from '../specialists/contracts';
import {
  captureSpecialistCodeCommit,
  type SpecialistArtifactEnvelope,
} from '../specialists/artifacts';

// ── Orchestrator Types & Schemas ─────────────────────────────────────────────

export const OrchestratorTerminalStatusSchema = z.enum([
  'completed',
  'in_progress',
  'needs_review',
  'abstained',
  'budget_exceeded',
  'cancelled',
  'failed',
]);
export type OrchestratorTerminalStatus = z.infer<typeof OrchestratorTerminalStatusSchema>;

export interface OrchestratorStepEvent {
  step: number;
  specialist: string;
  action: string;
  status: 'started' | 'succeeded' | 'failed' | 'retrying' | 'skipped';
  durationMs: number;
  timestamp: string;
  details?: string;
}

export interface CapabilityLimits {
  maxDiscoveryInvocations: number;
  maxExtractionInvocations: number;
  maxProfileInvocations: number;
  maxResolverInvocations: number;
  maxCuratorInvocations: number;
  maxVerifierInvocations: number;
  maxTotalDispatches: number;
  maxTotalSteps: number;
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
  maxDiscoveryInvocations: 2,
  maxExtractionInvocations: 12,
  maxProfileInvocations: 4,
  maxResolverInvocations: 4,
  maxCuratorInvocations: 4,
  maxVerifierInvocations: 4,
  maxTotalDispatches: 20,
  maxTotalSteps: 20,
};

export interface WorkflowUsageLedger {
  totalDispatches: number;
  totalToolCalls: number;
  totalModelCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  bySpecialist: Record<string, {
    dispatches: number;
    toolCalls: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  }>;
}

export interface RouteRecord {
  fromPhase: string;
  toPhase: string;
  reason?: string;
  timestamp: string;
}

export interface WorkflowStateSnapshot {
  runId: string;
  version: string;
  status: OrchestratorTerminalStatus;
  currentPhase: string;
  retriesCount: number;
  totalDispatches: number;
  invocations: Record<string, number>;
  capabilityInvocationIds: Record<string, string[]>;
  extractionArtifactRefs: string[];
  routeRecords: RouteRecord[];
  usage: WorkflowUsageLedger;
  artifactIds: string[];
  totalDurationMs: number;
  persistenceWarnings?: string[];
  error?: string;
}

export interface SpecialistWorkflowRecord {
  workflowId: string;
  runId: string;
  workspaceId: string;
  workflowVersion: string;
  productSeed: ProductSeed;
  status: OrchestratorTerminalStatus;
  currentPhase: string;
  retriesCount: number;
  totalDispatches: number;
  invocations: Record<string, number>;
  capabilityInvocationIds: Record<string, string[]>;
  extractionArtifactRefs: string[];
  routeRecords: RouteRecord[];
  usage: WorkflowUsageLedger;
  stepEvents: OrchestratorStepEvent[];
  artifactIds: string[];
  persistenceWarnings?: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SpecialistWorkflowPersistenceRepository {
  save(record: SpecialistWorkflowRecord): Promise<void> | void;
  get(runId: string): Promise<SpecialistWorkflowRecord | null> | SpecialistWorkflowRecord | null;
}

export interface SpecialistWorkflowResult {
  runId: string;
  status: OrchestratorTerminalStatus;
  productSeed: ProductSeed;
  discoveryOutput?: DiscoverySpecialistOutput;
  discoveryArtifact?: SpecialistArtifactEnvelope;
  profileOutput?: ProfileEngineerProposal;
  profileArtifact?: SpecialistArtifactEnvelope;
  extractionBundles: ExtractionEvidenceBundle[];
  resolverOutput?: ResolvedFactSet;
  resolverArtifact?: SpecialistArtifactEnvelope;
  curatorOutput?: CuratedProductDraft;
  curatorArtifact?: SpecialistArtifactEnvelope;
  verifierOutput?: VerificationReport;
  verifierArtifact?: SpecialistArtifactEnvelope;
  events: OrchestratorStepEvent[];
  retriesCount: number;
  totalDispatches: number;
  totalDurationMs: number;
  workflowState: WorkflowStateSnapshot;
  error?: string;
}

export interface SpecialistOrchestratorDependencies {
  discovery?: DiscoverySpecialist;
  profileEngineer?: ProfileEngineerSpecialist;
  profileEngineerWorkflowLock?: ProfileEngineerWorkflowLock;
  resolver?: ResolverSpecialist;
  curator?: CuratorSpecialist;
  verifier?: VerifierSpecialist;
  workflowPersistence?: SpecialistWorkflowPersistenceRepository;
  extractionRunnerOptions?: DeterministicExtractionRunnerOptions;
  extractionRunner?: (
    url: string,
    context: SpecialistContext,
    profile?: ExtractionProfileBinding | null,
  ) => Promise<ExtractionEvidenceBundle>;
}

export interface RunWorkflowOptions {
  discoveredGtin?: string | null;
  gtinScope?: IdentifierScope;
}

export interface SpecialistOrchestratorOptions {
  maxRetries?: number;
  limits?: Partial<CapabilityLimits>;
  extractionConcurrency?: number;
  dependencies?: SpecialistOrchestratorDependencies;
  now?: () => string;
}

// ── In-Memory Persistence & Concurrency Locks (Test Fallbacks) ────────────────

export class InMemoryWorkflowPersistenceRepository implements SpecialistWorkflowPersistenceRepository {
  private readonly records = new Map<string, SpecialistWorkflowRecord>();

  public save(record: SpecialistWorkflowRecord): void {
    this.records.set(record.runId, { ...record });
  }

  public get(runId: string): SpecialistWorkflowRecord | null {
    return this.records.get(runId) ?? null;
  }
}

export class InMemoryProfileWorkflowLock implements ProfileEngineerWorkflowLock {
  private readonly activeLocks = new Set<string>();
  private readonly completedRecords = new Map<string, { targetVersion: number; sourceProfileVersion: string | null }>();

  public claim(
    domain: string,
    runId: string,
    _workspaceId: string,
    options?: ClaimProfileLockOptions,
  ): { acquired: boolean; workflowId: string; targetVersion?: number; workflow?: { targetVersion: number; sourceProfileVersion?: string | null }; reason?: string } {
    if (this.activeLocks.has(domain)) {
      return { acquired: false, workflowId: `wf:${domain}:${runId}`, reason: `Domain ${domain} profile is actively being synthesized` };
    }

    const existing = this.completedRecords.get(domain);
    const targetVersion = options?.targetVersion ?? 1;
    const sourceProfileVersion = options?.sourceProfileVersion ?? null;

    if (existing) {
      const isHigher = targetVersion > existing.targetVersion;
      const isDifferentSource = Boolean(sourceProfileVersion && existing.sourceProfileVersion && sourceProfileVersion !== existing.sourceProfileVersion);
      const isForced = Boolean(options?.forceNew);
      if (!isHigher && !isDifferentSource && !isForced) {
        return {
          acquired: false,
          workflowId: `wf:${domain}:${runId}`,
          targetVersion: existing.targetVersion,
          workflow: { targetVersion: existing.targetVersion, sourceProfileVersion: existing.sourceProfileVersion },
          reason: 'domain_workflow_already_completed',
        };
      }
      const newTargetVersion = isDifferentSource ? Math.max(targetVersion, existing.targetVersion + 1) : targetVersion;
      this.activeLocks.add(domain);
      return {
        acquired: true,
        workflowId: `wf:${domain}:${runId}`,
        targetVersion: newTargetVersion,
        workflow: { targetVersion: newTargetVersion, sourceProfileVersion },
      };
    }

    this.activeLocks.add(domain);
    return {
      acquired: true,
      workflowId: `wf:${domain}:${runId}`,
      targetVersion,
      workflow: { targetVersion, sourceProfileVersion },
    };
  }

  public complete(workflowId: string, _runId: string): { applied: boolean } {
    const domain = workflowId.split(':')[1];
    if (domain) {
      this.activeLocks.delete(domain);
      const prev = this.completedRecords.get(domain)?.targetVersion ?? 1;
      this.completedRecords.set(domain, { targetVersion: prev, sourceProfileVersion: null });
    }
    return { applied: true };
  }

  public fail(workflowId: string, _runId: string, _reason: string): { applied: boolean } {
    const domain = workflowId.split(':')[1];
    if (domain) this.activeLocks.delete(domain);
    return { applied: true };
  }
}

export function resolveDefaultProfileLock(options?: { allowInMemoryFallback?: boolean }): ProfileEngineerWorkflowLock {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repo = require('../../db/repositories/profile-engineer-workflow-repo');
    if (typeof repo.profileEngineerWorkflowLock === 'function') {
      return repo.profileEngineerWorkflowLock();
    }
  } catch (err) {
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST) || options?.allowInMemoryFallback;
    if (isTest) {
      return new InMemoryProfileWorkflowLock();
    }
    throw new Error(`Failed to initialize production profile workflow lock repository: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return new InMemoryProfileWorkflowLock();
}

export function resolveDefaultWorkflowPersistence(options?: { allowInMemoryFallback?: boolean }): SpecialistWorkflowPersistenceRepository {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repo = require('../../db/repositories/specialist-workflow-repo');
    if (typeof repo.specialistWorkflowPersistence === 'function') {
      return repo.specialistWorkflowPersistence();
    }
  } catch (err) {
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST) || options?.allowInMemoryFallback;
    if (isTest) {
      return new InMemoryWorkflowPersistenceRepository();
    }
    throw new Error(`Failed to initialize production workflow persistence repository: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return new InMemoryWorkflowPersistenceRepository();
}

// ── Concurrency-Safe Aggregate Budget Broker ─────────────────────────────────

export interface BudgetReservationHandle {
  id: string;
  specialist: string;
  dispatches: number;
  toolCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class WorkflowBudgetBroker {
  public readonly maxToolCalls: number;
  public readonly maxModelCalls: number;
  public readonly maxInputTokens: number;
  public readonly maxOutputTokens: number;
  public readonly maxCostUsd: number;
  public readonly maxDispatches: number;
  public readonly maxSteps: number;
  public readonly deadlineAt: number | null;
  public readonly usage: WorkflowUsageLedger;

  public totalSteps = 0;
  private activeReservations = new Map<string, BudgetReservationHandle>();
  private nextReservationSeq = 0;

  public constructor(context: SpecialistContext, maxDispatches: number, maxSteps: number, startedAt: number) {
    this.maxToolCalls = typeof context.policy.maxToolCalls === 'number' && context.policy.maxToolCalls > 0
      ? context.policy.maxToolCalls
      : Number.POSITIVE_INFINITY;
    this.maxModelCalls = typeof (context.policy as any).maxModelCalls === 'number' && (context.policy as any).maxModelCalls > 0
      ? (context.policy as any).maxModelCalls
      : Number.POSITIVE_INFINITY;
    this.maxInputTokens = typeof (context.policy as any).maxInputTokens === 'number' && (context.policy as any).maxInputTokens > 0
      ? (context.policy as any).maxInputTokens
      : Number.POSITIVE_INFINITY;
    this.maxOutputTokens = typeof (context.policy as any).maxOutputTokens === 'number' && (context.policy as any).maxOutputTokens > 0
      ? (context.policy as any).maxOutputTokens
      : Number.POSITIVE_INFINITY;
    this.maxCostUsd = typeof context.policy.maxCostUsd === 'number' && context.policy.maxCostUsd > 0
      ? context.policy.maxCostUsd
      : Number.POSITIVE_INFINITY;
    this.maxDispatches = maxDispatches;
    this.maxSteps = maxSteps;
    this.deadlineAt = context.deadlineAt ?? (context.policy.deadlineMs ? startedAt + context.policy.deadlineMs : null);

    this.usage = {
      totalDispatches: 0,
      totalToolCalls: 0,
      totalModelCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      bySpecialist: {},
    };
  }

  private getReservedTotals() {
    let toolCalls = 0;
    let modelCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let dispatches = 0;

    for (const h of this.activeReservations.values()) {
      toolCalls += h.toolCalls;
      modelCalls += h.modelCalls;
      inputTokens += h.inputTokens;
      outputTokens += h.outputTokens;
      costUsd += h.costUsd;
      dispatches += h.dispatches;
    }

    return { toolCalls, modelCalls, inputTokens, outputTokens, costUsd, dispatches };
  }

  public getRemainingToolCalls(): number {
    const reserved = this.getReservedTotals().toolCalls;
    return Math.max(0, this.maxToolCalls - (this.usage.totalToolCalls + reserved));
  }

  public getRemainingModelCalls(): number {
    const reserved = this.getReservedTotals().modelCalls;
    return Math.max(0, this.maxModelCalls - (this.usage.totalModelCalls + reserved));
  }

  public getRemainingInputTokens(): number {
    const reserved = this.getReservedTotals().inputTokens;
    return Math.max(0, this.maxInputTokens - (this.usage.totalInputTokens + reserved));
  }

  public getRemainingOutputTokens(): number {
    const reserved = this.getReservedTotals().outputTokens;
    return Math.max(0, this.maxOutputTokens - (this.usage.totalOutputTokens + reserved));
  }

  public getRemainingCostUsd(): number {
    if (!Number.isFinite(this.maxCostUsd)) return Number.POSITIVE_INFINITY;
    const reserved = this.getReservedTotals().costUsd;
    const committedAndReserved = this.usage.estimatedCostUsd + reserved;
    return Math.max(0, Number((this.maxCostUsd - committedAndReserved).toFixed(4)));
  }

  public getRuntimeAllowance(): SpecialistRuntimeAllowance {
    return {
      remainingToolCalls: this.getRemainingToolCalls(),
      remainingModelCalls: this.getRemainingModelCalls(),
      remainingInputTokens: this.getRemainingInputTokens(),
      remainingOutputTokens: this.getRemainingOutputTokens(),
      remainingCostUsd: Number.isFinite(this.maxCostUsd) ? this.getRemainingCostUsd() : undefined,
      deadlineAt: this.deadlineAt,
    };
  }

  public isOverBudget(): { exceeded: boolean; reason?: string } {
    if (this.deadlineAt && Date.now() > this.deadlineAt) {
      return { exceeded: true, reason: 'Execution deadline exceeded' };
    }
    if (this.usage.totalDispatches > this.maxDispatches) {
      return { exceeded: true, reason: `Total dispatch ceiling (${this.maxDispatches}) exceeded` };
    }
    if (this.totalSteps > this.maxSteps) {
      return { exceeded: true, reason: `Total step ceiling (${this.maxSteps}) exceeded` };
    }
    if (this.usage.totalToolCalls > this.maxToolCalls) {
      return { exceeded: true, reason: `Tool call budget ceiling (${this.maxToolCalls}) exceeded` };
    }
    if (this.usage.totalModelCalls > this.maxModelCalls) {
      return { exceeded: true, reason: `Model call budget ceiling (${this.maxModelCalls}) exceeded` };
    }
    if (this.usage.totalInputTokens > this.maxInputTokens) {
      return { exceeded: true, reason: `Input token budget ceiling (${this.maxInputTokens}) exceeded` };
    }
    if (this.usage.totalOutputTokens > this.maxOutputTokens) {
      return { exceeded: true, reason: `Output token budget ceiling (${this.maxOutputTokens}) exceeded` };
    }
    if (this.usage.estimatedCostUsd > this.maxCostUsd) {
      return { exceeded: true, reason: `Cost budget ceiling ($${this.maxCostUsd}) exceeded` };
    }
    return { exceeded: false };
  }

  public reserve(
    specialist: string,
    requested: Partial<Omit<BudgetReservationHandle, 'id' | 'specialist'>> = {},
  ): { allowed: boolean; handle?: BudgetReservationHandle; reason?: string } {
    if (this.deadlineAt && Date.now() > this.deadlineAt) {
      return { allowed: false, reason: 'Execution deadline exceeded' };
    }

    const dispatches = requested.dispatches ?? 1;
    const toolCalls = requested.toolCalls ?? 0;
    const modelCalls = requested.modelCalls ?? 0;
    const inputTokens = requested.inputTokens ?? 0;
    const outputTokens = requested.outputTokens ?? 0;
    const costUsd = requested.costUsd ?? 0;

    const reserved = this.getReservedTotals();

    if (this.totalSteps + 1 > this.maxSteps) {
      return { allowed: false, reason: `Total step ceiling (${this.maxSteps}) reached` };
    }
    if (this.usage.totalDispatches + reserved.dispatches + dispatches > this.maxDispatches) {
      return { allowed: false, reason: `Total dispatch ceiling (${this.maxDispatches}) reached` };
    }
    if (this.usage.totalToolCalls + reserved.toolCalls + toolCalls > this.maxToolCalls) {
      return { allowed: false, reason: `Tool call budget ceiling (${this.maxToolCalls}) reached` };
    }
    if (this.usage.totalModelCalls + reserved.modelCalls + modelCalls > this.maxModelCalls) {
      return { allowed: false, reason: `Model call budget ceiling (${this.maxModelCalls}) reached` };
    }
    if (this.usage.totalInputTokens + reserved.inputTokens + inputTokens > this.maxInputTokens) {
      return { allowed: false, reason: `Input token budget ceiling (${this.maxInputTokens}) reached` };
    }
    if (this.usage.totalOutputTokens + reserved.outputTokens + outputTokens > this.maxOutputTokens) {
      return { allowed: false, reason: `Output token budget ceiling (${this.maxOutputTokens}) reached` };
    }
    if (this.usage.estimatedCostUsd + reserved.costUsd + costUsd > this.maxCostUsd) {
      return { allowed: false, reason: `Cost budget ceiling ($${this.maxCostUsd}) reached` };
    }

    this.totalSteps += 1;
    this.nextReservationSeq += 1;
    const handle: BudgetReservationHandle = {
      id: `res:${this.nextReservationSeq}:${specialist}`,
      specialist,
      dispatches,
      toolCalls,
      modelCalls,
      inputTokens,
      outputTokens,
      costUsd,
    };
    this.activeReservations.set(handle.id, handle);

    return { allowed: true, handle };
  }

  public commit(
    handle: BudgetReservationHandle,
    actualUsage?: SpecialistUsage | null,
    durationMs = 0,
  ): void {
    // Release this specific handle from active reservations
    this.activeReservations.delete(handle.id);

    const specialist = handle.specialist;
    if (!this.usage.bySpecialist[specialist]) {
      this.usage.bySpecialist[specialist] = {
        dispatches: 0,
        toolCalls: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        durationMs: 0,
      };
    }
    const entry = this.usage.bySpecialist[specialist];
    entry.dispatches += handle.dispatches;
    entry.durationMs += durationMs;
    this.usage.totalDispatches += handle.dispatches;

    if (actualUsage) {
      entry.toolCalls += actualUsage.toolCalls;
      entry.modelCalls += actualUsage.modelCalls;
      entry.inputTokens += actualUsage.inputTokens;
      entry.outputTokens += actualUsage.outputTokens;
      entry.estimatedCostUsd = Number((entry.estimatedCostUsd + actualUsage.estimatedCostUsd).toFixed(4));

      this.usage.totalToolCalls += actualUsage.toolCalls;
      this.usage.totalModelCalls += actualUsage.modelCalls;
      this.usage.totalInputTokens += actualUsage.inputTokens;
      this.usage.totalOutputTokens += actualUsage.outputTokens;
      this.usage.estimatedCostUsd = Number((this.usage.estimatedCostUsd + actualUsage.estimatedCostUsd).toFixed(4));
    }
  }

  public release(handle: BudgetReservationHandle): void {
    this.activeReservations.delete(handle.id);
  }
}

// ── Normalized Identifier Helper ─────────────────────────────────────────────

function extractDigits(str: string | null | undefined): string {
  return (str ?? '').replace(/\D/g, '');
}

export interface CanonicalScopedIdentifier {
  gtin: string | null;
  scope: IdentifierScope;
}

export function normalizeScopedIdentifier(
  rawGtin: string | null | undefined,
  requestedScope?: IdentifierScope,
): CanonicalScopedIdentifier {
  if (!rawGtin || rawGtin.trim().length === 0) {
    return { gtin: null, scope: requestedScope ?? 'consumer_unit' };
  }

  const d = extractDigits(rawGtin);
  if (d.length === 14) {
    if (requestedScope === 'case') {
      return { gtin: rawGtin.trim(), scope: 'case' };
    }
    return { gtin: null, scope: 'consumer_unit' };
  }

  if ([8, 12, 13].includes(d.length)) {
    return { gtin: rawGtin.trim(), scope: requestedScope ?? 'consumer_unit' };
  }

  return { gtin: rawGtin.trim(), scope: requestedScope ?? 'unknown' };
}

// ── Concurrent Map Helper ───────────────────────────────────────────────────

async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── Selector Validation Helper ───────────────────────────────────────────────

function isGenuineCssSelectorObservation(o: ExtractionObservation | undefined): string | null {
  if (!o) return null;
  if (o.method !== 'selector' && o.method !== 'profile_selector') return null;
  const path = o.sourcePath;
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  if (/^\[\d+\]/.test(trimmed) || /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(trimmed) || trimmed.startsWith('/')) {
    return null;
  }

  const isCss = trimmed.startsWith('#') ||
    trimmed.startsWith('.') ||
    /^h[1-6](\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[.*\])?/i.test(trimmed) ||
    /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[.*\])/.test(trimmed) ||
    trimmed.startsWith('[data-') ||
    trimmed.startsWith('[itemprop') ||
    trimmed.startsWith('[class') ||
    trimmed.includes(' > ') ||
    trimmed.includes(' ');

  return isCss ? trimmed : null;
}

// ── Orchestrator Implementation ─────────────────────────────────────────────

export class SpecialistOrchestrator {
  private readonly maxRetries: number;
  private readonly limits: CapabilityLimits;
  private readonly extractionConcurrency: number;
  private readonly dependencies: SpecialistOrchestratorDependencies;
  private readonly persistenceRepo: SpecialistWorkflowPersistenceRepository;
  private readonly now: () => string;

  public constructor(options: SpecialistOrchestratorOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.limits = { ...DEFAULT_CAPABILITY_LIMITS, ...options.limits };
    this.extractionConcurrency = Math.max(1, Math.min(8, options.extractionConcurrency ?? 3));
    this.dependencies = options.dependencies ?? {};
    this.persistenceRepo = options.dependencies?.workflowPersistence ?? resolveDefaultWorkflowPersistence();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getWorkflowState(runId: string): Promise<SpecialistWorkflowRecord | null> {
    return this.persistenceRepo.get(runId);
  }

  public async runWorkflow(
    productSeed: ProductSeed,
    classificationContext: ClassificationContext,
    context: SpecialistContext,
    workflowOptions: RunWorkflowOptions = {},
  ): Promise<SpecialistWorkflowResult> {
    const startedAt = Date.now();
    const events: OrchestratorStepEvent[] = [];
    const routeRecords: RouteRecord[] = [];
    const capabilityInvocationIds: Record<string, string[]> = {
      discovery: [],
      extraction: [],
      profile_engineer: [],
      resolver: [],
      curator: [],
      verifier: [],
    };
    const extractionArtifactRefs = new Set<string>();
    const cumulativePersistenceWarnings: string[] = [];

    let eventSeq = 0;
    let retriesCount = 0;

    const invocations = {
      discovery: 0,
      extraction: 0,
      profile: 0,
      resolver: 0,
      curator: 0,
      verifier: 0,
    };

    const budgetBroker = new WorkflowBudgetBroker(
      context,
      this.limits.maxTotalDispatches,
      this.limits.maxTotalSteps,
      startedAt,
    );

    // Normalize caller-provided identifier ONCE at workflow start
    const canonicalIdentifier = normalizeScopedIdentifier(
      workflowOptions.discoveredGtin,
      workflowOptions.gtinScope,
    );

    let discoveryArtifact: SpecialistArtifactEnvelope | undefined;
    let profileArtifact: SpecialistArtifactEnvelope | undefined;
    let resolverArtifact: SpecialistArtifactEnvelope | undefined;
    let curatorArtifact: SpecialistArtifactEnvelope | undefined;
    let verifierArtifact: SpecialistArtifactEnvelope | undefined;

    const makeSnapshot = (
      status: OrchestratorTerminalStatus,
      currentPhase: string,
      error?: string,
    ): WorkflowStateSnapshot => {
      const artifactIds: string[] = [];
      if (discoveryArtifact) artifactIds.push(`${discoveryArtifact.artifactType}:${discoveryArtifact.contentHash}`);
      if (profileArtifact) artifactIds.push(`${profileArtifact.artifactType}:${profileArtifact.contentHash}`);
      if (resolverArtifact) artifactIds.push(`${resolverArtifact.artifactType}:${resolverArtifact.contentHash}`);
      if (curatorArtifact) artifactIds.push(`${curatorArtifact.artifactType}:${curatorArtifact.contentHash}`);
      if (verifierArtifact) artifactIds.push(`${verifierArtifact.artifactType}:${verifierArtifact.contentHash}`);

      return {
        runId: context.runId,
        version: '1.0.0',
        status,
        currentPhase,
        retriesCount,
        totalDispatches: budgetBroker.usage.totalDispatches,
        invocations: { ...invocations },
        capabilityInvocationIds: { ...capabilityInvocationIds },
        extractionArtifactRefs: Array.from(extractionArtifactRefs),
        routeRecords: [...routeRecords],
        usage: { ...budgetBroker.usage },
        artifactIds,
        totalDurationMs: Date.now() - startedAt,
        persistenceWarnings: cumulativePersistenceWarnings.length > 0 ? [...cumulativePersistenceWarnings] : undefined,
        error,
      };
    };

    const persistState = async (
      status: OrchestratorTerminalStatus,
      currentPhase: string,
      error?: string,
    ): Promise<WorkflowStateSnapshot> => {
      const snapshot = makeSnapshot(status, currentPhase, error);
      try {
        await this.persistenceRepo.save({
          workflowId: `wf:${context.runId}`,
          runId: context.runId,
          workspaceId: context.workspaceId,
          workflowVersion: '1.0.0',
          productSeed,
          status,
          currentPhase,
          retriesCount,
          totalDispatches: budgetBroker.usage.totalDispatches,
          invocations: { ...invocations },
          capabilityInvocationIds: { ...capabilityInvocationIds },
          extractionArtifactRefs: Array.from(extractionArtifactRefs),
          routeRecords: [...routeRecords],
          usage: { ...budgetBroker.usage },
          stepEvents: [...events],
          artifactIds: snapshot.artifactIds,
          persistenceWarnings: cumulativePersistenceWarnings.length > 0 ? [...cumulativePersistenceWarnings] : undefined,
          createdAt: new Date(startedAt).toISOString(),
          updatedAt: this.now(),
          error,
        });
      } catch (err) {
        const persistErr = err instanceof Error ? err.message : String(err);
        cumulativePersistenceWarnings.push(`persistence_error: ${persistErr}`);
        snapshot.persistenceWarnings = [...cumulativePersistenceWarnings];
        snapshot.error = snapshot.error ? `${snapshot.error} (persistence_error: ${persistErr})` : `persistence_error: ${persistErr}`;
      }
      return snapshot;
    };

    const recordEvent = (
      specialist: string,
      action: string,
      status: OrchestratorStepEvent['status'],
      durationMs: number,
      details?: string,
    ): void => {
      eventSeq += 1;
      events.push({
        step: eventSeq,
        specialist,
        action,
        status,
        durationMs,
        timestamp: this.now(),
        details,
      });
    };

    const isAborted = (): boolean => Boolean(context.signal?.aborted);

    if (isAborted()) {
      recordEvent('orchestrator', 'init', 'failed', 0, 'Workflow cancelled before start');
      const state = await persistState('cancelled', 'init', 'Execution cancelled before start');
      return {
        runId: context.runId,
        status: 'cancelled',
        productSeed,
        extractionBundles: [],
        events,
        retriesCount: 0,
        totalDispatches: 0,
        totalDurationMs: Date.now() - startedAt,
        workflowState: state,
        error: 'Execution cancelled',
      };
    }

    const effectiveProfileLock: ProfileEngineerWorkflowLock = this.dependencies.profileEngineerWorkflowLock
      ?? resolveDefaultProfileLock();

    const discovery = this.dependencies.discovery ?? new DiscoverySpecialist({}, { codeCommit: captureSpecialistCodeCommit() });
    const profileEngineer = this.dependencies.profileEngineer ?? new ProfileEngineerSpecialist(
      { workflow: effectiveProfileLock },
      { codeCommit: captureSpecialistCodeCommit() },
    );
    const resolver = this.dependencies.resolver ?? new ResolverSpecialist({ now: this.now });
    const curator = this.dependencies.curator ?? new CuratorSpecialist({ now: this.now });
    const verifier = this.dependencies.verifier ?? new VerifierSpecialist({ now: this.now });

    let discoveryOutput: DiscoverySpecialistOutput | undefined;
    let profileOutput: ProfileEngineerProposal | undefined;
    let extractionBundles: ExtractionEvidenceBundle[] = [];
    let resolverOutput: ResolvedFactSet | undefined;
    let curatorOutput: CuratedProductDraft | undefined;
    let verifierOutput: VerificationReport | undefined;

    let targetPhase: 'discovery' | 'extraction' | 'resolver' | 'curator' | 'verifier' = 'discovery';

    const getDynamicSpecialistContext = (): SpecialistContext => {
      return {
        ...context,
        runtimeAllowance: budgetBroker.getRuntimeAllowance(),
        deadlineAt: budgetBroker.deadlineAt ?? undefined,
      };
    };

    while (budgetBroker.usage.totalDispatches < this.limits.maxTotalDispatches) {
      if (isAborted()) {
        recordEvent('orchestrator', 'cancellation_check', 'failed', 0, 'Workflow cancelled by caller');
        const state = await persistState('cancelled', targetPhase, 'Workflow cancelled by caller');
        return {
          runId: context.runId,
          status: 'cancelled',
          productSeed,
          discoveryOutput,
          discoveryArtifact,
          profileOutput,
          profileArtifact,
          extractionBundles,
          resolverOutput,
          resolverArtifact,
          curatorOutput,
          curatorArtifact,
          verifierOutput,
          verifierArtifact,
          events,
          retriesCount,
          totalDispatches: budgetBroker.usage.totalDispatches,
          totalDurationMs: Date.now() - startedAt,
          workflowState: state,
          error: 'Execution cancelled',
        };
      }

      switch (targetPhase) {
        case 'discovery': {
          if (invocations.discovery >= this.limits.maxDiscoveryInvocations) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Discovery invocation limit reached');
            const state = await persistState('budget_exceeded', 'discovery', 'Discovery invocation limit reached');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              extractionBundles: [],
              workflowState: state,
              error: 'Discovery invocation limit reached',
            };
          }

          const reservation = budgetBroker.reserve('discovery', { dispatches: 1, toolCalls: 1, costUsd: 0.005 });
          if (!reservation.allowed) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, reservation.reason);
            const state = await persistState('budget_exceeded', 'discovery', reservation.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              extractionBundles: [],
              workflowState: state,
              error: reservation.reason,
            };
          }

          invocations.discovery += 1;
          const invocationId = `inv:discovery:${invocations.discovery}`;
          capabilityInvocationIds.discovery.push(invocationId);

          const stepStart = Date.now();
          recordEvent('discovery', 'discover_candidates', 'started', 0);
          await persistState('in_progress', 'discovery');

          const discContext = getDynamicSpecialistContext();
          const discResult: SpecialistResult = await discovery.execute(
            {
              schemaVersion: 1,
              productSeed,
              discoveredGtin: canonicalIdentifier.gtin,
              batchContext: null,
              sourceCandidates: [],
            },
            discContext,
          );

          const discDuration = Date.now() - stepStart;
          budgetBroker.commit(reservation.handle!, discResult.usage, discDuration);

          const discBudgetOver = budgetBroker.isOverBudget();
          if (discBudgetOver.exceeded) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, discBudgetOver.reason);
            const state = await persistState('budget_exceeded', 'discovery', discBudgetOver.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              extractionBundles,
              workflowState: state,
              error: discBudgetOver.reason,
            };
          }

          if (discResult.outcome !== 'succeeded' || !discResult.output) {
            if (discResult.outcome === 'abstained') {
              recordEvent('discovery', 'discover_candidates', 'succeeded', discDuration, 'Discovery abstained (no candidates)');
              const state = await persistState('abstained', 'discovery');
              return {
                runId: context.runId,
                status: 'abstained',
                productSeed,
                extractionBundles,
                events,
                retriesCount,
                totalDispatches: budgetBroker.usage.totalDispatches,
                totalDurationMs: Date.now() - startedAt,
                workflowState: state,
              };
            }
            recordEvent('discovery', 'discover_candidates', 'failed', discDuration, discResult.failure?.message);
            const state = await persistState('failed', 'discovery', discResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: discResult.failure?.message ?? 'Discovery failed',
            };
          }

          const envelope = discResult.output as SpecialistArtifactEnvelope;
          discoveryArtifact = envelope;
          discoveryOutput = envelope.payload as DiscoverySpecialistOutput;

          if (discoveryOutput.candidates.length === 0) {
            recordEvent('discovery', 'discover_candidates', 'succeeded', discDuration, 'Discovery abstained (no candidates)');
            const state = await persistState('abstained', 'discovery');
            return {
              runId: context.runId,
              status: 'abstained',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
            };
          }

          recordEvent(
            'discovery',
            'discover_candidates',
            'succeeded',
            discDuration,
            `Found ${discoveryOutput.candidates.length} candidates`,
          );

          routeRecords.push({
            fromPhase: 'discovery',
            toPhase: 'extraction',
            reason: `Discovered ${discoveryOutput.candidates.length} candidates`,
            timestamp: this.now(),
          });
          targetPhase = 'extraction';
          await persistState('in_progress', 'transition_to_extraction');
          break;
        }

        case 'extraction': {
          const stepStart = Date.now();
          recordEvent('extraction_runner', 'extract_evidence', 'started', 0);
          await persistState('in_progress', 'extraction');

          const candidates = discoveryOutput?.candidates ?? [];
          const candidateUrls = candidates
            .slice(0, 3)
            .map((c) => (c as any).finalUrl ?? (c as any).source?.url ?? (c as any).url)
            .filter((u): u is string => typeof u === 'string' && Boolean(u.trim()));

          const trustedCandidateGtin = (() => {
            const trusted = candidates.find(
              (c) => (c.pageKind === 'exact_pdp' || c.pageKind === 'probable_pdp') &&
                c.extracted.identifiers.some((i) => i.kind === 'gtin' && Boolean(i.sourceArtifactId) && i.evidenceIds.length > 0),
            )?.extracted.identifiers.find((i) => i.kind === 'gtin')?.value ?? null;
            if (!trusted) return null;
            const d = extractDigits(trusted);
            if (d.length === 14 && canonicalIdentifier.scope !== 'case') {
              return null;
            }
            return trusted;
          })();

          const effectiveExtractionGtin = canonicalIdentifier.gtin ?? trustedCandidateGtin ?? null;

          let requiresProfileHold = false;
          let profileHoldReason = 'Holding workflow for manual review and activation of proposed profile in Profile Builder';
          const synthesizedDomainsInPhase = new Set<string>();
          const bundlesByUrl = new Map<string, ExtractionEvidenceBundle>();

          if (candidateUrls.length > 0 && budgetBroker.getRemainingToolCalls() <= 0) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Tool call budget ceiling reached before extraction');
            const state = await persistState('budget_exceeded', 'extraction', 'Tool call budget ceiling reached');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Tool call budget ceiling reached',
            };
          }

          // Bounded parallel extraction with per-worker relative deadline calculation
          extractionBundles = await boundedMap(
            candidateUrls,
            this.extractionConcurrency,
            async (url) => {
              if (invocations.extraction >= this.limits.maxExtractionInvocations) {
                return {
                  schemaVersion: 1 as const,
                  runnerVersion: '1.0.0',
                  requestedUrl: url,
                  finalUrl: url,
                  retrievedAt: this.now(),
                  contentHash: sha256Hex(url),
                  artifactRefs: [],
                  profile: null,
                  extractionPath: [],
                  observations: [],
                  images: [],
                  variant: null,
                  identityStatus: 'insufficient_evidence' as const,
                  identityReasons: ['Extraction invocation limit reached'],
                  failures: [{ code: 'extraction_failed' as const, stage: 'retrieval' as const, message: 'Extraction invocation limit reached', retryable: false }],
                  deterministicOnly: true,
                };
              }

              const workerReservation = budgetBroker.reserve('extraction', { dispatches: 1, toolCalls: 1 });
              if (!workerReservation.allowed) {
                return {
                  schemaVersion: 1 as const,
                  runnerVersion: '1.0.0',
                  requestedUrl: url,
                  finalUrl: url,
                  retrievedAt: this.now(),
                  contentHash: sha256Hex(url),
                  artifactRefs: [],
                  profile: null,
                  extractionPath: [],
                  observations: [],
                  images: [],
                  variant: null,
                  identityStatus: 'insufficient_evidence' as const,
                  identityReasons: ['Dispatch or budget limit reached'],
                  failures: [{ code: 'extraction_failed' as const, stage: 'retrieval' as const, message: 'Dispatch limit reached', retryable: false }],
                  deterministicOnly: true,
                };
              }

              invocations.extraction += 1;
              capabilityInvocationIds.extraction.push(`inv:extraction:${invocations.extraction}`);

              // Calculate fresh relative deadline immediately before worker execution
              const workerNow = Date.now();
              const workerTimeoutMs = budgetBroker.deadlineAt
                ? Math.max(1, budgetBroker.deadlineAt - workerNow)
                : (context.policy.deadlineMs ?? 30_000);

              let bundle: ExtractionEvidenceBundle;
              const workerDynContext = getDynamicSpecialistContext();

              if (this.dependencies.extractionRunner) {
                bundle = await this.dependencies.extractionRunner(url, workerDynContext, null);
              } else {
                const { bundle: detBundle } = await runDeterministicExtraction(
                  {
                    url,
                    expected: {
                      gtin: effectiveExtractionGtin ?? undefined,
                      name: productSeed.name,
                    },
                    signal: context.signal,
                    timeoutMs: workerTimeoutMs,
                  },
                  this.dependencies.extractionRunnerOptions ?? { now: this.now },
                );
                bundle = detBundle;
              }

              budgetBroker.commit(workerReservation.handle!, {
                toolCalls: 1,
                modelCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                estimatedCostUsd: 0,
              });

              for (const ref of bundle.artifactRefs) {
                extractionArtifactRefs.add(ref);
              }
              bundlesByUrl.set(url, bundle);
              if (bundle.finalUrl) bundlesByUrl.set(bundle.finalUrl, bundle);

              return bundle;
            },
          );

          if (extractionBundles.length > 0 && extractionBundles.every((b) => b.identityReasons.includes('Dispatch or budget limit reached'))) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Extraction dispatches blocked by budget limit');
            const state = await persistState('budget_exceeded', 'extraction', 'Extraction dispatches blocked by budget limit');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Extraction dispatches blocked by budget limit',
            };
          }

          // Profile synthesis check
          for (const bundle of extractionBundles) {
            const url = bundle.finalUrl ?? bundle.requestedUrl;
            const domain = (() => {
              try { return new URL(url).hostname; } catch { return 'unknown'; }
            })();

            const needsProfile = bundle.failures.some((f) => f.code === 'profile_failed' || f.code === 'profile_missing');
            if (needsProfile && !synthesizedDomainsInPhase.has(domain) && invocations.profile < this.limits.maxProfileInvocations) {
              synthesizedDomainsInPhase.add(domain);

              const domainCandidates = candidates.filter((c: any) => {
                try {
                  const cUrl = c.finalUrl ?? c.source?.url ?? c.url;
                  return typeof cUrl === 'string' && new URL(cUrl).hostname === domain;
                } catch {
                  return false;
                }
              });

              if (domainCandidates.length >= 2) {
                const sample1 = domainCandidates[0];
                const sample2 = domainCandidates[1];
                const sample1Url = (sample1 as any).finalUrl ?? (sample1 as any).source?.url ?? (sample1 as any).url;
                const sample2Url = (sample2 as any).finalUrl ?? (sample2 as any).source?.url ?? (sample2 as any).url;

                const bundle1 = bundlesByUrl.get(sample1Url) ?? (sample1.source?.url ? bundlesByUrl.get(sample1.source.url) : undefined);
                const bundle2 = bundlesByUrl.get(sample2Url) ?? (sample2.source?.url ? bundlesByUrl.get(sample2.source.url) : undefined);

                const sample1Artifacts = [...new Set(sample1.extracted.identifiers
                  .map((i: any) => i.sourceArtifactId)
                  .concat(bundle1?.artifactRefs ?? [])
                  .filter((id: any) => Boolean(id)))];
                const sample2Artifacts = [...new Set(sample2.extracted.identifiers
                  .map((i: any) => i.sourceArtifactId)
                  .concat(bundle2?.artifactRefs ?? [])
                  .filter((id: any) => Boolean(id)))];

                const sample1TitleObs = bundle1?.observations.find((o) => o.field === 'title' || o.field === 'product_name');
                const sample2TitleObs = bundle2?.observations.find((o) => o.field === 'title' || o.field === 'product_name');
                const sample1TitleHint = isGenuineCssSelectorObservation(sample1TitleObs);
                const sample2TitleHint = isGenuineCssSelectorObservation(sample2TitleObs);

                const hasRealEvidence = sample1Artifacts.length > 0 && sample2Artifacts.length > 0;

                if (hasRealEvidence) {
                  const profReservation = budgetBroker.reserve('profile_engineer', { dispatches: 1, costUsd: 0.001 });
                  if (profReservation.allowed) {
                    invocations.profile += 1;
                    const profInvId = `inv:profile_engineer:${invocations.profile}`;
                    capabilityInvocationIds.profile_engineer.push(profInvId);

                    routeRecords.push({
                      fromPhase: 'extraction',
                      toPhase: 'profile_engineer',
                      reason: `Synthesizing profile proposal for domain: ${domain}`,
                      timestamp: this.now(),
                    });
                    await persistState('in_progress', 'profile_engineer_synthesis');

                    recordEvent('profile_engineer', 'synthesize_profile', 'started', 0, `Synthesizing profile proposal for domain: ${domain}`);

                    const sample1Obs: Record<string, string> = {};
                    if (sample1.extracted.brand) sample1Obs.brand = sample1.extracted.brand;
                    if (sample1.extracted.productName) sample1Obs.product_name = sample1.extracted.productName;
                    if (sample1.extracted.size) sample1Obs.size = sample1.extracted.size;
                    if (sample1.extracted.sku) sample1Obs.sku = sample1.extracted.sku;
                    if (sample1.extracted.gtins.length > 0) sample1Obs.gtin = sample1.extracted.gtins[0];

                    const sample2Obs: Record<string, string> = {};
                    if (sample2.extracted.brand) sample2Obs.brand = sample2.extracted.brand;
                    if (sample2.extracted.productName) sample2Obs.product_name = sample2.extracted.productName;
                    if (sample2.extracted.size) sample2Obs.size = sample2.extracted.size;
                    if (sample2.extracted.sku) sample2Obs.sku = sample2.extracted.sku;
                    if (sample2.extracted.gtins.length > 0) sample2Obs.gtin = sample2.extracted.gtins[0];

                    const sample1Hints: Record<string, string> = {};
                    if (sample1TitleHint) sample1Hints.titleSelector = sample1TitleHint;
                    const sample2Hints: Record<string, string> = {};
                    if (sample2TitleHint) sample2Hints.titleSelector = sample2TitleHint;

                    // Distinguish missing profile (v1) from failed/stale active profile (vN+1 repair)
                    const failedProfile = bundle.failures.some((f) => f.code === 'profile_failed') && bundle.profile
                      ? {
                        profileId: bundle.profile.id,
                        targetVersion: typeof bundle.profile.version === 'number' ? bundle.profile.version + 1 : 2,
                        version: bundle.profile.version,
                        sourceProfileVersion: bundle.profile.version != null ? String(bundle.profile.version) : null,
                        runtime: bundle.profile.runtime ?? 'rendered',
                      }
                      : null;

                    const profContext = getDynamicSpecialistContext();
                    const profResult = await profileEngineer.execute(
                      {
                        schemaVersion: 1,
                        domain,
                        repairOf: failedProfile,
                        samples: [
                          {
                            url: sample1Url,
                            artifactRefs: sample1Artifacts,
                            expectedName: sample1.extracted.productName ?? productSeed.name,
                            expectedGtin: sample1.extracted.gtins[0] ?? effectiveExtractionGtin ?? undefined,
                            signals: {
                              jsonLd: sample1.extracted.identifiers.some((i: any) => i.method === 'json_ld'),
                              shopify: sample1.signals.some((s: any) => s.value.toLowerCase().includes('shopify')),
                              woocommerce: sample1.signals.some((s: any) => s.value.toLowerCase().includes('woocommerce')),
                              embeddedState: false,
                              selectorOnly: false,
                              changedMarkup: false,
                              wrongVariant: sample1.pageKind === 'wrong_variant',
                            },
                            selectorHints: sample1Hints,
                            observedFields: sample1Obs,
                          },
                          {
                            url: sample2Url,
                            artifactRefs: sample2Artifacts,
                            expectedName: sample2.extracted.productName ?? productSeed.name,
                            expectedGtin: sample2.extracted.gtins[0] ?? effectiveExtractionGtin ?? undefined,
                            signals: {
                              jsonLd: sample2.extracted.identifiers.some((i: any) => i.method === 'json_ld'),
                              shopify: sample2.signals.some((s: any) => s.value.toLowerCase().includes('shopify')),
                              woocommerce: sample2.signals.some((s: any) => s.value.toLowerCase().includes('woocommerce')),
                              embeddedState: false,
                              selectorOnly: false,
                              changedMarkup: false,
                              wrongVariant: sample2.pageKind === 'wrong_variant',
                            },
                            selectorHints: sample2Hints,
                            observedFields: sample2Obs,
                          },
                        ],
                        requiredFields: ['titleSelector'],
                      },
                      profContext,
                    );

                    budgetBroker.commit(profReservation.handle!, profResult.usage, 0);

                    if (profResult.outcome === 'succeeded' && profResult.output) {
                      const profEnv = profResult.output as SpecialistArtifactEnvelope;
                      profileArtifact = profEnv;
                      profileOutput = profEnv.payload as ProfileEngineerProposal;

                      recordEvent(
                        'profile_engineer',
                        'synthesize_profile',
                        'succeeded',
                        0,
                        `Proposed profile for ${domain}; held for manual review/activation`,
                      );
                      requiresProfileHold = true;
                      profileHoldReason = `Profile proposed for domain '${domain}' requiring manual review and activation in Profile Builder`;
                    } else if (profResult.outcome === 'abstained') {
                      requiresProfileHold = true;
                      profileHoldReason = `Profile synthesis for ${domain} abstained: ${profResult.abstention?.reason ?? 'profile_unavailable'}`;
                      recordEvent('profile_engineer', 'synthesize_profile', 'skipped', 0, profileHoldReason);
                    } else if (profResult.outcome === 'failed') {
                      requiresProfileHold = true;
                      profileHoldReason = `Profile synthesis for ${domain} failed: ${profResult.failure?.message ?? 'profile_failed'}`;
                      recordEvent('profile_engineer', 'synthesize_profile', 'failed', 0, profileHoldReason);
                    }
                  }
                } else if (!hasRealEvidence) {
                  recordEvent('profile_engineer', 'insufficient_evidence', 'skipped', 0, `Abstained profile synthesis for ${domain}: missing retained page artifact evidence`);
                }
              }
            }
          }

          const extractDuration = Date.now() - stepStart;
          recordEvent(
            'extraction_runner',
            'extract_evidence',
            'succeeded',
            extractDuration,
            `Collected ${extractionBundles.length} extraction bundle(s)`,
          );

          if (requiresProfileHold) {
            recordEvent(
              'orchestrator',
              'profile_review_hold',
              'succeeded',
              0,
              profileHoldReason,
            );
            const state = await persistState('needs_review', 'extraction_profile_hold');
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
            };
          }

          routeRecords.push({
            fromPhase: 'extraction',
            toPhase: 'resolver',
            reason: `Extracted ${extractionBundles.length} evidence bundle(s)`,
            timestamp: this.now(),
          });
          targetPhase = 'resolver';
          await persistState('in_progress', 'transition_to_resolver');
          break;
        }

        case 'resolver': {
          if (invocations.resolver >= this.limits.maxResolverInvocations) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Resolver invocation limit reached');
            const state = await persistState('budget_exceeded', 'resolver', 'Resolver invocation limit reached');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Resolver invocation limit reached',
            };
          }

          const reservation = budgetBroker.reserve('resolver', { dispatches: 1, costUsd: 0.001 });
          if (!reservation.allowed) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, reservation.reason);
            const state = await persistState('budget_exceeded', 'resolver', reservation.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: reservation.reason,
            };
          }

          invocations.resolver += 1;
          const resInvId = `inv:resolver:${invocations.resolver}`;
          capabilityInvocationIds.resolver.push(resInvId);

          const stepStart = Date.now();
          recordEvent('resolver', 'reconcile_facts', 'started', 0);
          await persistState('in_progress', 'resolver');

          const trustedCandidateGtin = (() => {
            const trusted = discoveryOutput?.candidates.find(
              (c) => (c.pageKind === 'exact_pdp' || c.pageKind === 'probable_pdp') &&
                c.extracted.identifiers.some((i) => i.kind === 'gtin' && Boolean(i.sourceArtifactId) && i.evidenceIds.length > 0),
            )?.extracted.identifiers.find((i) => i.kind === 'gtin')?.value ?? null;
            if (!trusted) return null;
            const d = extractDigits(trusted);
            if (d.length === 14 && canonicalIdentifier.scope !== 'case') {
              return null;
            }
            return trusted;
          })();

          const effectiveResolverGtin = canonicalIdentifier.gtin ?? trustedCandidateGtin ?? null;
          const effectiveResolverScope = canonicalIdentifier.gtin ? canonicalIdentifier.scope : (effectiveResolverGtin && extractDigits(effectiveResolverGtin).length === 14 ? 'case' : 'consumer_unit');

          const resContext = getDynamicSpecialistContext();
          const resResult: SpecialistResult = await resolver.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              expectedIdentity: {
                gtin: effectiveResolverGtin,
                gtinScope: effectiveResolverScope,
              },
              discoveryCandidates: discoveryOutput?.candidates ?? [],
              extractionBundles,
            },
            resContext,
          );

          const resDuration = Date.now() - stepStart;
          budgetBroker.commit(reservation.handle!, resResult.usage, resDuration);

          const resBudgetOver = budgetBroker.isOverBudget();
          if (resBudgetOver.exceeded) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, resBudgetOver.reason);
            const state = await persistState('budget_exceeded', 'resolver', resBudgetOver.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: resBudgetOver.reason,
            };
          }

          if (resResult.outcome !== 'succeeded' || !resResult.output) {
            recordEvent('resolver', 'reconcile_facts', 'failed', resDuration, resResult.failure?.message);
            const state = await persistState('failed', 'resolver', resResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: resResult.failure?.message ?? 'Resolver failed',
            };
          }

          const envelope = resResult.output as SpecialistArtifactEnvelope;
          resolverArtifact = envelope;
          resolverOutput = envelope.payload as ResolvedFactSet;

          recordEvent(
            'resolver',
            'reconcile_facts',
            'succeeded',
            resDuration,
            `Resolved identity: ${resolverOutput.identity.status}, facts: ${resolverOutput.fieldCompleteness.resolved}/${resolverOutput.fieldCompleteness.total}`,
          );

          routeRecords.push({
            fromPhase: 'resolver',
            toPhase: 'curator',
            reason: `Reconciled ${resolverOutput.fieldCompleteness.resolved} facts`,
            timestamp: this.now(),
          });
          targetPhase = 'curator';
          await persistState('in_progress', 'transition_to_curator');
          break;
        }

        case 'curator': {
          if (invocations.curator >= this.limits.maxCuratorInvocations) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Curator invocation limit reached');
            const state = await persistState('budget_exceeded', 'curator', 'Curator invocation limit reached');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Curator invocation limit reached',
            };
          }

          const curCost = (curator as any).plannedCostUsd ?? 0.005;
          const curModels = (curator as any).plannedModelCalls ?? 0;
          const curInTokens = (curator as any).plannedInputTokens ?? 0;
          const curOutTokens = (curator as any).plannedOutputTokens ?? 0;
          const reservation = budgetBroker.reserve('curator', {
            dispatches: 1,
            modelCalls: curModels,
            inputTokens: curInTokens,
            outputTokens: curOutTokens,
            costUsd: curCost,
          });
          if (!reservation.allowed) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, reservation.reason);
            const state = await persistState('budget_exceeded', 'curator', reservation.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: reservation.reason,
            };
          }

          invocations.curator += 1;
          const curInvId = `inv:curator:${invocations.curator}`;
          capabilityInvocationIds.curator.push(curInvId);

          const stepStart = Date.now();
          recordEvent('curator', 'synthesize_draft', 'started', 0);
          await persistState('in_progress', 'curator');

          if (!resolverOutput) {
            recordEvent('curator', 'synthesize_draft', 'failed', 0, 'Missing resolved facts');
            const state = await persistState('failed', 'curator', 'Missing resolved facts');
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Missing resolved facts',
            };
          }

          const curContext = getDynamicSpecialistContext();
          const curResult: SpecialistResult = await curator.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              classificationContext,
            },
            curContext,
          );

          const curDuration = Date.now() - stepStart;
          budgetBroker.commit(reservation.handle!, curResult.usage, curDuration);

          const curBudgetOver = budgetBroker.isOverBudget();
          if (curBudgetOver.exceeded) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, curBudgetOver.reason);
            const state = await persistState('budget_exceeded', 'curator', curBudgetOver.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: curBudgetOver.reason,
            };
          }

          if (curResult.outcome !== 'succeeded' || !curResult.output) {
            recordEvent('curator', 'synthesize_draft', 'failed', curDuration, curResult.failure?.message);
            const state = await persistState('failed', 'curator', curResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: curResult.failure?.message ?? 'Curator failed',
            };
          }

          const envelope = curResult.output as SpecialistArtifactEnvelope;
          curatorArtifact = envelope;
          curatorOutput = envelope.payload as CuratedProductDraft;

          recordEvent(
            'curator',
            'synthesize_draft',
            'succeeded',
            curDuration,
            `Draft title: '${curatorOutput.catalogTitle}'`,
          );

          routeRecords.push({
            fromPhase: 'curator',
            toPhase: 'verifier',
            reason: `Curated draft '${curatorOutput.catalogTitle}'`,
            timestamp: this.now(),
          });
          targetPhase = 'verifier';
          await persistState('in_progress', 'transition_to_verifier');
          break;
        }

        case 'verifier': {
          if (invocations.verifier >= this.limits.maxVerifierInvocations) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Verifier invocation limit reached');
            const state = await persistState('budget_exceeded', 'verifier', 'Verifier invocation limit reached');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Verifier invocation limit reached',
            };
          }

          const verCost = (verifier as any).plannedCostUsd ?? 0.005;
          const verModels = (verifier as any).plannedModelCalls ?? 0;
          const verInTokens = (verifier as any).plannedInputTokens ?? 0;
          const verOutTokens = (verifier as any).plannedOutputTokens ?? 0;
          const reservation = budgetBroker.reserve('verifier', {
            dispatches: 1,
            modelCalls: verModels,
            inputTokens: verInTokens,
            outputTokens: verOutTokens,
            costUsd: verCost,
          });
          if (!reservation.allowed) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, reservation.reason);
            const state = await persistState('budget_exceeded', 'verifier', reservation.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: reservation.reason,
            };
          }

          invocations.verifier += 1;
          const verInvId = `inv:verifier:${invocations.verifier}`;
          capabilityInvocationIds.verifier.push(verInvId);

          const stepStart = Date.now();
          recordEvent('verifier', 'verify_quality', 'started', 0);
          await persistState('in_progress', 'verifier');

          if (!resolverOutput || !curatorOutput) {
            recordEvent('verifier', 'verify_quality', 'failed', 0, 'Missing facts or draft for verification');
            const state = await persistState('failed', 'verifier', 'Missing facts or draft');
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: 'Missing facts or draft',
            };
          }

          const verContext = getDynamicSpecialistContext();
          const verResult: SpecialistResult = await verifier.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              curatedDraft: curatorOutput,
              classificationContext,
              extractionBundles,
            },
            verContext,
          );

          const verDuration = Date.now() - stepStart;
          budgetBroker.commit(reservation.handle!, verResult.usage, verDuration);

          const verBudgetOver = budgetBroker.isOverBudget();
          if (verBudgetOver.exceeded) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, verBudgetOver.reason);
            const state = await persistState('budget_exceeded', 'verifier', verBudgetOver.reason);
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: verBudgetOver.reason,
            };
          }

          if (verResult.outcome === 'abstained') {
            const isBudget = Boolean(verResult.abstention?.reason?.includes('budget') || verResult.abstention?.reason?.includes('cost'));
            const termStatus = isBudget ? 'budget_exceeded' : 'abstained';
            recordEvent('verifier', 'verify_quality', isBudget ? 'failed' : 'succeeded', verDuration, verResult.abstention?.reason);
            const state = await persistState(termStatus, 'verifier', isBudget ? verResult.abstention?.reason : undefined);
            return {
              runId: context.runId,
              status: termStatus,
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: isBudget ? verResult.abstention?.reason : undefined,
            };
          }

          if (verResult.outcome !== 'succeeded' || !verResult.output) {
            recordEvent('verifier', 'verify_quality', 'failed', verDuration, verResult.failure?.message);
            const state = await persistState('failed', 'verifier', verResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
              error: verResult.failure?.message ?? 'Verifier failed',
            };
          }

          const envelope = verResult.output as SpecialistArtifactEnvelope;
          verifierArtifact = envelope;
          verifierOutput = envelope.payload as VerificationReport;

          recordEvent(
            'verifier',
            'verify_quality',
            'succeeded',
            verDuration,
            `Verdict: ${verifierOutput.verdict}, Score: ${verifierOutput.score}`,
          );

          // Evaluate verdict
          if (verifierOutput.verdict === 'pass') {
            recordEvent('orchestrator', 'terminal_eval', 'succeeded', 0, 'Workflow completed successfully');
            const state = await persistState('completed', 'completed');
            return {
              runId: context.runId,
              status: 'completed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
            };
          }

          if (retriesCount >= this.maxRetries) {
            recordEvent(
              'orchestrator',
              'retry_limit_reached',
              'succeeded',
              0,
              `Max retries (${this.maxRetries}) reached; holding for human review`,
            );
            const state = await persistState('needs_review', 'review_hold_retries_exhausted');
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
            };
          }

          // Execute structured retry routing
          retriesCount += 1;
          const retry = verifierOutput.retryRequest;

          if (retry?.targetSpecialist === 'curator') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying curator: ${retry.reason}`);
            routeRecords.push({
              fromPhase: 'verifier',
              toPhase: 'curator',
              reason: retry.reason,
              timestamp: this.now(),
            });
            targetPhase = 'curator';
            await persistState('in_progress', 'retry_curator');
          } else if (retry?.targetSpecialist === 'resolver') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying resolver: ${retry.reason}`);
            routeRecords.push({
              fromPhase: 'verifier',
              toPhase: 'resolver',
              reason: retry.reason,
              timestamp: this.now(),
            });
            targetPhase = 'resolver';
            await persistState('in_progress', 'retry_resolver');
          } else if (retry?.targetSpecialist === 'discovery') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying discovery: ${retry.reason}`);
            routeRecords.push({
              fromPhase: 'verifier',
              toPhase: 'discovery',
              reason: retry.reason,
              timestamp: this.now(),
            });
            targetPhase = 'discovery';
            await persistState('in_progress', 'retry_discovery');
          } else {
            // Unhandled or human_review verdict
            recordEvent('orchestrator', 'human_review_hold', 'succeeded', 0, 'Holding for human review');
            const state = await persistState('needs_review', 'human_review_verdict');
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches: budgetBroker.usage.totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: state,
            };
          }
          break;
        }
      }
    }

    recordEvent('orchestrator', 'dispatch_limit_reached', 'failed', 0, `Exceeded max total dispatches (${this.limits.maxTotalDispatches})`);
    const state = await persistState('budget_exceeded', 'dispatch_limit_reached', 'Exceeded max total dispatches');
    return {
      runId: context.runId,
      status: 'budget_exceeded',
      productSeed,
      discoveryOutput,
      discoveryArtifact,
      profileOutput,
      profileArtifact,
      extractionBundles,
      resolverOutput,
      resolverArtifact,
      curatorOutput,
      curatorArtifact,
      verifierOutput,
      verifierArtifact,
      events,
      retriesCount,
      totalDispatches: budgetBroker.usage.totalDispatches,
      totalDurationMs: Date.now() - startedAt,
      workflowState: state,
      error: 'Exceeded max total dispatches',
    };
  }
}
