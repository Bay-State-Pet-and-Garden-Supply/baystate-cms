/**
 * Store Manager run executor (epic #42, #40; operations console, Issue 1).
 *
 * `runStoreManagerExecution` is the ONLY runtime runner for every Store
 * Manager entrypoint (chat, command, schedule, event, playbook, replay,
 * plan_preview). It resolves the model once, starts telemetry, builds the
 * static prompt + bounded context, validates inbound chat messages OR a
 * server-owned objective, runs `streamText` with the registry's tools and the
 * #34 approval wiring, aggregates usage, emits versioned events, and
 * terminalizes the durable session/turn/telemetry rows on every terminal path
 * (success, failure, cancel, deadline, policy denial).
 *
 * `runStoreManagerTurn` is a compatibility wrapper for the interactive chat
 * request kind — it must never become a second orchestration implementation.
 * Preview mode executes zero model/tool calls and returns a contract-derived
 * descriptor; unattended modes (schedule/event/playbook/replay) drain the
 * stream server-side and return a completed terminal outcome.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { streamText, toUIMessageStream, isStepCount, convertToModelMessages, type UIMessage } from 'ai';
import { resolveAiSdkModelWithFallback, type ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import {
  buildStoreManagerSystemPrompt,
  STORE_MANAGER_PROMPT_VERSION,
} from '../../server/services/store-manager-prompt-builder';
import {
  buildAttachedProductContext,
  injectAttachedContext,
  buildPinnedScopeContext,
  selectedSkusSchema,
} from '../../server/services/store-manager-context';
import {
  beginStoreManagerCall,
  terminalizeStoreManagerCall,
  buildStoreManagerMessageMetadata,
} from '../../server/services/store-manager-telemetry';
import { computeApiCost } from '../../ai/model-pricing';
import {
  safeValidateStoreManagerMessages,
  StoreManagerMessageValidationError,
} from '../../shared/schemas/store-manager';
import {
  validateStoreManagerExecutionRequest,
  deriveStoreManagerActorClass,
  type StoreManagerExecutionRequest,
  type StoreManagerPreviewDescriptor,
} from '../../shared/schemas/store-manager-operations';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  createStoreManagerPolicy,
  deriveRunToolAllowlist,
  policyToSnapshotJson,
  type StoreManagerRuntimePolicy,
} from './policy';
import {
  createStoreManagerToolRegistry,
  createRuntimeSessionState,
  buildRegistryApprovalConfig,
  type StoreManagerRuntimeSessionState,
  type StoreManagerToolRegistry,
} from './tool-registry';
import { createEventSink, type StoreManagerRuntimeEvent } from './events';
import { compileExecutionPreview } from './artifacts';
import type { StoreManagerPinnedScope } from './contracts';
import {
  createStoreManagerSession,
  createStoreManagerTurn,
  updateStoreManagerSessionModelCall,
  terminalizeStoreManagerSession,
  terminalizeStoreManagerTurn,
  persistStoreManagerEvents,
} from '../../db/repositories/store-manager-session-repo';
import { resolveActivePreferenceContentHash } from '../../server/services/store-manager-preference-service';

// ---------------------------------------------------------------------------
// Chat (compatibility) input
// ---------------------------------------------------------------------------

export interface StoreManagerTurnInput {
  workspaceId: string;
  workspacePath: string;
  threadId: string | null;
  messages: unknown;
  selectedSkus?: string[];
  selectedModel?: string;
  abortSignal?: AbortSignal;
  toolApprovalSecret: string;
  /** Optional pre-generated per-chat execution id (route-bound). */
  executionId?: string;
  /** Pinned conversational scope (Issue 2); server-resolved by the route. */
  pinnedScope?: StoreManagerPinnedScope | null;
}

/** Chat-specific extras carried through the execution boundary. */
export interface StoreManagerChatTurnDeps {
  messages: unknown;
  selectedSkus?: string[];
  toolApprovalSecret: string;
  executionId?: string;
  /** Caller (HTTP request) abort signal composed with the whole-run deadline. */
  abortSignal?: AbortSignal;
}

/**
 * Bounded tool outcome captured from a drained stream (Issue 2). The command
 * route returns these to the palette; nothing raw/unbounded is retained.
 */
export interface StoreManagerDrainedToolOutcome {
  toolCallId: string;
  toolName: string;
  status: 'ok' | 'error' | 'denied';
  output?: unknown;
  errorText?: string;
}

/** Bounded summary of a drained (non-chat) run for interactive entrypoints. */
export interface StoreManagerDrainedOutput {
  text: string;
  toolResults: StoreManagerDrainedToolOutcome[];
}

export interface StoreManagerExecutionDeps {
  /** Injectable model resolver for tests (defaults to the real resolver). */
  resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
  /** Injectable clock for tests. */
  now?: () => Date;
  registry?: StoreManagerToolRegistry;
  /** Server-owned policy narrowing (test seams / operator config); never request-derived. */
  policyOverrides?: NonNullable<Parameters<typeof createStoreManagerPolicy>[0]>['overrides'];
  /** Approval secret for chat streaming; generated per-run otherwise. */
  toolApprovalSecret?: string;
  /** Chat-specific transport (messages + approval secret) for entrypoint 'chat'. */
  chat?: StoreManagerChatTurnDeps;
  /**
   * Server-owned execution-context extras (operations console, Issue 7).
   * Playbook checkpoints inject server-recorded approvals + approval-bound
   * diff hashes so a resumed execute step passes the gate and refuses stale
   * previews. Never request-derived.
   */
  executionContextExtras?: {
    serverApprovedCalls?: ReadonlyArray<{
      toolCallId: string;
      approvalId: string;
      diffHash: string;
      expiresAt: number;
    }>;
    boundDiffHashes?: ReadonlyMap<string, string>;
  };
  /**
   * Active workspace-preference content hash (server-owned). Defaults to the
   * repository-backed resolver; injectable for tests. Never request-derived.
   */
  resolvePreferencesHash?: (workspaceId: string) => string | null;
}

export type StoreManagerExecutionResult =
  | {
      kind: 'chat';
      runId: string;
      turnId: string;
      modelCallId: string;
      executionId: string;
      uiMessageStream: ReturnType<typeof toUIMessageStream>;
      resolvedModel: ResolvedAiSdkModel;
      policy: StoreManagerRuntimePolicy;
    }
  | {
      kind: 'completed';
      runId: string;
      turnId: string;
      modelCallId: string | null;
      terminalStatus: 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded';
      resolvedModel: ResolvedAiSdkModel | null;
      policy: StoreManagerRuntimePolicy;
      /** Bounded text + tool-outcome summary (Issue 2; empty for schedules/events). */
      output: StoreManagerDrainedOutput;
    }
  | {
      kind: 'preview';
      runId: string;
      turnId: string;
      preview: StoreManagerPreviewDescriptor;
      policy: StoreManagerRuntimePolicy;
    };

export interface StoreManagerTurnResult {
  uiMessageStream: ReturnType<typeof toUIMessageStream>;
  modelCallId: string;
  executionId: string;
  sessionId: string;
  turnId: string;
  resolvedModel: ResolvedAiSdkModel;
  policy: StoreManagerRuntimePolicy;
}

export class StoreManagerTurnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreManagerTurnError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Objective → server-owned inbound messages (non-chat entrypoints)
// ---------------------------------------------------------------------------

function objectiveToMessages(objective: string, scope: StoreManagerPinnedScope | null): UIMessage[] {
  let text = `Objective: ${objective}`;
  if (scope) {
    const scopeContext = buildPinnedScopeContext(scope);
    text = `Objective: ${objective}\n\n${scopeContext.serialized}`;
  }
  return [
    {
      id: 'objective-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    },
  ];
}

function scopeJson(scope: StoreManagerPinnedScope | null | undefined): string | null {
  return scope ? JSON.stringify(scope) : null;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runStoreManagerExecution(
  request: StoreManagerExecutionRequest,
  deps: StoreManagerExecutionDeps = {},
): Promise<StoreManagerExecutionResult> {
  const registry = deps.registry ?? createStoreManagerToolRegistry();
  const now = deps.now ?? (() => new Date());

  // Strict request validation: unknown keys/oversized fields fail before any
  // model/tool/service work (server-generated runId is still schema-checked).
  const validated = validateStoreManagerExecutionRequest(request);

  const executionId = deps.chat?.executionId ?? validated.runId;
  const turnId = randomUUID();
  const runId = validated.runId;

  const actorClass = deriveStoreManagerActorClass(validated.entrypoint, validated.executionMode);
  const isPreview = validated.executionMode === 'preview';
  const approvalSecret =
    deps.toolApprovalSecret ??
    (deps.chat?.toolApprovalSecret ?? randomBytes(32).toString('hex'));

  // --- immutable per-run policy (execution mode + scope + actor captured) ---
  // Unattended/preview modes derive a read-only tool allowlist (read adapters
  // only) so the policy snapshot itself excludes persistent adapters (Issue 4).
  const runToolAllowlist = deriveRunToolAllowlist(registry.all(), validated.executionMode);
  const policy = createStoreManagerPolicy(
    {
      workspaceId: validated.workspaceId,
      sessionId: runId,
      turnId,
      entrypoint: validated.entrypoint,
      executionMode: validated.executionMode,
      actorClass,
      pinnedScope: validated.pinnedScope,
      preferencesHash: (deps.resolvePreferencesHash ?? resolveActivePreferenceContentHash)(validated.workspaceId),
      promptVersion: STORE_MANAGER_PROMPT_VERSION.toString(),
      overrides: deps.policyOverrides ?? validated.policyProfile,
    },
    runToolAllowlist,
  );

  const sessionState: StoreManagerRuntimeSessionState = createRuntimeSessionState({
    sessionId: runId,
    workspaceId: validated.workspaceId,
    turnId,
  });

  const sink = createEventSink({ persistEvents: persistStoreManagerEvents });
  const emit: RuntimeEmit = (event) => sink.record(event);

  // Whole-run deadline machinery + terminalization helper are declared BEFORE
  // any early-return path (preview, validation failure) so every terminal path
  // can clear the timer and terminalize the durable rows exactly once.
  const deadlineController = new AbortController();
  let deadlineHit = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineAt = now().getTime() + policy.deadlineMs;
  const modelSignal =
    deps.chat && deps.chat.abortSignal
      ? AbortSignal.any([deps.chat.abortSignal, deadlineController.signal])
      : deadlineController.signal;
  const armDeadline = () => {
    if (deadlineTimer !== undefined) return;
    const remaining = Math.max(0, deadlineAt - now().getTime());
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      deadlineController.abort(new Error('store_manager_run_deadline'));
    }, remaining);
    if (typeof (deadlineTimer as { unref?: () => void }).unref === 'function') {
      (deadlineTimer as { unref: () => void }).unref();
    }
  };

  let modelCallId: string | null = null;
  let didTerminalize = false;
  let finalStatus: 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded' = 'success';
  function terminalizeTurnState(
    status: 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded',
    reason: string | undefined,
    totalToolCalls: number,
    detail?: string,
  ): void {
    if (didTerminalize) return;
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    didTerminalize = true;
    finalStatus = status;
    terminalizeStoreManagerTurn(validated.workspaceId, turnId, status, reason ?? null, totalToolCalls);
    terminalizeStoreManagerSession(validated.workspaceId, runId);
    emit({
      version: 1,
      type: 'turn_terminal',
      sessionId: runId,
      workspaceId: validated.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      status,
      reason,
      modelCallId,
      totalToolCalls,
    });
    if (detail) {
      emit({
        version: 1,
        type: 'tool_result',
        sessionId: runId,
        workspaceId: validated.workspaceId,
        turnId,
        createdAt: now().toISOString(),
        toolName: 'runtime',
        status: status === 'success' ? 'ok' : 'error',
        errorCode: reason,
      });
    }
    sink.flush(validated.workspaceId);
  }

  // Preview mode: contract compilation only. No model resolution, no transport,
  // no tool dispatch, no reads. The run row is the bounded preview audit record.
  if (isPreview) {
    createRunRows(validated, runId, turnId, executionId, policy, null, now);
    emitRunStarted(emit, validated, runId, turnId, policy, now);
    const preview = compileExecutionPreview(validated, registry, policy);
    emit({
      version: 1,
      type: 'plan_preview',
      sessionId: runId,
      workspaceId: validated.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      expectedToolCount: preview.expectedTools.length,
      modelCalls: 0,
      toolDispatches: 0,
      scopeHash: preview.scopeHash,
    });
    terminalizeTurnState('success', 'preview', 0);
    sink.flush(validated.workspaceId);
    return { kind: 'preview', runId, turnId, preview, policy };
  }

  // --- resolve model once (fail before any transport attempt on explicit unavailability) ---
  // The default resolver wires the configured fallback target (storeManager
  // workload route) into a resilient transport. `executedResolved` returns
  // the model that ACTUALLY ran: the resilient wrapper mutates
  // `resolved.executedFallback` when the primary fails and the fallback
  // executes, so telemetry/cost/metadata never attribute a fallback run to
  // the failed primary. Injected test resolvers return plain resolved models
  // (no `fallback`), so no wrapping occurs and behavior is unchanged.
  const resolved = (deps.resolveModel ?? ((selectedModel?: string) => resolveAiSdkModelWithFallback(selectedModel)))(
    validated.selectedModel,
  );
  const model = resolved.modelInstance;
  const executedResolved = (): ResolvedAiSdkModel => resolved.executedFallback ?? resolved;
  const logFallbackExecution = (): void => {
    if (resolved.executedFallback) {
      console.warn(
        `[StoreManager] Executed fallback model ${resolved.executedFallback.provider}:${resolved.executedFallback.modelId} after primary ${resolved.provider}:${resolved.modelId} failed.`,
      );
    }
  };

  createRunRows(validated, runId, turnId, executionId, policy, resolved, now);
  emitRunStarted(emit, validated, runId, turnId, policy, now);

  // --- build registry tools (needed for tool-aware chat message validation) ---
  const aiSdkTools = registry.buildAiSdkTools({
    policy,
    session: sessionState,
    executionContext: {
      workspaceId: validated.workspaceId,
      workspacePath: validated.workspacePath,
      executionId,
      approvalExpiresAt: deadlineAt,
      serverApprovedCalls: deps.executionContextExtras?.serverApprovedCalls,
      boundDiffHashes: deps.executionContextExtras?.boundDiffHashes,
    },
    adapterContext: {
      workspaceId: validated.workspaceId,
      workspacePath: validated.workspacePath,
      sessionId: runId,
      executionId,
      deadlineAt,
    },
    emit,
    now: () => now().getTime(),
    deadlineAt,
    callerSignal: modelSignal,
  });

  // --- inbound content: validated chat messages OR server-owned objective ---
  let chatMessages: unknown[];
  if (validated.entrypoint === 'chat') {
    if (!deps.chat) {
      throw new StoreManagerTurnError(
        'chat_transport_missing',
        'Chat entrypoint requires the chat transport (messages + approval secret).',
      );
    }
    try {
      chatMessages = await safeValidateStoreManagerMessages({
        messages: deps.chat.messages,
        tools: aiSdkTools,
      });
    } catch (err) {
      const code = err instanceof StoreManagerMessageValidationError ? err.code : 'message_validation_failed';
      terminalizeTurnState('failed', code, 0, err instanceof Error ? err.message : 'Message validation failed.');
      throw new StoreManagerTurnError(code, err instanceof Error ? err.message : 'Message validation failed.');
    }
    // Bounded attached context (#33) injected below system.
    const selectedSkus = deps.chat.selectedSkus;
    if (selectedSkus && Array.isArray(selectedSkus) && selectedSkus.length > 0) {
      const parsed = selectedSkusSchema.safeParse({ selectedSkus });
      if (!parsed.success) {
        terminalizeTurnState('failed', 'invalid_selected_skus', 0, 'Invalid attached product selection.');
        throw new StoreManagerTurnError(
          'invalid_selected_skus',
          'Invalid attached product selection: at most 10 unique SKUs of bounded length are allowed.',
        );
      }
      const context = buildAttachedProductContext(
        validated.workspaceId,
        validated.workspacePath,
        parsed.data.selectedSkus,
      );
      chatMessages = injectAttachedContext(chatMessages as UIMessage[], context.serialized);
    }
    // Pinned conversational scope (Issue 2): bounded structured context below
    // the system prompt so the model never silently scans the whole catalog.
    if (validated.pinnedScope) {
      const scopeContext = buildPinnedScopeContext(validated.pinnedScope);
      chatMessages = injectAttachedContext(chatMessages as UIMessage[], scopeContext.serialized);
    }
  } else {
    chatMessages = objectiveToMessages(validated.objective, validated.pinnedScope ?? null);
  }

  // --- model messages + telemetry start (immediately before transport) ---
  const modelMessages = await convertToModelMessages(chatMessages as UIMessage[]);
  modelCallId = beginStoreManagerCall(validated.workspaceId, resolved);
  updateStoreManagerSessionModelCall(validated.workspaceId, runId, modelCallId);
  armDeadline();

  const result = streamText({
    model,
    system: buildStoreManagerSystemPrompt(),
    messages: modelMessages,
    tools: aiSdkTools,
    toolApproval: buildRegistryApprovalConfig(registry.all(), {
      // Unattended/preview runs must never wait for an approval the operator
      // will not see; the registry denies persistent adapters at dispatch.
      // Command runs (Issue 2) use the drained path with no approval channel,
      // so persistent adapters are also forced to not-applicable — they are
      // refused at the approval gate (approval_required) before any side
      // effect, and repair never runs without explicit operator approval.
      // Playbook steps (Issue 7) drain server-side with server-recorded
      // checkpoint approvals — the SDK must never render a client approval
      // UI for a drained stream; the gate enforces checkpoint approvals.
      forceNotApplicable:
        policy.denyPersistent ||
        validated.entrypoint === 'command' ||
        validated.entrypoint === 'playbook',
    }),
    experimental_toolApprovalSecret: approvalSecret,
    // Whole-run deadline + caller cancellation, composed server-side.
    abortSignal: modelSignal,
    stopWhen: isStepCount(policy.maxToolCalls),
    onEnd: ({ usage }) => {
      const promptTokens = usage?.inputTokens ?? null;
      const completionTokens = usage?.outputTokens ?? null;
      logFallbackExecution();
      terminalizeStoreManagerCall(modelCallId, executedResolved(), 'success', {
        promptTokens,
        completionTokens,
      });
      const cost = computeApiCost(executedResolved().provider, executedResolved().modelId, executedResolved().locality, promptTokens, completionTokens);
      const costExceeded =
        typeof cost.estimatedApiCostUsd === 'number' &&
        cost.estimatedApiCostUsd > policy.maxModelCostUsd;
      terminalizeTurnState(
        costExceeded ? 'policy_denied' : 'success',
        costExceeded ? 'cost_exceeded' : undefined,
        sessionState.toolCalls,
      );
    },
    onError: (error) => {
      logFallbackExecution();
      if (deadlineHit) {
        terminalizeStoreManagerCall(modelCallId, executedResolved(), 'deadline_exceeded');
        terminalizeTurnState('deadline_exceeded', 'deadline_exceeded', sessionState.toolCalls);
        return;
      }
      terminalizeStoreManagerCall(modelCallId, executedResolved(), 'failed', {
        errorCode: error instanceof Error ? error.name : 'STREAM_ERROR',
      });
      terminalizeTurnState('failed', 'stream_error', sessionState.toolCalls);
    },
    onAbort: () => {
      logFallbackExecution();
      if (deadlineHit) {
        terminalizeStoreManagerCall(modelCallId, executedResolved(), 'deadline_exceeded');
        terminalizeTurnState('deadline_exceeded', 'deadline_exceeded', sessionState.toolCalls);
        return;
      }
      terminalizeStoreManagerCall(modelCallId, executedResolved(), 'cancelled');
      terminalizeTurnState('cancelled', 'client_abort', sessionState.toolCalls);
    },
  });

  const uiMessageStream = toUIMessageStream({
    stream: result.stream,
    tools: aiSdkTools,
    messageMetadata: ({ part }) => {
      if (part.type === 'start') {
        return {
          modelCallId,
          provider: resolved.provider,
          model: resolved.modelId,
          locality: resolved.locality,
          resolutionReason: resolved.resolutionReason,
        };
      }
      if (part.type === 'finish') {
        return buildStoreManagerMessageMetadata(executedResolved(), modelCallId, {
          inputTokens: part.totalUsage?.inputTokens,
          outputTokens: part.totalUsage?.outputTokens,
        });
      }
      return undefined;
    },
  });

  if (validated.entrypoint === 'chat') {
    return {
      kind: 'chat',
      runId,
      turnId,
      modelCallId,
      executionId,
      uiMessageStream,
      resolvedModel: resolved,
      policy,
    };
  }

  // Non-chat entrypoints: drain the stream server-side (tool dispatch happens
  // through the registry; terminalization fires via onEnd/onError/onAbort).
  // Interactive commands (Issue 2) also capture a bounded text + tool-outcome
  // summary for the command palette — no raw/unbounded content is retained.
  let drainedOutput: StoreManagerDrainedOutput = { text: '', toolResults: [] };
  const toolNameById = new Map<string, string>();
    try {
      for await (const chunk of uiMessageStream as unknown as AsyncIterable<unknown>) {
        const c = chunk as {
          type?: string;
          delta?: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        if (c.type === 'text-delta' && typeof c.delta === 'string') {
          drainedOutput.text = (drainedOutput.text + c.delta).slice(0, 64 * 1024);
        } else if (typeof c.type === 'string' && c.type.startsWith('tool-')) {
          if (c.toolCallId && typeof c.toolName === 'string') {
            toolNameById.set(c.toolCallId, c.toolName);
          }
          if (c.type === 'tool-output-available' && c.toolCallId) {
            const output = c.output as { status?: string; reasonCode?: string } | undefined;
            const structuredDenial =
              output && typeof output === 'object' && (output.status === 'policy_denied' || output.status === 'error');
            drainedOutput.toolResults.push({
              toolCallId: c.toolCallId,
              toolName: toolNameById.get(c.toolCallId) ?? 'unknown',
              status: structuredDenial ? (output.status === 'policy_denied' ? 'denied' : 'error') : 'ok',
              output: c.output,
            });
          } else if (c.type === 'tool-output-error' && c.toolCallId) {
            drainedOutput.toolResults.push({
              toolCallId: c.toolCallId,
              toolName: toolNameById.get(c.toolCallId) ?? 'unknown',
              status: 'error',
              errorText: c.errorText?.slice(0, 500),
            });
          } else if (c.type === 'tool-output-denied' && c.toolCallId) {
            drainedOutput.toolResults.push({
              toolCallId: c.toolCallId,
              toolName: toolNameById.get(c.toolCallId) ?? 'unknown',
              status: 'denied',
            });
          }
        }
      }
  } catch {
    // The stream may throw on abort (deadline/cancel); terminalization is
    // handled by the SDK callbacks above — never throw here.
  }
  return {
    kind: 'completed',
    runId,
    turnId,
    modelCallId,
    terminalStatus: finalStatus,
    resolvedModel: resolved,
    policy,
    output: drainedOutput,
  };
}

// ---------------------------------------------------------------------------
// Shared row/event helpers
// ---------------------------------------------------------------------------

function createRunRows(
  request: StoreManagerExecutionRequest,
  runId: string,
  turnId: string,
  executionId: string,
  policy: StoreManagerRuntimePolicy,
  resolved: ResolvedAiSdkModel | null,
  now: () => Date,
): void {
  createStoreManagerSession({
    id: runId,
    workspaceId: request.workspaceId,
    threadId: request.threadId ?? null,
    turnId,
    executionId,
    policyHash: policy.policyHash,
    policyVersion: policy.version,
    policySnapshotJson: policyToSnapshotJson(policy),
    requestedModel: request.selectedModel ?? null,
    resolvedProvider: resolved?.provider ?? 'none',
    resolvedModel: resolved?.modelId ?? 'none',
    resolvedLocality: resolved?.locality ?? 'cloud',
    resolutionReason: resolved?.resolutionReason ?? 'preview_no_model_resolution',
    modelCallId: null,
    objective: request.objective,
    entrypoint: request.entrypoint,
    executionMode: request.executionMode,
    actorClass: policy.actorClass,
    scopeJson: scopeJson(request.pinnedScope ?? null),
    scopeHash: request.pinnedScope ? hashCanonicalJson(request.pinnedScope) : null,
    promptVersion: policy.promptVersion,
    lineageJson: request.lineage ? JSON.stringify(request.lineage) : null,
  });
  createStoreManagerTurn({
    workspaceId: request.workspaceId,
    sessionId: runId,
    turnId,
    phase: 'investigate',
    policyHash: policy.policyHash,
  });
}

function emitRunStarted(
  emit: RuntimeEmit,
  request: StoreManagerExecutionRequest,
  runId: string,
  turnId: string,
  policy: StoreManagerRuntimePolicy,
  now: () => Date,
): void {
  emit({
    version: 1,
    type: 'turn_started',
    sessionId: runId,
    workspaceId: request.workspaceId,
    turnId,
    createdAt: now().toISOString(),
    phase: 'investigate',
    policyHash: policy.policyHash,
    modelCallId: null,
  });
  emit({
    version: 1,
    type: 'execution_started',
    sessionId: runId,
    workspaceId: request.workspaceId,
    turnId,
    createdAt: now().toISOString(),
    entrypoint: request.entrypoint,
    executionMode: request.executionMode,
    actorClass: policy.actorClass,
    objectiveHash: hashCanonicalJson(request.objective),
    scopeHash: request.pinnedScope ? hashCanonicalJson(request.pinnedScope) : null,
    lineage: request.lineage ?? null,
  });
  if (request.lineage?.commandName) {
    emit({
      version: 1,
      type: 'command_compiled',
      sessionId: runId,
      workspaceId: request.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      commandName: request.lineage.commandName,
      commandVersion: request.lineage.commandVersion ?? 1,
      compiledObjective: request.objective.slice(0, 800),
    });
  }
  if (request.lineage?.scheduleId || request.lineage?.triggerKind) {
    emit({
      version: 1,
      type: 'schedule_trigger_lineage',
      sessionId: runId,
      workspaceId: request.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      scheduleId: request.lineage.scheduleId ?? null,
      triggerKind: request.lineage.triggerKind ?? null,
      occurrenceKey: request.lineage.occurrenceKey ?? null,
    });
  }
  if (request.lineage?.replayOfRunId) {
    emit({
      version: 1,
      type: 'replay_lineage',
      sessionId: runId,
      workspaceId: request.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      replayOfRunId: request.lineage.replayOfRunId,
      sourceEntrypoint: request.entrypoint,
    });
  }
  if (request.lineage?.playbookId) {
    emit({
      version: 1,
      type: 'playbook_lineage',
      sessionId: runId,
      workspaceId: request.workspaceId,
      turnId,
      createdAt: now().toISOString(),
      playbookId: request.lineage.playbookId,
      playbookVersion: request.lineage.playbookVersion ?? null,
      stepId: request.lineage.stepId ?? null,
      stepKind: request.lineage.stepKind ?? null,
    });
  }
}

type RuntimeEmit = (event: StoreManagerRuntimeEvent) => void;

// ---------------------------------------------------------------------------
// Compatibility wrapper (chat)
// ---------------------------------------------------------------------------

export async function runStoreManagerTurn(
  input: StoreManagerTurnInput,
  deps: StoreManagerTurnDeps = {},
): Promise<StoreManagerTurnResult> {
  let request: StoreManagerExecutionRequest;
  try {
    request = validateStoreManagerExecutionRequest({
      runId: randomUUID(),
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      threadId: input.threadId ?? null,
      entrypoint: 'chat',
      objective: 'Chat interaction with the Store Manager assistant.',
      executionMode: 'interactive',
      selectedModel: input.selectedModel,
      pinnedScope: input.pinnedScope ?? undefined,
    });
  } catch (err) {
    throw new StoreManagerTurnError(
      'execution_request_invalid',
      err instanceof Error ? err.message : 'Invalid execution request.',
    );
  }

  const result = await runStoreManagerExecution(request, {
    registry: deps.registry,
    now: deps.now,
    resolveModel: deps.resolveModel,
    policyOverrides: deps.policyOverrides,
    chat: {
      messages: input.messages,
      selectedSkus: input.selectedSkus,
      toolApprovalSecret: input.toolApprovalSecret,
      executionId: input.executionId,
      abortSignal: input.abortSignal,
    },
  });

  if (result.kind !== 'chat') {
    throw new StoreManagerTurnError(
      'chat_result_missing',
      'Chat execution did not produce a streaming result.',
    );
  }
  return {
    uiMessageStream: result.uiMessageStream,
    modelCallId: result.modelCallId,
    executionId: result.executionId,
    sessionId: result.runId,
    turnId: result.turnId,
    resolvedModel: result.resolvedModel,
    policy: result.policy,
  };
}

export interface StoreManagerTurnDeps {
  /** Injectable model resolver for tests (defaults to the real resolver). */
  resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
  /** Injectable clock for tests. */
  now?: () => Date;
  registry?: StoreManagerToolRegistry;
  /** Server-owned policy narrowing (test seams / operator config); never request-derived. */
  policyOverrides?: NonNullable<Parameters<typeof createStoreManagerPolicy>[0]>['overrides'];
}
