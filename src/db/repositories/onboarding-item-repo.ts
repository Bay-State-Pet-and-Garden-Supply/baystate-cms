import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingItem, ItemStatus, PipelineStage, StageStatus } from '../../shared/schemas/onboarding';

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
}

const STAGE_ORDER: PipelineStage[] = ['discovery', 'extraction', 'curation', 'review', 'promotion'];

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
    stage: (row.stage || 'discovery') as PipelineStage,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported', 'discovery', 'pending', NULL, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
  );

  const inserted: OnboardingItem[] = [];

  const insertAll = db.transaction(() => {
    for (const item of items) {
      const id = randomUUID();
      const isDuplicateNum = item.isDuplicate ? 1 : 0;
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
        stage: 'discovery' as PipelineStage,
        stageStatus: 'pending' as StageStatus,
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

      const currentIdx = STAGE_ORDER.indexOf(item.stage);
      if (currentIdx < 0 || currentIdx >= STAGE_ORDER.length - 1) {
        // Already at promotion or unknown stage — can't advance
        skipped++;
        continue;
      }

      const nextStage = STAGE_ORDER[currentIdx + 1];
      if (nextStage === 'review') {
        const proposals = item.curationData?.classificationProposals || [];
        const hasPending = proposals.some(
          (p: any) => p.targetId !== 'product_draft_projection' && p.status !== 'accepted' && p.status !== 'rejected'
        );
        if (hasPending) {
          skipped++;
          continue;
        }
      }

      db.query(
        `UPDATE onboarding_items
         SET stage = ?, stage_status = 'pending', error_message = NULL, retry_count = 0, updated_at = ?
         WHERE id = ?`,
      ).run(nextStage, now, id);
      advanced++;
    }
  })();

  return { advanced, skipped };
}

/**
 * Update the stage_status of an item (used by worker while processing).
 */
export function updateItemStageStatus(
  id: string,
  stageStatus: StageStatus,
  errorMessage?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET stage_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
  ).run(stageStatus, errorMessage ?? null, now, id);
}

/**
 * Mark an item's review stage as completed with the current timestamp.
 * Sets stage_status='completed' for items in the review stage.
 */
export function completeReviewStage(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE onboarding_items SET stage_status = 'completed', updated_at = ? WHERE id = ? AND stage = 'review'",
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
      "UPDATE onboarding_items SET stage_status = 'completed', error_message = NULL, updated_at = ? WHERE id = ? AND stage = 'promotion'",
    ).run(now, id);
  } else {
    db.query(
      'UPDATE onboarding_items SET stage_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
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
  const placeholders = itemIds.map(() => '?').join(', ');
  db.query(
    `UPDATE onboarding_items
     SET stage_status = 'pending', error_message = NULL, retry_count = 0, curation_data_json = NULL, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(now, ...itemIds);
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
     SET stage_status = 'skipped', updated_at = ?
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
     SET stage = ?, stage_status = 'completed', updated_at = ?
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
        db.query(`
          DELETE FROM classification_proposal_decisions
          WHERE proposal_id IN (
            SELECT id FROM classification_proposals
            WHERE run_id IN (SELECT id FROM classification_runs WHERE onboarding_item_id = ?)
          )
        `).run(id);
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
         SET stage = ?, stage_status = 'completed', error_message = NULL, retry_count = 0, updated_at = ?
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

function updateItemExtractionData(id: string, extractionDataJson: string): void {
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
