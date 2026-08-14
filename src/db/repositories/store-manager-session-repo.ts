/**
 * store_manager_sessions / store_manager_turns / store_manager_events /
 * store_manager_run_artifacts repository (epic #42, #40; operations console).
 *
 * Minimal durable audit for one Store Manager run. Everything stored is
 * redacted by construction: policy hash + immutable policy snapshot, resolved
 * model metadata, entrypoint/mode/actor, pinned-scope digest, bounded lineage,
 * tool name/version/risk, normalized input DIGEST and bounded scope, approval
 * outcomes, and the terminal outcome with the exact `ai_model_calls.id`.
 * Chain of thought, raw prompts, approval secrets/signatures, credentials,
 * absolute workspace paths, and raw tool/network payloads are never stored.
 *
 * The operations-console schema (new columns, event sequence, artifacts) is
 * created by `src/db/store-manager-operations-migration.ts`; this repository
 * self-heals via `ensureStoreManagerOperationsSchema()` before any write so a
 * pre-operations DB upgrades lazily.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import { verifyPolicySnapshot } from '../../store-manager/runtime/policy';
import type { StoreManagerRuntimePolicy } from '../../store-manager/runtime/policy';
import type { StoreManagerPhase } from '../../store-manager/runtime/contracts';
import type { StoreManagerRuntimeEvent } from '../../store-manager/runtime/events';
import type {
  StoreManagerArtifactKind,
  StoreManagerEntrypoint,
  StoreManagerExecutionMode,
  StoreManagerActorClass,
} from '../../shared/schemas/store-manager-operations';

export type StoreManagerSessionStatus = 'active' | 'terminal';
export type StoreManagerTurnStatus = 'active' | 'terminal';
export type StoreManagerTerminalStatus = 'success' | 'failed' | 'cancelled' | 'policy_denied' | 'deadline_exceeded';

export interface CreateStoreManagerSessionInput {
  /** Optional explicit id (run id); defaults to a fresh uuid. */
  id?: string;
  workspaceId: string;
  threadId: string | null;
  turnId: string;
  executionId: string;
  policyHash: string;
  policyVersion: number;
  /** Immutable policy snapshot JSON (hash-verified on read). */
  policySnapshotJson?: string | null;
  requestedModel: string | null;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedLocality: 'local' | 'cloud';
  resolutionReason: string;
  modelCallId: string | null;
  objective?: string | null;
  entrypoint?: StoreManagerEntrypoint | null;
  executionMode?: StoreManagerExecutionMode | null;
  actorClass?: StoreManagerActorClass | null;
  scopeJson?: string | null;
  scopeHash?: string | null;
  promptVersion?: string | null;
  lineageJson?: string | null;
}

export interface StoreManagerSessionRow {
  id: string;
  workspace_id: string;
  thread_id: string | null;
  turn_id: string;
  execution_id: string;
  policy_hash: string;
  policy_version: number;
  policy_snapshot_json: string | null;
  requested_model: string | null;
  resolved_provider: string;
  resolved_model: string;
  resolved_locality: 'local' | 'cloud';
  resolution_reason: string;
  model_call_id: string | null;
  objective: string | null;
  entrypoint: StoreManagerEntrypoint | null;
  execution_mode: StoreManagerExecutionMode | null;
  actor_class: StoreManagerActorClass | null;
  scope_json: string | null;
  scope_hash: string | null;
  prompt_version: string | null;
  lineage_json: string | null;
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

/** Thrown when a run's policy snapshot is missing or fails hash verification. */
export class StoreManagerPolicySnapshotError extends Error {
  readonly code: 'policy_snapshot_missing' | 'policy_snapshot_invalid' | 'run_not_found';
  constructor(code: StoreManagerPolicySnapshotError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerPolicySnapshotError';
    this.code = code;
  }
}

export function createStoreManagerSession(input: CreateStoreManagerSessionInput): string {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO store_manager_sessions
       (id, workspace_id, thread_id, turn_id, execution_id, policy_hash, policy_version,
        policy_snapshot_json, requested_model, resolved_provider, resolved_model,
        resolved_locality, resolution_reason, model_call_id,
        objective, entrypoint, execution_mode, actor_class, scope_json, scope_hash,
        prompt_version, lineage_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.executionId,
      input.policyHash,
      input.policyVersion,
      input.policySnapshotJson ?? null,
      input.requestedModel,
      input.resolvedProvider,
      input.resolvedModel,
      input.resolvedLocality,
      input.resolutionReason,
      input.modelCallId,
      input.objective ?? null,
      input.entrypoint ?? null,
      input.executionMode ?? null,
      input.actorClass ?? null,
      input.scopeJson ?? null,
      input.scopeHash ?? null,
      input.promptVersion ?? null,
      input.lineageJson ?? null,
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

// ---------------------------------------------------------------------------
// Run listing / detail (workspace-scoped, cursor paginated)
// ---------------------------------------------------------------------------

export interface StoreManagerRunCursor {
  createdAt: string;
  id: string;
}

export interface ListStoreManagerRunsOptions {
  /** Cursor from the previous page (last row's createdAt + id). */
  after?: StoreManagerRunCursor | null;
  /** Page size: 1..200, default 50. */
  limit?: number;
  /** Optional entrypoint filter (bounded). */
  entrypoint?: StoreManagerEntrypoint | null;
}

export function getStoreManagerRuns(
  workspaceId: string,
  opts: ListStoreManagerRunsOptions = {},
): StoreManagerSessionRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const base = 'FROM store_manager_sessions WHERE workspace_id = ?';
  const params: unknown[] = [workspaceId];
  let where = base;
  if (opts.entrypoint) {
    where += ' AND entrypoint = ?';
    params.push(opts.entrypoint);
  }
  if (opts.after) {
    where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(opts.after.createdAt, opts.after.createdAt, opts.after.id);
  }
  params.push(limit);
  return db
    .query(`SELECT * ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(params as any[])) as StoreManagerSessionRow[];
}

/**
 * Durable policy snapshot for a run with hash verification. Throws
 * `StoreManagerPolicySnapshotError` (fail closed) when the run is foreign/
 * missing, the snapshot is absent, or the recomputed hash does not match the
 * recorded policy hash.
 */
export function getStoreManagerPolicySnapshot(
  workspaceId: string,
  runId: string,
): StoreManagerRuntimePolicy {
  const row = getStoreManagerSession(workspaceId, runId);
  if (!row) {
    throw new StoreManagerPolicySnapshotError('run_not_found', `Run "${runId}" was not found in this workspace.`);
  }
  if (!row.policy_snapshot_json) {
    throw new StoreManagerPolicySnapshotError(
      'policy_snapshot_missing',
      `Run "${runId}" has no persisted policy snapshot; replay/inspection refused.`,
    );
  }
  if (!verifyPolicySnapshot(row.policy_snapshot_json, row.policy_hash)) {
    throw new StoreManagerPolicySnapshotError(
      'policy_snapshot_invalid',
      `Run "${runId}" policy snapshot failed hash verification; replay/inspection refused.`,
    );
  }
  return JSON.parse(row.policy_snapshot_json) as StoreManagerRuntimePolicy;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Events (ordered, monotonic per-workspace sequence for cursor pagination/SSE)
// ---------------------------------------------------------------------------

/**
 * Persist an ordered event batch for one workspace. Payloads are already
 * redacted by the event constructors; this only inserts rows. Each row gets a
 * monotonic per-workspace `sequence` (max+1) so consumers can page/replay
 * deterministically even when `created_at` collides.
 */
export function persistStoreManagerEvents(
  workspaceId: string,
  events: readonly StoreManagerRuntimeEvent[],
): void {
  if (events.length === 0) return;
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const seqRow = db
    .query('SELECT COALESCE(MAX(sequence), 0) AS seq FROM store_manager_events WHERE workspace_id = ?')
    .get(workspaceId) as { seq: number };
  let next = seqRow.seq;
  const insert = db.query(
    `INSERT INTO store_manager_events
       (id, workspace_id, session_id, turn_id, event_type, event_version, payload_json, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    const payload = JSON.stringify(event);
    // Bound the persisted payload defensively (should never exceed in practice).
    if (payload.length > 64 * 1024) continue;
    next += 1;
    insert.run(randomUUID(), workspaceId, event.sessionId, event.turnId, event.type, event.version, payload, next, now);
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
      'SELECT payload_json FROM store_manager_events WHERE workspace_id = ? AND session_id = ? ORDER BY sequence ASC LIMIT ?',
    )
    .all(workspaceId, sessionId, limit) as Array<{ payload_json: string }>;
  return rows.map((r) => JSON.parse(r.payload_json) as StoreManagerRuntimeEvent);
}

export interface StoreManagerEventRow {
  id: string;
  sequence: number;
  session_id: string;
  turn_id: string;
  event_type: string;
  event_version: number;
  payload_json: string;
  created_at: string;
}

/** Cursor-based event listing (workspace-scoped, bounded). */
export function getStoreManagerEventsCursored(
  workspaceId: string,
  opts: { afterSequence?: number | null; limit?: number; sessionId?: string | null } = {},
): StoreManagerEventRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const params: unknown[] = [workspaceId];
  let where = 'workspace_id = ?';
  if (opts.sessionId) {
    where += ' AND session_id = ?';
    params.push(opts.sessionId);
  }
  if (opts.afterSequence != null) {
    where += ' AND sequence > ?';
    params.push(opts.afterSequence);
  }
  params.push(limit);
  return db
    .query(
      `SELECT id, sequence, session_id, turn_id, event_type, event_version, payload_json, created_at
       FROM store_manager_events WHERE ${where} ORDER BY sequence ASC LIMIT ?`,
    )
    .all(...(params as any[])) as StoreManagerEventRow[];
}

// ---------------------------------------------------------------------------
// Immutable run artifacts
// ---------------------------------------------------------------------------

export interface CreateStoreManagerRunArtifactInput {
  id?: string;
  workspaceId: string;
  runId: string;
  kind: StoreManagerArtifactKind;
  schemaVersion: number;
  contentJson: string;
  contentHash: string;
  createdAt?: string;
}

export interface StoreManagerRunArtifactRow {
  id: string;
  workspace_id: string;
  run_id: string;
  kind: StoreManagerArtifactKind;
  schema_version: number;
  content_json: string;
  content_hash: string;
  created_at: string;
}

export function createStoreManagerRunArtifact(input: CreateStoreManagerRunArtifactInput): string {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_run_artifacts
       (id, workspace_id, run_id, kind, schema_version, content_json, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.runId,
      input.kind,
      input.schemaVersion,
      input.contentJson,
      input.contentHash,
      input.createdAt ?? new Date().toISOString(),
    ],
  );
  return id;
}

export function getStoreManagerRunArtifacts(
  workspaceId: string,
  runId: string,
  limit = 50,
): StoreManagerRunArtifactRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return db
    .query(
      `SELECT * FROM store_manager_run_artifacts WHERE workspace_id = ? AND run_id = ?
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(workspaceId, runId, bounded) as StoreManagerRunArtifactRow[];
}

export function getStoreManagerRunArtifact(
  workspaceId: string,
  artifactId: string,
): StoreManagerRunArtifactRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_run_artifacts WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, artifactId) as StoreManagerRunArtifactRow | undefined;
  return row ?? null;
}
