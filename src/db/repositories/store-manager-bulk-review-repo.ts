/**
 * Store Manager bulk-review repository (operations console, Issue 8).
 *
 * Workspace identity is part of every read/mutation contract: lookups and
 * mutations predicate on `workspace_id`, so a batch owned by another
 * workspace is indistinguishable from a missing one (fail closed, no
 * ownership disclosure). Batch previews are immutable (header + per-item
 * snapshots/digests); the append-only decision ledger records exactly what
 * the operator approved/denied for every item. Batch id is correlation only.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  BulkReviewBatchStatus,
  BulkReviewItemDecision,
  StoreManagerBulkReviewBatch,
  StoreManagerBulkReviewBatchSummary,
  StoreManagerBulkReviewDecision,
  StoreManagerBulkReviewItem,
} from '../../shared/schemas/store-manager-bulk-review';

export type { StoreManagerBulkReviewBatch, StoreManagerBulkReviewItem, StoreManagerBulkReviewDecision };

export interface BulkReviewItemSnapshot {
  proposalId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  itemDigest: string;
}

export interface CreateBulkReviewBatchInput {
  workspaceId: string;
  groupKey: string;
  field: string;
  normalizationKind: 'casing' | 'whitespace' | 'separator';
  ruleVersion: string;
  evidenceKey: string;
  distinctSkuCount: number;
  diffHash: string;
  createdBy: string;
  items: BulkReviewItemSnapshot[];
}

export interface BulkReviewBatchRow extends StoreManagerBulkReviewBatch {
  group_key: string;
  proposal_count: number;
  distinct_sku_count: number;
  diff_hash: string | null;
  created_by: string;
}

export interface BulkReviewItemRow extends StoreManagerBulkReviewItem {
  affected_skus_json: string;
  item_digest: string;
  decision_actor: string | null;
  change_set_item_ref: string | null;
}

/** Derive the deterministic group key for a homogeneous selection. */
export function computeBulkReviewGroupKey(input: {
  workspaceId: string;
  field: string;
  normalizationKind: string;
  ruleVersion: string;
  evidenceKey: string;
}): string {
  return hashCanonicalJson({
    workspaceId: input.workspaceId,
    field: input.field,
    normalizationKind: input.normalizationKind,
    ruleVersion: input.ruleVersion,
    evidenceKey: input.evidenceKey,
  });
}

function mapBatchRow(row: Record<string, unknown>): StoreManagerBulkReviewBatch {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    field: String(row.field),
    normalizationKind: row.normalization_kind as StoreManagerBulkReviewBatch['normalizationKind'],
    ruleVersion: String(row.rule_version),
    evidenceKey: String(row.evidence_key),
    groupKey: String(row.group_key),
    status: row.status as StoreManagerBulkReviewBatch['status'],
    proposalCount: Number(row.proposal_count),
    distinctSkuCount: Number(row.distinct_sku_count),
    diffHash: row.diff_hash ? String(row.diff_hash) : null,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapBatchSummaryRow(row: Record<string, unknown>): StoreManagerBulkReviewBatchSummary {
  return {
    id: String(row.id),
    field: String(row.field),
    normalizationKind: row.normalization_kind as StoreManagerBulkReviewBatchSummary['normalizationKind'],
    status: row.status as StoreManagerBulkReviewBatchSummary['status'],
    proposalCount: Number(row.proposal_count),
    distinctSkuCount: Number(row.distinct_sku_count),
    createdAt: String(row.created_at),
  };
}

function mapItemRow(row: Record<string, unknown>): StoreManagerBulkReviewItem {
  let affectedSkus: string[] = [];
  try {
    affectedSkus = JSON.parse(String(row.affected_skus_json));
  } catch {
    // fallback to empty list
  }
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id),
    proposalId: String(row.proposal_id),
    field: String(row.field),
    oldValue: String(row.old_value),
    newValue: String(row.new_value),
    affectedSkus,
    itemDigest: String(row.item_digest),
    decision: row.decision as StoreManagerBulkReviewItem['decision'],
    decisionActor: row.decision_actor ? String(row.decision_actor) : null,
    changeSetItemRef: row.change_set_item_ref ? String(row.change_set_item_ref) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Create one immutable batch header + item snapshots inside ONE transaction.
 * Bounded by the shared schema (max 200 items). Returns the stored batch.
 */
export function createBulkReviewBatch(input: CreateBulkReviewBatchInput): StoreManagerBulkReviewBatch {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  if (input.items.length > 200) {
    throw new Error('Bulk review batch exceeds the 200-item bound.');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  return db.transaction(() => {
    db.run(
      `INSERT INTO store_manager_bulk_review_batches
         (id, workspace_id, group_key, field, normalization_kind, rule_version, evidence_key,
          status, proposal_count, distinct_sku_count, diff_hash, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.groupKey,
        input.field,
        input.normalizationKind,
        input.ruleVersion,
        input.evidenceKey,
        input.items.length,
        input.distinctSkuCount,
        input.diffHash,
        input.createdBy,
        now,
        now,
      ],
    );
    for (const item of input.items) {
      db.run(
        `INSERT INTO store_manager_bulk_review_items
           (id, workspace_id, batch_id, proposal_id, field, old_value, new_value,
            affected_skus_json, item_digest, decision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          id,
          item.proposalId,
          item.field,
          item.oldValue,
          item.newValue,
          JSON.stringify(item.affectedSkus),
          item.itemDigest,
          now,
          now,
        ],
      );
    }
    return findBulkReviewBatch(input.workspaceId, id)!;
  })();
}

/** Fetch one batch scoped to the caller's workspace. Foreign/unknown -> null. */
export function findBulkReviewBatch(workspaceId: string, batchId: string): StoreManagerBulkReviewBatch | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM store_manager_bulk_review_batches WHERE workspace_id = ? AND id = ?',
  ).get(workspaceId, batchId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapBatchRow(row);
}

/** List batches for one workspace (bounded, newest first). */
export function listBulkReviewBatches(workspaceId: string, limit = 50): StoreManagerBulkReviewBatchSummary[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  const rows = db.query(
    'SELECT id, workspace_id, field, normalization_kind, status, proposal_count, distinct_sku_count, created_at FROM store_manager_bulk_review_batches WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(workspaceId, bounded) as Record<string, unknown>[];
  return rows.map(mapBatchSummaryRow);
}

/** Fetch all item snapshots for one workspace-scoped batch. */
export function listBulkReviewBatchItems(workspaceId: string, batchId: string): StoreManagerBulkReviewItem[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM store_manager_bulk_review_items WHERE workspace_id = ? AND batch_id = ? ORDER BY rowid ASC',
  ).all(workspaceId, batchId) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

/**
 * Update a batch's status scoped to the caller's workspace. Returns true only
 * when a row was actually updated; foreign/unknown ids return false.
 */
export function updateBulkReviewBatchStatus(
  workspaceId: string,
  batchId: string,
  status: BulkReviewBatchStatus,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    'UPDATE store_manager_bulk_review_batches SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    [status, now, workspaceId, batchId],
  );
  return Number(result.changes ?? 0) > 0;
}

/**
 * Update one item's decision scoped to the caller's workspace. Returns true
 * only when the row was updated.
 */
export function updateBulkReviewItemDecision(
  workspaceId: string,
  batchId: string,
  proposalId: string,
  decision: BulkReviewItemDecision,
  actor: string | null,
  changeSetItemRef: string | null,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.run(
    'UPDATE store_manager_bulk_review_items SET decision = ?, decision_actor = ?, change_set_item_ref = ?, updated_at = ? WHERE workspace_id = ? AND batch_id = ? AND proposal_id = ?',
    [decision, actor, changeSetItemRef, now, workspaceId, batchId, proposalId],
  );
  return Number(result.changes ?? 0) > 0;
}

/** Append one per-item audit decision (correlation only — never authority). */
export function insertBulkReviewDecision(
  input: Omit<StoreManagerBulkReviewDecision, 'id' | 'createdAt'>,
): StoreManagerBulkReviewDecision {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO store_manager_bulk_review_decisions
       (id, workspace_id, batch_id, proposal_id, decision, actor, run_id, diff_hash, change_set_item_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.batchId,
      input.proposalId,
      input.decision,
      input.actor,
      input.runId ?? null,
      input.diffHash ?? null,
      input.changeSetItemRef ?? null,
      now,
    ],
  );
  return { ...input, id, createdAt: now };
}

/** Count per-item decisions for one batch (audit completeness). */
export function countBulkReviewDecisions(workspaceId: string, batchId: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as count FROM store_manager_bulk_review_decisions WHERE workspace_id = ? AND batch_id = ?',
  ).get(workspaceId, batchId) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}
