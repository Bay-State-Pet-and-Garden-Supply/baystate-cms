/**
 * store_manager_schedules / _versions / _occurrences / _leases repository
 * (operations console, Issue 4).
 *
 * Workspace identity is part of every contract: lookups/updates predicate on
 * `workspace_id` so a foreign row is indistinguishable from a missing one.
 *
 * Restart safety: every occurrence carries a unique per-workspace
 * `occurrence_key` (the DB UNIQUE constraint is the backstop), so the same
 * logical occurrence can never be inserted twice. Claims are atomic single
 * statements (`UPDATE ... WHERE status = 'pending'`); a competing worker
 * sees zero affected rows and refuses. Leases expire via the scheduler's
 * `expireStaleLeases`; a crashed claim returns to `pending` and is retried.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import type {
  StoreManagerScheduleDefinition,
  StoreManagerScheduleOccurrence,
  StoreManagerOccurrenceStatus,
} from '../../shared/schemas/store-manager-schedule';

export interface ScheduleDefinitionRow extends StoreManagerScheduleDefinition {
  enableAuditJson: string | null;
}

export interface CreateScheduleInput {
  id?: string;
  workspaceId: string;
  name: string;
  templateKind: StoreManagerScheduleDefinition['templateKind'];
  timezone: string;
  recurrencePreset: StoreManagerScheduleDefinition['recurrencePreset'];
  timeOfDay: string;
  dayOfWeek: number | null;
  scopeJson: string | null;
  selectedModel: string | null;
  objective: string;
  definitionHash: string;
  policyProfileJson: string | null;
  enabled?: boolean;
  enableAuditJson?: string | null;
  createdAt?: string;
}

export interface CreateOccurrenceInput {
  id?: string;
  workspaceId: string;
  scheduleId: string;
  scheduleVersion: number;
  occurrenceKey: string;
  scheduledAt: string;
  status?: StoreManagerOccurrenceStatus;
}

function mapScheduleRow(row: Record<string, unknown>): ScheduleDefinitionRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    version: Number(row.version),
    templateKind: String(row.template_kind) as StoreManagerScheduleDefinition['templateKind'],
    enabled: Number(row.enabled) === 1,
    timezone: String(row.timezone),
    recurrencePreset: String(row.recurrence_preset) as StoreManagerScheduleDefinition['recurrencePreset'],
    timeOfDay: String(row.time_of_day),
    dayOfWeek: row.day_of_week != null ? Number(row.day_of_week) : null,
    scope: row.scope_json ? JSON.parse(String(row.scope_json)) : null,
    selectedModel: row.selected_model ? String(row.selected_model) : null,
    objective: String(row.objective),
    definitionHash: String(row.definition_hash),
    policyProfile: row.policy_profile_json ? JSON.parse(String(row.policy_profile_json)) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    lastRunStatus: row.last_run_status ? (String(row.last_run_status) as StoreManagerOccurrenceStatus) : null,
    lastRunId: row.last_run_id ? String(row.last_run_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    enableAuditJson: row.enable_audit_json ? String(row.enable_audit_json) : null,
  };
}

function mapOccurrenceRow(row: Record<string, unknown>): StoreManagerScheduleOccurrence {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    scheduleId: String(row.schedule_id),
    scheduleVersion: Number(row.schedule_version),
    occurrenceKey: String(row.occurrence_key),
    scheduledAt: String(row.scheduled_at),
    status: String(row.status) as StoreManagerOccurrenceStatus,
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

// ---------------------------------------------------------------------------
// Schedule definitions
// ---------------------------------------------------------------------------

export function createSchedule(input: CreateScheduleInput): ScheduleDefinitionRow {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_schedules
       (id, workspace_id, name, version, template_kind, enabled, timezone,
        recurrence_preset, time_of_day, day_of_week, scope_json, selected_model,
        objective, definition_hash, policy_profile_json, next_run_at, last_run_at,
        last_run_status, last_run_id, enable_audit_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [
      id, input.workspaceId, input.name, input.templateKind, input.enabled ? 1 : 0,
      input.timezone, input.recurrencePreset, input.timeOfDay, input.dayOfWeek,
      input.scopeJson, input.selectedModel, input.objective, input.definitionHash,
      input.policyProfileJson, input.enableAuditJson ?? null, now, now,
    ],
  );
  insertScheduleVersion(db, id, input.workspaceId, 1, input.definitionHash, now, input);
  const row = db.query('SELECT * FROM store_manager_schedules WHERE id = ?').get(id) as Record<string, unknown>;
  return mapScheduleRow(row);
}

function insertScheduleVersion(
  db: { run(sql: string, params: unknown[]): { changes?: number } },
  scheduleId: string,
  workspaceId: string,
  version: number,
  definitionHash: string,
  now: string,
  input: CreateScheduleInput,
): void {
  const definition = {
    id: scheduleId,
    workspaceId,
    name: input.name,
    version,
    templateKind: input.templateKind,
    enabled: input.enabled ?? false,
    timezone: input.timezone,
    recurrencePreset: input.recurrencePreset,
    timeOfDay: input.timeOfDay,
    dayOfWeek: input.dayOfWeek,
    scope: input.scopeJson ? JSON.parse(input.scopeJson) : null,
    selectedModel: input.selectedModel,
    objective: input.objective,
    definitionHash,
    policyProfile: input.policyProfileJson ? JSON.parse(input.policyProfileJson) : null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO store_manager_schedule_versions
       (id, workspace_id, schedule_id, version, definition_json, definition_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), workspaceId, scheduleId, version, JSON.stringify(definition), definitionHash, now],
  );
}

export function getSchedule(workspaceId: string, id: string): ScheduleDefinitionRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_schedules WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? mapScheduleRow(row) : null;
}

export function listSchedules(workspaceId: string, limit = 100): ScheduleDefinitionRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return (
    db
      .query(
        'SELECT * FROM store_manager_schedules WHERE workspace_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(workspaceId, bounded) as Record<string, unknown>[]
  ).map(mapScheduleRow);
}

/**
 * Atomically bump the definition version: writes the immutable version row
 * and updates the schedule pointer. Throws when the schedule is foreign.
 */
export function updateScheduleDefinition(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<CreateScheduleInput, 'name' | 'timezone' | 'recurrencePreset' | 'timeOfDay' | 'dayOfWeek' | 'scopeJson' | 'selectedModel' | 'objective' | 'definitionHash' | 'policyProfileJson'>>,
): ScheduleDefinitionRow {
  const db = getDb();
  const existing = getSchedule(workspaceId, id);
  if (!existing) {
    throw new Error('Schedule not found in this workspace.');
  }
  const nextVersion = existing.version + 1;
  const now = new Date().toISOString();
  const merged: CreateScheduleInput = {
    workspaceId,
    name: patch.name ?? existing.name,
    templateKind: existing.templateKind,
    timezone: patch.timezone ?? existing.timezone,
    recurrencePreset: patch.recurrencePreset ?? existing.recurrencePreset,
    timeOfDay: patch.timeOfDay ?? existing.timeOfDay,
    dayOfWeek: patch.dayOfWeek !== undefined ? patch.dayOfWeek : existing.dayOfWeek,
    scopeJson: patch.scopeJson !== undefined ? patch.scopeJson : existing.scope ? JSON.stringify(existing.scope) : null,
    selectedModel: patch.selectedModel !== undefined ? patch.selectedModel : existing.selectedModel,
    objective: patch.objective ?? existing.objective,
    definitionHash: patch.definitionHash ?? existing.definitionHash,
    policyProfileJson:
      patch.policyProfileJson !== undefined
        ? patch.policyProfileJson
        : existing.policyProfile
          ? JSON.stringify(existing.policyProfile)
          : null,
    enabled: existing.enabled,
  };
  insertScheduleVersion(db, id, workspaceId, nextVersion, merged.definitionHash, now, merged);
  db.run(
    `UPDATE store_manager_schedules
     SET name = ?, version = ?, timezone = ?, recurrence_preset = ?, time_of_day = ?,
         day_of_week = ?, scope_json = ?, selected_model = ?, objective = ?,
         definition_hash = ?, policy_profile_json = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      merged.name, nextVersion, merged.timezone, merged.recurrencePreset, merged.timeOfDay,
      merged.dayOfWeek, merged.scopeJson, merged.selectedModel, merged.objective,
      merged.definitionHash, merged.policyProfileJson, now, workspaceId, id,
    ],
  );
  const row = db.query('SELECT * FROM store_manager_schedules WHERE id = ?').get(id) as Record<string, unknown>;
  return mapScheduleRow(row);
}

export function setScheduleEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
  auditJson: string,
): ScheduleDefinitionRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      'UPDATE store_manager_schedules SET enabled = ?, enable_audit_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(enabled ? 1 : 0, auditJson, now, workspaceId, id);
  if (Number(result.changes ?? 0) === 0) return null;
  return getSchedule(workspaceId, id);
}

export function updateScheduleRunState(
  workspaceId: string,
  id: string,
  fields: {
    nextRunAt: string | null;
    lastRunAt?: string | null;
    lastRunStatus?: StoreManagerOccurrenceStatus | null;
    lastRunId?: string | null;
  },
): void {
  const db = getDb();
  db.run(
    `UPDATE store_manager_schedules
     SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at),
         last_run_status = COALESCE(?, last_run_status),
         last_run_id = COALESCE(?, last_run_id),
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      fields.nextRunAt,
      fields.lastRunAt ?? null,
      fields.lastRunStatus ?? null,
      fields.lastRunId ?? null,
      new Date().toISOString(),
      workspaceId,
      id,
    ],
  );
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/**
 * Insert one occurrence. The per-workspace UNIQUE(workspace_id, occurrence_key)
 * constraint is the restart backstop: a duplicate key is ignored and the
 * existing row returned (idempotent — an occurrence can never double-run).
 */
export function createOccurrence(input: CreateOccurrenceInput): StoreManagerScheduleOccurrence {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .query('SELECT * FROM store_manager_schedule_occurrences WHERE workspace_id = ? AND occurrence_key = ?')
    .get(input.workspaceId, input.occurrenceKey) as Record<string, unknown> | undefined;
  if (existing) return mapOccurrenceRow(existing);
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_schedule_occurrences
       (id, workspace_id, schedule_id, schedule_version, occurrence_key, scheduled_at,
        status, run_id, error_code, retry_count, claimed_at, lease_expires_at,
        heartbeat_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id, input.workspaceId, input.scheduleId, input.scheduleVersion, input.occurrenceKey,
      input.scheduledAt, input.status ?? 'pending', now, now,
    ],
  );
  return mapOccurrenceRow(
    db.query('SELECT * FROM store_manager_schedule_occurrences WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function getOccurrence(workspaceId: string, id: string): StoreManagerScheduleOccurrence | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_schedule_occurrences WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? mapOccurrenceRow(row) : null;
}

/**
 * List occurrences due at or before `nowIso` (status pending), bounded.
 * `catchUpWindowMs` caps how far back missed occurrences are honored; older
 * rows are returned too so the scheduler can mark them cancelled rather than
 * silently skipping them.
 */
export function listDueOccurrences(
  workspaceId: string,
  nowIso: string,
  opts: { limit?: number; catchUpWindowMs?: number } = {},
): StoreManagerScheduleOccurrence[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const rows = db
    .query(
      `SELECT * FROM store_manager_schedule_occurrences
       WHERE workspace_id = ? AND status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .all(workspaceId, nowIso, limit) as Record<string, unknown>[];
  return rows.map(mapOccurrenceRow);
}

/**
 * Atomic claim. The single UPDATE with `WHERE status = 'pending'` is the
 * concurrency guard: a competing worker sees zero affected rows. On success a
 * lease row is (re)written so heartbeats/expiry can be tracked.
 */
export function claimOccurrence(
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
      `UPDATE store_manager_schedule_occurrences
       SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    )
    .run(nowIso, leaseExpiresIso, nowIso, nowIso, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return false;
  db.query(
    `INSERT INTO store_manager_schedule_leases
       (occurrence_id, workspace_id, schedule_id, owner, claimed_at, lease_expires_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(occurrence_id) DO UPDATE SET
       owner = excluded.owner, claimed_at = excluded.claimed_at,
       lease_expires_at = excluded.lease_expires_at, heartbeat_at = excluded.heartbeat_at`,
  ).run(
    occurrenceId,
    workspaceId,
    (getOccurrence(workspaceId, occurrenceId) as unknown as { scheduleId: string }).scheduleId,
    owner,
    nowIso,
    leaseExpiresIso,
    nowIso,
  );
  return true;
}

export function heartbeatOccurrence(workspaceId: string, occurrenceId: string, leaseMs: number, nowIso: string): boolean {
  const db = getDb();
  const leaseExpiresIso = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
  const result = db
    .query(
      `UPDATE store_manager_schedule_occurrences
       SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(nowIso, leaseExpiresIso, nowIso, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return false;
  db.query(
    `UPDATE store_manager_schedule_leases SET heartbeat_at = ?, lease_expires_at = ? WHERE occurrence_id = ?`,
  ).run(nowIso, leaseExpiresIso, occurrenceId);
  return true;
}

export interface FinalizeOccurrenceInput {
  workspaceId: string;
  occurrenceId: string;
  status: Exclude<StoreManagerOccurrenceStatus, 'pending' | 'claimed'>;
  runId?: string | null;
  errorCode?: string | null;
  nowIso?: string;
}

export function finalizeOccurrence(input: FinalizeOccurrenceInput): StoreManagerScheduleOccurrence | null {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_schedule_occurrences
       SET status = ?, run_id = ?, error_code = ?, completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(input.status, input.runId ?? null, input.errorCode ?? null, now, now, input.workspaceId, input.occurrenceId);
  if (Number(result.changes ?? 0) === 0) return null;
  db.query('DELETE FROM store_manager_schedule_leases WHERE occurrence_id = ?').run(input.occurrenceId);
  return getOccurrence(input.workspaceId, input.occurrenceId);
}

/**
 * Return a failed/unavailable occurrence to `pending` for a retry, bumping
 * `retry_count` and rescheduling to `retryAtIso`. Only `claimed` rows can be
 * requeued (no double-scheduling of completed work).
 */
export function requeueOccurrence(
  workspaceId: string,
  occurrenceId: string,
  retryAtIso: string,
  errorCode: string,
): StoreManagerScheduleOccurrence | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_schedule_occurrences
       SET status = 'pending', scheduled_at = ?, retry_count = retry_count + 1,
           error_code = ?, claimed_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'claimed'`,
    )
    .run(retryAtIso, errorCode, now, workspaceId, occurrenceId);
  if (Number(result.changes ?? 0) === 0) return null;
  db.query('DELETE FROM store_manager_schedule_leases WHERE occurrence_id = ?').run(occurrenceId);
  return getOccurrence(workspaceId, occurrenceId);
}

/** Mark overdue pending occurrences as cancelled (beyond the catch-up window). */
export function cancelOverdueOccurrences(
  workspaceId: string,
  cutoffIso: string,
  limit = 200,
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db
    .query(
      `SELECT id FROM store_manager_schedule_occurrences
       WHERE workspace_id = ? AND status = 'pending' AND scheduled_at < ? LIMIT ?`,
    )
    .all(workspaceId, cutoffIso, Math.min(limit, 200)) as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.transaction(() => {
    db.query(
      `UPDATE store_manager_schedule_occurrences
       SET status = 'cancelled', error_code = 'catch_up_window_exceeded', completed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND status = 'pending' AND id IN (${placeholders})`,
    ).run(now, now, workspaceId, ...ids);
  })();

  return rows.length;
}

/**
 * Reset leases whose `lease_expires_at` has passed back to `pending` so a
 * crashed worker's claim is retried (not lost). Returns the count released.
 */
export function expireStaleLeases(workspaceId: string, nowIso: string, limit = 200): number {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db
    .query(
      `SELECT o.id FROM store_manager_schedule_occurrences o
       JOIN store_manager_schedule_leases l ON l.occurrence_id = o.id
       WHERE o.workspace_id = ? AND o.status = 'claimed' AND l.lease_expires_at < ?
       LIMIT ?`,
    )
    .all(workspaceId, nowIso, Math.min(limit, 200)) as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.transaction(() => {
    db.query(
      `UPDATE store_manager_schedule_occurrences
       SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           error_code = 'lease_expired', updated_at = ?
       WHERE workspace_id = ? AND status = 'claimed' AND id IN (${placeholders})`,
    ).run(now, workspaceId, ...ids);
    db.query(
      `DELETE FROM store_manager_schedule_leases WHERE occurrence_id IN (${placeholders})`,
    ).run(...ids);
  })();

  return rows.length;
}

export function listOccurrencesBySchedule(
  workspaceId: string,
  scheduleId: string,
  opts: { limit?: number; status?: StoreManagerOccurrenceStatus } = {},
): StoreManagerScheduleOccurrence[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: (string | number)[] = [workspaceId, scheduleId];
  let where = 'workspace_id = ? AND schedule_id = ?';
  if (opts.status) {
    where += ' AND status = ?';
    params.push(opts.status);
  }
  params.push(limit);
  return (
    db
      .query(
        `SELECT * FROM store_manager_schedule_occurrences WHERE ${where} ORDER BY scheduled_at DESC LIMIT ?`,
      )
      .all(...(params as [string, ...(string | number)[]])) as Record<string, unknown>[]
  ).map(mapOccurrenceRow);
}

/**
 * Recent terminal-failed/unavailable occurrences across schedules (Inbox
 * collector source). Bounded, workspace-scoped, ordered newest first.
 */
export function listRecentFailedOccurrences(
  workspaceId: string,
  sinceIso: string,
  limit = 50,
): StoreManagerScheduleOccurrence[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return (
    db
      .query(
        `SELECT * FROM store_manager_schedule_occurrences
         WHERE workspace_id = ? AND status IN ('failed', 'unavailable')
           AND (completed_at IS NOT NULL AND completed_at >= ?)
         ORDER BY completed_at DESC LIMIT ?`,
      )
      .all(workspaceId, sinceIso, bounded) as Record<string, unknown>[]
  ).map(mapOccurrenceRow);
}
