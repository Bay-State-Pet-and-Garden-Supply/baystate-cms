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
import { createRequire } from 'node:module';
import {
  PI_EXECUTOR_NAME,
  ProductIntelligencePolicySchema,
  ProductResearchInputSchema,
  isLegacyTerminalSubmission,
  type HistoricalTerminalSubmission,
  type StructuredSubmission,
  type ProductIntelligenceExecutionEvent,
  type ProductIntelligencePolicy,
  type ProductResearchContext,
  type ProductResearchInput,
  type ProductResearchResult,
} from './contracts';
import type { ExecutionEventSink, ProductIntelligenceExecutor } from './executor';
import type { ProductAssetEvidence } from './assets/schema';
import type { PiAssetRow } from '../db/repositories/product-intelligence-repo';
import { getCurrentWorkspace } from '../server/services/workspace-service';
import { getDb } from '../db/connection';
import { checkPiRunStartBudget, checkPiStorageBudget } from './budgets';
import { PolicyDeniedError } from './policy';
import {
  appendPiEvent,
  completePiStep,
  completePiToolCall,
  countPiRuns,
  createPiRun,
  deletePiRun,
  deletePiRunsOlderThan,
  getPiAssetsByIds,
  getPiResult,
  getPiRun,
  insertPiAsset,
  insertPiComparison,
  insertPiConflict,
  insertPiEvidence,
  insertPiResult,
  insertPiSource,
  insertPiStep,
  insertPiToolCall,
  latestPiEventSequence,
  listPiAssetsByRun,
  listPiComparisons,
  listPiConflicts,
  listPiEvents,
  listPiEvidence,
  listPiEvidenceByToolEvidenceId,
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
import { verifyPolicySnapshot, assertReducingOverride, computePolicyConfigId } from './policy';
import { buildResearchPrompt } from './pi/pi-prompt-builder';
import { DEFAULT_RESEARCH_TOOL_NAMES } from './tools';
import { isWorkflowSubmission, validateTerminalSubmission } from './workflow/bundle-validator';
import type { BundleImageCandidate } from './workflow/bundle';

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
/** Evidence as relayed on tool_call_finished events (subset of the schema). */
export interface ToolEvidenceEvent {
  id: string;
  kind?: string | null;
  url?: string | null;
  domain?: string | null;
  method?: string | null;
  snippet?: string | null;
  contentHash?: string | null;
  /** P1-4 field-level entries: extracted field name + value + source path. */
  field?: string | null;
  value?: string | null;
  path?: string | null;
}

/**
 * Smoke finding A: persist tool-result evidence durably at tool completion.
 * Each evidence entry gets a source row (deduped by url per run) so evidence
 * never dangles, and an evidence row keyed by the deterministic tool evidence
 * id (metadata.toolEvidenceId) so terminal submissions can cite it.
 */
export function persistToolEvidence(
  runId: string,
  evidence: ToolEvidenceEvent[],
  emit: (type: string, payload: Record<string, unknown>) => void,
): void {
  const existingSources = listPiSources(runId);
  const alreadyPersisted = new Set(
    listPiEvidenceByToolEvidenceId(runId, evidence.map((entry) => entry.id)).map(
      (row) => (JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string }).toolEvidenceId,
    ),
  );
  for (const entry of evidence) {
    if (alreadyPersisted.has(entry.id)) continue;
    if (!entry.url) {
      // No source URL -> no durable source row; the evidence cannot dangle.
      continue;
    }
    let source = existingSources.find((candidate) => candidate.url === entry.url);
    if (!source) {
      source = insertPiSource({
        runId,
        url: entry.url,
        domain: entry.domain ?? domainOf(entry.url),
        sourceType: sourceTypeOfKind(entry.kind),
      });
      existingSources.push(source);
      emit('source.added', { url: entry.url, domain: entry.domain ?? domainOf(entry.url) });
    }
    // P1-4: field-level entries persist ONE row per extracted field carrying
    // the ACTUAL value, the extraction method, and the source path — so a
    // reviewer can reconstruct 'field = value supported by path' from the
    // persisted rows alone. Legacy page-level entries keep the coarse
    // { evidenceId, snippet } value and kind-based target field.
    const isFieldEntry = typeof entry.field === 'string' && entry.field.length > 0;
    insertPiEvidence({
      runId,
      sourceId: source.id,
      targetField: typeof entry.field === 'string' && entry.field.length > 0 ? entry.field : (entry.kind ?? 'tool_evidence'),
      value: isFieldEntry ? (entry.value ?? null) : { evidenceId: entry.id, snippet: entry.snippet ?? null },
      extractionMethod: entry.method ?? null,
      snippet: entry.snippet ?? null,
      metadata: isFieldEntry
        ? { toolEvidenceId: entry.id, path: entry.path ?? null, contentHash: entry.contentHash ?? null }
        : { toolEvidenceId: entry.id },
    });
    alreadyPersisted.add(entry.id);
  }
}

function sourceTypeOfKind(kind: string | null | undefined): string {
  switch (kind) {
    case 'official_evidence':
      return 'manufacturer';
    case 'supplier_evidence':
      return 'supplier';
    case 'retailer_corroboration':
      return 'retailer';
    case 'gtin_evidence':
    case 'search_lead':
      return 'registry';
    case 'catalog_evidence':
      return 'catalog';
    default:
      return 'other';
  }
}

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
      error: fields.error,
      evidence: fields.evidence,
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
        const errorJson = event.isError && event.error ? String(event.error).slice(0, 500) : undefined;
        const complete = (callId: string): void => {
          completePiToolCall(callId, { isError: event.isError ?? false, errorJson });
        };
        // Smoke finding A: persist tool-result evidence durably so the run
        // inspector is truthful even for failed/deadline runs.
        if (Array.isArray(event.evidence) && event.evidence.length > 0) {
          persistToolEvidence(this.runId, event.evidence as ToolEvidenceEvent[], (type, payload) => {
            this.emitDomain(type, payload);
          });
        }
        const callId = this.openToolCalls.get(String(event.sequence));
        if (!callId) {
          // Defensive fallback for sequence drift (e.g. a dropped or replayed
          // event): close the most recently opened still-open call. Maps keep
          // insertion order, so the last value is the newest.
          const last = [...this.openToolCalls.values()].at(-1);
          if (last) {
            complete(last);
            this.openToolCalls.delete(last);
          }
          break;
        }
        complete(callId);
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
  /** PI-10 replay lineage: set when this run is a same-configuration rerun. */
  originRunId?: string | null;
  /** Review finding 7: the approved-policy record this run's policy was
   *  derived from, and the reducing overrides applied. Persisted so a real
   *  rerun reauthorizes the BASE record (never the resolved configId, which
   *  has no approved-policy row when overrides were applied). */
  basePolicyId?: string | null;
  basePolicyVersion?: number | null;
  policyOverridesJson?: string | null;
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

  // PI-10: centralized workspace budgets (concurrent/daily runs, daily tokens,
  // daily cost). Enforced server-side before the run is created — the agent
  // prompt is never trusted with budget decisions.
  checkPiRunStartBudget(workspace.id);

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
    originRunId: input.originRunId ?? null,
    replayDepth: input.originRunId ? (getPiRun(input.originRunId)?.replayDepth ?? 0) + 1 : 0,
    // Review finding 7 + round-3 atomicity: the run row is BORN with its
    // approved-policy lineage (base record + reducing overrides) — no
    // post-insert UPDATE, so reruns reauthorize the base record rather than
    // a resolved configId that has no approved-policy row.
    basePolicyId: input.basePolicyId ?? null,
    basePolicyVersion: input.basePolicyVersion ?? null,
    policyOverridesJson: input.policyOverridesJson ?? null,
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
        // Review finding 6: the legacy PI-1 envelope is excluded from the
        // live result type; a submission that is not a workflow submission
        // is DENIED here (never { valid: true }) so no executor — fake or
        // otherwise — can skip PI-4 validation. Abstentions (null
        // submission) remain valid.
        const validation =
          result.submission === null
            ? { valid: true, issues: [] as string[] }
            : isWorkflowSubmission(result.submission)
              ? validateTerminalSubmission(result.submission, parsedInput.gtin, workspace.id)
              : { valid: false, issues: ['unsupported submission shape'] as string[] };
        if (!validation.valid) {
          const message = `Terminal submission failed validation: ${validation.issues.join('; ')}`;
          transitionPiRunStatus(run.id, 'failed', { errorCode: 'validation_error', errorMessage: message });
          sink.emitDomain('run.failed', { code: 'validation_error', message });
          return result;
        }
        // PI-10: artifact storage budget is enforced before any durable asset
        // rows are written, and fails the run cleanly (never leaves it stuck
        // in 'running').
        const submissionRun = getPiRun(run.id);
        if (submissionRun) {
          try {
            checkPiStorageBudget(submissionRun.workspaceId);
          } catch (storageError) {
            if (storageError instanceof PolicyDeniedError) {
              const message = `Terminal submission rejected: ${storageError.message}`;
              transitionPiRunStatus(run.id, 'failed', { errorCode: 'policy_denied', errorMessage: message });
              sink.emitDomain('run.failed', { code: 'policy_denied', message });
              return result;
            }
            throw storageError;
          }
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
          actualCost: result.modelCostUsd ?? undefined,
          estimatedCost: result.modelCostUsd ?? undefined,
          tokenUsageJson: result.tokenUsage
            ? JSON.stringify({
                input_tokens: result.tokenUsage.inputTokens,
                output_tokens: result.tokenUsage.outputTokens,
              })
            : undefined,
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
        transitionPiRunStatus(run.id, 'completed', {
          completedAt: new Date().toISOString(),
          actualCost: result.modelCostUsd ?? undefined,
          estimatedCost: result.modelCostUsd ?? undefined,
          tokenUsageJson: result.tokenUsage
            ? JSON.stringify({
                input_tokens: result.tokenUsage.inputTokens,
                output_tokens: result.tokenUsage.outputTokens,
              })
            : undefined,
        });
        break;
      }
      case 'cancelled': {
        // PI-10: usage accounting applies to every terminal outcome — a run
        // that burns model tokens then fails/cancels still counts against the
        // daily token/cost budgets (review finding PI-10-MINOR-5).
        transitionPiRunStatus(run.id, 'cancelled', {
          cancelledAt: new Date().toISOString(),
          actualCost: result.modelCostUsd ?? undefined,
          estimatedCost: result.modelCostUsd ?? undefined,
          tokenUsageJson: result.tokenUsage
            ? JSON.stringify({
                input_tokens: result.tokenUsage.inputTokens,
                output_tokens: result.tokenUsage.outputTokens,
              })
            : undefined,
        });
        break;
      }
      case 'failed': {
        const code = result.failure?.code ?? 'unknown';
        const message = result.failure?.message ?? 'Run failed';
        transitionPiRunStatus(run.id, 'failed', {
          errorCode: code,
          errorMessage: message,
          actualCost: result.modelCostUsd ?? undefined,
          estimatedCost: result.modelCostUsd ?? undefined,
          tokenUsageJson: result.tokenUsage
            ? JSON.stringify({
                input_tokens: result.tokenUsage.inputTokens,
                output_tokens: result.tokenUsage.outputTokens,
              })
            : undefined,
        });
        break;
      }
      case 'timed_out': {
        const message = result.failure?.message ?? 'Hard deadline exceeded';
        transitionPiRunStatus(run.id, 'failed', {
          errorCode: 'deadline_exceeded',
          errorMessage: message,
          actualCost: result.modelCostUsd ?? undefined,
          estimatedCost: result.modelCostUsd ?? undefined,
          tokenUsageJson: result.tokenUsage
            ? JSON.stringify({
                input_tokens: result.tokenUsage.inputTokens,
                output_tokens: result.tokenUsage.outputTokens,
              })
            : undefined,
        });
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

  // Historical PI-1 envelope: sources + evidence + conflicts rows (kept for
  // type correctness; the terminal gate denies legacy shapes before they
  // reach persistence, so this branch is unreachable for live runs).
  if (isLegacyTerminalSubmission(submission)) {
    persistPi1Artifacts(runId, submission, sink);
    return;
  }

  // PI-4 workflow submissions: persist image assets (PI-6) and conflicts.
  // Per-tool evidence rows are persisted at tool completion (smoke finding
  // A); this terminal JOIN verifies every identity-cited evidence id has a
  // durable row and reports gaps honestly without fabricating rows.
  if ('disposition' in submission) {
    persistBundleAssets(runId, submission, sink);
    for (const conflict of submission.conflicts) {
      persistConflict(runId, conflict.field, conflict.severity === 'blocking' ? 'high' : conflict.severity, conflict.evidenceIds, sink);
    }
    reconcileCitedEvidence(runId, submission, sink);
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

/** Smoke finding A (terminal half): ensure every evidence id the bundle
 *  cites on its identity resolves to a durable evidence row. Per-tool
 *  persistence already created the rows; this only reports gaps. Never
 *  fabricates an evidence row without a source. */
function reconcileCitedEvidence(
  runId: string,
  submission: { identity?: { evidenceIds?: string[] } },
  sink: PersistingExecutionEventSink,
): void {
  const cited = submission.identity?.evidenceIds ?? [];
  if (cited.length === 0) return;
  const persisted = new Set(
    listPiEvidenceByToolEvidenceId(runId, cited).map(
      (row: { metadataJson: string | null }) =>
        (JSON.parse(row.metadataJson ?? '{}') as { toolEvidenceId?: string }).toolEvidenceId,
    ),
  );
  for (const id of cited) {
    if (!persisted.has(id)) {
      sink.emitDomain('evidence.gap', {
        evidenceId: id,
        detail: 'cited on the submission but no durable evidence row (source URL missing at tool time)',
      });
    }
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

/**
 * Persist PI-4 bundle image candidates as durable asset records (PI-6). Each
 * candidate also gets a source row (license/terms refs carry the rights
 * provenance). These records are the durable image-evidence store; the
 * promotion consumer that reads approved records for Agent Lab imports is
 * wired in a later issue (draft promotion currently consumes no PI assets).
 * Candidates without a content hash (unverified alternates) stay only in the
 * result JSON — a durable asset record requires extracted provenance.
 */
function persistBundleAssets(
  runId: string,
  submission: { imageCandidates: BundleImageCandidate[] },
  sink: PersistingExecutionEventSink,
): void {
  // PI-10: artifact storage budget enforced centrally at the single durable
  // persistence point — the agent never decides storage limits itself. The
  // pending payload bytes are counted so a single candidate batch cannot
  // overshoot the cap (review finding PI-10-MINOR-4). Note: this is the
  // DB payload proxy — on-disk quarantined image files are not counted.
  const runRow = getPiRun(runId);
  if (runRow) {
    const pendingBytes = submission.imageCandidates
      .filter((candidate) => (candidate.originalContentHash ?? undefined) !== undefined)
      .reduce((sum, candidate) => sum + JSON.stringify(candidate).length, 0);
    checkPiStorageBudget(runRow.workspaceId, pendingBytes);
  }
  const existingSources = listPiSources(runId);
  for (const candidate of submission.imageCandidates) {
    // Round-3 (review finding 5): authority comes ONLY from durable
    // server-verified asset rows. A candidate whose verifiedAssetIds resolve
    // to nothing is dropped — agent-supplied identity/rights/commerce claims
    // are never written into durable asset rows.
    const verified = getPiAssetsByIds(candidate.verifiedAssetIds ?? []);
    if (verified.length === 0) {
      sink.emitDomain('asset.rejected', {
        url: candidate.url,
        reason: 'no durable server-verified asset resolves from the cited ids',
      });
      continue;
    }
    const v = verified[0];
    let source = existingSources.find((s) => s.id === v.sourceId) ?? existingSources.find((s) => s.url === v.sourceUrl);
    if (!source) {
      source = insertPiSource({
        runId,
        url: v.sourceUrl,
        domain: domainOf(v.sourceUrl),
        sourceType: v.sourceType,
        gtinMatchStatus: v.exactProductMatch ? 'exact' : 'unknown',
        variantMatchStatus: v.exactVariantMatch === 1 ? 'exact' : v.exactVariantMatch === 0 ? 'conflicting' : 'unknown',
        retrievedAt: v.retrievedAt ?? null,
        licenseRef: v.rightsEvidenceRef ?? null,
        termsRef: v.rightsBasis ?? null,
      });
      existingSources.push(source);
    }
    insertPiAsset({
      runId,
      sourceId: source.id,
      sourceUrl: v.sourceUrl,
      sourcePageUrl: v.sourcePageUrl ?? null,
      sourceType: v.sourceType,
      sourcePath: v.sourcePath ?? null,
      sourceArtifactId: v.sourceArtifactId ?? candidate.sourceArtifactId,
      extractionMethod: v.extractionMethod ?? 'manual',
      retrievedAt: v.retrievedAt ?? new Date().toISOString(),
      originalContentHash: v.originalContentHash,
      perceptualHash: v.perceptualHash ?? null,
      variantReference: v.variantReference ?? candidate.variantReference ?? null,
      rightsStatus: v.rightsStatus as 'approved' | 'restricted' | 'unknown',
      rightsBasis: v.rightsBasis ?? null,
      rightsEvidenceRef: v.rightsEvidenceRef ?? null,
      observedBrand: v.observedBrand ?? null,
      observedProductName: v.observedProductName ?? null,
      observedVariant: v.observedVariant ?? null,
      observedNetContent: parseObservedNetContent(v.observedNetContentJson),
      observedPackCount: v.observedPackCount ?? null,
      observedGtin: v.observedGtin ?? null,
      exactProductMatch: !!v.exactProductMatch,
      exactVariantMatch: v.exactVariantMatch === 1 ? true : v.exactVariantMatch === 0 ? false : null,
      qualityStatus: v.qualityStatus as 'usable' | 'low_quality' | 'invalid',
      commerceApproved: !!v.commerceApproved,
      conflicts: parseConflictsJson(v.conflictsJson),
      payload: candidate,
    });
    sink.emitDomain('asset.added', {
      sourceUrl: v.sourceUrl,
      rightsStatus: v.rightsStatus,
      commerceApproved: !!v.commerceApproved,
    });
  }
}

function parseConflictsJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function parseObservedNetContent(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Map a raw asset row back to the durable ProductAssetEvidence record
 * (parse JSON columns, convert 0/1 flags). The assets table is the canonical
 * image-evidence store — see src/product-intelligence/assets/schema.ts.
 */
export function assetEvidenceFromRow(row: PiAssetRow): ProductAssetEvidence {
  return {
    id: row.id,
    runId: row.runId,
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    sourcePageUrl: row.sourcePageUrl,
    sourceType: row.sourceType,
    sourcePath: row.sourcePath,
    sourceArtifactId: row.sourceArtifactId ?? '', // schema requires an artifact id; null rows predate the requirement
    extractionMethod: row.extractionMethod as ProductAssetEvidence['extractionMethod'],
    retrievedAt: row.retrievedAt,
    originalContentHash: row.originalContentHash,
    perceptualHash: row.perceptualHash,
    variantReference: row.variantReference,
    rightsStatus: row.rightsStatus as ProductAssetEvidence['rightsStatus'],
    rightsBasis: row.rightsBasis,
    rightsEvidenceRef: row.rightsEvidenceRef,
    observedBrand: row.observedBrand,
    observedProductName: row.observedProductName,
    observedVariant: row.observedVariant,
    observedNetContent: row.observedNetContentJson ? (JSON.parse(row.observedNetContentJson) as ProductAssetEvidence['observedNetContent']) : null,
    observedPackCount: row.observedPackCount,
    observedGtin: row.observedGtin,
    exactProductMatch: row.exactProductMatch === 1,
    exactVariantMatch: row.exactVariantMatch === null ? null : row.exactVariantMatch === 1,
    qualityStatus: row.qualityStatus as ProductAssetEvidence['qualityStatus'],
    commerceApproved: row.commerceApproved === 1,
    conflicts: JSON.parse(row.conflictsJson) as string[],
    payload: row.payloadJson ? (JSON.parse(row.payloadJson) as Record<string, unknown>) : {},
    createdAt: row.createdAt,
  };
}

function submissionDisposition(submission: HistoricalTerminalSubmission): 'submitted' | 'abstained' {
  if ('evidenceSources' in submission) return submission.abstention ? 'abstained' : 'submitted';
  if ('disposition' in submission) return 'submitted';
  return 'abstained';
}

function submissionNeedsReview(result: ProductResearchResult): boolean {
  const submission = result.submission;
  if (!submission) return false;
  // Historical PI-1 envelopes (only reachable through parsed old rows;
  // live results are workflow-only since the terminal gate denies legacy).
  if (isLegacyTerminalSubmission(submission)) {
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
  // Historical PI-1 envelopes (unreachable for live results — the terminal
  // gate denies legacy shapes before persistence).
  if (isLegacyTerminalSubmission(submission)) {
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
  assets: ProductAssetEvidence[];
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
    assets: listPiAssetsByRun(run.id).map(assetEvidenceFromRow),
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
  baselineType: 'legacy' | 'classification_run' | 'manual' | 'pi_run';
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
    imageCount: listPiAssetsByRun(input.runId).length,
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
    if (isLegacyTerminalSubmission(submission)) return submission.productProposal.fields.length;
    if ('disposition' in submission) return submission.commerceFacts.length;
    return 0;
  } catch {
    return 0;
  }
}

/** PI-10-MINOR-7: resolve a workspace's path for reruns that must honor the
 * origin workspace rather than the current one. */
function workspacePathOf(workspaceId: string): string | null {
  const row = getDb().query('SELECT workspace_path AS path FROM workspace WHERE id = ?').get(workspaceId) as { path: string } | undefined;
  return row?.path ?? null;
}
/** Clone sources + evidence + conflicts from an origin run into a replay run. */
function clonePiEvidenceRows(originRunId: string, replayRunId: string): void {
  const sourceIdMap = new Map<string, string>();
  for (const source of listPiSources(originRunId)) {
    const row = insertPiSource({
      runId: replayRunId,
      url: source.url,
      canonicalUrl: source.canonicalUrl ?? null,
      domain: source.domain,
      sourceType: source.sourceType,
      gtinMatchStatus: source.gtinMatchStatus,
      variantMatchStatus: source.variantMatchStatus,
      retrievedAt: source.retrievedAt ?? null,
      licenseRef: source.licenseRef ?? null,
      termsRef: source.termsRef ?? null,
    });
    sourceIdMap.set(source.id, row.id);
  }
  for (const evidence of listPiEvidence(originRunId)) {
    const sourceId = evidence.sourceId ? (sourceIdMap.get(evidence.sourceId) ?? null) : null;
    insertPiEvidence({
      runId: replayRunId,
      sourceId: sourceId ?? '',
      targetField: evidence.targetField,
      value: JSON.parse(evidence.valueJson ?? 'null'),
      extractionMethod: evidence.extractionMethod ?? null,
      sourceField: evidence.sourceField ?? null,
      reliability: evidence.reliability ?? null,
      directSupport: evidence.directSupport === 1,
      snippet: evidence.snippet ?? null,
      metadata: evidence.metadataJson ? JSON.parse(evidence.metadataJson) : null,
    });
  }
}

/** Explicit retention: delete terminal runs older than N days. */
export function runRetentionCleanup(workspaceId: string, olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  return deletePiRunsOlderThan(workspaceId, cutoff);
}

// ---------------------------------------------------------------------------
// PI-10: replay modes (deterministic / same-configuration rerun)
// ---------------------------------------------------------------------------

/** PI-10: runaway replay chains are refused at this depth (review PI-10-MINOR-6). */
export const MAX_PI_REPLAY_DEPTH = 16;

/**
 * PI-10 replay. Every replay creates a NEW run linked to its origin
 * (origin_run_id + replay_depth); the original run stays immutable.
 *
 * 'deterministic' reconstructs the terminal result from the stored result
 * row — no external calls, no model, no network. Refused when the origin has
 * no stored result (failed/cancelled runs cannot be reconstructed) or the
 * replay chain is deeper than MAX_PI_REPLAY_DEPTH.
 *
 * 'rerun' launches a real execution with the original immutable input,
 * policy snapshot, config, and mode, using the caller-supplied executor
 * (the route resolves it preferring the original's executor "where still
 * available").
 *
 * @throws if the original run is still running (replays need a settled origin)
 * or not found.
 */

/** Read the approved-policy lineage for a run (review finding 7). *//** Read the approved-policy lineage for a run (review finding 7). */
function getRunPolicyLineage(
  runId: string,
): { basePolicyId: string | null; basePolicyVersion: number | null; policyOverridesJson: string | null } {
  const row = getDb()
    .query(
      `SELECT base_policy_id AS basePolicyId, base_policy_version AS basePolicyVersion,
              policy_overrides_json AS policyOverridesJson
       FROM product_intelligence_runs WHERE id = ?`,
    )
    .get(runId) as
    | { basePolicyId: string | null; basePolicyVersion: number | null; policyOverridesJson: string | null }
    | undefined;
  return row ?? { basePolicyId: null, basePolicyVersion: null, policyOverridesJson: null };
}

export async function replayPiRun(
  runId: string,
  options: {
    mode: 'deterministic' | 'rerun';
    compare?: boolean;
    executor?: ProductIntelligenceExecutor;
  },
): Promise<{ run: PiRunRow; mode: 'deterministic' | 'rerun' }> {
  const origin = getPiRun(runId);
  if (!origin) throw new Error(`Product intelligence run not found: ${runId}`);
  if (origin.status === 'running') {
    throw new Error(`Cannot replay a running run: ${runId}`);
  }
  if (origin.replayDepth >= MAX_PI_REPLAY_DEPTH) {
    throw new Error(`Replay chain too deep (max ${MAX_PI_REPLAY_DEPTH}): ${runId}`);
  }

  if (options.mode === 'deterministic') {
    // A failed/cancelled origin has no stored result to reconstruct — refusing
    // beats creating a misleading 'completed' run with no result.
    const stored = getPiResult(origin.id);
    if (!stored) {
      throw new Error(`Cannot deterministically replay run ${runId}: no stored result to reconstruct`);
    }
    const replay = createPiRun({
      workspaceId: origin.workspaceId,
      onboardingItemId: origin.onboardingItemId,
      mode: origin.mode,
      executor: origin.executor,
      inputJson: origin.inputJson,
      policyJson: origin.policyJson,
      configSnapshotId: origin.configSnapshotId,
      configSnapshotHash: origin.configSnapshotHash,
      codeCommit: origin.codeCommit,
      promptHash: origin.promptHash,
      piVersion: origin.piVersion,
      extensionVersionsJson: origin.extensionVersionsJson,
      originRunId: origin.id,
      replayDepth: origin.replayDepth + 1,
      // Round-3 atomicity: deterministic replay inherits the ORIGIN's
      // approved-policy lineage at insert time (reproduces evidence, not
      // authority — the lineage is re-evaluated on any real rerun).
      basePolicyId: origin.basePolicyId ?? null,
      basePolicyVersion: origin.basePolicyVersion ?? null,
      policyOverridesJson: origin.policyOverridesJson ?? null,
      status: 'completed',
    });
    // Reconstruct the terminal result from the stored row (deterministic).
    insertPiResult({
      runId: replay.id,
      schemaVersion: stored.schemaVersion,
      disposition: stored.disposition,
      result: JSON.parse(stored.resultJson) as ProductResearchResult,
    });
    // Smoke finding A under PI-10: the per-tool evidence/source rows are part
    // of the run's durable story — the deterministic replay clones them so
    // the replayed run's inspector matches the original (new ids, preserved
    // metadata incl. metadata.toolEvidenceId).
    clonePiEvidenceRows(origin.id, replay.id);
    appendPiEvent(replay.id, 0, 'replay', {
      mode: 'deterministic',
      originRunId: origin.id,
      replayedAt: new Date().toISOString(),
    });
    if (options.compare) {
      createPiComparison({ runId: replay.id, baselineType: 'pi_run', baselineRef: origin.id });
    }
    return { run: replay, mode: 'deterministic' };
  }

  // Same-configuration rerun: real execution with the original immutable
  // configuration; the route resolved the executor preferring the original's.
  if (!options.executor) {
    throw new Error('Rerun requires an executor (resolve via the execution router)');
  }
  // P0-4 (review remediation): the kill switch / feature flags dominate every
  // path, reruns included. When the current resolution diverted to the legacy
  // executor, a Pi rerun must be refused — never resurrect Pi. A rerun must
  // also never change the origin's executor family (fail closed).
  if (origin.executor === PI_EXECUTOR_NAME && options.executor.name !== PI_EXECUTOR_NAME) {
    throw new Error('Pi is disabled; rerun unavailable');
  }
  if (origin.executor !== PI_EXECUTOR_NAME && options.executor.name === PI_EXECUTOR_NAME) {
    throw new Error('A rerun must use the same executor family as the origin run');
  }
  // P0-4 + P0-2 + review finding 7: a rerun must not resurrect a security
  // policy that is no longer approved/active. When the origin was created
  // from an approved-policy record with reducing overrides, reauthorize the
  // BASE record (id + version) and re-apply the stored overrides against its
  // immutable policy_json, verifying the re-derived configId still matches
  // the origin snapshot (a reducing override produces a resolved hash with
  // no approved-policy row — refusing on that hash would break valid runs).
  // Pre-lineage runs fall back to the content configId check.
  const originPolicy = ProductIntelligencePolicySchema.parse(JSON.parse(origin.policyJson));
  const lazyRequire = createRequire(import.meta.url);
  const policyRepo = lazyRequire('../db/repositories/pi-approved-policy-repo') as {
    isApprovedPolicyActive: (workspaceId: string, configId: string) => boolean;
    isApprovedPolicyRecordActive: (workspaceId: string, policyId: string, version?: number) => boolean;
    getApprovedPolicyRecord: (workspaceId: string, policyId: string, version?: number) => { policyJson: string } | undefined;
  };
  const lineage = getRunPolicyLineage(origin.id);
  let rerunPolicy: ProductIntelligencePolicy;
  if (lineage.basePolicyId) {
    if (!policyRepo.isApprovedPolicyRecordActive(origin.workspaceId, lineage.basePolicyId, lineage.basePolicyVersion ?? undefined)) {
      throw new Error('origin policy is no longer approved; rerun refused');
    }
    const baseRecord = policyRepo.getApprovedPolicyRecord(origin.workspaceId, lineage.basePolicyId, lineage.basePolicyVersion ?? undefined);
    if (!baseRecord) {
      throw new Error('origin policy record is missing; rerun refused');
    }
    const basePolicy = ProductIntelligencePolicySchema.parse(JSON.parse(baseRecord.policyJson));
    const rawOverrides = lineage.policyOverridesJson ? (JSON.parse(lineage.policyOverridesJson) as Partial<ProductIntelligencePolicy>) : undefined;
    const resolved = rawOverrides
      ? computePolicyConfigId(ProductIntelligencePolicySchema.parse(assertReducingOverride(basePolicy, rawOverrides)))
      : basePolicy;
    // Immutable records make this a tamper check; still, never rerun on a
    // policy that no longer derives from the approved base.
    if (resolved.configId !== originPolicy.configId) {
      throw new Error('origin policy snapshot is inconsistent with the approved base record; rerun refused');
    }
    rerunPolicy = resolved;
  } else {
    if (!policyRepo.isApprovedPolicyActive(origin.workspaceId, originPolicy.configId)) {
      throw new Error('origin policy is no longer approved; rerun refused');
    }
    rerunPolicy = originPolicy;
  }
  const started = await startProductIntelligenceRun(
    options.executor,
    {
      input: ProductResearchInputSchema.parse(JSON.parse(origin.inputJson)),
      mode: origin.mode,
      policy: rerunPolicy,
      onboardingItemId: origin.onboardingItemId,
      originRunId: origin.id,
      basePolicyId: lineage.basePolicyId,
      basePolicyVersion: lineage.basePolicyVersion,
      policyOverridesJson: lineage.policyOverridesJson,
    },
    // PI-10-MINOR-7: honor the ORIGIN's workspace, not the current one — the
    // service API only treats workspaceId as authoritative when the path is
    // provided too, and a rerun must land in the origin's workspace.
    { workspaceId: origin.workspaceId, workspacePath: workspacePathOf(origin.workspaceId) ?? undefined },
  );
  if (options.compare) {
    createPiComparison({ runId: started.run.id, baselineType: 'pi_run', baselineRef: origin.id });
  }
  return { run: started.run, mode: 'rerun' };
}

export { createPiRun, countPiRuns, deletePiRun, getPiRun, listPiRuns };
export type { PiRunRow };
