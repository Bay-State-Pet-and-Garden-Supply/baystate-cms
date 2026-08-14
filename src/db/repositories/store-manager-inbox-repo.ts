/**
 * store_manager_inbox_items repository (operations console, Issue 3).
 *
 * Workspace identity is part of every contract: lookups/updates predicate on
 * `workspace_id` so a foreign row is indistinguishable from a missing one.
 * Rows are materialized for stable acknowledgement/history; collectors
 * re-derive current authority and this repo reconciles lifecycle. The model
 * has no tool path into this repository.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import type {
  StoreManagerInboxItem,
  StoreManagerInboxKind,
  StoreManagerInboxLifecycle,
  StoreManagerSeverity,
} from '../../shared/schemas/store-manager-inbox';

export interface InboxCandidateInput {
  kind: StoreManagerInboxKind;
  dedupeKey: string;
  severity: StoreManagerSeverity;
  title: string;
  summary: string;
  scopeJson: string;
  count: number;
  sourceRefsJson: string;
  fingerprint: string;
  sourceUpdatedAt: string;
}

export interface StoreManagerInboxRow extends StoreManagerInboxItem {}

function mapRow(row: Record<string, unknown>): StoreManagerInboxItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as StoreManagerInboxKind,
    dedupeKey: String(row.dedupe_key),
    severity: String(row.severity) as StoreManagerSeverity,
    title: String(row.title),
    summary: String(row.summary),
    scope: JSON.parse(String(row.scope_json)) as StoreManagerInboxItem['scope'],
    count: Number(row.count),
    sourceRefs: JSON.parse(String(row.source_refs_json)) as StoreManagerInboxItem['sourceRefs'],
    fingerprint: String(row.fingerprint),
    lifecycle: String(row.lifecycle) as StoreManagerInboxLifecycle,
    sourceUpdatedAt: String(row.source_updated_at),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    resolvedReason: row.resolved_reason ? (row.resolved_reason as 'disappeared' | 'operator') : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Workspace-scoped lookup; foreign/missing rows are indistinguishable (null). */
export function getInboxItem(workspaceId: string, id: string): StoreManagerInboxItem | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM store_manager_inbox_items WHERE workspace_id = ? AND id = ?',
  ).get(...[workspaceId, id]) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function getInboxItemByDedupeKey(workspaceId: string, dedupeKey: string): StoreManagerInboxItem | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM store_manager_inbox_items WHERE workspace_id = ? AND dedupe_key = ?',
  ).get(...[workspaceId, dedupeKey]) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function listInboxItems(
  workspaceId: string,
  opts: { lifecycle?: StoreManagerInboxLifecycle | null; limit?: number } = {},
): StoreManagerInboxItem[] {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const params: unknown[] = [workspaceId];
  let where = 'workspace_id = ?';
  if (opts.lifecycle) {
    where += ' AND lifecycle = ?';
    params.push(opts.lifecycle);
  }
  params.push(limit);
  const rows = db.query(
    `SELECT * FROM store_manager_inbox_items WHERE ${where}
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT ?`,
  ).all(...(params as any[])) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Insert a fresh finding (lifecycle `open`). `firstSeenAt` equals `lastSeenAt`.
 */
export function insertInboxItem(workspaceId: string, candidate: InboxCandidateInput): StoreManagerInboxItem {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO store_manager_inbox_items
       (id, workspace_id, kind, dedupe_key, severity, title, summary, scope_json, count,
        source_refs_json, fingerprint, lifecycle, source_updated_at, first_seen_at,
        last_seen_at, acknowledged_at, resolved_at, superseded_at, resolved_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id, workspaceId, candidate.kind, candidate.dedupeKey, candidate.severity,
      candidate.title, candidate.summary, candidate.scopeJson, candidate.count,
      candidate.sourceRefsJson, candidate.fingerprint, candidate.sourceUpdatedAt,
      now, now, now, now,
    ],
  );
  return mapRow(db.query('SELECT * FROM store_manager_inbox_items WHERE id = ?').get(...[id]) as Record<string, unknown>);
}

/**
 * Refresh a still-present finding. Lifecycle is preserved (an acknowledged row
 * stays acknowledged — acknowledgement retention); only counts/timestamps and
 * the content fingerprint advance.
 */
export function updateInboxItemContent(workspaceId: string, id: string, candidate: InboxCandidateInput): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET severity = ?, title = ?, summary = ?, scope_json = ?, count = ?, source_refs_json = ?,
         fingerprint = ?, source_updated_at = ?, last_seen_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      candidate.severity, candidate.title, candidate.summary, candidate.scopeJson,
      candidate.count, candidate.sourceRefsJson, candidate.fingerprint,
      candidate.sourceUpdatedAt, now, now, workspaceId, id,
    ],
  );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Re-open a resolved/superseded finding that reappeared with a new
 * fingerprint. Clears the terminal timestamps and returns it to `open`.
 */
export function reopenInboxItem(workspaceId: string, id: string, candidate: InboxCandidateInput): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET severity = ?, title = ?, summary = ?, scope_json = ?, count = ?, source_refs_json = ?,
         fingerprint = ?, lifecycle = 'open', source_updated_at = ?, first_seen_at = ?,
         last_seen_at = ?, acknowledged_at = NULL, resolved_at = NULL, superseded_at = NULL,
         resolved_reason = NULL, updated_at = ?
     WHERE workspace_id = ? AND id = ? AND lifecycle IN ('resolved', 'superseded')`,
    [
      candidate.severity, candidate.title, candidate.summary, candidate.scopeJson,
      candidate.count, candidate.sourceRefsJson, candidate.fingerprint,
      candidate.sourceUpdatedAt, now, now, now, workspaceId, id,
    ],
  );
  return Number(result.changes ?? 0) > 0;
}

/**
 * A finding disappeared from the authoritative source: mark open/acknowledged
 * rows `resolved` with `resolved_reason = 'disappeared'` (they stay auditable
 * and RE-OPEN if the same finding reappears). Already-resolved rows untouched.
 */
export function resolveInboxItemAsDisappeared(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET lifecycle = 'resolved', resolved_at = ?, resolved_reason = 'disappeared', updated_at = ?
     WHERE workspace_id = ? AND id = ? AND lifecycle IN ('open', 'acknowledged')`,
    [now, now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}

/** Operator acknowledge: open → acknowledged (no source effect). */
export function acknowledgeInboxItem(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET lifecycle = 'acknowledged', acknowledged_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ? AND lifecycle = 'open'`,
    [now, now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}

/** Operator resolve: open/acknowledged → resolved (no source effect). */
export function resolveInboxItem(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET lifecycle = 'resolved', resolved_at = ?, resolved_reason = 'operator', updated_at = ?
     WHERE workspace_id = ? AND id = ? AND lifecycle IN ('open', 'acknowledged')`,
    [now, now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}

/** Mark a row superseded (retired by a newer dedupe key; auditable). */
export function supersedeInboxItem(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE store_manager_inbox_items
     SET lifecycle = 'superseded', superseded_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ? AND lifecycle NOT IN ('superseded')`,
    [now, now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}
