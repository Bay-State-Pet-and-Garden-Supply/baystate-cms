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
 *       ├── 'pass' ───────────────────────► Terminal: COMPLETED
 *       ├── 'retry_curator' (retries < max) ──► Re-run Curator → Verifier
 *       ├── 'retry_resolver' (retries < max) ─► Re-run Resolver → Curator → Verifier
 *       ├── 'retry_discovery' (retries < max) ► Re-run Discovery → Pipeline
 *       └── 'human_review' / retries exhausted ► Terminal: NEEDS_REVIEW
 *
 * INVARIANTS:
 *   - Specialists NEVER invoke each other; ONLY the orchestrator dispatches work.
 *   - All inter-specialist data flows are schema-validated typed artifacts.
 *   - Loops stop deterministically at configured retry/dispatch/budget limits.
 *   - Cancellation via AbortSignal immediately aborts execution and sets CANCELLED.
 *   - Atomic dispatch & tool/cost ledger reservations enforce hard aggregate policy limits.
 *   - 14-digit GTINs are strictly case-scoped and never promoted as consumer GTINs.
 *   - Caller identifiers are normalized once and passed canonically across all phases.
 *   - Profile Engineer proposals require governance/manual review before activation.
 *   - Profile synthesis uses concurrency-safe workflow locks with real per-page selector evidence.
 *   - Every phase transition and route is durably persisted with full invocation and artifact provenance.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import type { ProductSeed } from '../product-seed';
import {
  DiscoverySpecialist,
  type DiscoverySpecialistOutput,
  type DiscoveryCandidate,
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
} from '../extraction/evidence';
import type { SpecialistContext, SpecialistResult, SpecialistUsage } from '../specialists/contracts';
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
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
  maxDiscoveryInvocations: 2,
  maxExtractionInvocations: 12,
  maxProfileInvocations: 4,
  maxResolverInvocations: 4,
  maxCuratorInvocations: 4,
  maxVerifierInvocations: 4,
  maxTotalDispatches: 20,
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

  public claim(
    domain: string,
    runId: string,
    _workspaceId: string,
    _options?: ClaimProfileLockOptions,
  ): { acquired: boolean; workflowId: string; reason?: string } {
    if (this.activeLocks.has(domain)) {
      return { acquired: false, workflowId: `wf:${domain}:${runId}`, reason: `Domain ${domain} profile is actively being synthesized` };
    }
    this.activeLocks.add(domain);
    return { acquired: true, workflowId: `wf:${domain}:${runId}` };
  }

  public complete(workflowId: string, _runId: string): { applied: boolean } {
    const domain = workflowId.split(':')[1];
    if (domain) this.activeLocks.delete(domain);
    return { applied: true };
  }

  public fail(workflowId: string, _runId: string, _reason: string): { applied: boolean } {
    const domain = workflowId.split(':')[1];
    if (domain) this.activeLocks.delete(domain);
    return { applied: true };
  }
}

export function resolveDefaultProfileLock(): ProfileEngineerWorkflowLock {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repo = require('../../db/repositories/profile-engineer-workflow-repo');
    if (typeof repo.profileEngineerWorkflowLock === 'function') {
      return repo.profileEngineerWorkflowLock();
    }
  } catch {
    // In test runners or environments without bun:sqlite, fallback to in-memory lock
  }
  return new InMemoryProfileWorkflowLock();
}

export function resolveDefaultWorkflowPersistence(): SpecialistWorkflowPersistenceRepository {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const repo = require('../../db/repositories/specialist-workflow-repo');
    if (typeof repo.specialistWorkflowPersistence === 'function') {
      return repo.specialistWorkflowPersistence();
    }
  } catch {
    // In test runners or environments without bun:sqlite, fallback to in-memory persistence
  }
  return new InMemoryWorkflowPersistenceRepository();
}

// ── Aggregate Budget Broker ──────────────────────────────────────────────────

export class WorkflowBudgetBroker {
  private readonly maxToolCalls: number;
  private readonly maxCostUsd: number;
  private readonly maxDispatches: number;
  private readonly deadlineAt: number | null;
  public readonly usage: WorkflowUsageLedger;

  public constructor(context: SpecialistContext, maxDispatches: number) {
    this.maxToolCalls = typeof context.policy.maxToolCalls === 'number' && context.policy.maxToolCalls > 0
      ? context.policy.maxToolCalls
      : Number.POSITIVE_INFINITY;
    this.maxCostUsd = typeof context.policy.maxCostUsd === 'number' && context.policy.maxCostUsd > 0
      ? context.policy.maxCostUsd
      : Number.POSITIVE_INFINITY;
    this.maxDispatches = maxDispatches;
    this.deadlineAt = context.deadlineAt ?? null;

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

  public canDispatch(count = 1): { allowed: boolean; reason?: string } {
    if (this.deadlineAt && Date.now() > this.deadlineAt) {
      return { allowed: false, reason: 'Execution deadline exceeded' };
    }
    if (this.usage.totalDispatches + count > this.maxDispatches) {
      return { allowed: false, reason: `Total dispatch ceiling (${this.maxDispatches}) reached` };
    }
    if (this.usage.totalToolCalls >= this.maxToolCalls) {
      return { allowed: false, reason: `Tool call budget ceiling (${this.maxToolCalls}) reached` };
    }
    if (this.usage.estimatedCostUsd >= this.maxCostUsd) {
      return { allowed: false, reason: `Cost budget ceiling ($${this.maxCostUsd}) reached` };
    }
    return { allowed: true };
  }

  public reserveToolCalls(count: number): { allowed: boolean; reason?: string } {
    if (this.usage.totalToolCalls + count > this.maxToolCalls) {
      return { allowed: false, reason: `Tool call reservation of ${count} exceeds limit (${this.maxToolCalls})` };
    }
    this.usage.totalToolCalls += count;
    return { allowed: true };
  }

  public recordUsage(specialist: string, usage?: SpecialistUsage | null, durationMs = 0): void {
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
    entry.durationMs += durationMs;

    if (usage) {
      entry.toolCalls += usage.toolCalls;
      entry.modelCalls += usage.modelCalls;
      entry.inputTokens += usage.inputTokens;
      entry.outputTokens += usage.outputTokens;
      entry.estimatedCostUsd += usage.estimatedCostUsd;

      // Tool calls reserved upfront are tracked; add unreserved difference
      if (specialist !== 'extraction') {
        this.usage.totalToolCalls += usage.toolCalls;
      }
      this.usage.totalModelCalls += usage.modelCalls;
      this.usage.totalInputTokens += usage.inputTokens;
      this.usage.totalOutputTokens += usage.outputTokens;
      this.usage.estimatedCostUsd += usage.estimatedCostUsd;
    }
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
    // 14-digit GTIN is strictly case-scoped; if caller did not specify 'case', reject from consumer unit
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

function isGenuineCssSelector(path: string | null | undefined): boolean {
  if (!path || typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed) return false;

  // Reject JSON path expressions (e.g. `[0].name`, `items[0]`, `product.name`, `/items/0`)
  if (/^\[\d+\]/.test(trimmed) || /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(trimmed) || trimmed.startsWith('/')) {
    return false;
  }

  // Accept CSS selector patterns: ID, class, tag, attribute selector, child combinator
  return trimmed.startsWith('#') ||
    trimmed.startsWith('.') ||
    /^h[1-6](\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[.*\])?/i.test(trimmed) ||
    /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[.*\])/.test(trimmed) ||
    trimmed.startsWith('[data-') ||
    trimmed.startsWith('[itemprop') ||
    trimmed.startsWith('[class') ||
    trimmed.includes(' > ') ||
    trimmed.includes(' ');
}

// ── Orchestrator Implementation ─────────────────────────────────────────────

export class SpecialistOrchestrator {
  private readonly maxRetries: number;
  private readonly limits: CapabilityLimits;
  private readonly extractionConcurrency: number;
  private readonly dependencies: SpecialistOrchestratorDependencies;
  private readonly now: () => string;

  public constructor(options: SpecialistOrchestratorOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.limits = { ...DEFAULT_CAPABILITY_LIMITS, ...options.limits };
    this.extractionConcurrency = Math.max(1, Math.min(8, options.extractionConcurrency ?? 3));
    this.dependencies = options.dependencies ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async getWorkflowState(runId: string): Promise<SpecialistWorkflowRecord | null> {
    const persistence = this.dependencies.workflowPersistence ?? resolveDefaultWorkflowPersistence();
    return persistence.get(runId);
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

    const budgetBroker = new WorkflowBudgetBroker(context, this.limits.maxTotalDispatches);

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

    const persistenceRepo: SpecialistWorkflowPersistenceRepository = this.dependencies.workflowPersistence
      ?? resolveDefaultWorkflowPersistence();

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
        await persistenceRepo.save({
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

    const reserveDispatch = (specialist: string, count = 1): boolean => {
      const check = budgetBroker.canDispatch(count);
      if (!check.allowed) {
        return false;
      }
      budgetBroker.usage.totalDispatches += count;
      if (!budgetBroker.usage.bySpecialist[specialist]) {
        budgetBroker.usage.bySpecialist[specialist] = {
          dispatches: 0,
          toolCalls: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          durationMs: 0,
        };
      }
      budgetBroker.usage.bySpecialist[specialist].dispatches += count;
      return true;
    };

    const reserveExtractionDispatch = (): boolean => {
      if (invocations.extraction >= this.limits.maxExtractionInvocations) {
        return false;
      }
      const toolRes = budgetBroker.reserveToolCalls(1);
      if (!toolRes.allowed) {
        return false;
      }
      if (!reserveDispatch('extraction', 1)) {
        // Rollback tool reservation if dispatch rejected
        budgetBroker.usage.totalToolCalls -= 1;
        return false;
      }
      invocations.extraction += 1;
      // Allocate capability invocation ID atomically with successful reservation
      capabilityInvocationIds.extraction.push(`inv:extraction:${invocations.extraction}`);
      return true;
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

      // Check pre-dispatch budget allowances
      const budgetCheck = budgetBroker.canDispatch(1);
      if (!budgetCheck.allowed) {
        recordEvent('orchestrator', 'budget_check', 'failed', 0, budgetCheck.reason);
        const state = await persistState('budget_exceeded', targetPhase, budgetCheck.reason);
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
          error: budgetCheck.reason,
        };
      }

      switch (targetPhase) {
        case 'discovery': {
          if (invocations.discovery >= this.limits.maxDiscoveryInvocations || !reserveDispatch('discovery', 1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Discovery invocation or total dispatch limit exceeded');
            const state = await persistState('budget_exceeded', 'discovery', 'Discovery invocation or dispatch limit reached');
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
              error: 'Discovery invocation or dispatch limit reached',
            };
          }

          invocations.discovery += 1;
          const invocationId = `inv:discovery:${invocations.discovery}`;
          capabilityInvocationIds.discovery.push(invocationId);

          const stepStart = Date.now();
          recordEvent('discovery', 'discover_candidates', 'started', 0);
          await persistState('in_progress', 'discovery');

          const discResult: SpecialistResult = await discovery.execute(
            {
              schemaVersion: 1,
              productSeed,
              discoveredGtin: canonicalIdentifier.gtin,
              batchContext: null,
              sourceCandidates: [],
            },
            context,
          );

          const discDuration = Date.now() - stepStart;
          budgetBroker.recordUsage('discovery', discResult.usage, discDuration);

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
            .map((c) => c.finalUrl ?? c.source.url);

          // Promote GTIN strictly from verified PDP candidate with consumer unit GTIN provenance
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
          const synthesizedDomainsInPhase = new Set<string>();
          const bundlesByUrl = new Map<string, ExtractionEvidenceBundle>();

          // Bounded parallel extraction
          extractionBundles = await boundedMap(
            candidateUrls,
            this.extractionConcurrency,
            async (url) => {
              if (!reserveExtractionDispatch()) {
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

              let bundle: ExtractionEvidenceBundle;
              if (this.dependencies.extractionRunner) {
                bundle = await this.dependencies.extractionRunner(url, context, null);
              } else {
                const { bundle: detBundle } = await runDeterministicExtraction(
                  {
                    url,
                    expected: {
                      gtin: effectiveExtractionGtin ?? undefined,
                      name: productSeed.name,
                    },
                    signal: context.signal,
                  },
                  this.dependencies.extractionRunnerOptions ?? { now: this.now },
                );
                bundle = detBundle;
              }

              budgetBroker.recordUsage('extraction', {
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

          // After extraction bundles are keyed by URL, check if profile synthesis is needed
          for (const bundle of extractionBundles) {
            const url = bundle.finalUrl ?? bundle.requestedUrl;
            const domain = (() => {
              try { return new URL(url).hostname; } catch { return 'unknown'; }
            })();

            const needsProfile = bundle.failures.some((f) => f.code === 'profile_failed' || f.code === 'profile_missing');
            if (needsProfile && !synthesizedDomainsInPhase.has(domain) && invocations.profile < this.limits.maxProfileInvocations) {
              synthesizedDomainsInPhase.add(domain);

              const domainCandidates = candidates.filter((c: DiscoveryCandidate) => {
                try {
                  const cUrl = c.finalUrl ?? c.source.url;
                  return new URL(cUrl).hostname === domain;
                } catch {
                  return false;
                }
              });

              if (domainCandidates.length >= 2) {
                const sample1 = domainCandidates[0];
                const sample2 = domainCandidates[1];
                const sample1Url = sample1.finalUrl ?? sample1.source.url;
                const sample2Url = sample2.finalUrl ?? sample2.source.url;

                const bundle1 = bundlesByUrl.get(sample1Url) ?? bundlesByUrl.get(sample1.source.url);
                const bundle2 = bundlesByUrl.get(sample2Url) ?? bundlesByUrl.get(sample2.source.url);

                const sample1Artifacts = [...new Set(sample1.extracted.identifiers
                  .map((i) => i.sourceArtifactId)
                  .concat(bundle1?.artifactRefs ?? [])
                  .filter((id) => Boolean(id)))];
                const sample2Artifacts = [...new Set(sample2.extracted.identifiers
                  .map((i) => i.sourceArtifactId)
                  .concat(bundle2?.artifactRefs ?? [])
                  .filter((id) => Boolean(id)))];

                // Genuine title selector candidate hints (derived strictly from that page's own extraction observations)
                const sample1TitleHint = bundle1?.observations.find((o) => (o.field === 'title' || o.field === 'product_name') && isGenuineCssSelector(o.sourcePath))?.sourcePath ?? null;
                const sample2TitleHint = bundle2?.observations.find((o) => (o.field === 'title' || o.field === 'product_name') && isGenuineCssSelector(o.sourcePath))?.sourcePath ?? null;

                const hasRealEvidence = sample1Artifacts.length > 0 && sample2Artifacts.length > 0;

                if (hasRealEvidence && reserveDispatch('profile_engineer', 1)) {
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

                  const profResult = await profileEngineer.execute(
                    {
                      schemaVersion: 1,
                      domain,
                      activeProfile: null,
                      samples: [
                        {
                          url: sample1Url,
                          artifactRefs: sample1Artifacts,
                          expectedName: sample1.extracted.productName ?? productSeed.name,
                          expectedGtin: sample1.extracted.gtins[0] ?? effectiveExtractionGtin ?? undefined,
                          signals: {
                            jsonLd: sample1.extracted.identifiers.some((i) => i.method === 'json_ld'),
                            shopify: sample1.signals.some((s) => s.value.toLowerCase().includes('shopify')),
                            woocommerce: sample1.signals.some((s) => s.value.toLowerCase().includes('woocommerce')),
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
                            jsonLd: sample2.extracted.identifiers.some((i) => i.method === 'json_ld'),
                            shopify: sample2.signals.some((s) => s.value.toLowerCase().includes('shopify')),
                            woocommerce: sample2.signals.some((s) => s.value.toLowerCase().includes('woocommerce')),
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
                    context,
                  );

                  budgetBroker.recordUsage('profile_engineer', profResult.usage, 0);

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
              'Holding workflow for manual review and activation of proposed profile in Profile Builder',
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
          if (invocations.resolver >= this.limits.maxResolverInvocations || !reserveDispatch('resolver', 1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Resolver invocation or total dispatch limit exceeded');
            const state = await persistState('budget_exceeded', 'resolver', 'Resolver invocation or dispatch limit reached');
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
              error: 'Resolver invocation or dispatch limit reached',
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
            context,
          );

          const resDuration = Date.now() - stepStart;
          budgetBroker.recordUsage('resolver', resResult.usage, resDuration);

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
          if (invocations.curator >= this.limits.maxCuratorInvocations || !reserveDispatch('curator', 1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Curator invocation or total dispatch limit exceeded');
            const state = await persistState('budget_exceeded', 'curator', 'Curator invocation or dispatch limit reached');
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
              error: 'Curator invocation or dispatch limit reached',
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

          const curResult: SpecialistResult = await curator.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              classificationContext,
            },
            context,
          );

          const curDuration = Date.now() - stepStart;
          budgetBroker.recordUsage('curator', curResult.usage, curDuration);

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
          if (invocations.verifier >= this.limits.maxVerifierInvocations || !reserveDispatch('verifier', 1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Verifier invocation or total dispatch limit exceeded');
            const state = await persistState('budget_exceeded', 'verifier', 'Verifier invocation or dispatch limit reached');
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
              error: 'Verifier invocation or dispatch limit reached',
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

          const verResult: SpecialistResult = await verifier.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              curatedDraft: curatorOutput,
              classificationContext,
              extractionBundles,
            },
            context,
          );

          const verDuration = Date.now() - stepStart;
          budgetBroker.recordUsage('verifier', verResult.usage, verDuration);

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
