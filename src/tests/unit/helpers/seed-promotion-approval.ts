import { getDb } from '../../../db/connection';
import { markReviewed, markApproved } from '../../../db/repositories/onboarding-review-repo';

/**
 * Epic #46 review round-2 — seed durable review + approval for items that a
 * test is about to promote.
 *
 * `promoteItems` now rejects (final transactional authority) any item that is
 * not `promotion / pending` with a non-invalidated durable approval. Legacy
 * promotion fixtures that placed items directly into the promotion stage with
 * raw SQL never created `onboarding_review_state` rows, so they fail under the
 * gate. This helper restores the real operating contract those fixtures must
 * encode: an item is reviewed, then approved, before the export-draft step.
 *
 * `markReviewed` is an upsert that CLEARs any prior approval; `markApproved`
 * requires reviewed_at set + not invalidated + approved_at null and sets the
 * approval. The correct seed is therefore markReviewed THEN markApproved.
 */
export function seedPromotionApproval(
  items: Array<{ id: string; batchId: string }>,
): void {
  for (const item of items) {
    markReviewed({ itemId: item.id, batchId: item.batchId, reviewedBy: 'test' });
    markApproved({ itemId: item.id, batchId: item.batchId, approvedBy: 'test' });
  }
}

/**
 * Move items into the promotion stage AND seed durable review + approval.
 *
 * Legacy promotion fixtures called `promoteItems` directly from the
 * `curation / completed` state. The round-2 authority gate requires the item
 * to be `promotion / pending` with a non-invalidated approval at the final
 * transaction, so fixtures must reflect that real post-approval state. Use
 * BEFORE any `promoteItems` call that is expected to reach a non-approval gate
 * (or to succeed).
 */
export function prepareItemsForPromotion(
  items: Array<{ id: string; batchId: string }>,
): void {
  if (items.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  for (const item of items) {
    db.query(
      "UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now, item.id);
  }
  seedPromotionApproval(items);
}
