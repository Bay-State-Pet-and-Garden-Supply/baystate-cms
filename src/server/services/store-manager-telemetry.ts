/**
 * Store Manager telemetry (epic #42, #37).
 *
 * One authoritative resolved-model object (from #32) feeds streaming,
 * `ai_model_calls`, cost, UI metadata, and logs. Rows are inserted as
 * `started` immediately before the first transport attempt and terminalized
 * exactly once via the repository's `WHERE status = 'started'` guard.
 *
 * The chat-history save path must never trust client-supplied usage totals,
 * provider, or model: it re-hydrates from the workspace-owned
 * `ai_model_calls` row by id (see `sanitizeChatMessagesForPersistence`).
 */

import { computeApiCost, type CostBasis } from '../../ai/model-pricing';
import { getModelProfile } from '../../ai/model-registry';
import { getProviderDefinition } from '../../ai/provider-registry';
import {
  insertAiModelCallStart,
  completeAiModelCall,
  insertTerminalAiModelCall,
  getAiModelCallByWorkspaceAndId,
  type GeneralModelCallStatus,
} from '../../db/repositories/ai-model-call-repo';
import type { ResolvedAiSdkModel } from './ai-sdk-model-resolver';
import type {
  StoreManagerEntrypoint,
  StoreManagerLineage,
} from '../../shared/schemas/store-manager-operations';
import { hashCanonicalJson } from '../../shared/stable-id';

export const STORE_MANAGER_TASK = 'store_manager_assistant' as const;

/**
 * Task label for an entrypoint. Chat keeps the historical task id so existing
 * `ai_model_calls` rows stay queryable; other entrypoints use a bounded
 * `store_manager_<entrypoint>` label. No new telemetry columns are added —
 * this is a labeling helper only.
 */
export function storeManagerTaskForEntrypoint(entrypoint: StoreManagerEntrypoint): string {
  if (entrypoint === 'chat') return STORE_MANAGER_TASK;
  return `store_manager_${entrypoint}`;
}

/**
 * Deterministic lineage digest for a run (bounded identifiers only). Returns
 * null when there is no lineage so callers can store a NULL column. Never
 * contains secrets or free-form text.
 */
export function storeManagerLineageDigest(lineage: StoreManagerLineage | null | undefined): string | null {
  if (!lineage) return null;
  return hashCanonicalJson(lineage);
}

/**
 * Safe metadata attached to the assistant UI message at stream finish. This
 * is presentation/UX data derived from the durable telemetry row; the row is
 * still the source of truth for persisted history.
 */
export interface StoreManagerMessageMetadata {
  modelCallId: string;
  provider: string;
  model: string;
  locality: 'local' | 'cloud';
  resolutionReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number | null;
  costBasis?: CostBasis;
}

/**
 * Insert a `started` ai_model_calls row for one Store Manager chat turn.
 * Called before the first transport attempt so a server restart between
 * response and chat-save cannot lose model-call telemetry.
 */
export function beginStoreManagerCall(
  workspaceId: string,
  resolved: ResolvedAiSdkModel,
): string {
  return insertAiModelCallStart({
    workspaceId,
    task: STORE_MANAGER_TASK,
    provider: resolved.provider,
    model: resolved.modelId,
    locality: resolved.locality,
  });
}

/**
 * Terminalize a Store Manager model call exactly once. Cost is always derived
 * from the exact resolved provider/model/locality and the supplied tokens.
 * The repository guard (`WHERE id = ? AND status = 'started'`) makes this
 * idempotent across overlapping onEnd/onError/onAbort paths.
 */
export function terminalizeStoreManagerCall(
  callId: string,
  resolved: ResolvedAiSdkModel,
  status: Extract<GeneralModelCallStatus, 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded'>,
  opts: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    errorCode?: string | null;
  } = {},
): boolean {
  const cost = computeApiCost(
    resolved.provider,
    resolved.modelId,
    resolved.locality,
    opts.promptTokens ?? null,
    opts.completionTokens ?? null,
  );
  return completeAiModelCall(callId, {
    status,
    promptTokens: opts.promptTokens ?? null,
    completionTokens: opts.completionTokens ?? null,
    estimatedApiCostUsd: cost.estimatedApiCostUsd,
    costBasis: cost.costBasis,
    errorCode: opts.errorCode ?? null,
  });
}

/**
 * Build the message metadata attached to the streamed assistant message at
 * finish. `usage` must come from the AI SDK aggregate step usage (v7
 * `onEnd.usage` / stream `finish.totalUsage`), never from final-step-only
 * values.
 */
export function buildStoreManagerMessageMetadata(
  resolved: ResolvedAiSdkModel,
  callId: string,
  usage: { inputTokens?: number | null; outputTokens?: number | null },
): StoreManagerMessageMetadata {
  const cost = computeApiCost(
    resolved.provider,
    resolved.modelId,
    resolved.locality,
    usage.inputTokens ?? null,
    usage.outputTokens ?? null,
  );
  return {
    modelCallId: callId,
    provider: resolved.provider,
    model: resolved.modelId,
    locality: resolved.locality,
    resolutionReason: resolved.resolutionReason,
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    estimatedCostUsd: cost.estimatedApiCostUsd,
    costBasis: cost.costBasis,
  };
}

/**
 * Record an explicit-selection or default-resolution failure as a terminal
 * `unavailable` row. No transport attempt occurred and no `started` row was
 * created, so this is the only row for the request. Provider/locality are
 * best-effort from the registry; `unavailable` clearly marks non-execution.
 */
export function insertStoreManagerUnavailableCall(
  workspaceId: string,
  attemptedModel: string | undefined,
  errorCode = 'model_unavailable',
): void {
  const profile = typeof attemptedModel === 'string' && attemptedModel ? getModelProfile(attemptedModel) : null;
  const provider = profile?.provider ?? 'unknown';
  const locality: 'local' | 'cloud' =
    profile && getProviderDefinition(profile.provider)?.locality === 'local' ? 'local' : 'cloud';
  insertTerminalAiModelCall({
    workspaceId,
    task: STORE_MANAGER_TASK,
    provider,
    model: attemptedModel ?? 'unresolved',
    locality,
    status: 'unavailable',
    errorCode,
  });
}

const ALLOWED_CHAT_ROLES = new Set(['user', 'assistant']);

/**
 * Validate a client-supplied chat-messages payload and reconstruct telemetry
 * server-side. Client-supplied `usage` totals/provider/model are never
 * trusted. For assistant messages carrying a `modelCallId`, metadata is
 * re-hydrated from the workspace-owned `ai_model_calls` row; foreign or
 * unknown call ids are stripped. Messages failing the minimal schema are
 * dropped. Never throws; returns the sanitized list.
 */
export function sanitizeChatMessagesForPersistence(
  workspaceId: string,
  messages: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const sanitized: Array<Record<string, unknown>> = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.id !== 'string' || msg.id.length === 0) continue;
    if (typeof msg.role !== 'string' || !ALLOWED_CHAT_ROLES.has(msg.role)) continue;

    const clean: Record<string, unknown> = { ...msg };
    delete clean.usage;

    const metadata: Record<string, unknown> =
      clean.metadata && typeof clean.metadata === 'object'
        ? { ...(clean.metadata as Record<string, unknown>) }
        : {};
    // Capture the server-attached claims BEFORE stripping them so resolution-
    // reason can be preserved only when they match the durable row.
    const claimedProvider = typeof metadata.provider === 'string' ? metadata.provider : null;
    const claimedModel = typeof metadata.model === 'string' ? metadata.model : null;
    const claimedResolutionReason =
      typeof metadata.resolutionReason === 'string' ? metadata.resolutionReason : null;
    // Never accept client-supplied telemetry fields (totals, cost, or the
    // resolved provider/model/locality). They are reconstructed only from the
    // workspace-owned durable row below.
    delete metadata.promptTokens;
    delete metadata.completionTokens;
    delete metadata.estimatedCostUsd;
    delete metadata.costBasis;
    delete metadata.provider;
    delete metadata.model;
    delete metadata.locality;
    delete metadata.resolutionReason;

    const callId = typeof metadata.modelCallId === 'string' ? metadata.modelCallId : null;
    if (callId) {
      const row = getAiModelCallByWorkspaceAndId(workspaceId, callId);
      if (row) {
        clean.metadata = {
          modelCallId: row.id,
          provider: row.provider,
          model: row.model,
          locality: row.locality,
          // resolutionReason has no table column; keep it only when the
          // server-attached claims match the durable row.
          ...(claimedResolutionReason &&
          claimedProvider === row.provider &&
          claimedModel === row.model
            ? { resolutionReason: claimedResolutionReason }
            : {}),
          promptTokens: row.prompt_tokens ?? 0,
          completionTokens: row.completion_tokens ?? 0,
          estimatedCostUsd: row.estimated_api_cost_usd,
          costBasis: row.cost_basis,
        };
      } else {
        // Foreign or unknown call id: strip telemetry; never trust the client.
        delete metadata.modelCallId;
        clean.metadata = metadata;
      }
    } else {
      clean.metadata = metadata;
    }

    sanitized.push(clean);
  }

  return sanitized;
}
