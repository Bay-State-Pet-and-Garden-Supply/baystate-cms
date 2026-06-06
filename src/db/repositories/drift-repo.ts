import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface DriftRow {
  id: string;
  workspaceId: string;
  sku: string;
  detectedAt: string;
  status: string;
  localHash: string | null;
  remoteHash: string;
  localJson: string | null;
  remoteJson: string;
  diffJson: string | null;
  reconcileChangeSetId: string | null;
}

export interface CreateDriftInput {
  workspaceId: string;
  sku: string;
  localHash: string | null;
  remoteHash: string;
  localJson: string | null;
  remoteJson: string;
  diffJson?: string | null;
}

export function createDrift(row: CreateDriftInput): DriftRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status,
       local_hash, remote_hash, local_json, remote_json, diff_json)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [id, row.workspaceId, row.sku, now,
      row.localHash, row.remoteHash, row.localJson, row.remoteJson, row.diffJson ?? null],
  );
  return findDriftById(id)!;
}

export function findDriftById(id: string): DriftRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM remote_drift WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listDrift(workspaceId: string, status?: string): DriftRow[] {
  const db = getDb();
  let sql = 'SELECT * FROM remote_drift WHERE workspace_id = ?';
  const params: (string | number | null)[] = [workspaceId];
  if (status) {
    if (status === 'blocking') {
      sql += ' AND (status = ? OR status = ?)';
      params.push('open', 'in_reconcile');
    } else {
      sql += ' AND status = ?';
      params.push(status);
    }
  }
  sql += ' ORDER BY detected_at DESC';
  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function findBlockingDriftForSku(workspaceId: string, sku: string): DriftRow | null {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM remote_drift
     WHERE workspace_id = ? AND sku = ? AND (status = ? OR status = ?)
     ORDER BY detected_at DESC LIMIT 1`,
  ).get(workspaceId, sku, 'open', 'in_reconcile') as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function hasBlockingDriftForSku(workspaceId: string, sku: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT 1 FROM remote_drift
     WHERE workspace_id = ? AND sku = ? AND (status = ? OR status = ?) LIMIT 1`,
  ).get(workspaceId, sku, 'open', 'in_reconcile') as Record<string, unknown> | undefined;
  return !!row;
}

export function hasOpenDriftForSku(workspaceId: string, sku: string): boolean {
  const db = getDb();
  const row = db.query(
    'SELECT 1 FROM remote_drift WHERE workspace_id = ? AND sku = ? AND status = ? LIMIT 1',
  ).get(workspaceId, sku, 'open') as Record<string, unknown> | undefined;
  return !!row;
}

export function countBlockingDrift(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) as cnt FROM remote_drift
     WHERE workspace_id = ? AND (status = ? OR status = ?)`,
  ).get(workspaceId, 'open', 'in_reconcile') as Record<string, unknown>;
  return Number(row.cnt);
}

export function countOpenDrift(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as cnt FROM remote_drift WHERE workspace_id = ? AND status = ?',
  ).get(workspaceId, 'open') as Record<string, unknown>;
  return Number(row.cnt);
}

export function resolveDrift(id: string, newStatus: string): void {
  const db = getDb();
  db.run('UPDATE remote_drift SET status = ? WHERE id = ?', [newStatus, id]);
}

export function linkDriftToChangeSet(id: string, changeSetId: string, newStatus?: string): void {
  const db = getDb();
  if (newStatus) {
    db.run(
      'UPDATE remote_drift SET reconcile_change_set_id = ?, status = ? WHERE id = ?',
      [changeSetId, newStatus, id],
    );
  } else {
    db.run(
      'UPDATE remote_drift SET reconcile_change_set_id = ? WHERE id = ?',
      [changeSetId, id],
    );
  }
}

export function reopenDriftForChangeSet(workspaceId: string, changeSetId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  // Reopen any drifts linked to this change set back to 'open' status
  db.run(
    `UPDATE remote_drift
     SET status = 'open', reconcile_change_set_id = NULL, detected_at = ?
     WHERE workspace_id = ? AND reconcile_change_set_id = ? AND status = 'in_reconcile'`,
    [now, workspaceId, changeSetId],
  );
}

export function findLinkedDrift(workspaceId: string, changeSetId: string): DriftRow | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM remote_drift WHERE workspace_id = ? AND reconcile_change_set_id = ? LIMIT 1',
  ).get(workspaceId, changeSetId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

function mapRow(row: Record<string, unknown>): DriftRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sku: String(row.sku),
    detectedAt: String(row.detected_at),
    status: String(row.status),
    localHash: row.local_hash ? String(row.local_hash) : null,
    remoteHash: String(row.remote_hash),
    localJson: row.local_json ? String(row.local_json) : null,
    remoteJson: String(row.remote_json),
    diffJson: row.diff_json ? String(row.diff_json) : null,
    reconcileChangeSetId: row.reconcile_change_set_id ? String(row.reconcile_change_set_id) : null,
  };
}
