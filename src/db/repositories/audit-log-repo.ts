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

/**
 * Count audit-log rows for an action within one workspace.
 *
 * Additive telemetry helper (epic #46): e.g. `domain_release` operations
 * (entityType `extractor_profile_domain`) are counted to measure
 * extractor-profile domain unblocks. NOTE: the private `listAuditLogs`
 * helper that previously sat right above this function was removed as dead
 * code (never referenced) while touching this file.
 */
export function countAuditLogsByAction(workspaceId: string, action: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) AS count FROM audit_log WHERE workspace_id = ? AND action = ?',
  ).get(workspaceId, action) as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}
