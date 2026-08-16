/**
 * Durable operator review/approval state (epic #46, Phases 1/7).
 *
 * The pipeline stage alone cannot answer the five questions the operator
 * read model needs (Curation complete / Review not started / Reviewed /
 * Approved / Exported). This repository owns the durable review and approval
 * record for each onboarding item:
 *
 * - `markReviewed` — written by the review-complete flow; re-review clears
 *   any prior approval (a fresh review supersedes the old release decision).
 * - `markReviewInvalidated` — a consequential edit after review invalidates
 *   the review AND clears any approval: the item must be re-reviewed and is
 *   never bulk-approvable while invalidated.
 * - `markApproved` — guarded write: requires an existing, non-invalidated
 *   review and no prior approval. Approval does NOT export anything.
 */
import { getDb } from '../connection';

export interface OnboardingReviewState {
  itemId: string;
  batchId: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewInvalidatedAt: string | null;
  reviewInvalidationReason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalOrigin: string;
  createdAt: string;
  updatedAt: string;
}

interface ReviewStateRow {
  item_id: string;
  batch_id: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_invalidated_at: string | null;
  review_invalidation_reason: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approval_origin: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ReviewStateRow): OnboardingReviewState {
  return {
    itemId: row.item_id,
    batchId: row.batch_id,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewInvalidatedAt: row.review_invalidated_at,
    reviewInvalidationReason: row.review_invalidation_reason,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    approvalOrigin: row.approval_origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getReviewState(itemId: string): OnboardingReviewState | undefined {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM onboarding_review_state WHERE item_id = ?',
  ).get(itemId) as ReviewStateRow | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * Load every review-state row for a batch, keyed by item id. One batched
 * query — used by the batch work-state projection.
 */
export function listReviewStates(batchId: string): Map<string, OnboardingReviewState> {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_review_state WHERE batch_id = ?',
  ).all(batchId) as ReviewStateRow[];
  return new Map(rows.map(row => [row.item_id, mapRow(row)]));
}

/**
 * Record a durable human review. Upsert semantics: re-review replaces the
 * review timestamp and CLEARS any prior approval (a fresh review supersedes
 * the old release decision) plus any prior invalidation (the item is being
 * deliberately re-verified after an edit).
 */
export function markReviewed(input: { itemId: string; batchId: string; reviewedBy: string }): OnboardingReviewState {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getReviewState(input.itemId);
  const createdAt = existing?.createdAt ?? now;
  db.query(
    `INSERT INTO onboarding_review_state
       (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason,
        approved_at, approved_by, approval_origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'bulk', ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       reviewed_at = excluded.reviewed_at,
       reviewed_by = excluded.reviewed_by,
       review_invalidated_at = NULL,
       review_invalidation_reason = NULL,
       approved_at = NULL,
       approved_by = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.itemId, input.batchId, now, input.reviewedBy, createdAt, now);
  return getReviewState(input.itemId)!;
}

/**
 * Invalidate a durable review after a consequential edit. Also clears any
 * approval: the release decision no longer applies to the edited output.
 * No-op when the item was never reviewed (or already invalidated).
 *
 * @returns true when a review was actually invalidated.
 */
export function markReviewInvalidated(itemId: string, reason: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_review_state
     SET review_invalidated_at = ?, review_invalidation_reason = ?,
         approved_at = NULL, approved_by = NULL, updated_at = ?
     WHERE item_id = ? AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL`,
  ).run(now, reason, now, itemId);
  return result.changes > 0;
}

/**
 * Guarded approval write: requires an existing non-invalidated review and no
 * prior approval. Returns false (no write) when the durable state does not
 * support approval — the caller reports the item as rejected.
 */
export function markApproved(input: {
  itemId: string;
  batchId: string;
  approvedBy: string;
  origin?: string;
}): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_review_state
     SET approved_at = ?, approved_by = ?, approval_origin = ?, updated_at = ?
     WHERE item_id = ? AND batch_id = ?
       AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL AND approved_at IS NULL`,
  ).run(now, input.approvedBy, input.origin ?? 'bulk', now, input.itemId, input.batchId);
  return result.changes > 0;
}

/**
 * Atomic bulk approval + review→promotion advance (epic #46 review
 * remediation, fix 1).
 *
 * The two writes — durable approval (`onboarding_review_state`) and the
 * item stage transition (`onboarding_items` review/completed →
 * promotion/pending) — happen in ONE transaction for the whole batch
 * operation (a stronger guarantee than per-item transactions: a concurrent
 * consequential edit can never interleave and leave an item in `promotion`
 * WITHOUT durable approval). Per-item failures are isolated via `continue`
 * (no throw), so one rejected item never rolls back the others.
 *
 * Guards mirror the existing single-write primitives: the approval UPDATE
 * requires an existing non-invalidated review and no prior approval; the
 * advance UPDATE requires the item to still be `review / completed` in the
 * SAME batch. A blocked semantic validation is refused exactly like the
 * diagnostics advance guard (`advanceReviewedItemsToPromotion`). When the
 * advance guard fails AFTER the approval write succeeded, the approval is
 * reverted inside the SAME transaction — no partial state escapes.
 *
 * Returns per-item structured outcomes (approved | rejected + reason).
 */
export function approveAndAdvanceItems(input: {
  itemIds: string[];
  batchId: string;
  approvedBy: string;
  origin?: string;
}): { approved: string[]; rejected: Array<{ itemId: string; reason: string }> } {
  const db = getDb();
  const now = new Date().toISOString();
  const approved: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];

  db.transaction(() => {
    for (const id of input.itemIds) {
      // 1. Read the CURRENT item state inside the transaction (serializable
      //    single-writer: no interleaving is possible after this read).
      const itemRow = db.query(
        `SELECT id, batch_id, stage, stage_status, curation_data_json
         FROM onboarding_items WHERE id = ?`,
      ).get(id) as
        | { id: string; batch_id: string; stage: string; stage_status: string; curation_data_json: string | null }
        | undefined;
      if (!itemRow) {
        rejected.push({ itemId: id, reason: 'item_not_found' });
        continue;
      }
      if (itemRow.batch_id !== input.batchId) {
        rejected.push({ itemId: id, reason: 'item_not_in_batch' });
        continue;
      }
      if (itemRow.stage !== 'review' || itemRow.stage_status !== 'completed') {
        rejected.push({ itemId: id, reason: `not_eligible:${itemRow.stage}/${itemRow.stage_status}` });
        continue;
      }
      // Semantic-block parity with the diagnostics advance guard: a blocked
      // member is never a release decision.
      let curation: {
        semanticValidation?: { status?: unknown; findings?: Array<{ message?: unknown }> };
      } | null = null;
      try {
        curation = itemRow.curation_data_json
          ? JSON.parse(itemRow.curation_data_json) as {
              semanticValidation?: { status?: unknown; findings?: Array<{ message?: unknown }> };
            }
          : null;
      } catch {
        // Corrupt curation payload — fail closed per item, never abort the
        // whole bulk approval transaction (reviewer P6).
        rejected.push({ itemId: id, reason: 'invalid_curation_data' });
        continue;
      }
      const semanticValidation = curation?.semanticValidation;
      if (
        semanticValidation &&
        typeof semanticValidation === 'object' &&
        semanticValidation.status === 'blocked'
      ) {
        const findings = semanticValidation.findings;
        const firstMessage =
          Array.isArray(findings) && findings.length > 0 && typeof findings[0]?.message === 'string'
            ? findings[0].message
            : 'A hard cohort semantic validation finding blocks this item.';
        rejected.push({ itemId: id, reason: `semantic_validation_blocked: ${firstMessage}` });
        continue;
      }

      // 2. Guarded durable approval write.
      const approvalResult = db.query(
        `UPDATE onboarding_review_state
         SET approved_at = ?, approved_by = ?, approval_origin = ?, updated_at = ?
         WHERE item_id = ? AND batch_id = ?
           AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL AND approved_at IS NULL`,
      ).run(now, input.approvedBy, input.origin ?? 'bulk', now, id, input.batchId);
      if (approvalResult.changes === 0) {
        // Precise rejection reason from the CURRENT durable row.
        const row = db.query(
          'SELECT reviewed_at, review_invalidated_at, approved_at FROM onboarding_review_state WHERE item_id = ?',
        ).get(id) as
          | { reviewed_at: string | null; review_invalidated_at: string | null; approved_at: string | null }
          | undefined;
        if (!row?.reviewed_at) {
          rejected.push({ itemId: id, reason: 'not_reviewed' });
        } else if (row.review_invalidated_at) {
          rejected.push({ itemId: id, reason: 'review_invalidated' });
        } else if (row.approved_at) {
          rejected.push({ itemId: id, reason: 'already_approved' });
        } else {
          rejected.push({ itemId: id, reason: 'approval_write_conflict' });
        }
        continue;
      }

      // 3. Guarded advance review→promotion in the SAME transaction. On
      //    failure the approval write is reverted atomically below.
      const advanceResult = db.query(
        `UPDATE onboarding_items
         SET stage = 'promotion', stage_status = 'pending', error_message = NULL, retry_count = 0,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND batch_id = ? AND stage = 'review' AND stage_status = 'completed'`,
      ).run(now, id, input.batchId);
      if (advanceResult.changes > 0) {
        approved.push(id);
      } else {
        db.query(
          `UPDATE onboarding_review_state
           SET approved_at = NULL, approved_by = NULL, approval_origin = NULL, updated_at = ?
           WHERE item_id = ?`,
        ).run(now, id);
        rejected.push({ itemId: id, reason: 'advance_failed_state_changed' });
      }
    }
  })();

  return { approved, rejected };
}
