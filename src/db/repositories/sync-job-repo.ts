import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface SyncJobRow {
  id: string;
  workspaceId: string;
  changeSetId: string | null;
  kind: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  productCount: number;
  artifactPath: string | null;
  errorSummary: string | null;
  metadataJson: string | null;
}

export interface SyncJobEventRow {
  id: string;
  syncJobId: string;
  level: string;
  message: string;
  detailsJson: string | null;
  createdAt: string;
}

export function createSyncJob(job: {
  workspaceId: string;
  changeSetId?: string | null;
  kind: string;
  metadataJson?: string | null;
}): SyncJobRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO sync_jobs (id, workspace_id, change_set_id, kind, status, started_at, metadata_json)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    [id, job.workspaceId, job.changeSetId ?? null, job.kind, now, job.metadataJson ?? null],
  );
  return findSyncJobById(id)!;
}

export function findSyncJobById(id: string): SyncJobRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM sync_jobs WHERE id = ?').get(...[id]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listSyncJobs(workspaceId: string): SyncJobRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM sync_jobs WHERE workspace_id = ? ORDER BY started_at DESC',
  ).all(...[workspaceId]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Bounded workspace-scoped read of terminal failed sync jobs (operations
 * console, Issue 3 — Inbox collector). Foreign rows are invisible; the error
 * summary is returned raw here and must be redacted/truncated by callers
 * before it reaches the client.
 */
export function listFailedSyncJobs(workspaceId: string, limit = 50): SyncJobRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  const rows = db.query(
    "SELECT * FROM sync_jobs WHERE workspace_id = ? AND status = 'failed' ORDER BY completed_at DESC LIMIT ?",
  ).all(...[workspaceId, bounded]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Workspace-scoped count of failed sync jobs (bounded by time window), used
 * by the failed-sync-diff notification rule and Inbox collector.
 */
export function countFailedSyncJobsSince(workspaceId: string, sinceIso: string | null): number {
  const db = getDb();
  const row = sinceIso
    ? db.query(
        "SELECT COUNT(*) as count FROM sync_jobs WHERE workspace_id = ? AND status = 'failed' AND completed_at >= ?",
      ).get(...[workspaceId, sinceIso]) as { count: number }
    : db.query(
        "SELECT COUNT(*) as count FROM sync_jobs WHERE workspace_id = ? AND status = 'failed'",
      ).get(...[workspaceId]) as { count: number };
  return Number(row?.count ?? 0);
}

/**
 * Workspace-scoped terminal transition observation (operations console,
 * Issue 5 — sync_failed trigger). Failed sync jobs observed as committed
 * durable state only; foreign rows are invisible. Bounded; error summaries
 * are returned raw here and MUST be redacted/truncated by the caller before
 * they reach a prompt, artifact, or the client.
 */
export function listFailedSyncJobsForObservation(workspaceId: string, limit = 200): SyncJobRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 500);
  const rows = db.query(
    "SELECT * FROM sync_jobs WHERE workspace_id = ? AND status = 'failed' ORDER BY completed_at ASC LIMIT ?",
  ).all(...[workspaceId, bounded]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function completeSyncJob(id: string, status: string, fields?: {
  productCount?: number;
  artifactPath?: string;
  errorSummary?: string;
  metadataJson?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = ['status = ?', 'completed_at = ?'];
  const params: (string | number | null)[] = [status, now];
  if (fields?.productCount !== undefined) { sets.push('product_count = ?'); params.push(fields.productCount); }
  if (fields?.artifactPath !== undefined) { sets.push('artifact_path = ?'); params.push(fields.artifactPath); }
  if (fields?.errorSummary !== undefined) { sets.push('error_summary = ?'); params.push(fields.errorSummary); }
  params.push(id);
  db.run(`UPDATE sync_jobs SET ${sets.join(', ')} WHERE id = ?`, params);
}

// --- Events ---

export function addSyncJobEvent(event: {
  syncJobId: string;
  level: string;
  message: string;
  detailsJson?: string | null;
}): SyncJobEventRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO sync_job_events (id, sync_job_id, level, message, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, event.syncJobId, event.level, event.message, event.detailsJson ?? null, now],
  );
  return { id, syncJobId: event.syncJobId, level: event.level, message: event.message, detailsJson: event.detailsJson ?? null, createdAt: now };
}

export function listSyncJobEvents(syncJobId: string): SyncJobEventRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM sync_job_events WHERE sync_job_id = ? ORDER BY created_at ASC',
  ).all(...[syncJobId]) as Record<string, unknown>[];
  return rows.map(e => ({
    id: String(e.id),
    syncJobId: String(e.sync_job_id),
    level: String(e.level),
    message: String(e.message),
    detailsJson: e.details_json ? String(e.details_json) : null,
    createdAt: String(e.created_at),
  }));
}

function mapRow(row: Record<string, unknown>): SyncJobRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    changeSetId: row.change_set_id ? String(row.change_set_id) : null,
    kind: String(row.kind),
    status: String(row.status),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    productCount: Number(row.product_count),
    artifactPath: row.artifact_path ? String(row.artifact_path) : null,
    errorSummary: row.error_summary ? String(row.error_summary) : null,
    metadataJson: row.metadata_json ? String(row.metadata_json) : null,
  };
}
