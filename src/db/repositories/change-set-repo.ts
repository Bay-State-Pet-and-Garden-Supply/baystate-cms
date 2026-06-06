import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface ChangeSetRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  baseCommit: string;
  approvedCommit: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

export interface ChangeSetItemRow {
  id: string;
  changeSetId: string;
  sku: string;
  operation: string;
  draftJson: string;
  baseJson: string | null;
  draftHash: string;
  validationStatus: string;
  createdAt: string;
  updatedAt: string;
}

export function createChangeSet(ws: {
  workspaceId: string;
  title: string;
  description?: string | null;
  baseCommit: string;
}): ChangeSetRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO change_sets (id, workspace_id, title, description, status, base_commit, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [id, ws.workspaceId, ws.title, ws.description ?? null, ws.baseCommit, now, now],
  );
  return findChangeSetById(id)!;
}

export function findChangeSetById(id: string): ChangeSetRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM change_sets WHERE id = ?').get(...[id]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listChangeSets(workspaceId: string): ChangeSetRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM change_sets WHERE workspace_id = ? ORDER BY created_at DESC',
  ).all(...[workspaceId]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function updateChangeSetStatus(id: string, status: string, approvedCommit?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (approvedCommit) {
    db.run(
      `UPDATE change_sets SET status = ?, updated_at = ?, approved_commit = ?, approved_at = ? WHERE id = ?`,
      [status, now, approvedCommit, now, id],
    );
  } else {
    db.run(`UPDATE change_sets SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
  }
}

export function findActiveChangeSet(workspaceId: string): ChangeSetRow | null {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM change_sets WHERE workspace_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
  ).get(...[workspaceId]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

// --- Change Set Items ---

export function upsertChangeSetItem(item: {
  changeSetId: string;
  sku: string;
  operation: string;
  draftJson: string;
  baseJson: string | null;
  draftHash: string;
}): ChangeSetItemRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, base_json, draft_hash, validation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
     ON CONFLICT(change_set_id, sku) DO UPDATE SET
       operation = COALESCE(EXCLUDED.operation, change_set_items.operation),
       draft_json = EXCLUDED.draft_json,
       base_json = COALESCE(EXCLUDED.base_json, change_set_items.base_json),
       draft_hash = EXCLUDED.draft_hash,
       validation_status = 'unknown',
       updated_at = EXCLUDED.updated_at`,
    [id, item.changeSetId, item.sku, item.operation, item.draftJson, item.baseJson, item.draftHash, now, now],
  );
  const row = db.query(
    'SELECT * FROM change_set_items WHERE change_set_id = ? AND sku = ?',
  ).get(...[item.changeSetId, item.sku]) as Record<string, unknown> | undefined;
  return mapItemRow(row!);
}

export function listChangeSetItems(changeSetId: string): ChangeSetItemRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM change_set_items WHERE change_set_id = ? ORDER BY sku ASC',
  ).all(...[changeSetId]) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

export function deleteChangeSetItem(changeSetId: string, sku: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ? AND sku = ?', [changeSetId, sku]);
}

export function deleteChangeSet(id: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ?', [id]);
  db.run('DELETE FROM change_sets WHERE id = ?', [id]);
}

export function setItemValidationStatus(changeSetId: string, sku: string, status: string): void {
  const db = getDb();
  db.run(
    'UPDATE change_set_items SET validation_status = ?, updated_at = ? WHERE change_set_id = ? AND sku = ?',
    [status, new Date().toISOString(), changeSetId, sku],
  );
}

function mapRow(row: Record<string, unknown>): ChangeSetRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status),
    baseCommit: String(row.base_commit),
    approvedCommit: row.approved_commit ? String(row.approved_commit) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
  };
}

function mapItemRow(row: Record<string, unknown>): ChangeSetItemRow {
  return {
    id: String(row.id),
    changeSetId: String(row.change_set_id),
    sku: String(row.sku),
    operation: String(row.operation),
    draftJson: String(row.draft_json),
    baseJson: row.base_json ? String(row.base_json) : null,
    draftHash: String(row.draft_hash),
    validationStatus: String(row.validation_status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
