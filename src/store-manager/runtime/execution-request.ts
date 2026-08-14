/**
 * Store Manager execution request factory (operations console, Issue 1).
 *
 * Every executable entrypoint (chat, command, schedule, event, playbook,
 * replay, plan_preview) produces a strict `StoreManagerExecutionRequest` and
 * enters the single runtime runner via `runStoreManagerExecution`. This module
 * owns server-side request construction + strict validation; it contains no
 * model, tool, or service imports so it stays a pure contract boundary.
 */

import { randomUUID } from 'node:crypto';
import {
  validateStoreManagerExecutionRequest,
  deriveStoreManagerActorClass,
  type StoreManagerExecutionRequest,
  type StoreManagerEntrypoint,
  type StoreManagerExecutionMode,
  type StoreManagerActorClass,
  type StoreManagerPinnedScope,
  type StoreManagerLineage,
  type StoreManagerPolicyProfile,
} from '../../shared/schemas/store-manager-operations';

export interface StoreManagerExecutionRequestDraft {
  workspaceId: string;
  workspacePath: string;
  entrypoint: StoreManagerEntrypoint;
  objective: string;
  executionMode: StoreManagerExecutionMode;
  threadId?: string | null;
  runId?: string;
  pinnedScope?: StoreManagerPinnedScope;
  lineage?: StoreManagerLineage;
  selectedModel?: string;
  policyProfile?: StoreManagerPolicyProfile;
}

/**
 * Build a validated execution request. `runId` defaults to a fresh uuid; an
 * explicit bounded runId is accepted so replay/tests can pin identity. The
 * raw candidate (including any unknown keys) is passed through the strict
 * schema so forged/unknown fields fail before any runtime work. Throws
 * `StoreManagerExecutionRequestError` on any schema violation.
 */
export function createStoreManagerExecutionRequest(
  draft: StoreManagerExecutionRequestDraft,
): StoreManagerExecutionRequest {
  return validateStoreManagerExecutionRequest({
    ...draft,
    runId: draft.runId ?? randomUUID(),
  });
}

/** Deterministic actor class for a validated request (entrypoint/mode derived). */
export function actorClassForExecutionRequest(
  request: StoreManagerExecutionRequest,
): StoreManagerActorClass {
  return deriveStoreManagerActorClass(request.entrypoint, request.executionMode);
}

/** Default objective label for an entrypoint (used when callers do not supply one). */
export function defaultObjectiveForEntrypoint(entrypoint: StoreManagerEntrypoint): string {
  switch (entrypoint) {
    case 'chat':
      return 'Chat interaction with the Store Manager assistant.';
    case 'command':
      return 'Command-driven Store Manager operation.';
    case 'schedule':
      return 'Scheduled read-only Store Manager run.';
    case 'event':
      return 'Event-triggered read-only Store Manager run.';
    case 'playbook':
      return 'Playbook step execution.';
    case 'replay':
      return 'Replay of a prior Store Manager run against current catalog state.';
    case 'plan_preview':
      return 'Preview-only plan compilation (zero execution).';
  }
}
