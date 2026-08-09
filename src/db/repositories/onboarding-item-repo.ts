import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingItem, ItemStatus, PipelineStage, StageStatus, SourcingDecision } from '../../shared/schemas/onboarding';

export interface OnboardingItemRow {
  id: string;
  batch_id: string;
  upc: string;
  name: string;
  price: string | null;
  quantity: number | null;
  brand_hint: string | null;
  department_hint: string | null;
  source_url: string | null;
  expected_name: string | null;
  coordinated_title: string | null;
  /** DEPRECATED — use stage + stage_status. Kept for backward compat during migration. */
  status: string;
  stage: string;
  stage_status: string;
  error_message: string | null;
  retry_count: number;
  is_duplicate: number;
  existing_sku: string | null;
  extraction_data_json: string | null;
  curation_data_json: string | null;
  row_number: number;
  created_at: string;
  updated_at: string;
}

export interface InsertItemData {
  upc: string;
  name: string;
  price?: string | null;
  quantity?: number | null;
  brandHint?: string | null;
  departmentHint?: string | null;
  sourceUrl?: string | null;
  rowNumber: number;
  isDuplicate?: boolean;
  existingSku?: string | null;
  stage?: PipelineStage;
  stageStatus?: StageStatus;
}

const STAGE_ORDER: PipelineStage[] = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'];

const PIPELINE_STAGES = STAGE_ORDER;

function mapRowToItem(row: OnboardingItemRow): OnboardingItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    upc: row.upc,
    name: row.name,
    price: row.price,
    quantity: row.quantity,
    brandHint: row.brand_hint,
    departmentHint: row.department_hint,
    sourceUrl: row.source_url,
    expectedName: row.expected_name ?? null,
    coordinatedTitle: row.coordinated_title ?? null,
    sourceType: (row as any).source_type ?? 'official_page',
    acceptedEvidenceAttemptIds: (row as any).accepted_evidence_attempt_ids_json ? JSON.parse((row as any).accepted_evidence_attempt_ids_json) : [],
    acceptedEvidenceAttemptId: (row as any).accepted_evidence_attempt_id ?? null,
    sourcingDecision: (row as any).sourcing_decision_json ? JSON.parse((row as any).sourcing_decision_json) : null,
    stage: (row.stage || 'sourcing') as PipelineStage,
    stageStatus: (row.stage_status || 'pending') as StageStatus,
    status: (row.status || 'imported') as ItemStatus,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    isDuplicate: row.is_duplicate === 1,
    existingSku: row.existing_sku,
    extractionData: row.extraction_data_json ? JSON.parse(row.extraction_data_json) : null,
    curationData: row.curation_data_json ? JSON.parse(row.curation_data_json) : null,
    rowNumber: row.row_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── INSERT ────────────────────────────────────────────────────────────────────

export function insertItems(batchId: string, items: InsertItemData[]): OnboardingItem[] {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.query(
    `INSERT INTO onboarding_items
      (id, batch_id, upc, name, price, quantity, brand_hint, department_hint, source_url, expected_name,
       status, stage, stage_status, error_message, retry_count, is_duplicate, existing_sku,
       extraction_data_json, curation_data_json, row_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported', ?, ?, NULL, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
  );

  const inserted: OnboardingItem[] = [];

  const insertAll = db.transaction(() => {
    for (const item of items) {
      const id = randomUUID();
      const isDuplicateNum = item.isDuplicate ? 1 : 0;
      const targetStage = item.stage ?? 'sourcing';
      const targetStageStatus = item.stageStatus ?? 'pending';
      stmt.run(
        id,
        batchId,
        item.upc,
        item.name,
        item.price ?? null,
        item.quantity ?? null,
        item.brandHint ?? null,
        item.departmentHint ?? null,
        item.sourceUrl ?? null,
        targetStage,
        targetStageStatus,
        isDuplicateNum,
        item.existingSku ?? null,
        item.rowNumber,
        now,
        now,
      );
      inserted.push({
        id,
        batchId,
        upc: item.upc,
        name: item.name,
        price: item.price ?? null,
        quantity: item.quantity ?? null,
        brandHint: item.brandHint ?? null,
        departmentHint: item.departmentHint ?? null,
        sourceUrl: item.sourceUrl ?? null,
        expectedName: null,
        sourceType: 'official_page',
        acceptedEvidenceAttemptIds: [],
        acceptedEvidenceAttemptId: null,
        sourcingDecision: null,
        stage: targetStage as PipelineStage,
        stageStatus: targetStageStatus as StageStatus,
        status: 'imported' as ItemStatus,
        errorMessage: null,
        retryCount: 0,
        isDuplicate: !!item.isDuplicate,
        existingSku: item.existingSku ?? null,
        extractionData: null,
        curationData: null,
        rowNumber: item.rowNumber,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  insertAll();

  return inserted;
}

// ─── LOOKUPS ────────────────────────────────────────────────────────────────────

export function findItemById(id: string): OnboardingItem | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_items WHERE id = ?').get(id) as OnboardingItemRow | undefined;
  return row ? mapRowToItem(row) : undefined;
}

export function listItemsByBatch(
  batchId: string,
  statusFilter?: ItemStatus | ItemStatus[],
): OnboardingItem[] {
  const db = getDb();

  let rows: OnboardingItemRow[];
  if (!statusFilter) {
    rows = db.query(
      'SELECT * FROM onboarding_items WHERE batch_id = ? ORDER BY row_number',
    ).all(batchId) as OnboardingItemRow[];
  } else {
    const statuses = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
    const placeholders = statuses.map(() => '?').join(', ');
    rows = db.query(
      `SELECT * FROM onboarding_items WHERE batch_id = ? AND status IN (${placeholders}) ORDER BY row_number`,
    ).all(batchId, ...statuses) as OnboardingItemRow[];
  }

  return rows.map(mapRowToItem);
}

// ─── STAGE-BASED METHODS ────────────────────────────────────────────────────────

/**
 * Get all items for a batch, grouped by stage. Used by the Pipeline Board.
 */
export function listItemsByBatchStaged(batchId: string): Record<PipelineStage, OnboardingItem[]> {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_items WHERE batch_id = ? ORDER BY row_number',
  ).all(batchId) as OnboardingItemRow[];

  const items = rows.map(mapRowToItem);
  const grouped: Record<PipelineStage, OnboardingItem[]> = {
    sourcing: [],
    discovery: [],
    extraction: [],
    curation: [],
    review: [],
    promotion: [],
  };

  for (const item of items) {
    const stage = item.stage;
    if (grouped[stage]) {
      grouped[stage].push(item);
    }
  }

  return grouped;
}

/**
 * Get items that are pending within a specific stage — used by the worker.
 * Optionally filtered by workspaceId for multi-workspace support.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getPendingItemsByStage(
  stage: PipelineStage,
  limit: number,
  workspaceId?: string,
): OnboardingItem[] {
  const db = getDb();

  let rows: OnboardingItemRow[];
  if (workspaceId) {
    rows = db.query(
      `SELECT i.* FROM onboarding_items i
       JOIN onboarding_batches b ON i.batch_id = b.id
       WHERE b.workspace_id = ? AND b.status = 'active' AND i.stage = ? AND i.stage_status = 'pending'
       ORDER BY i.row_number
       LIMIT ?`,
    ).all(workspaceId, stage, limit) as OnboardingItemRow[];
  } else {
    rows = db.query(
      `SELECT i.* FROM onboarding_items i
       JOIN onboarding_batches b ON i.batch_id = b.id
       WHERE b.status = 'active' AND i.stage = ? AND i.stage_status = 'pending'
       ORDER BY i.row_number
       LIMIT ?`,
    ).all(stage, limit) as OnboardingItemRow[];
  }
  return rows.map(mapRowToItem);
}

/**
 * Atomically claim pending items for processing within a workspace.
 *
 * Uses a single atomic UPDATE with a subquery to find eligible items and
 * claim them in one statement. Items with 'in_progress' and a stale claim
 * (older than 5 minutes) are re-claimable for crash recovery. Newly advanced
 * or reset items have stage_status='pending' so they are always claimable
 * regardless of any old claimed_by value (the stale threshold clause only
 * matches in_progress items that still carry an old claim).
 *
 * @param stage - Pipeline stage to claim items from
 * @param limit - Maximum number of items to claim
 * @param workspaceId - Workspace to claim items from
 * @param workerId - Unique worker identifier for the claiming worker
 * @returns Array of claimed onboarding items (empty if none available)
 */
export function claimItemsForProcessing(
  stage: PipelineStage,
  limit: number,
  workspaceId: string,
  workerId: string,
): OnboardingItem[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Atomic UPDATE with subquery. The outer AND stage_status = 'pending'
  // prevents claiming items already picked up by a concurrent worker.
  // Eligibility is strictly stage_status = 'pending' — stale in_progress
  // items are recovered by requeueStaleInProgressItems.
  const result = db.run(
    `UPDATE onboarding_items
     SET stage_status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ?
     WHERE id IN (
       SELECT i.id FROM onboarding_items i
       JOIN onboarding_batches b ON i.batch_id = b.id
       WHERE b.workspace_id = ? AND b.status = 'active'
       AND i.stage = ? AND i.stage_status = 'pending'
       ORDER BY i.row_number
       LIMIT ?
     )
     AND stage_status = 'pending'`,
    [workerId, now, now, workspaceId, stage, limit],
  );

  if (result.changes === 0) return [];

  // Read back the claimed items (identified by workerId + timestamp pair)
  const rows = db.query(
    `SELECT * FROM onboarding_items
     WHERE claimed_by = ? AND claimed_at = ?
     ORDER BY row_number
     LIMIT ?`,
  ).all(workerId, now, limit) as OnboardingItemRow[];

  return rows.map(mapRowToItem);
}

/**
 * Requeue items in this workspace that are stuck in 'in_progress' with a
 * stale claim (older than the given threshold). Clears claim fields and
 * resets stage_status to 'pending'. Used by worker startup to recover
 * items from a crashed worker without touching items a live worker holds.
 *
 * @param workspaceId - Workspace to clean up
 * @param staleBefore - ISO timestamp; items with claimed_at older than this are reset
 * @returns Number of items requeued
 */
export function requeueStaleInProgressItems(workspaceId: string, staleBefore: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  
  // Fail any active classification runs for the items we are about to requeue
  db.run(
    `UPDATE classification_runs
     SET status = 'failed', completed_at = ?, error_message = 'Worker claim went stale'
     WHERE status = 'running' AND onboarding_item_id IN (
       SELECT id FROM onboarding_items
       WHERE stage_status = 'in_progress' AND (claimed_at IS NULL OR claimed_at < ?)
       AND batch_id IN (SELECT id FROM onboarding_batches WHERE workspace_id = ?)
     )`,
    [now, staleBefore, workspaceId],
  );

  const result = db.run(
    `UPDATE onboarding_items
     SET stage_status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE stage_status = 'in_progress' AND (claimed_at IS NULL OR claimed_at < ?)
     AND batch_id IN (SELECT id FROM onboarding_batches WHERE workspace_id = ?)`,
    [now, staleBefore, workspaceId],
  );
  if (result.changes > 0) {
    console.log(`[OnboardingItemRepo] Requeued ${result.changes} stale in_progress items for workspace ${workspaceId}`);
  }
  return result.changes;
}

/**
 * Advance one or more items to the next stage.
 * Only advances items that are 'completed' in their current stage.
 * Sets items to pending in the target stage. Resets retry_count and error_message.
 */
export function advanceItemsToNextStage(itemIds: string[]): { advanced: number; skipped: number } {
  if (itemIds.length === 0) return { advanced: 0, skipped: 0 };

  const db = getDb();
  const now = new Date().toISOString();
  let advanced = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const id of itemIds) {
      const item = findItemById(id);
      if (!item) {
        skipped++;
        continue;
      }

      // Only advance items that are 'completed' in their current stage
      if (item.stageStatus !== 'completed') {
        skipped++;
        continue;
      }

      let nextStage: PipelineStage;
      if (item.stage === 'sourcing') {
        if (item.sourcingDecision?.route === 'bundle_to_curation') {
          nextStage = 'curation';
        } else {
          nextStage = 'discovery';
        }
      } else {
        const currentIdx = STAGE_ORDER.indexOf(item.stage);
        if (currentIdx < 0 || currentIdx >= STAGE_ORDER.length - 1) {
          // Already at promotion or unknown stage — can't advance
          skipped++;
          continue;
        }
        nextStage = STAGE_ORDER[currentIdx + 1];
      }

      db.query(
        `UPDATE onboarding_items
         SET stage = ?, stage_status = 'pending', error_message = NULL, retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(nextStage, now, id);
      advanced++;
    }
  })();

  return { advanced, skipped };
}

/**
 * Update the stage_status of an item (used by worker while processing).
 * Clears claim fields whenever the item transitions out of in_progress
 * so it can be claimed again immediately on retry.
 */
export function updateItemStageStatus(
  id: string,
  stageStatus: StageStatus,
  errorMessage?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  // Clear claim fields on any terminal or retryable status transition
  if (stageStatus !== 'in_progress') {
    db.query(
      'UPDATE onboarding_items SET stage_status = ?, error_message = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?',
    ).run(stageStatus, errorMessage ?? null, now, id);
  } else {
    db.query(
      'UPDATE onboarding_items SET stage_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    ).run(stageStatus, errorMessage ?? null, now, id);
  }
}

/**
 * Mark an item's review stage as completed with the current timestamp.
 * Sets stage_status='completed' for items in the review stage.
 */
export function completeReviewStage(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE onboarding_items SET stage_status = 'completed', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND stage = 'review'",
  ).run(now, id);
}

/**
 * Mark an item's promotion stage as completed or failed.
 */
export function completePromotionStage(id: string, success: boolean, errorMessage?: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (success) {
    db.query(
      "UPDATE onboarding_items SET stage_status = 'completed', error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND stage = 'promotion'",
    ).run(now, id);
  } else {
    db.query(
      'UPDATE onboarding_items SET stage_status = ?, error_message = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?',
    ).run('failed', errorMessage ?? null, now, id);
  }
}

/**
 * Stage-aware update for source URL + completion in discovery stage.
 */
export function setDiscoverySourceUrl(id: string, url: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE onboarding_items SET source_url = ?, stage_status = 'completed', updated_at = ? WHERE id = ?",
  ).run(url, now, id);
}

/**
 * Get stage distribution counts for a batch (for column headers).
 */
export function getStageCounts(batchId: string): Record<PipelineStage, number> {
  const db = getDb();
  const rows = db.query(
    'SELECT stage, COUNT(*) as count FROM onboarding_items WHERE batch_id = ? GROUP BY stage',
  ).all(batchId) as Array<{ stage: string; count: number }>;

  const counts: Record<PipelineStage, number> = {
    sourcing: 0,
    discovery: 0,
    extraction: 0,
    curation: 0,
    review: 0,
    promotion: 0,
  };

  for (const row of rows) {
    const stage = row.stage as PipelineStage;
    if (Object.prototype.hasOwnProperty.call(counts, stage)) {
      counts[stage] = row.count;
    }
  }

  return counts;
}

/**
 * Reset items back to pending in their current stage (for retry).
 */
export function resetItemsToPending(itemIds: string[]): void {
  if (itemIds.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of itemIds) {
      const item = findItemById(id);
      if (!item) continue;

      // Fail any active classification runs for this item
      db.query(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Superseded by reset'
         WHERE onboarding_item_id = ? AND status = 'running'`,
      ).run(now, id);

      if (item.stage === 'review' || item.stage === 'promotion') {
        db.query(
          `UPDATE onboarding_items
           SET stage_status = 'pending', error_message = NULL, retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(now, id);
      } else {
        db.query(
          `UPDATE onboarding_items
           SET stage_status = 'pending', error_message = NULL, retry_count = 0, curation_data_json = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(now, id);
      }
    }
  })();
}

/**
 * Skip items (mark as skipped in current stage).
 */
export function skipItems(itemIds: string[]): void {
  if (itemIds.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = itemIds.map(() => '?').join(', ');
  db.query(
    `UPDATE onboarding_items
     SET stage_status = 'skipped', claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(now, ...itemIds);
}

/**
 * Reset items to a specific pipeline stage with 'completed' status.
 * Preserves all existing extraction/curation data and source URLs.
 * The item will show in the target stage in the PipelineBoard but
 * the worker will not re-process it (since stage_status is 'completed').
 */
export function resetItemsToStage(
  itemIds: string[],
  targetStage: PipelineStage,
): { reset: number } {
  if (itemIds.length === 0) return { reset: 0 };
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = itemIds.map(() => '?').join(', ');
  db.query(
    `UPDATE onboarding_items
     SET stage = ?, stage_status = 'completed', claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(targetStage, now, ...itemIds);
  return { reset: itemIds.length };
}

/**
 * Send items to their previous stage, undoing results of the current stage.
 * Target stage is marked as 'completed' so it will not rerun.
 */
export function sendItemsToPreviousStage(
  itemIds: string[],
): { moved: number; skipped: number } {
  if (itemIds.length === 0) return { moved: 0, skipped: 0 };

  const db = getDb();
  const now = new Date().toISOString();
  let moved = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const id of itemIds) {
      const item = findItemById(id);
      if (!item) {
        skipped++;
        continue;
      }

      const currentIdx = STAGE_ORDER.indexOf(item.stage);
      if (currentIdx <= 0) {
        skipped++;
        continue;
      }

      const previousStage = STAGE_ORDER[currentIdx - 1];

      // Undo the current stage's specific outcomes
      if (item.stage === 'extraction') {
        db.query('DELETE FROM onboarding_extractions WHERE item_id = ?').run(id);
        db.query('UPDATE onboarding_items SET extraction_data_json = NULL, status = ? WHERE id = ?').run('source_confirmed', id);
      } else if (item.stage === 'curation') {
        db.query('UPDATE onboarding_items SET curation_data_json = NULL WHERE id = ?').run(id);
      } else if (item.stage === 'review') {
        // Append-only: supersede the run's decisions instead of deleting them.
        // Re-review can then re-issue decisions (including exact retries of
        // previously superseded payloads) as fresh live revisions.
        db.query(`
          UPDATE classification_proposal_decisions
          SET superseded_at = ?
          WHERE superseded_at IS NULL AND proposal_id IN (
            SELECT id FROM classification_proposals
            WHERE run_id IN (SELECT id FROM classification_runs WHERE onboarding_item_id = ?)
          )
        `).run(now, id);
        db.query(`
          UPDATE classification_proposals
          SET status = 'pending'
          WHERE run_id IN (SELECT id FROM classification_runs WHERE onboarding_item_id = ?)
        `).run(id);
        db.query('UPDATE onboarding_items SET status = ? WHERE id = ?').run('curated', id);
      } else if (item.stage === 'promotion') {
        db.query(`
          DELETE FROM change_set_items
          WHERE sku = ? AND change_set_id IN (SELECT id FROM change_sets WHERE status = 'draft')
        `).run(item.upc);
        db.query('DELETE FROM product_pages WHERE product_sku = ?').run(item.upc);
        db.query('UPDATE onboarding_items SET status = ? WHERE id = ?').run('ready', id);
      }

      // Revert the item back to the previous stage, set to completed
      db.query(
        `UPDATE onboarding_items
         SET stage = ?, stage_status = 'completed', error_message = NULL, retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(previousStage, now, id);

      moved++;
    }
  })();

  return { moved, skipped };
}


// ─── DEPRECATED — kept for backward compat during migration ────────────────────
function updateItemStatus(
  id: string,
  status: ItemStatus,
  errorMessage?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
  ).run(status, errorMessage ?? null, now, id);
}

/** @deprecated Use setDiscoverySourceUrl instead (sets stage_status only, no legacy status) */
// fallow-ignore-next-line unused-export
export function updateItemSourceUrl(id: string, url: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE onboarding_items SET source_url = ?, status = ?, stage_status = 'completed', updated_at = ? WHERE id = ?",
  ).run(url, 'source_confirmed', now, id);
}

export function updateItemExtractionData(id: string, extractionDataJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
  ).run(extractionDataJson, now, id);
}

function updateItemCurationData(id: string, curationDataJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?',
  ).run(curationDataJson, now, id);
}

export function updateItemExpectedName(id: string, expectedName: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET expected_name = ?, updated_at = ? WHERE id = ?',
  ).run(expectedName, now, id);
}

export function updateItemBrandHint(id: string, brandHint: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET brand_hint = ?, updated_at = ? WHERE id = ?',
  ).run(brandHint, now, id);
}

export function incrementRetryCount(id: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?',
  ).run(now, id);
  const row = db.query('SELECT retry_count FROM onboarding_items WHERE id = ?').get(id) as { retry_count: number };
  return row.retry_count;
}

/** @deprecated Use getStageCounts instead */
function countItemsByStatus(batchId: string): Record<string, number> {
  const db = getDb();
  const rows = db.query(
    'SELECT status, COUNT(*) as count FROM onboarding_items WHERE batch_id = ? GROUP BY status',
  ).all(batchId) as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

/** @deprecated Use getPendingItemsByStage instead */
function getNextPendingItems(
  batchId: string,
  status: ItemStatus,
  limit: number,
): OnboardingItem[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_items WHERE batch_id = ? AND status = ? ORDER BY row_number LIMIT ?',
  ).all(batchId, status, limit) as OnboardingItemRow[];
  return rows.map(mapRowToItem);
}

export interface WeeklyReportProductItem {
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  batchName: string;
  status: string;
  stage: string;
  stageStatus: string;
  createdAt: string;
  updatedAt: string;
}

export function getWeeklyReportItems(startDateIso: string, endDateIso: string): WeeklyReportProductItem[] {
  const db = getDb();
  const rows = db.query(
    `SELECT 
      i.id, i.upc, i.name, i.expected_name, i.coordinated_title, i.brand_hint, i.status, i.stage, i.stage_status, i.created_at, i.updated_at, i.curation_data_json, i.extraction_data_json,
      b.name as batch_name
    FROM onboarding_items i
    LEFT JOIN onboarding_batches b ON i.batch_id = b.id
    WHERE (i.created_at >= ? AND i.created_at <= ?)
       OR (i.updated_at >= ? AND i.updated_at <= ?)
    ORDER BY i.updated_at DESC`
  ).all(startDateIso, endDateIso, startDateIso, endDateIso) as Array<{
    id: string;
    upc: string;
    name: string;
    expected_name: string | null;
    coordinated_title: string | null;
    brand_hint: string | null;
    status: string;
    stage: string;
    stage_status: string;
    created_at: string;
    updated_at: string;
    curation_data_json: string | null;
    extraction_data_json: string | null;
    batch_name: string | null;
  }>;

  return rows.map(r => {
    let displayTitle = r.name;
    if (r.coordinated_title) {
      displayTitle = r.coordinated_title;
    } else if (r.curation_data_json) {
      try {
        const curation = JSON.parse(r.curation_data_json);
        if (curation?.curatedTitle) displayTitle = curation.curatedTitle;
      } catch {}
    } else if (r.expected_name) {
      displayTitle = r.expected_name;
    } else if (r.extraction_data_json) {
      try {
        const ext = JSON.parse(r.extraction_data_json);
        if (ext?.title) displayTitle = ext.title;
      } catch {}
    }

    return {
      id: r.id,
      upc: r.upc,
      name: displayTitle,
      brandHint: r.brand_hint,
      batchName: r.batch_name || 'Direct Import',
      status: r.status,
      stage: r.stage,
      stageStatus: r.stage_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/**
  * Update an item's sourcing decision and option stage / stage_status.
  */
export function updateSourcingDecision(
  id: string,
  decision: SourcingDecision,
  nextStage?: PipelineStage,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const jsonStr = JSON.stringify(decision);

  if (nextStage) {
    db.query(
      `UPDATE onboarding_items
       SET sourcing_decision_json = ?, stage = ?, stage_status = 'pending', error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(jsonStr, nextStage, now, id);
  } else {
    db.query(
      `UPDATE onboarding_items
       SET sourcing_decision_json = ?, stage_status = 'completed', error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(jsonStr, now, id);
  }
}

