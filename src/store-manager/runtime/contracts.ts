/**
 * Store Manager runtime contracts (epic #42, #40).
 *
 * Provider-neutral shape for the bounded agent/tool runtime: versioned tool
 * adapters, structured outcomes, execution context, and the per-turn policy.
 * Everything here is intentionally free of AI SDK / Hono / DB imports so the
 * registry and adapters stay testable in isolation.
 */

import type { z } from 'zod';
import type {
  StoreManagerEntrypoint,
  StoreManagerExecutionMode,
  StoreManagerActorClass,
  StoreManagerPinnedScope,
  StoreManagerScopeKind,
  StoreManagerLineage,
} from '../../shared/schemas/store-manager-operations';
export type {
  StoreManagerEntrypoint,
  StoreManagerExecutionMode,
  StoreManagerActorClass,
  StoreManagerPinnedScope,
  StoreManagerScopeKind,
  StoreManagerLineage,
} from '../../shared/schemas/store-manager-operations';
import type { StoreManagerArtifactKind } from '../../shared/schemas/store-manager-operations';
import type { StoreManagerActionDiff } from '../../shared/schemas/store-manager-diff';

// ---------------------------------------------------------------------------
// Structured outcomes
// ---------------------------------------------------------------------------

/**
 * Expected tool results share one bounded vocabulary so callers and the UI
 * can render any adapter generically. Unexpected exceptions never leak as
 * raw errors; they are redacted `error` outcomes.
 */
export type StoreManagerToolResult =
  | { status: 'ok'; data: unknown }
  | { status: 'no_result'; data?: unknown; note?: string }
  | {
      status: 'policy_denied';
      reasonCode:
        | 'not_in_workspace'
        | 'not_found'
        | 'phase_not_allowed'
        | 'approval_required'
        | 'approval_denied'
        | 'budget_exceeded'
        | 'deadline_exceeded'
        | 'timeout'
        | 'size_exceeded'
        | 'unsupported'
        | 'invalid_input'
        | 'persistent_not_allowed'
        | 'stale_preview';
      message: string;
    }
  | { status: 'error'; errorCode: string; message: string };

export function okResult(data: unknown): StoreManagerToolResult {
  return { status: 'ok', data };
}

export function noResult(note?: string, data?: unknown): StoreManagerToolResult {
  return note ? { status: 'no_result', note, data } : { status: 'no_result', data };
}

export function policyDenied(
  reasonCode: Extract<StoreManagerToolResult, { status: 'policy_denied' }>['reasonCode'],
  message: string,
): StoreManagerToolResult {
  return { status: 'policy_denied', reasonCode, message };
}

export function errorResult(errorCode: string, message: string): StoreManagerToolResult {
  return { status: 'error', errorCode, message };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Interaction phases:
 * - `investigate`: read-only exploration (the initial phase).
 * - `approve`: a persistent tool call with a valid signed operator approval is
 *   the only tool allowed to execute (exact approved tool).
 * - `verify`: authoritative reads for the affected resource after a mutation.
 *
 * The model cannot activate a broader phase through arguments; the registry
 * derives the phase from session state and the approval status of the exact
 * tool call.
 */
export type StoreManagerPhase = 'investigate' | 'approve' | 'verify';

export const READ_PHASES: readonly StoreManagerPhase[] = ['investigate', 'verify'] as const;

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

export interface StoreManagerAdapterContext {
  workspaceId: string;
  workspacePath: string;
  /** Durable per-run session id (store_manager_sessions.id). */
  sessionId: string;
  /** Per-chat execution id bound by the route (#34). */
  executionId: string;
  /** Absolute epoch ms after which the execution context refuses to run. */
  deadlineAt: number;
  /** Caller/whole-run AbortSignal (composed per call with a timeout). */
  signal?: AbortSignal;
  /** Resolved pinned scope (bounded identifiers only); null when unpinned. */
  pinnedScope?: StoreManagerPinnedScope | null;
  /** Entrypoint that produced this run. */
  entrypoint?: StoreManagerEntrypoint;
  /** Bounded, server-side emit hook for runtime events. */
  emit(event: StoreManagerRuntimeEvent): void;
}

/**
 * One versioned, bounded tool contract. Adapters must NOT contain raw SQL,
 * `fetch`, or filesystem writes — they call existing services/repositories
 * which own those capabilities.
 */
export interface StoreManagerToolAdapter {
  /** Stable tool name exposed to the model (kebab/snake semantics: preview/store/stage/dismiss/repair). */
  name: string;
  /** Bump on any breaking contract change. */
  version: number;
  description: string;
  /** Prompt guidance derived from this metadata (never from request data). */
  promptGuidelines: string;
  inputSchema: z.ZodType<unknown>;
  /** Optional output schema; when present, registry validates results. */
  outputSchema?: z.ZodType<unknown>;
  riskClass: 'read' | 'proposal_write' | 'catalog_mutation' | 'network_filesystem_repair';
  sideEffects: string;
  requiresApproval: boolean;
  stateTransition: string;
  /** Phases in which this adapter is allowed to dispatch. */
  allowedPhases: readonly StoreManagerPhase[];
  /**
   * Pinned scope kinds this adapter can honor. Undefined = the adapter does
   * not declare scope support (legacy adapters execute regardless); when
   * declared, the registry refuses `scope_unsupported` for any other kind.
   */
  supportedScopes?: readonly StoreManagerScopeKind[];
  /**
   * Deterministic pre-approval preview (operations console, Issue 7).
   * REQUIRED for persistent-risk adapters (the registry refuses to register
   * a persistent adapter without one). Produces the bounded action diff the
   * operator approves; dispatch recomputes it and refuses `stale_preview` on
   * any drift (bound by diff hash). Read adapters may omit it.
   */
  previewDiff?: (
    input: Record<string, unknown>,
    ctx: StoreManagerAdapterContext,
  ) => Promise<StoreManagerActionDiff | null> | StoreManagerActionDiff | null;
  /** Normalized one-line scope summary for approval cards and events. */
  scopeSummary(input: Record<string, unknown>): string;
  execute(
    params: Record<string, unknown>,
    ctx: StoreManagerAdapterContext,
  ): Promise<StoreManagerToolResult> | StoreManagerToolResult;
}

// ---------------------------------------------------------------------------
// Runtime events (versioned, redacted by construction)
// ---------------------------------------------------------------------------

export interface StoreManagerRuntimeEventBase {
  version: 1;
  sessionId: string;
  workspaceId: string;
  turnId: string;
  createdAt: string;
}

export type StoreManagerRuntimeEvent =
  | (StoreManagerRuntimeEventBase & { type: 'turn_started'; phase: StoreManagerPhase; policyHash: string; modelCallId: string | null })
  | (StoreManagerRuntimeEventBase & {
      type: 'tool_dispatched';
      toolName: string;
      toolVersion: number;
      toolRisk: StoreManagerToolAdapter['riskClass'];
      inputDigest: string;
      scope: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'tool_approval';
      toolName: string;
      toolCallId: string;
      approved: boolean;
      reason?: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'tool_result';
      toolName: string;
      status: StoreManagerToolResult['status'];
      errorCode?: string;
      reasonCode?: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'phase_changed';
      from: StoreManagerPhase;
      to: StoreManagerPhase;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'turn_terminal';
      status: 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded';
      reason?: string;
      modelCallId: string | null;
      totalToolCalls: number;
    })
  // ── Operations-console event types (Issue 1: bounded lineage/artifact hooks) ──
  | (StoreManagerRuntimeEventBase & {
      type: 'command_compiled';
      commandName: string;
      commandVersion: number;
      compiledObjective: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'plan_preview';
      expectedToolCount: number;
      modelCalls: 0;
      toolDispatches: 0;
      scopeHash: string | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'checkpoint';
      checkpointId: string;
      diffHash: string | null;
      scopeHash: string | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'artifact_created';
      artifactId: string;
      kind: StoreManagerArtifactKind;
      contentHash: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'verification_diff';
      artifactId: string | null;
      diffHash: string | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'schedule_trigger_lineage';
      scheduleId: string | null;
      triggerKind: string | null;
      occurrenceKey: string | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'playbook_lineage';
      playbookId: string | null;
      playbookVersion: number | null;
      stepId: string | null;
      stepKind: string | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'notification_linkage';
      notificationId: string;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'execution_started';
      entrypoint: StoreManagerEntrypoint;
      executionMode: StoreManagerExecutionMode;
      actorClass: StoreManagerActorClass;
      objectiveHash: string;
      scopeHash: string | null;
      lineage: StoreManagerLineage | null;
    })
  // ── Issue 7: diff-first action UX, replay lineage, bounded history queries ──
  | (StoreManagerRuntimeEventBase & {
      type: 'action_diff';
      toolName: string;
      toolVersion: number;
      diffHash: string;
      skuCount: number;
      networkActivity: string;
      stale: boolean;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'replay_lineage';
      replayOfRunId: string;
      sourceEntrypoint: StoreManagerEntrypoint | null;
    })
  | (StoreManagerRuntimeEventBase & {
      type: 'history_query';
      queryId: string;
      queryVersion: number;
      matchedRows: number;
      truncated: boolean;
    });
