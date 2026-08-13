/**
 * store_manager_sessions / store_manager_turns / store_manager_events
 * repository (epic #42, #40).
 *
 * Minimal durable audit for one Store Manager turn. Everything stored is
 * redacted by construction: policy hash/version, resolved model metadata,
 * tool name/version/risk, normalized input DIGEST and bounded scope, approval
 * outcomes, and the terminal outcome with the exact `ai_model_calls.id`.
 * Chain of thought, raw prompts, approval secrets/signatures, credentials,
 * absolute workspace paths, and raw tool/network payloads are never stored.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { StoreManagerPhase } from '../../store-manager/runtime/contracts';
import type { StoreManagerRuntimeEvent } from '../../store-manager/runtime/events';

export type StoreManagerSessionStatus = 'active' | 'terminal';
export type StoreManagerTurnStatus = 'active' | 'terminal';
export type StoreManagerTerminalStatus = 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded';

export interface CreateStoreManagerSessionInput {
  /** Optional explicit id; defaults to a fresh uuid. */
  id?: string;
  workspaceId: string;
  threadId: string | null;
  turnId: string;
  executionId: string;
  policyHash: string;
  policyVersion: 1;
  requestedModel: string | null;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedLocality: 'local' | 'cloud';
  resolutionReason: string;
  modelCallId: string | null;
}

export interface StoreManagerSessionRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  turn_id: string;
  execution_id: string;
  policy_hash: string;
  policy_version: number;
  requested_model: string | null;
  resolved_provider: string;
  resolved_model: string;
  resolved_locality: 'local' | 'cloud';
  resolution_reason: string;
  model_call_id: string | null;
  status: StoreManagerSessionStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateStoreManagerTurnInput {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  phase: StoreManagerPhase;
  policyHash: string;
}

export interface StoreManagerTurnRow {
  id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  phase: StoreManagerPhase;
  status: StoreManagerTurnStatus;
  terminal_status: StoreManagerTerminalStatus | null;
  outcome_reason: string | null;
  total_tool_calls: number;
  policy_hash: string;
  created_at: string;
  ended_at: string | null;
}

export function createStoreManagerSession(input: CreateStoreManagerSessionInput): string {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO store_manager_sessions
       (id, workspace_id, thread_id, turn_id, execution_id, policy_hash, policy_version,
        requested_model, resolved_provider, resolved_model, resolved_locality,
        resolution_reason, model_call_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.executionId,
      input.policyHash,
      input.policyVersion,
      input.requestedModel,
      input.resolvedProvider,
      input.resolvedModel,
      input.resolvedLocality,
      input.resolutionReason,
      input.modelCallId,
      now,
      now,
    ],
  );
  return id;
}

/** Workspace-scoped lookup: foreign sessions are indistinguishable from missing. */
export function getStoreManagerSession(workspaceId: string, sessionId: string): StoreManagerSessionRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_sessions WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, sessionId) as StoreManagerSessionRow | undefined;
  return row ?? null;
}

export function terminalizeStoreManagerSession(
  workspaceId: string,
  sessionId: string,
): boolean {
  const db = getDb();
  const result = db
    .query(
      "UPDATE store_manager_sessions SET status = 'terminal', updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'",
    )
    .run(new Date().toISOString(), workspaceId, sessionId);
  return result.changes > 0;
}

export function updateStoreManagerSessionModelCall(
  workspaceId: string,
  sessionId: string,
  modelCallId: string,
): boolean {
  const db = getDb();
  const result = db
    .query(
      'UPDATE store_manager_sessions SET model_call_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(modelCallId, new Date().toISOString(), workspaceId, sessionId);
  return result.changes > 0;
}

export function createStoreManagerTurn(input: CreateStoreManagerTurnInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO store_manager_turns
       (id, workspace_id, session_id, turn_id, phase, status, terminal_status,
        outcome_reason, total_tool_calls, policy_hash, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, 0, ?, ?, NULL)`,
    [id, input.workspaceId, input.sessionId, input.turnId, input.phase, input.policyHash, now],
  );
  return id;
}

export function getStoreManagerTurn(workspaceId: string, turnId: string): StoreManagerTurnRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_turns WHERE workspace_id = ? AND turn_id = ?')
    .get(workspaceId, turnId) as StoreManagerTurnRow | undefined;
  return row ?? null;
}

export function updateStoreManagerTurnPhase(
  workspaceId: string,
  turnId: string,
  phase: StoreManagerPhase,
): boolean {
  const db = getDb();
  const result = db
    .query(
      "UPDATE store_manager_turns SET phase = ?, updated_at = ? WHERE workspace_id = ? AND turn_id = ?",
    )
    .run(phase, new Date().toISOString(), workspaceId, turnId);
  return result.changes > 0;
}

export function incrementStoreManagerTurnToolCalls(
  workspaceId: string,
  turnId: string,
): number {
  const db = getDb();
  db.query(
    'UPDATE store_manager_turns SET total_tool_calls = total_tool_calls + 1, updated_at = ? WHERE workspace_id = ? AND turn_id = ?',
  ).run(new Date().toISOString(), workspaceId, turnId);
  const row = db
    .query('SELECT total_tool_calls FROM store_manager_turns WHERE workspace_id = ? AND turn_id = ?')
    .get(workspaceId, turnId) as { total_tool_calls: number } | undefined;
  return row?.total_tool_calls ?? 0;
}

export function terminalizeStoreManagerTurn(
  workspaceId: string,
  turnId: string,
  terminalStatus: StoreManagerTerminalStatus,
  outcomeReason: string | null,
  totalToolCalls: number,
): boolean {
  const db = getDb();
  const result = db
    .query(
      `UPDATE store_manager_turns
       SET status = 'terminal', terminal_status = ?, outcome_reason = ?,
           total_tool_calls = ?, ended_at = ?
       WHERE workspace_id = ? AND turn_id = ? AND status = 'active'`,
    )
    .run(terminalStatus, outcomeReason, totalToolCalls, new Date().toISOString(), workspaceId, turnId);
  return result.changes > 0;
}

/**
 * Persist an ordered event batch for one workspace. Payloads are already
 * redacted by the event constructors; this only inserts rows.
 */
export function persistStoreManagerEvents(
  workspaceId: string,
  events: readonly StoreManagerRuntimeEvent[],
): void {
  if (events.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.query(
    `INSERT INTO store_manager_events
       (id, workspace_id, session_id, turn_id, event_type, event_version, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    const payload = JSON.stringify(event);
    // Bound the persisted payload defensively (should never exceed in practice).
    if (payload.length > 64 * 1024) continue;
    insert.run(randomUUID(), workspaceId, event.sessionId, event.turnId, event.type, event.version, payload, now);
  }
}

export function getStoreManagerEvents(
  workspaceId: string,
  sessionId: string,
  limit = 200,
): StoreManagerRuntimeEvent[] {
  const db = getDb();
  const rows = db
    .query(
      'SELECT payload_json FROM store_manager_events WHERE workspace_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
    )
    .all(workspaceId, sessionId, limit) as Array<{ payload_json: string }>;
  return rows.map((r) => JSON.parse(r.payload_json) as StoreManagerRuntimeEvent);
}
