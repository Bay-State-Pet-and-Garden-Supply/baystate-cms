/**
 * store_manager_notifications / store_manager_notification_rules repository
 * (operations console, Issue 3).
 *
 * Notifications are durable in-app threshold FACTS with a per-workspace
 * monotonic sequence for cursor SSE + polling fallback. Rules keep a bounded
 * last-seen snapshot so the deterministic engine emits only on threshold
 * crossing or a new source identity — never on every scan. All access is
 * workspace-scoped (foreign rows are indistinguishable from missing).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import type {
  StoreManagerNotification,
  StoreManagerNotificationRuleKind,
} from '../../shared/schemas/store-manager-notification';

export interface StoreManagerNotificationRuleRow {
  id: string;
  workspaceId: string;
  kind: StoreManagerNotificationRuleKind;
  version: number;
  enabled: boolean;
  configJson: string;
  lastSeenSnapshotJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Default rule configuration for a workspace (created on first evaluation). */
export const DEFAULT_NOTIFICATION_RULES: ReadonlyArray<{
  kind: StoreManagerNotificationRuleKind;
  enabled: boolean;
  configJson: string;
}> = [
  { kind: 'proposal_backlog_exceeded', enabled: true, configJson: JSON.stringify({ threshold: 20 }) },
  { kind: 'critical_issue_count_increased', enabled: true, configJson: '{}' },
  { kind: 'sync_failure_appeared', enabled: true, configJson: '{}' },
  { kind: 'image_integrity_dropped', enabled: true, configJson: '{}' },
  // Phase B seam: scheduled reports evaluate this rule once report artifacts
  // exist; it ships disabled so no unattended emission happens in Phase A.
  { kind: 'scheduled_report_new_fingerprint', enabled: false, configJson: '{}' },
];

function mapRuleRow(row: Record<string, unknown>): StoreManagerNotificationRuleRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as StoreManagerNotificationRuleKind,
    version: Number(row.version),
    enabled: Number(row.enabled) === 1,
    configJson: String(row.config_json),
    lastSeenSnapshotJson: row.last_seen_snapshot_json ? String(row.last_seen_snapshot_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Seed default rules (idempotent per workspace). Returns the rule rows. */
export function ensureNotificationRules(workspaceId: string): StoreManagerNotificationRuleRow[] {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  for (const def of DEFAULT_NOTIFICATION_RULES) {
    const existing = db.query(
      'SELECT id FROM store_manager_notification_rules WHERE workspace_id = ? AND kind = ?',
    ).get(...[workspaceId, def.kind]) as { id: string } | undefined;
    if (!existing) {
      db.run(
        `INSERT INTO store_manager_notification_rules
           (id, workspace_id, kind, version, enabled, config_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
        [randomUUID(), workspaceId, def.kind, def.enabled ? 1 : 0, def.configJson, now, now],
      );
    }
  }
  const rows = db.query(
    'SELECT * FROM store_manager_notification_rules WHERE workspace_id = ? ORDER BY kind',
  ).all(...[workspaceId]) as Record<string, unknown>[];
  return rows.map(mapRuleRow);
}

export function getNotificationRule(workspaceId: string, kind: StoreManagerNotificationRuleKind): StoreManagerNotificationRuleRow | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM store_manager_notification_rules WHERE workspace_id = ? AND kind = ?',
  ).get(...[workspaceId, kind]) as Record<string, unknown> | undefined;
  return row ? mapRuleRow(row) : null;
}

/** Update the rule's last-seen snapshot (bounded JSON, evaluated state only). */
export function updateNotificationRuleSnapshot(
  workspaceId: string,
  kind: StoreManagerNotificationRuleKind,
  snapshotJson: string,
): void {
  const db = getDb();
  db.query(
    'UPDATE store_manager_notification_rules SET last_seen_snapshot_json = ?, updated_at = ? WHERE workspace_id = ? AND kind = ?',
  ).run(snapshotJson, new Date().toISOString(), workspaceId, kind);
}

export interface InsertNotificationInput {
  workspaceId: string;
  ruleId: string;
  ruleKind: StoreManagerNotificationRuleKind;
  ruleVersion: number;
  fingerprint: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  inboxItemId?: string | null;
  sourceRunId?: string | null;
}

function mapNotificationRow(row: Record<string, unknown>): StoreManagerNotification {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ruleId: String(row.rule_id),
    ruleKind: String(row.rule_kind) as StoreManagerNotificationRuleKind,
    ruleVersion: Number(row.rule_version),
    fingerprint: String(row.fingerprint),
    severity: String(row.severity) as StoreManagerNotification['severity'],
    title: String(row.title),
    message: String(row.message),
    inboxItemId: row.inbox_item_id ? String(row.inbox_item_id) : null,
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    sequence: Number(row.sequence),
    readAt: row.read_at ? String(row.read_at) : null,
    createdAt: String(row.created_at),
  };
}

/**
 * Insert a notification with the next monotonic per-workspace sequence.
 * Returns the row, or null when a row with the same fingerprint already
 * exists (dedupe — no repeat chatter).
 */
export function insertNotification(input: InsertNotificationInput): StoreManagerNotification | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const existing = db.query(
    'SELECT id FROM store_manager_notifications WHERE workspace_id = ? AND fingerprint = ?',
  ).get(...[input.workspaceId, input.fingerprint]) as { id: string } | undefined;
  if (existing) return null;
  const seqRow = db.query(
    'SELECT COALESCE(MAX(sequence), 0) AS seq FROM store_manager_notifications WHERE workspace_id = ?',
  ).get(...[input.workspaceId]) as { seq: number };
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO store_manager_notifications
       (id, workspace_id, rule_id, rule_kind, rule_version, fingerprint, severity, title,
        message, inbox_item_id, source_run_id, sequence, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id, input.workspaceId, input.ruleId, input.ruleKind, input.ruleVersion,
      input.fingerprint, input.severity, input.title, input.message,
      input.inboxItemId ?? null, input.sourceRunId ?? null, seqRow.seq + 1, now,
    ],
  );
  const row = db.query('SELECT * FROM store_manager_notifications WHERE id = ?').get(...[id]) as Record<string, unknown>;
  return mapNotificationRow(row);
}

/** Latest per-workspace notification sequence (0 when none). */
export function getLatestNotificationSequence(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COALESCE(MAX(sequence), 0) AS seq FROM store_manager_notifications WHERE workspace_id = ?',
  ).get(...[workspaceId]) as { seq: number };
  return Number(row?.seq ?? 0);
}

/** Cursor-based bounded listing ordered by ascending sequence. */
export function listNotifications(
  workspaceId: string,
  opts: { afterSequence?: number | null; limit?: number } = {},
): StoreManagerNotification[] {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const params: unknown[] = [workspaceId];
  let where = 'workspace_id = ?';
  if (opts.afterSequence != null) {
    where += ' AND sequence > ?';
    params.push(opts.afterSequence);
  }
  params.push(limit);
  const rows = db.query(
    `SELECT * FROM store_manager_notifications WHERE ${where} ORDER BY sequence ASC LIMIT ?`,
  ).all(...(params as any[])) as Record<string, unknown>[];
  return rows.map(mapNotificationRow);
}

/** Workspace-scoped unread count (bounded display). */
export function countUnreadNotifications(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as count FROM store_manager_notifications WHERE workspace_id = ? AND read_at IS NULL',
  ).get(...[workspaceId]) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** Workspace-scoped mark-read. Returns true only when a row was updated. */
export function markNotificationRead(workspaceId: string, id: string): boolean {
  const db = getDb();
  const result = db.query(
    'UPDATE store_manager_notifications SET read_at = ? WHERE workspace_id = ? AND id = ? AND read_at IS NULL',
  ).run(new Date().toISOString(), workspaceId, id);
  return Number(result.changes ?? 0) > 0;
}
