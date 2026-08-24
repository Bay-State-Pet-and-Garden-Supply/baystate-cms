/**
 * store_manager_triggers / _versions / _occurrences / _leases +
 * store_manager_source_cursors repository (operations console, Issue 5).
 *
 * Workspace identity is part of every contract: lookups/updates predicate on
 * `workspace_id` so a foreign row is indistinguishable from a missing one
 * (fail closed, no ownership disclosure).
 *
 * Restart safety mirrors the schedule repo: every occurrence carries a unique
 * per-workspace `occurrence_key` (the DB UNIQUE constraint is the backstop),
 * so the same logical occurrence can never run twice. Claims are atomic
 * single statements; leases expire via `expireStaleTriggerLeases`. Source
 * cursors are updated in the same transaction as the occurrence insert
 * (cursor-after-insert), so a crash between insert and cursor commit simply
 * re-observes the same fingerprint and the unique occurrence key dedupes.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import type {
  StoreManagerTriggerDefinition,
  StoreManagerTriggerConfig,
  StoreManagerTriggerKind,
  StoreManagerTriggerOccurrence,
  StoreManagerTriggerOccurrenceStatus,
  StoreManagerSourceCursor,
  StoreManagerTriggerSourceRef,
} from '../../shared/schemas/store-manager-trigger';

export interface TriggerDefinitionRow extends StoreManagerTriggerDefinition {
  enableAuditJson: string | null;
}

export interface CreateTriggerInput {
  id?: string;
  workspaceId: string;
  name: string;
  kind: StoreManagerTriggerKind;
  config: StoreManagerTriggerConfig;
  scopeJson: string | null;
  selectedModel: string | null;
  objective: string;
  definitionHash: string;
  enabled?: boolean;
  enableAuditJson?: string | null;
  createdAt?: string;
}

export interface CreateTriggerOccurrenceInput {
  id?: string;
  workspaceId: string;
  triggerId: string;
  triggerVersion: number;
  occurrenceKey: string;
  sourceRef: StoreManagerTriggerSourceRef;
  scopeJson: string | null;
  scheduledAt: string;
  status?: StoreManagerTriggerOccurrenceStatus;
  errorCode?: string | null;
}

export interface UpsertSourceCursorInput {
  id?: string;
  workspaceId: string;
  sourceKind: string;
  sourceId: string;
  fingerprint: string;
  baselineJson?: string | null;
  terminalObserved?: boolean;
  lastObservedAt?: string;
}

function mapTriggerRow(row: Record<string, unknown>): TriggerDefinitionRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    version: Number(row.version),
    kind: String(row.kind) as StoreManagerTriggerKind,
    enabled: Number(row.enabled) === 1,
    config: JSON.parse(String(row.config_json)) as StoreManagerTriggerConfig,
    scope: row.scope_json ? JSON.parse(String(row.scope_json)) : null,
    selectedModel: row.selected_model ? String(row.selected_model) : null,
    objective: String(row.objective),
    definitionHash: String(row.definition_hash),
    lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
    lastScanStatus: row.last_scan_status ? (String(row.last_scan_status) as StoreManagerTriggerDefinition['lastScanStatus']) : null,
    lastRunId: row.last_run_id ? String(row.last_run_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    enableAuditJson: row.enable_audit_json ? String(row.enable_audit_json) : null,
  };
}

function mapOccurrenceRow(row: Record<string, unknown>): StoreManagerTriggerOccurrence {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    triggerId: String(row.trigger_id),
    triggerVersion: Number(row.trigger_version),
    occurrenceKey: String(row.occurrence_key),
    sourceRef: { kind: String(row.source_kind), id: String(row.source_id) },
    scopeJson: row.scope_json ? String(row.scope_json) : null,
    scheduledAt: String(row.scheduled_at),
    status: String(row.status) as StoreManagerTriggerOccurrenceStatus,
    runId: row.run_id ? String(row.run_id) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    retryCount: Number(row.retry_count),
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCursorRow(row: Record<string, unknown>): StoreManagerSourceCursor {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    fingerprint: String(row.fingerprint),
    baselineJson: row.baseline_json ? String(row.baseline_json) : null,
    terminalObserved: Number(row.terminal_observed) === 1,
    lastObservedAt: String(row.last_observed_at),
    evalCount: Number(row.eval_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Trigger definitions
// ---------------------------------------------------------------------------

export function createTrigger(input: CreateTriggerInput): TriggerDefinitionRow {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_triggers
       (id, workspace_id, name, version, kind, enabled, config_json, scope_json,
        selected_model, objective, definition_hash, enable_audit_json, last_scan_at,
        last_scan_status, last_run_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      id, input.workspaceId, input.name, input.kind, input.enabled ? 1 : 0,
      JSON.stringify(input.config), input.scopeJson, input.selectedModel,
      input.objective, input.definitionHash, input.enableAuditJson ?? null, now, now,
    ],
  );
  insertTriggerVersion(db, id, input.workspaceId, 1, input.definitionHash, now, input);
  const row = db.query('SELECT * FROM store_manager_triggers WHERE id = ?').get(id) as Record<string, unknown>;
  return mapTriggerRow(row);
}

function insertTriggerVersion(
  db: { run(sql: string, params: unknown[]): { changes?: number } },
  triggerId: string,
  workspaceId: string,
  version: number,
  definitionHash: string,
  now: string,
  input: CreateTriggerInput,
): void {
  const definition = {
    id: triggerId,
    workspaceId,
    name: input.name,
    version,
    kind: input.kind,
    enabled: input.enabled ?? false,
    config: input.config,
    scope: input.scopeJson ? JSON.parse(input.scopeJson) : null,
    selectedModel: input.selectedModel,
    objective: input.objective,
    definitionHash,
    lastScanAt: null,
    lastScanStatus: null,
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO store_manager_trigger_versions
       (id, workspace_id, trigger_id, version, definition_json, definition_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), workspaceId, triggerId, version, JSON.stringify(definition), definitionHash, now],
  );
}

export function getTrigger(workspaceId: string, id: string): TriggerDefinitionRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_triggers WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? mapTriggerRow(row) : null;
}

export function listTriggers(workspaceId: string, limit = 100): TriggerDefinitionRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return (
    db
      .query(
        'SELECT * FROM store_manager_triggers WHERE workspace_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(workspaceId, bounded) as Record<string, unknown>[]
  ).map(mapTriggerRow);
}

/** Enabled triggers in a workspace (the observation scanner's source). */
export function listEnabledTriggers(workspaceId: string, limit = 100): TriggerDefinitionRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return (
    db
      .query(
        'SELECT * FROM store_manager_triggers WHERE workspace_id = ? AND enabled = 1 ORDER BY created_at ASC LIMIT ?',
      )
      .all(workspaceId, bounded) as Record<string, unknown>[]
  ).map(mapTriggerRow);
}

/** Atomically bump the definition version (immutable version row + pointer). */
export function updateTriggerDefinition(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<CreateTriggerInput, 'name' | 'config' | 'scopeJson' | 'selectedModel' | 'objective' | 'definitionHash'>>,
): TriggerDefinitionRow {
  const db = getDb();
  const existing = getTrigger(workspaceId, id);
  if (!existing) throw new Error('Trigger not found in this workspace.');
  const nextVersion = existing.version + 1;
  const now = new Date().toISOString();
  const merged: CreateTriggerInput = {
    workspaceId,
    name: patch.name ?? existing.name,
    kind: existing.kind,
    config: patch.config ?? existing.config,
    scopeJson: patch.scopeJson !== undefined ? patch.scopeJson : existing.scope ? JSON.stringify(existing.scope) : null,
    selectedModel: patch.selectedModel !== undefined ? patch.selectedModel : existing.selectedModel,
    objective: patch.objective ?? existing.objective,
    definitionHash: patch.definitionHash ?? existing.definitionHash,
    enabled: existing.enabled,
  };
  insertTriggerVersion(db, id, workspaceId, nextVersion, merged.definitionHash, now, merged);
  db.run(
    `UPDATE store_manager_triggers
     SET name = ?, version = ?, config_json = ?, scope_json = ?, selected_model = ?,
         objective = ?, definition_hash = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      merged.name, nextVersion, JSON.stringify(merged.config), merged.scopeJson,
      merged.selectedModel, merged.objective, merged.definitionHash, now, workspaceId, id,
    ],
  );
  const row = db.query('SELECT * FROM store_manager_triggers WHERE id = ?').get(id) as Record<string, unknown>;
  return mapTriggerRow(row);
}

export function setTriggerEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
  auditJson: string,
): TriggerDefinitionRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      'UPDATE store_manager_triggers SET enabled = ?, enable_audit_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(enabled ? 1 : 0, auditJson, now, workspaceId, id);
  if (Number(result.changes ?? 0) === 0) return null;
  return getTrigger(workspaceId, id);
}

export function updateTriggerScanState(
  workspaceId: string,
  id: string,
  fields: {
    lastScanAt: string;
    lastScanStatus: StoreManagerTriggerDefinition['lastScanStatus'];
    lastRunId?: string | null;
  },
): void {
  const db = getDb();
  db.run(
    `UPDATE store_manager_triggers
     SET last_scan_at = ?, last_scan_status = ?, last_run_id = COALESCE(?, last_run_id), updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [fields.lastScanAt, fields.lastScanStatus, fields.lastRunId ?? null, new Date().toISOString(), workspaceId, id],
  );
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/**
 * Insert one occurrence. The per-workspace UNIQUE(workspace_id, occurrence_key)
 * constraint is the restart/at-least-once backstop: a duplicate key is ignored
 * and the existing row returned (an occurrence can never double-run).
 */
export function createTriggerOccurrence(input: CreateTriggerOccurrenceInput): StoreManagerTriggerOccurrence {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .query('SELECT * FROM store_manager_trigger_occurrences WHERE workspace_id = ? AND occurrence_key = ?')
    .get(input.workspaceId, input.occurrenceKey) as Record<string, unknown> | undefined;
  if (existing) return mapOccurrenceRow(existing);
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_trigger_occurrences
       (id, workspace_id, trigger_id, trigger_version, occurrence_key, source_kind,
        source_id, scope_json, scheduled_at, status, run_id, error_code, retry_count,
        claimed_at, lease_expires_at, heartbeat_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id, input.workspaceId, input.triggerId, input.triggerVersion, input.occurrenceKey,
      input.sourceRef.kind, input.sourceRef.id, input.scopeJson, input.scheduledAt,
      input.status ?? 'pending', input.errorCode ?? null, now, now,
    ],
  );
  return mapOccurrenceRow(
    db.query('SELECT * FROM store_manager_trigger_occurrences WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function getTriggerOccurrence(workspaceId: string, id: string): StoreManagerTriggerOccurrence | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_trigger_occurrences WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? mapOccurrenceRow(row) : null;
}

export function listDueTriggerOccurrences(
  workspaceId: string,
  nowIso: string,
  opts: { limit?: number } = {},
): StoreManagerTriggerOccurrence[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const rows = db
    .query(
      `SELECT * FROM store_manager_trigger_occurrences
       WHERE workspace_id = ? AND status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .all(workspaceId, nowIso, limit) as Record<string, unknown>[];
  return rows.map(mapOccurrenceRow);
}

export function claimTriggerOccurrence(
  workspaceId: string,
  occurrenceId: string,
  owner: string,
  leaseMs: number,
  nowIso: string,
): boolean {
  const db = getDb();
  const leaseExpiresIso = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
  const result = db
    .query(
      `UPDATE store_manager_trigger_occurrences
       SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(nowIso, leaseExpiresIso, nowIso, nowIso, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return false;
  const occurrence = getTriggerOccurrence(workspaceId, occurrenceId);
  db.query(
    `INSERT INTO store_manager_trigger_leases
       (occurrence_id, workspace_id, trigger_id, owner, claimed_at, lease_expires_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(occurrence_id) DO UPDATE SET
       owner = excluded.owner, claimed_at = excluded.claimed_at,
       lease_expires_at = excluded.lease_expires_at, heartbeat_at = excluded.heartbeat_at`,
  ).run(
    occurrenceId,
    workspaceId,
    occurrence?.triggerId ?? '',
    owner,
    nowIso,
    leaseExpiresIso,
    nowIso,
  );
  return true;
}

export function heartbeatTriggerOccurrence(
  workspaceId: string,
  occurrenceId: string,
  leaseMs: number,
  nowIso: string,
): boolean {
  const db = getDb();
  const leaseExpiresIso = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
  const result = db
    .query(
      `UPDATE store_manager_trigger_occurrences
       SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(nowIso, leaseExpiresIso, nowIso, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return false;
  db.query(
    `UPDATE store_manager_trigger_leases SET heartbeat_at = ?, lease_expires_at = ? WHERE occurrence_id = ?`,
  ).run(nowIso, leaseExpiresIso, occurrenceId);
  return true;
}

export interface FinalizeTriggerOccurrenceInput {
  workspaceId: string;
  occurrenceId: string;
  status: Exclude<StoreManagerTriggerOccurrenceStatus, 'pending' | 'claimed'>;
  runId?: string | null;
  errorCode?: string | null;
  nowIso?: string;
}

export function finalizeTriggerOccurrence(input: FinalizeTriggerOccurrenceInput): StoreManagerTriggerOccurrence | null {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_trigger_occurrences
       SET status = ?, run_id = ?, error_code = ?, completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(input.status, input.runId ?? null, input.errorCode ?? null, now, now, input.workspaceId, input.occurrenceId);
  if (Number(result.changes ?? 0) === 0) return null;
  db.query('DELETE FROM store_manager_trigger_leases WHERE occurrence_id = ?').run(input.occurrenceId);
  return getTriggerOccurrence(input.workspaceId, input.occurrenceId);
}

export function requeueTriggerOccurrence(
  workspaceId: string,
  occurrenceId: string,
  retryAtIso: string,
  errorCode: string,
): StoreManagerTriggerOccurrence | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_trigger_occurrences
       SET status = 'pending', scheduled_at = ?, retry_count = retry_count + 1,
           error_code = ?, claimed_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(retryAtIso, errorCode, now, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return null;
  db.query('DELETE FROM store_manager_trigger_leases WHERE occurrence_id = ?').run(occurrenceId);
  return getTriggerOccurrence(workspaceId, occurrenceId);
}

/** Mark overdue pending occurrences as cancelled (beyond the catch-up window). */
export function cancelOverdueTriggerOccurrences(
  workspaceId: string,
  cutoffIso: string,
  limit = 200,
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_trigger_occurrences
       SET status = 'cancelled', error_code = 'catch_up_window_exceeded', completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id IN (
         SELECT id FROM store_manager_trigger_occurrences
         WHERE workspace_id = ? AND status = 'pending' AND scheduled_at < ? LIMIT ?
       )`,
    )
    .run(now, now, workspaceId, workspaceId, cutoffIso, Math.min(limit, 200));
  return Number(result.changes ?? 0);
}

/** Reset expired leases back to pending so a crashed claim is retried. */
export function expireStaleTriggerLeases(workspaceId: string, nowIso: string, limit = 200): number {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db
    .query(
      `SELECT o.id FROM store_manager_trigger_occurrences o
       JOIN store_manager_trigger_leases l ON l.occurrence_id = o.id
       WHERE o.workspace_id = ? AND o.status = 'claimed' AND l.lease_expires_at < ?
       LIMIT ?`,
    )
    .all(workspaceId, nowIso, Math.min(limit, 200)) as Array<{ id: string }>;
  for (const row of rows) {
    db.query(
      `UPDATE store_manager_trigger_occurrences
       SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           error_code = 'lease_expired', updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    ).run(now, workspaceId, row.id);
    db.query('DELETE FROM store_manager_trigger_leases WHERE occurrence_id = ?').run(row.id);
  }
  return rows.length;
}

export function listOccurrencesByTrigger(
  workspaceId: string,
  triggerId: string,
  opts: { limit?: number; status?: StoreManagerTriggerOccurrenceStatus } = {},
): StoreManagerTriggerOccurrence[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: (string | number)[] = [workspaceId, triggerId];
  let where = 'workspace_id = ? AND trigger_id = ?';
  if (opts.status) {
    where += ' AND status = ?';
    params.push(opts.status);
  }
  params.push(limit);
  return (
    db
      .query(
        `SELECT * FROM store_manager_trigger_occurrences WHERE ${where} ORDER BY scheduled_at DESC LIMIT ?`,
      )
      .all(...(params as [string, ...(string | number)[]])) as Record<string, unknown>[]
  ).map(mapOccurrenceRow);
}

/** Recent terminal occurrences across triggers (bounded, newest first). */
export function listRecentTerminalTriggerOccurrences(
  workspaceId: string,
  sinceIso: string,
  limit = 50,
): StoreManagerTriggerOccurrence[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return (
    db
      .query(
        `SELECT * FROM store_manager_trigger_occurrences
         WHERE workspace_id = ? AND status IN ('failed', 'unavailable')
           AND (completed_at IS NOT NULL AND completed_at >= ?)
         ORDER BY completed_at DESC LIMIT ?`,
      )
      .all(workspaceId, sinceIso, bounded) as Record<string, unknown>[]
  ).map(mapOccurrenceRow);
}

// ---------------------------------------------------------------------------
// Source cursors
// ---------------------------------------------------------------------------

export function getSourceCursor(
  workspaceId: string,
  sourceKind: string,
  sourceId: string,
): StoreManagerSourceCursor | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_source_cursors WHERE workspace_id = ? AND source_kind = ? AND source_id = ?')
    .get(workspaceId, sourceKind, sourceId) as Record<string, unknown> | undefined;
  return row ? mapCursorRow(row) : null;
}

/**
 * Upsert one source cursor. `lastObservedAt` defaults to now; `evalCount`
 * increments when the caller passes `incrementEval`. Returns the stored row.
 */
export function upsertSourceCursor(input: UpsertSourceCursorInput): StoreManagerSourceCursor {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getSourceCursor(input.workspaceId, input.sourceKind, input.sourceId);
  const id = input.id ?? existing?.id ?? randomUUID();
  const lastObservedAt = input.lastObservedAt ?? existing?.lastObservedAt ?? now;
  const evalCount = (existing?.evalCount ?? 0) + 1;
  db.query(
    `INSERT INTO store_manager_source_cursors
       (id, workspace_id, source_kind, source_id, fingerprint, baseline_json,
        terminal_observed, last_observed_at, eval_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, source_kind, source_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       baseline_json = COALESCE(excluded.baseline_json, store_manager_source_cursors.baseline_json),
       terminal_observed = excluded.terminal_observed,
       last_observed_at = excluded.last_observed_at,
       eval_count = excluded.eval_count,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.workspaceId,
    input.sourceKind,
    input.sourceId,
    input.fingerprint,
    input.baselineJson ?? null,
    input.terminalObserved ?? false ? 1 : 0,
    lastObservedAt,
    evalCount,
    now,
    now,
  );
  return getSourceCursor(input.workspaceId, input.sourceKind, input.sourceId)!;
}
