import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

// ---------------------------------------------------------------------------
// catalog_health_proposals repository (epic #42, #35)
//
// Workspace identity is part of every read/mutation contract: lookups and
// updates predicate on `workspace_id` so a proposal from another workspace is
// indistinguishable from a missing one. Every mutating helper reports whether
// a row in the caller's workspace was actually affected so services can fail
// closed.
// ---------------------------------------------------------------------------

export type ProposalStatus = 'proposed' | 'applied' | 'dismissed';
export type ProposalSource = 'deterministic' | 'ai';

export interface CatalogProposal {
  id: string;
  workspaceId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  reason: string;
  confidence: number;
  source: ProposalSource;
  status: ProposalStatus;
  changeSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertProposalInput {
  workspaceId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  reason: string;
  confidence: number;
  source: ProposalSource;
  status?: ProposalStatus;
}

/**
 * List proposals for one workspace with optional field/status filters.
 */
export function listProposals(
  workspaceId: string,
  filter?: { field?: string; status?: string },
): CatalogProposal[] {
  const db = getDb();
  let sql = 'SELECT * FROM catalog_health_proposals WHERE workspace_id = ?';
  const params: unknown[] = [workspaceId];

  if (filter?.field) {
    sql += ' AND field = ?';
    params.push(filter.field);
  }
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }

  sql += ' ORDER BY confidence DESC, created_at DESC';

  const rows = db.query(sql).all(...(params as any[])) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Fetch a single proposal by ID, scoped to the caller's workspace. A proposal
 * owned by another workspace returns null (same external result as unknown).
 */
export function findProposalById(workspaceId: string, id: string): CatalogProposal | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM catalog_health_proposals WHERE workspace_id = ? AND id = ?',
  ).get(workspaceId, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Dismiss a proposal within the caller's workspace. Returns true only when a
 * row was actually updated; foreign/unknown ids return false without a side
 * effect.
 */
export function dismissProposal(workspaceId: string, id: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE catalog_health_proposals SET status = 'dismissed', updated_at = ? WHERE workspace_id = ? AND id = ?",
    [now, workspaceId, id],
  );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Delete generated `proposed` proposals for a workspace/field, optionally
 * restricted to one source. Returns the number of deleted rows.
 */
export function deleteGeneratedProposals(
  workspaceId: string,
  field: string,
  source?: ProposalSource,
): number {
  const db = getDb();
  let sql = "DELETE FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND status = 'proposed'";
  const params: any[] = [workspaceId, field];
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  const result = db.run(sql, ...params);
  return Number(result.changes ?? 0);
}

/**
 * Returns the id of an existing proposal matching the exact workspace, field,
 * old value, and new value, or null. Used to avoid duplicate suggestions.
 */
export function findDuplicateProposal(
  workspaceId: string,
  field: string,
  oldValue: string,
  newValue: string,
): string | null {
  const db = getDb();
  const row = db.query(
    'SELECT id FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND old_value = ? AND new_value = ? LIMIT 1',
  ).get(workspaceId, field, oldValue, newValue) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Insert a proposal and return the stored row.
 */
export function insertProposal(input: InsertProposalInput): CatalogProposal {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO catalog_health_proposals (id, workspace_id, field, old_value, new_value, affected_skus, reason, confidence, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.field,
      input.oldValue,
      input.newValue,
      JSON.stringify(input.affectedSkus),
      input.reason,
      input.confidence,
      input.source,
      input.status ?? 'proposed',
      now,
      now,
    ],
  );
  return findProposalById(input.workspaceId, id)!;
}

/**
 * Update a proposal's status (optionally recording the Change Set it was
 * staged into), scoped to the caller's workspace. Returns true only when a
 * row was actually updated.
 */
export function updateProposalStatus(
  workspaceId: string,
  id: string,
  status: ProposalStatus,
  changeSetId?: string | null,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result =
    changeSetId !== undefined
      ? db.run(
          'UPDATE catalog_health_proposals SET status = ?, change_set_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
          [status, changeSetId, now, workspaceId, id],
        )
      : db.run(
          'UPDATE catalog_health_proposals SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
          [status, now, workspaceId, id],
        );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Count proposals in one workspace by status.
 */
export function countProposalsByStatus(workspaceId: string, status: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as count FROM catalog_health_proposals WHERE workspace_id = ? AND status = ?',
  ).get(workspaceId, status) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function mapRow(row: Record<string, unknown>): CatalogProposal {
  let affectedSkus: string[] = [];
  try {
    affectedSkus = JSON.parse(String(row.affected_skus));
  } catch {
    // fallback to empty list
  }

  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    affectedSkus,
    reason: String(row.reason),
    confidence: Number(row.confidence),
    source: row.source as ProposalSource,
    status: row.status as ProposalStatus,
    changeSetId: row.change_set_id ? String(row.change_set_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
