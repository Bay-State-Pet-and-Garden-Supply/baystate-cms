/**
 * Store Manager turn executor (epic #42, #40).
 *
 * The executor is the ONLY route orchestration seam for chat: it resolves the
 * model once, starts telemetry, builds the static prompt + bounded attached
 * context, validates inbound messages, runs `streamText` with the registry's
 * tools and the #34 approval wiring, aggregates usage, emits versioned events,
 * and terminalizes the durable session/turn/telemetry rows on every terminal
 * path (success, failure, cancel, deadline).
 */

import { randomUUID } from 'node:crypto';
import { streamText, toUIMessageStream, isStepCount, convertToModelMessages, type UIMessage } from 'ai';
import { resolveAiSdkModel, type ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import { buildStoreManagerSystemPrompt } from '../../server/services/store-manager-prompt-builder';
import {
  buildAttachedProductContext,
  injectAttachedContext,
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
import { createStoreManagerPolicy, type StoreManagerRuntimePolicy } from './policy';
import {
  createStoreManagerToolRegistry,
  createRuntimeSessionState,
  buildRegistryApprovalConfig,
  type StoreManagerRuntimeSessionState,
  type StoreManagerToolRegistry,
} from './tool-registry';
import { createEventSink, type StoreManagerEventSink } from './events';
import {
  createStoreManagerSession,
  createStoreManagerTurn,
  updateStoreManagerSessionModelCall,
  terminalizeStoreManagerSession,
  terminalizeStoreManagerTurn,
  persistStoreManagerEvents,
} from '../../db/repositories/store-manager-session-repo';

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

export async function runStoreManagerTurn(
  input: StoreManagerTurnInput,
  deps: StoreManagerTurnDeps = {},
): Promise<StoreManagerTurnResult> {
  const registry = deps.registry ?? createStoreManagerToolRegistry();
  const now = deps.now ?? (() => new Date());
  const resolveModel = deps.resolveModel ?? ((selectedModel?: string) => resolveAiSdkModel(selectedModel));

  // --- resolve model once (fail before any transport attempt on explicit unavailability) ---
  const resolved = resolveModel(input.selectedModel);
  const model = resolved.modelInstance;

  // --- immutable per-turn policy + durable session/turn rows ---
  const executionId = input.executionId ?? randomUUID();
  const turnId = randomUUID();
  const sessionId = randomUUID();
  const policy = createStoreManagerPolicy(
    { workspaceId: input.workspaceId, sessionId, turnId, overrides: deps.policyOverrides },
    registry.allowlist(),
  );

  const sessionState: StoreManagerRuntimeSessionState = createRuntimeSessionState({
    sessionId,
    workspaceId: input.workspaceId,
    turnId,
  });

  createStoreManagerSession({
    id: sessionId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId,
    executionId,
    policyHash: policy.policyHash,
    policyVersion: policy.version,
    requestedModel: input.selectedModel ?? null,
    resolvedProvider: resolved.provider,
    resolvedModel: resolved.modelId,
    resolvedLocality: resolved.locality,
    resolutionReason: resolved.resolutionReason,
    modelCallId: null,
  });
  createStoreManagerTurn({
    workspaceId: input.workspaceId,
    sessionId,
    turnId,
    phase: 'investigate',
    policyHash: policy.policyHash,
  });

  const sink = createEventSink({ persistEvents: persistStoreManagerEvents });
  const emit = (event: Parameters<StoreManagerEventSink['record']>[0]) => sink.record(event);
  emit({
    version: 1,
    type: 'turn_started',
    sessionId,
    workspaceId: input.workspaceId,
    turnId,
    createdAt: now().toISOString(),
    phase: 'investigate',
    policyHash: policy.policyHash,
    modelCallId: null,
  });

  const deadlineAt = now().getTime() + policy.deadlineMs;

  // Whole-turn deadline enforced OUTSIDE the model: a server-owned controller
  // fires at deadlineAt and is composed with the caller's abort signal so a
  // model that never calls a tool (or an in-flight tool call) is aborted too.
  // `deadlineHit` distinguishes this from a client abort for terminalization.
  const deadlineController = new AbortController();
  let deadlineHit = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const modelSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, deadlineController.signal])
    : deadlineController.signal;
  // Arm the deadline after the durable session/turn rows exist but before any
  // transport; a fired deadline aborts the composed signal (and any in-flight
  // tool call). `unref` keeps the timer from holding the process open in tests.
  const armDeadline = () => {
    if (deadlineTimer !== undefined) return;
    const remaining = Math.max(0, deadlineAt - now().getTime());
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      deadlineController.abort(new Error('store_manager_turn_deadline'));
    }, remaining);
    if (typeof (deadlineTimer as { unref?: () => void }).unref === 'function') {
      (deadlineTimer as { unref: () => void }).unref();
    }
  };

  // Terminalization state + helper declared before any early-return path so
  // validation failures can terminalize the durable turn/session correctly.
  let modelCallId: string | null = null;
  let didTerminalize = false;
  function terminalizeTurn(
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
    terminalizeStoreManagerTurn(input.workspaceId, turnId, status, reason ?? null, totalToolCalls);
    terminalizeStoreManagerSession(input.workspaceId, sessionId);
    emit({
      version: 1,
      type: 'turn_terminal',
      sessionId,
      workspaceId: input.workspaceId,
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
        sessionId,
        workspaceId: input.workspaceId,
        turnId,
        createdAt: now().toISOString(),
        toolName: 'runtime',
        status: status === 'success' ? 'ok' : 'error',
        errorCode: reason,
      });
    }
    sink.flush(input.workspaceId);
  }

  // --- build registry tools (needed for tool-aware message validation) ---
  const aiSdkTools = registry.buildAiSdkTools({
    policy,
    session: sessionState,
    executionContext: {
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      executionId,
      approvalExpiresAt: deadlineAt,
    },
    adapterContext: {
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      sessionId,
      executionId,
      deadlineAt,
    },
    emit,
    now: () => now().getTime(),
    deadlineAt,
    callerSignal: modelSignal,
  });

  // --- inbound message validation BEFORE model conversion/execution ---
  let validatedMessages: UIMessage[];
  try {
    validatedMessages = await safeValidateStoreManagerMessages({
      messages: input.messages,
      tools: aiSdkTools,
    });
  } catch (err) {
    const code = err instanceof StoreManagerMessageValidationError ? err.code : 'message_validation_failed';
    terminalizeTurn('failed', code, 0, err instanceof Error ? err.message : 'Message validation failed.');
    throw new StoreManagerTurnError(code, err instanceof Error ? err.message : 'Message validation failed.');
  }

  // --- bounded attached context (#33) injected below system ---
  let chatMessages: unknown[] = validatedMessages;
  if (input.selectedSkus && Array.isArray(input.selectedSkus) && input.selectedSkus.length > 0) {
    const parsed = selectedSkusSchema.safeParse({ selectedSkus: input.selectedSkus });
    if (!parsed.success) {
      terminalizeTurn('failed', 'invalid_selected_skus', 0, 'Invalid attached product selection.');
      throw new StoreManagerTurnError(
        'invalid_selected_skus',
        'Invalid attached product selection: at most 10 unique SKUs of bounded length are allowed.',
      );
    }
    const context = buildAttachedProductContext(
      input.workspaceId,
      input.workspacePath,
      parsed.data.selectedSkus,
    );
    chatMessages = injectAttachedContext(validatedMessages, context.serialized);
  }

  // --- model messages + telemetry start (immediately before transport) ---
  const modelMessages = await convertToModelMessages(chatMessages as UIMessage[]);
  modelCallId = beginStoreManagerCall(input.workspaceId, resolved);
  updateStoreManagerSessionModelCall(input.workspaceId, sessionId, modelCallId);
  armDeadline();

  const result = streamText({
    model,
    system: buildStoreManagerSystemPrompt(),
    messages: modelMessages,
    tools: aiSdkTools,
    toolApproval: buildRegistryApprovalConfig(registry.all()),
    experimental_toolApprovalSecret: input.toolApprovalSecret,
    // Whole-turn deadline + caller cancellation, composed server-side.
    abortSignal: modelSignal,
    stopWhen: isStepCount(policy.maxToolCalls),
    onEnd: ({ usage }) => {
      const promptTokens = usage?.inputTokens ?? null;
      const completionTokens = usage?.outputTokens ?? null;
      terminalizeStoreManagerCall(modelCallId, resolved, 'success', {
        promptTokens,
        completionTokens,
      });
      const cost = computeApiCost(resolved.provider, resolved.modelId, resolved.locality, promptTokens, completionTokens);
      const costExceeded =
        typeof cost.estimatedApiCostUsd === 'number' &&
        cost.estimatedApiCostUsd > policy.maxModelCostUsd;
      terminalizeTurn(
        costExceeded ? 'policy_denied' : 'success',
        costExceeded ? 'cost_exceeded' : undefined,
        sessionState.toolCalls,
      );
    },
    onError: (error) => {
      if (deadlineHit) {
        terminalizeStoreManagerCall(modelCallId, resolved, 'deadline_exceeded');
        terminalizeTurn('deadline_exceeded', 'deadline_exceeded', sessionState.toolCalls);
        return;
      }
      terminalizeStoreManagerCall(modelCallId, resolved, 'failed', {
        errorCode: error instanceof Error ? error.name : 'STREAM_ERROR',
      });
      terminalizeTurn('failed', 'stream_error', sessionState.toolCalls);
    },
    onAbort: () => {
      if (deadlineHit) {
        terminalizeStoreManagerCall(modelCallId, resolved, 'deadline_exceeded');
        terminalizeTurn('deadline_exceeded', 'deadline_exceeded', sessionState.toolCalls);
        return;
      }
      terminalizeStoreManagerCall(modelCallId, resolved, 'cancelled');
      terminalizeTurn('cancelled', 'client_abort', sessionState.toolCalls);
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
        return buildStoreManagerMessageMetadata(resolved, modelCallId, {
          inputTokens: part.totalUsage?.inputTokens,
          outputTokens: part.totalUsage?.outputTokens,
        });
      }
      return undefined;
    },
  });

  return { uiMessageStream, modelCallId, executionId, sessionId, turnId, resolvedModel: resolved, policy };
}
