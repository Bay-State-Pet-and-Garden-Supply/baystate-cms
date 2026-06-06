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
