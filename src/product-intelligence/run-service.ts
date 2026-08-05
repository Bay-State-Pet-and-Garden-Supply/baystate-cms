/**
 * Product Intelligence run service (PI-2).
 *
 * Orchestrates durable runs: creates the run row with immutable input and
 * policy snapshot, executes through a ProductIntelligenceExecutor, persists
 * every normalized event (idempotent by (run_id, sequence)) plus derived
 * steps and tool calls, stores the validated submission's sources, evidence,
 * and conflicts, writes the result with a schema version and content hash,
 * and transitions the run to exactly one terminal status.
 *
 * Also provides the replay cursor for SSE reconnects, live event fan-out,
 * run cancellation (caller AbortSignal), comparisons against a baseline,
 * and the explicit retention policy.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/19
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ProductIntelligencePolicySchema,
  ProductResearchInputSchema,
  type StructuredSubmission,
  type TerminalResultSubmission,
  type ProductIntelligenceExecutionEvent,
  type ProductIntelligencePolicy,
  type ProductResearchContext,
  type ProductResearchInput,
  type ProductResearchResult,
} from './contracts';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from './executor';
import { getCurrentWorkspace } from '../server/services/workspace-service';
import { getDb } from '../db/connection';
import {
  appendPiEvent,
  completePiStep,
  completePiToolCall,
  countPiRuns,
  createPiRun,
  deletePiRun,
  deletePiRunsOlderThan,
  getPiResult,
  getPiRun,
  insertPiComparison,
  insertPiConflict,
  insertPiEvidence,
  insertPiResult,
  insertPiSource,
  insertPiStep,
  insertPiToolCall,
  latestPiEventSequence,
  listPiComparisons,
  listPiConflicts,
  listPiEvents,
  listPiEvidence,
  listPiRuns,
  listPiSources,
  listPiToolCalls,
  transitionPiRunStatus,
  type PiComparisonRow,
  type PiConflictRow,
  type PiEvidenceRow,
  type PiResultRow,
  type PiRunRow,
  type PiSourceRow,
  type PiToolCallRow,
} from '../db/repositories/product-intelligence-repo';
import { sha256Hex } from '../shared/stable-id';
import { verifyPolicySnapshot } from './policy';
import { buildResearchPrompt } from './pi/pi-prompt-builder';
import { DEFAULT_RESEARCH_TOOL_NAMES } from './tools';
import { isWorkflowSubmission, validateTerminalSubmission } from './workflow/bundle-validator';

export const PI_RESULT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Default immutable policy
// ---------------------------------------------------------------------------

/**
 * Default fail-closed policy: read-only built-in tools, the full bounded
 * research-tool set (PI-3 — all adapters are read-only and policy-gated),
 * local-only network and data sharing, no model route (Pi refuses to run
 * until an operator configures one), 5-minute deadline. `configId` is the
 * SHA-256 of the policy's own canonical JSON, so the default is immutable
 * and reproducible.
 */
export function buildDefaultPiPolicy(): ProductIntelligencePolicy {
  const policy = ProductIntelligencePolicySchema.parse({
    configId: 'pending',
    // Worker isolation: no host-file tools by default (PI-5). Research tools
    // are the only surface the worker needs; the workspace stays unreadable.
    allowedTools: [],
    researchTools: [...DEFAULT_RESEARCH_TOOL_NAMES],
    // Network fetches are allowed but always pass the policy gateway (SSRF
    // floor, protocol/port validation, size limits). Model calls stay denied
    // until an operator configures a model route + data-sharing policy.
    networkPolicy: 'allowlisted_remote',
    dataSharingPolicy: 'local_only',
    modelRoute: null,
    maxToolCalls: 100,
    maxCostUsd: null,
    deadlineMs: 300_000,
  });
  const configId = sha256Hex(JSON.stringify(policy));
  return { ...policy, configId };
}

// ---------------------------------------------------------------------------
// Live event bus (in-memory fan-out for SSE; DB is the durable replay source)
// ---------------------------------------------------------------------------

export interface PiLiveEvent {
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export class RunEventBus {
  private readonly subscribers = new Map<string, Set<(event: PiLiveEvent) => void>>();

  subscribe(runId: string, listener: (event: PiLiveEvent) => void): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.subscribers.delete(runId);
    };
  }

  publish(event: PiLiveEvent): void {
    this.subscribers.get(event.runId)?.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // A listener must never break the run.
      }
    });
  }

  subscriberCount(runId: string): number {
    return this.subscribers.get(runId)?.size ?? 0;
  }
}

export const globalRunEventBus = new RunEventBus();

// ---------------------------------------------------------------------------
// Persisting event sink
// ---------------------------------------------------------------------------

/**
 * ExecutionEventSink that persists every normalized event (idempotent by
 * (run_id, sequence)), derives steps and tool-call rows, and fans events out
 * to the live bus. The sink owns the per-run sequence counter — domain
 * events emitted through it can never collide with executor events.
 */
export class PersistingExecutionEventSink implements ExecutionEventSink {
  readonly runId: string;
  private readonly events: ProductIntelligenceExecutionEvent[] = [];
  private sequence = 0;
  private openStepId: string | null = null;
  private readonly openToolCalls = new Map<string, string>();

  constructor(
    runId: string,
    private readonly bus: RunEventBus = globalRunEventBus,
  ) {
    this.runId = runId;
  }

  emit(
    type: ProductIntelligenceExecutionEvent['type'],
    fields: Omit<Partial<ProductIntelligenceExecutionEvent>, 'type' | 'runId' | 'sequence' | 'timestamp'> = {},
  ): void {
    this.append(type, {
      message: fields.message,
      toolName: fields.toolName,
      isError: fields.isError,
      data: fields.data,
    });
  }

  /**
   * Emit a domain event (source.added, run.completed, ...) through the same
   * sequence space so the stream is totally ordered and idempotent.
   */
  emitDomain(type: string, payload: unknown): void {
    this.append(type, payload);
  }

  private append(type: string, payload: unknown): void {
    const event: ProductIntelligenceExecutionEvent = {
      type: type as ProductIntelligenceExecutionEvent['type'],
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      ...(typeof payload === 'object' && payload !== null ? (payload as object) : {}),
    };
    this.events.push(event);
    appendPiEvent(this.runId, event.sequence, event.type, payload);
    this.deriveRows(event, payload);
    this.bus.publish({
      runId: this.runId,
      sequence: event.sequence,
      type: event.type,
      payload,
      createdAt: event.timestamp,
    });
  }

  /** Derive steps and tool calls from normalized events. */
  private deriveRows(event: ProductIntelligenceExecutionEvent, payload: unknown): void {
    const data = (payload as { data?: unknown })?.data as { piVersion?: string; tools?: string[] } | undefined;
    switch (event.type) {
      case 'session_created': {
        const step = insertPiStep({
          runId: this.runId,
          stepType: 'session',
          sequence: event.sequence,
          summary: `Pi session created (pi ${data?.piVersion ?? 'unknown'})`,
          inputHash: null,
        });
        this.openStepId = step.id;
        break;
      }
      case 'agent_finished': {
        if (this.openStepId) {
          completePiStep(this.openStepId, { summary: 'Agent finished researching' });
          this.openStepId = null;
        }
        break;
      }
      case 'submission_received': {
        const step = insertPiStep({
          runId: this.runId,
          stepType: 'submission',
          sequence: event.sequence,
          summary: 'Terminal submission received',
        });
        completePiStep(step.id, {});
        break;
      }
      case 'tool_call_started': {
        const call = insertPiToolCall({
          runId: this.runId,
          stepId: this.openStepId,
          sequence: event.sequence,
          toolName: event.toolName ?? 'unknown',
          requestHash: null,
        });
        this.openToolCalls.set(String(event.sequence), call.id);
        break;
      }
      case 'tool_call_finished': {
        const callId = this.openToolCalls.get(String(event.sequence));
        if (!callId) {
          // Defensive fallback for sequence drift (e.g. a dropped or replayed
          // event): close the most recently opened still-open call. Maps keep
          // insertion order, so the last value is the newest.
          const last = [...this.openToolCalls.values()].at(-1);
          if (last) {
            completePiToolCall(last, { isError: event.isError ?? false });
            this.openToolCalls.delete(last);
          }
          break;
        }
        completePiToolCall(callId, { isError: event.isError ?? false });
        this.openToolCalls.delete(callId);
        break;
      }
      default:
        break;
    }
  }

  snapshot(): ProductIntelligenceExecutionEvent[] {
    return this.events.slice();
  }
}

// ---------------------------------------------------------------------------
// Domain event mapping for the SSE stream
// ---------------------------------------------------------------------------

const DOMAIN_EVENT_MAP: Record<string, string> = {
  run_started: 'run.started',
  session_created: 'step.started',
  agent_finished: 'step.completed',
  tool_call_started: 'tool.started',
  tool_call_finished: 'tool.completed',
  submission_received: 'result.updated',
  run_completed: 'run.completed',
  run_failed: 'run.failed',
  run_cancelled: 'run.cancelled',
  run_timeout: 'run.failed',
};

export function mapDomainEventType(type: string): string {
  return DOMAIN_EVENT_MAP[type] ?? type;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface StartPiRunInput {
  input: ProductResearchInput;
  /** Execution mode; 'onboarding' is rejected unless the flag allows it. */
  mode?: 'shadow' | 'interactive' | 'onboarding';
  policy?: ProductIntelligencePolicy;
  onboardingItemId?: string | null;
}

export interface StartPiRunResult {
  run: PiRunRow;
  /** Resolves when the run reaches a terminal state. */
  completed: Promise<ProductResearchResult>;
}

const activeControllers = new Map<string, AbortController>();

/** Cancel a running run by aborting its caller signal. */
export function cancelPiRun(id: string): boolean {
  const controller = activeControllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Best-effort CMS code commit (git HEAD of this repository). */
export function captureCodeCommit(): string | null {
  try {
    const headPath = path.join(process.cwd(), '.git', 'HEAD');
    const head = readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref:')) {
      const refPath = path.join(process.cwd(), '.git', head.slice(5).trim());
      return readFileSync(refPath, 'utf8').trim().slice(0, 40);
    }
    return head.slice(0, 40);
  } catch {
    return null;
  }
}

/**
 * Start a Product Intelligence run: create the durable row, execute through
 * the executor with a persisting sink, store the result and submission
 * artifacts, and transition to exactly one terminal status.
 */
export async function startProductIntelligenceRun(
  executor: ProductIntelligenceExecutor,
  input: StartPiRunInput,
  options: { workspaceId?: string; workspacePath?: string; bus?: RunEventBus } = {},
): Promise<StartPiRunResult> {
  const parsedInput = ProductResearchInputSchema.parse(input.input);
  const policy = ProductIntelligencePolicySchema.parse(input.policy ?? buildDefaultPiPolicy());
  const mode = input.mode ?? 'shadow';

  const workspace = options.workspaceId && options.workspacePath
    ? { id: options.workspaceId, path: options.workspacePath }
    : (() => {
        const ws = getCurrentWorkspace();
        return ws ? { id: ws.id, path: ws.workspacePath } : null;
      })();
  if (!workspace) {
    throw new Error('No active workspace; cannot start a Product Intelligence run');
  }
  const workspaceRow = getDb().query('SELECT id FROM workspace WHERE id = ?').get(workspace.id) as { id: string } | undefined;
  if (!workspaceRow) {
    throw new Error(`Workspace not found: ${workspace.id}; cannot start a Product Intelligence run`);
  }

  const bus = options.bus ?? globalRunEventBus;
  const controller = new AbortController();

  // Immutable snapshot verification: the configId must match the policy
  // content, or the run refuses to start (PI-5).
  const snapshot = verifyPolicySnapshot(policy);
  if (!snapshot.valid) {
    throw new Error(`Refusing to start run: ${snapshot.reason}`);
  }

  // Prompt/algorithm version captured with the run snapshot.
  const promptHash = buildResearchPrompt(parsedInput, {
    runId: 'pending',
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    policy,
    executionMode: mode,
    existingEvidenceRefs: [],
  }).promptHash;

  const run = createPiRun({
    workspaceId: workspace.id,
    onboardingItemId: input.onboardingItemId ?? null,
    mode,
    executor: executor.name,
    inputJson: JSON.stringify(parsedInput),
    policyJson: JSON.stringify(policy),
    configSnapshotId: policy.configId,
    configSnapshotHash: policy.configId,
    promptHash,
    codeCommit: captureCodeCommit(),
  });
  activeControllers.set(run.id, controller);

  const context: ProductResearchContext = {
    runId: run.id,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    policy,
    executionMode: mode,
    existingEvidenceRefs: [],
    signal: controller.signal,
  };

  const sink = new PersistingExecutionEventSink(run.id, bus);
  // run.started / terminal events are emitted by the executor itself (PI-1
  // contract); the service only emits additive domain events (needs_review,
  // source.added, ...) and the failure event for executor throws.

  const completed = (async () => {
    let result: ProductResearchResult;
    try {
      result = await executor.startResearch(parsedInput, context, sink);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transitionPiRunStatus(run.id, 'failed', { errorCode: 'unknown', errorMessage: message });
      sink.emitDomain('run.failed', { code: 'unknown', message });
      throw error;
    } finally {
      activeControllers.delete(run.id);
    }

    switch (result.outcome) {
      case 'submitted':
      case 'abstained': {
        // Deterministic CMS-side gate: the bundle must satisfy the workflow
        // rules (evidence on facts, blocked identities, taxonomy ids, image
        // rights, conflict dispositions). Invalid bundles fail the run.
        const validation = isWorkflowSubmission(result.submission)
          ? validateTerminalSubmission(result.submission, parsedInput.gtin, workspace.id)
          : { valid: true, issues: [] as string[] };
        if (!validation.valid) {
          const message = `Terminal submission failed validation: ${validation.issues.join('; ')}`;
          transitionPiRunStatus(run.id, 'failed', { errorCode: 'validation_error', errorMessage: message });
          sink.emitDomain('run.failed', { code: 'validation_error', message });
          return result;
        }
        persistSubmissionArtifacts(run.id, result, sink);
        // Disposition derives from the submission shape (deterministic):
        // bundles submit; abstentions and identity-conflict submissions abstain.
        const disposition = submissionDisposition(result.submission!);
        insertPiResult({ runId: run.id, schemaVersion: PI_RESULT_SCHEMA_VERSION, disposition, result });
        const needsReview = submissionNeedsReview(result);
        if (needsReview) {
          sink.emitDomain('run.needs_review', { reasons: reviewReasons(result) });
        }
        transitionPiRunStatus(run.id, 'completed', {
          completedAt: new Date().toISOString(),
          piVersion: result.piVersion,
        });
        break;
      }
      case 'unavailable': {
        insertPiResult({
          runId: run.id,
          schemaVersion: PI_RESULT_SCHEMA_VERSION,
          disposition: 'unavailable',
          result,
        });
        transitionPiRunStatus(run.id, 'completed', { completedAt: new Date().toISOString() });
        break;
      }
      case 'cancelled': {
        transitionPiRunStatus(run.id, 'cancelled', { cancelledAt: new Date().toISOString() });
        break;
      }
      case 'failed': {
        const code = result.failure?.code ?? 'unknown';
        const message = result.failure?.message ?? 'Run failed';
        transitionPiRunStatus(run.id, 'failed', { errorCode: code, errorMessage: message });
        break;
      }
      case 'timed_out': {
        const message = result.failure?.message ?? 'Hard deadline exceeded';
        transitionPiRunStatus(run.id, 'failed', { errorCode: 'deadline_exceeded', errorMessage: message });
        break;
      }
    }
    return result;
  })();

  return { run, completed };
}

/**
 * Persist the submission's sources, evidence, and conflicts into the
 * normalized tables and announce them on the stream. The submission's own
 * ids remain durably preserved in the result JSON; normalized rows link back
 * through metadata.
 */
function persistSubmissionArtifacts(
  runId: string,
  result: ProductResearchResult,
  sink: PersistingExecutionEventSink,
): void {
  const submission = result.submission;
  if (!submission) return;

  // PI-1 envelope: sources + evidence + conflicts rows.
  if ('evidenceSources' in submission) {
    persistPi1Artifacts(runId, submission, sink);
    return;
  }

  // PI-4 workflow submissions: persist conflicts (tool evidence stays in the
  // tool-call records and the result JSON; the bundle cites tool evidence ids).
  if ('disposition' in submission) {
    for (const conflict of submission.conflicts) {
      persistConflict(runId, conflict.field, conflict.severity === 'blocking' ? 'high' : conflict.severity, conflict.evidenceIds, sink);
    }
    return;
  }
  if ('recommendedDisposition' in submission) {
    for (const conflict of submission.conflicts) {
      persistConflict(runId, conflict.field, conflict.severity === 'blocking' ? 'high' : conflict.severity, conflict.evidenceIds, sink);
    }
    return;
  }
  // submit_insufficient_evidence: nothing to persist beyond the result JSON.
}

function persistPi1Artifacts(runId: string, submission: StructuredSubmission, sink: PersistingExecutionEventSink): void {
  const sourceIdMap = new Map<string, string>();
  for (const source of submission.evidenceSources) {
    const row = insertPiSource({
      runId,
      url: source.url,
      domain: source.domain,
      sourceType: source.kind,
      gtinMatchStatus: submission.identity.gtinMatch === 'exact' ? 'exact' : 'unknown',
      variantMatchStatus: 'unknown',
      retrievedAt: source.accessedAt,
    });
    sourceIdMap.set(source.id, row.id);
    sink.emitDomain('source.added', { sourceId: row.id, url: source.url, domain: source.domain });
  }

  for (const item of submission.evidenceItems) {
    const sourceId = item.sourceIds.map((id) => sourceIdMap.get(id)).find(Boolean);
    if (!sourceId) continue; // evidence without a durable source is not persisted
    const row = insertPiEvidence({
      runId,
      sourceId,
      targetField: item.field,
      value: item.value,
      snippet: item.quote ?? null,
      directSupport: true,
      metadata: { submissionEvidenceId: item.id },
    });
    sink.emitDomain('evidence.added', { evidenceId: row.id, field: item.field });
  }

  for (const conflict of submission.conflicts) {
    persistConflict(runId, conflict.category, conflict.severity, conflict.evidenceIds, sink, {
      resolution: conflict.resolutionProposal ? { proposal: conflict.resolutionProposal } : undefined,
    });
  }
}

function persistConflict(
  runId: string,
  field: string,
  severity: 'low' | 'medium' | 'high',
  evidenceIds: string[],
  sink: PersistingExecutionEventSink,
  extra: { resolution?: unknown } = {},
): void {
  const row = insertPiConflict({
    runId,
    field,
    severity,
    evidenceIds,
    resolution: extra.resolution,
  });
  sink.emitDomain('conflict.detected', {
    conflictId: row.id,
    field,
    severity,
  });
}

function submissionDisposition(submission: TerminalResultSubmission): 'submitted' | 'abstained' {
  if ('evidenceSources' in submission) return submission.abstention ? 'abstained' : 'submitted';
  if ('disposition' in submission) return 'submitted';
  return 'abstained';
}

function submissionNeedsReview(result: ProductResearchResult): boolean {
  const submission = result.submission;
  if (!submission) return false;
  if ('evidenceSources' in submission) {
    if (submission.identity.gtinMatch !== 'exact') return true;
    if (submission.conflicts.some((conflict) => conflict.severity === 'high')) return true;
    return submission.images.some((image) => image.identityMatch === 'unknown' || image.rightsStatus === 'unknown');
  }
  if ('disposition' in submission) {
    if (submission.identity.status !== 'exact_match') return true;
    if (submission.conflicts.some((conflict) => conflict.severity === 'blocking')) return true;
    return submission.imageCandidates.some((image) => image.rightsStatus === 'unknown' || !image.exactProductMatch);
  }
  if ('recommendedDisposition' in submission) return true; // identity-conflict submission
  return false; // insufficient-evidence abstention
}

function reviewReasons(result: ProductResearchResult): string[] {
  const reasons: string[] = [];
  const submission = result.submission;
  if (!submission) return reasons;
  if ('evidenceSources' in submission) {
    if (submission.identity.gtinMatch !== 'exact') reasons.push(`identity.gtinMatch is '${submission.identity.gtinMatch}'`);
    if (submission.conflicts.some((conflict) => conflict.severity === 'high')) reasons.push('high-severity conflicts present');
    if (submission.images.some((image) => image.identityMatch === 'unknown' || image.rightsStatus === 'unknown')) {
      reasons.push('image identity or rights status unknown');
    }
    return reasons;
  }
  if ('disposition' in submission) {
    if (submission.identity.status !== 'exact_match') reasons.push(`identity.status is '${submission.identity.status}'`);
    if (submission.conflicts.some((conflict) => conflict.severity === 'blocking')) reasons.push('blocking conflicts present');
    if (submission.imageCandidates.some((image) => image.rightsStatus === 'unknown' || !image.exactProductMatch)) {
      reasons.push('image rights or exact-product match unknown');
    }
    return reasons;
  }
  if ('recommendedDisposition' in submission) reasons.push('identity-conflict submission');
  return reasons;
}

// ---------------------------------------------------------------------------
// Projection, replay, comparisons, retention
// ---------------------------------------------------------------------------

export interface PiStepView {
  id: string;
  runId: string;
  stepType: string;
  sequence: number;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  inputHash: string | null;
  outputRef: string | null;
  startedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export interface PiRunProjection {
  run: PiRunRow;
  steps: PiStepView[];
  toolCalls: PiToolCallRow[];
  sources: PiSourceRow[];
  evidence: PiEvidenceRow[];
  conflicts: PiConflictRow[];
  result: PiResultRow | null;
  comparisons: PiComparisonRow[];
  eventCount: number;
}

/** Full normalized projection — the frontend renders from these rows only. */
export function getPiRunProjection(id: string): PiRunProjection | null {
  const run = getPiRun(id);
  if (!run) return null;
  return {
    run,
    steps: listPiSteps(run.id),
    toolCalls: listPiToolCalls(run.id),
    sources: listPiSources(run.id),
    evidence: listPiEvidence(run.id),
    conflicts: listPiConflicts(run.id),
    result: getPiResult(run.id) ?? null,
    comparisons: listPiComparisons(run.id),
    eventCount: latestPiEventSequence(run.id) + 1,
  };
}

function listPiSteps(runId: string): PiStepView[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, run_id AS runId, step_type AS stepType, sequence, status, summary,
              input_hash AS inputHash, output_ref AS outputRef,
              started_at AS startedAt, completed_at AS completedAt, error_json AS errorJson
       FROM product_intelligence_steps WHERE run_id = ? ORDER BY sequence ASC`,
    )
    .all(runId) as PiStepView[];
}

/** Events after a cursor — the SSE reconnect replay source. */
export function replayPiEvents(runId: string, afterSequence = -1): PiLiveEvent[] {
  return listPiEvents(runId, afterSequence).map((row) => ({
    runId: row.runId,
    sequence: row.sequence,
    type: mapDomainEventType(row.type),
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt,
  }));
}

export function createPiComparison(input: {
  runId: string;
  baselineType: 'legacy' | 'classification_run' | 'manual';
  baselineRef: string;
}): unknown {
  const run = getPiRun(input.runId);
  if (!run) throw new Error(`Product intelligence run not found: ${input.runId}`);
  const result = getPiResult(input.runId);
  const terminalAt = run.completedAt ?? run.cancelledAt;
  const metrics = {
    executor: run.executor,
    outcome: run.status === 'completed' ? (result ? result.disposition : 'completed') : run.status,
    durationMs: terminalAt ? Math.max(0, Date.parse(terminalAt) - Date.parse(run.startedAt)) : null,
    fieldCount: result ? countFields(result) : 0,
    conflictCount: listPiConflicts(input.runId).length,
    sourceCount: listPiSources(input.runId).length,
    imageCount: 0,
    abstained: result?.disposition === 'abstained',
    errorCode: run.errorCode,
  };
  return insertPiComparison({
    runId: input.runId,
    baselineType: input.baselineType,
    baselineRef: input.baselineRef,
    metrics,
  });
}

function countFields(result: { resultJson: string }): number {
  try {
    const parsed = JSON.parse(result.resultJson) as ProductResearchResult;
    const submission = parsed.submission;
    if (!submission) return 0;
    if ('evidenceSources' in submission) return submission.productProposal.fields.length;
    if ('disposition' in submission) return submission.commerceFacts.length;
    return 0;
  } catch {
    return 0;
  }
}

/** Explicit retention: delete terminal runs older than N days. */
export function runRetentionCleanup(workspaceId: string, olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  return deletePiRunsOlderThan(workspaceId, cutoff);
}

export { createPiRun, countPiRuns, deletePiRun, getPiRun, listPiRuns };
export type { PiRunRow };
