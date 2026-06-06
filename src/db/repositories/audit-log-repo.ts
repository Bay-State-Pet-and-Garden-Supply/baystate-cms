import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface AuditLogRow {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson: string | null;
}

export function addAuditLog(entry: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson?: string | null;
}): AuditLogRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entry.workspaceId, entry.entityType, entry.entityId, entry.action, entry.message, entry.detailsJson ?? null, now],
  );
  return { id, ...entry, detailsJson: entry.detailsJson ?? null };
}

export function listAuditLogs(workspaceId: string, limit = 50): AuditLogRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(...[workspaceId, limit]) as Record<string, unknown>[];
  return rows.map(row => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    action: String(row.action),
    message: String(row.message),
    detailsJson: row.details_json ? String(row.details_json) : null,
  }));
}
