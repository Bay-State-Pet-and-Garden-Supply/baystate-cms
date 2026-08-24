import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingItem, ItemStatus, PipelineStage, StageStatus, SourcingDecision, SourcingDecisionV2 } from '../../shared/schemas/onboarding';
import { getAcceptedAttemptIdsForItem, isAcceptanceMigrationCompleted } from './onboarding-acceptance-repo';
import { supersedeCurrentSourcingGeneration, getCurrentSourcingGeneration, getEvidenceAttemptsByItemAndGeneration } from './onboarding-evidence-repo';
import { getCurrentGenerationAcceptedAttemptIds } from './onboarding-acceptance-repo';
import { SOURCING_ENTRY_POLICY_VERSION, isCurrentSourcingEntryPolicy } from '../../onboarding/sourcing/entry-policy';
import {
  buildDistributorRecordProjection,
  type ProjectionResolutionInput,
  type SourcingProjectionReasonCode,
} from '../../onboarding/sourcing/distributor-record-projection';
import { SourcingDecisionV2Schema } from '../../shared/schemas/onboarding';

/**
 * Onboarding item with the durable sourcing entry-policy version hydrated
 * (Amendment A). The version is a column on `onboarding_items`; the shared
 * `OnboardingItem` schema predates it, so repo returns carry it as an
 * intersection type without widening the shared schema.
 */
export type OnboardingItemWithEntryPolicy = OnboardingItem & { sourcingEntryPolicyVersion: number };

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
  is_held?: number | null;
  held_reason?: string | null;
  error_message: string | null;
  retry_count: number;
  is_duplicate: number;
  existing_sku: string | null;
  source_type: string | null;
  sourcing_entry_policy_version: number | null;
  accepted_evidence_attempt_ids_json: string | null;
  accepted_evidence_attempt_id: string | null;
  sourcing_decision_json: string | null;
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
  isHeld?: boolean;
  heldReason?: string | null;
}

const STAGE_ORDER: PipelineStage[] = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'];

/**
 * Guarded JSON parse for the serialized sourcing decision. Returns the parsed
 * decision, or null when the stored JSON is malformed. Row hydration must
 * never throw on corrupt authority data; downstream consumers (e.g. the
 * distributor-record materializer) validate the decision and fail closed with
 * a stable code when it is absent or invalid.
 */
function safeParseDecision(raw: string): SourcingDecision | SourcingDecisionV2 | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.schemaVersion === 2) {
      const route = parsed.route as string;
      const origin = typeof parsed.origin === 'string' ? parsed.origin : 'automatic_policy';
      const decidedAt = typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date().toISOString();
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];

      if (route === 'evidence_to_discovery') {
        const acceptedAttemptIds = Array.isArray(parsed.acceptedEvidenceAttemptIds) ? parsed.acceptedEvidenceAttemptIds : [];
        const providerIds = Array.isArray(parsed.providerIds) ? parsed.providerIds : [];
        const genId = typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : null;

        // If there are no accepted attempts, no provider IDs, or no generation ID, this was effectively a fallback
        if (acceptedAttemptIds.length === 0 || providerIds.length === 0 || !genId) {
          const fallback: SourcingDecisionV2 = {
            schemaVersion: 2,
            route: 'fallback_to_discovery',
            origin: origin as any,
            acceptedEvidenceAttemptIds: [],
            providerIds: [],
            ...(genId ? { sourcingGenerationId: genId } : {}),
            sourceType: 'official_page',
            target: 'discovery',
            conflicts,
            warnings,
            decidedAt,
          };
          const res = SourcingDecisionV2Schema.safeParse(fallback);
          if (res.success) return res.data;
        } else {
          const normalized: SourcingDecisionV2 = {
            schemaVersion: 2,
            route: 'evidence_to_discovery',
            origin: origin as any,
            acceptedEvidenceAttemptIds: acceptedAttemptIds,
            providerIds,
            sourcingGenerationId: genId,
            sourceType: 'official_page',
            target: 'discovery',
            conflicts,
            warnings,
            decidedAt,
          };
          const res = SourcingDecisionV2Schema.safeParse(normalized);
          if (res.success) return res.data;
        }
      } else if (route === 'fallback_to_discovery') {
        const fallbackGenId = typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : null;
        const normalized: SourcingDecisionV2 = {
          schemaVersion: 2,
          route: 'fallback_to_discovery',
          origin: origin as any,
          acceptedEvidenceAttemptIds: [],
          providerIds: Array.isArray(parsed.providerIds) ? parsed.providerIds : [],
          ...(fallbackGenId ? { sourcingGenerationId: fallbackGenId } : {}),
          sourceType: 'official_page',
          target: 'discovery',
          conflicts,
          warnings,
          decidedAt,
        };
        const res = SourcingDecisionV2Schema.safeParse(normalized);
        if (res.success) return res.data;
      } else if (route === 'degraded_fallback_to_discovery') {
        const providerIds = Array.isArray(parsed.providerIds) && parsed.providerIds.length > 0 ? parsed.providerIds : ['unknown'];
        const normalized: SourcingDecisionV2 = {
          schemaVersion: 2,
          route: 'degraded_fallback_to_discovery',
          origin: origin as any,
          acceptedEvidenceAttemptIds: [],
          providerIds,
          sourcingGenerationId: typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : 'legacy',
          sourceType: 'official_page',
          target: 'discovery',
          conflicts,
          warnings,
          decidedAt,
        };
        const res = SourcingDecisionV2Schema.safeParse(normalized);
        if (res.success) return res.data;
      } else if (route === 'distributor_record_to_extraction') {
        const normalized: SourcingDecisionV2 = {
          schemaVersion: 2,
          route: 'distributor_record_to_extraction',
          origin: origin as any,
          acceptedEvidenceAttemptIds: Array.isArray(parsed.acceptedEvidenceAttemptIds) ? parsed.acceptedEvidenceAttemptIds : [],
          providerIds: Array.isArray(parsed.providerIds) ? parsed.providerIds : [],
          sourcingGenerationId: typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : 'legacy',
          evidenceHash: typeof parsed.evidenceHash === 'string' ? parsed.evidenceHash : '',
          sourceType: 'distributor_record',
          target: 'extraction',
          conflicts,
          warnings,
          decidedAt,
        };
        const res = SourcingDecisionV2Schema.safeParse(normalized);
        if (res.success) return res.data;
      }
    }

    return parsed as unknown as SourcingDecision | SourcingDecisionV2;
  } catch {
    return null;
  }
}

function mapRowToItem(row: OnboardingItemRow): OnboardingItemWithEntryPolicy {
  // Acceptances hydrate from the relational authority once the distributor
  // V2 migration marker exists (ADR 0014: normalized rows are 100%
  // authoritative — empty means zero acceptances, never legacy JSON).
  // Pre-migration databases keep the legacy JSON column fallback.
  const acceptedEvidenceAttemptIds = isAcceptanceMigrationCompleted()
    ? getAcceptedAttemptIdsForItem(row.id)
    : row.accepted_evidence_attempt_ids_json
      ? (JSON.parse(row.accepted_evidence_attempt_ids_json) as string[])
      : [];

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
    sourceType: (row.source_type ?? 'official_page') as 'official_page' | 'distributor_record',
    sourcingEntryPolicyVersion: row.sourcing_entry_policy_version ?? 0,
    acceptedEvidenceAttemptIds,
    acceptedEvidenceAttemptId: row.accepted_evidence_attempt_id ?? null,
    // Guarded parse (Milestone D round-8): a malformed serialized decision
    // must NEVER throw during row hydration. The materializer validates the
    // decision authority and fails closed with a stable code when absent.
    sourcingDecision: row.sourcing_decision_json ? safeParseDecision(row.sourcing_decision_json) : null,
    stage: (row.stage || 'sourcing') as PipelineStage,
    stageStatus: (row.stage_status || 'pending') as StageStatus,
    isHeld: row.is_held === 1,
    heldReason: row.held_reason ?? null,
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

/** Row projection of curation_data_json for read-only analysis tooling
 *  (e.g. the P2 mapping-coverage audit). Deliberately minimal: no stage/status
 *  hydration, no acceptance joins — callers parse the JSON payload themselves. */
export interface CurationDataHistoryRow {
  id: string;
  upc: string;
  name: string;
  curationDataJson: string | null;
}

/** Read-only scan of every onboarding item's persisted curation payload.
 *  Used by offline audit scripts (repository pattern: SQL lives here, never in
 *  scripts); NOT used by any runtime pipeline path. */
export function listCurationDataRows(): CurationDataHistoryRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT id, upc, name, curation_data_json FROM onboarding_items ORDER BY id ASC',
  ).all() as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: String(row.id),
    upc: String(row.upc),
    name: String(row.name),
    curationDataJson: row.curation_data_json ? String(row.curation_data_json) : null,
  }));
}

export function insertItems(
  batchId: string,
  items: InsertItemData[],
  entryStage: PipelineStage = 'discovery',
  sourcingEntryPolicyVersion: number = 0,
): OnboardingItemWithEntryPolicy[] {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.query(
    `INSERT INTO onboarding_items
      (id, batch_id, upc, name, price, quantity, brand_hint, department_hint, source_url, expected_name,
       status, stage, stage_status, is_held, held_reason, error_message, retry_count, is_duplicate, existing_sku,
       extraction_data_json, curation_data_json, row_number, sourcing_entry_policy_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported', ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  );

  const inserted: OnboardingItemWithEntryPolicy[] = [];

  const insertAll = db.transaction(() => {
    for (const item of items) {
      const id = randomUUID();
      const isDuplicateNum = item.isDuplicate ? 1 : 0;
      // The entry stage is the caller-selected effective stage (Discovery when
      // the Sourcing engine capability is disabled). Explicit `item.stage`
      // wins for fixtures/internal state construction only.
      const targetStage = item.stage ?? entryStage;
      const targetStageStatus = item.stageStatus ?? 'pending';
      const isHeldNum = item.isHeld ? 1 : 0;
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
        isHeldNum,
        item.heldReason ?? null,
        isDuplicateNum,
        item.existingSku ?? null,
        item.rowNumber,
        sourcingEntryPolicyVersion,
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
        sourcingEntryPolicyVersion,
        acceptedEvidenceAttemptIds: [],
        acceptedEvidenceAttemptId: null,
        sourcingDecision: null,
        stage: targetStage as PipelineStage,
        stageStatus: targetStageStatus as StageStatus,
        isHeld: !!item.isHeld,
        heldReason: item.heldReason ?? null,
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

export function findItemById(id: string): OnboardingItemWithEntryPolicy | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_items WHERE id = ?').get(id) as OnboardingItemRow | undefined;
  return row ? mapRowToItem(row) : undefined;
}

/**
 * Raw `extraction_data_json` lookup by item id — the exact legacy inline
 * query from product-curator's post-run OCR/extraction refresh (packaging-ocr
 * overhaul P2-T5 repository cleanup). Returns undefined when no row matches.
 */
export function findExtractionDataJsonRowById(id: string): { extraction_data_json: string | null } | undefined {
  const db = getDb();
  return db
    .query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?')
    .get(id) as { extraction_data_json: string | null } | undefined;
}

/** The semantic source fields the evidence_extraction stage reads from an
 *  onboarding item row (packaging-ocr overhaul P2-T5 repository cleanup of
 *  the stage's legacy inline SELECT — same columns, same WHERE). */
export interface ItemExtractionSourceRow {
  extraction_data_json: string | null;
  source_url: string | null;
  source_type: string | null;
  name: string;
  expected_name: string | null;
  brand_hint: string | null;
}

/** Read the evidence-extraction source fields for one item; undefined when no
 *  row matches (the stage abstains on undefined, exactly as before). */
export function findExtractionSourceRowById(id: string): ItemExtractionSourceRow | undefined {
  const db = getDb();
  return db
    .query(
      'SELECT extraction_data_json, source_url, source_type, name, expected_name, brand_hint FROM onboarding_items WHERE id = ?',
    )
    .get(id) as ItemExtractionSourceRow | undefined;
}

/**
 * Look up the raw extraction-data payload and brand hint for an onboarding
 * item by SKU (upc). Returns null when no onboarding item has that SKU.
 * Used by privileged image-repair so callers never hand-roll onboarding SQL.
 */
export function findExtractionDataByWorkspaceAndUpc(workspaceId: string, upc: string): {
  extractionDataJson: string | null;
  brandHint: string | null;
} | null {
  const db = getDb();
  // Workspace-scoped through the owning batch: a UPC onboarded in another
  // workspace is invisible here (fail closed). If multiple batches in this
  // workspace contain the SKU, newest batch first, then row order — the same
  // deterministic tie-break every caller observes.
  const row = db.query(
    `SELECT i.extraction_data_json, i.brand_hint
     FROM onboarding_items i
     JOIN onboarding_batches b ON b.id = i.batch_id
     WHERE b.workspace_id = ? AND i.upc = ?
     ORDER BY i.created_at DESC, i.row_number ASC
     LIMIT 1`,
  ).get(workspaceId, upc) as { extraction_data_json: string | null; brand_hint: string | null } | undefined;
  if (!row) return null;
  return { extractionDataJson: row.extraction_data_json, brandHint: row.brand_hint };
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
): OnboardingItemWithEntryPolicy[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Amendment A: Sourcing claims require the exact current entry-policy
  // version in BOTH the atomic subquery and the outer CAS — pre-amendment
  // (policy 0) items, including the legacy stranded rows, are never
  // automatically claimed/observed. Other stages are unchanged.
  const isSourcingClaim = stage === 'sourcing';
  const versionClause = isSourcingClaim ? ' AND sourcing_entry_policy_version = ?' : '';

  // Atomic UPDATE with subquery. The outer AND stage_status = 'pending'
  // prevents claiming items already picked up by a concurrent worker.
  // Eligibility is strictly stage_status = 'pending' in an active, running batch
  // where the item is NOT held — stale in_progress items are recovered by requeueStaleInProgressItems.
  const result = db.run(
    `UPDATE onboarding_items
     SET stage_status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ?
     WHERE id IN (
       SELECT i.id FROM onboarding_items i
       JOIN onboarding_batches b ON i.batch_id = b.id
       WHERE b.workspace_id = ? AND b.status = 'active' AND (b.execution_state = 'running' OR b.execution_state IS NULL)
       AND i.stage = ? AND i.stage_status = 'pending'
       AND (i.is_held = 0 OR i.is_held IS NULL)
       ${versionClause}
       ORDER BY i.row_number
       LIMIT ?
     )
     AND stage_status = 'pending'${versionClause}`,
    isSourcingClaim
      ? [workerId, now, now, workspaceId, stage, SOURCING_ENTRY_POLICY_VERSION, limit, SOURCING_ENTRY_POLICY_VERSION]
      : [workerId, now, now, workspaceId, stage, limit],
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
 * Release items in a batch so the worker can claim them (sets is_held = 0).
 * If itemIds is omitted, releases all items in the batch.
 */
export function releaseBatchItems(batchId: string, itemIds?: string[]): number {
  const db = getDb();
  const now = new Date().toISOString();
  if (itemIds && itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',');
    const res = db.run(
      `UPDATE onboarding_items
       SET is_held = 0, held_reason = NULL, updated_at = ?
       WHERE batch_id = ? AND id IN (${placeholders})`,
      [now, batchId, ...itemIds],
    );
    return res.changes;
  }
  const res = db.run(
    `UPDATE onboarding_items
     SET is_held = 0, held_reason = NULL, updated_at = ?
     WHERE batch_id = ?`,
    [now, batchId],
  );
  return res.changes;
}

/**
 * Hold items in a batch from worker claiming (sets is_held = 1 with an optional reason).
 */
export function holdBatchItems(batchId: string, itemIds: string[], reason?: string): number {
  if (itemIds.length === 0) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = itemIds.map(() => '?').join(',');
  const res = db.run(
    `UPDATE onboarding_items
     SET is_held = 1, held_reason = ?, updated_at = ?
     WHERE batch_id = ? AND id IN (${placeholders})`,
    [reason ?? null, now, batchId, ...itemIds],
  );
  return res.changes;
}

/**
 * Bulk assign a brand hint to an array of items in a batch.
 */
export function bulkAssignBrandToItems(batchId: string, itemIds: string[], brand: string): number {
  if (itemIds.length === 0) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = itemIds.map(() => '?').join(',');
  const res = db.run(
    `UPDATE onboarding_items
     SET brand_hint = ?, updated_at = ?
     WHERE batch_id = ? AND id IN (${placeholders})`,
    [brand.trim(), now, batchId, ...itemIds],
  );
  return res.changes;
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

      // Sourcing items with OPEN hard identity conflicts can never advance
      // through the generic endpoint (ADR 0014): resolution must clear every
      // hard conflict and complete via `completeSourcingWithDecision` first.
      // Stale superseded-generation conflicts are audit-only and never block.
      if (item.stage === 'sourcing') {
        const openConflict = db
          .query(
            `SELECT 1 FROM onboarding_evidence_conflicts
             WHERE item_id = ? AND severity = 'hard' AND status = 'open'
               AND sourcing_generation_id IS (
               SELECT id FROM sourcing_generations
               WHERE item_id = ?
               ORDER BY rowid DESC LIMIT 1
             )
             LIMIT 1`,
          )
          .get(id, id);
        if (openConflict) {
          skipped++;
          continue;
        }
      }

      let nextStage: PipelineStage;
      if (item.stage === 'sourcing') {
        // Sourcing advances only to adjacent Discovery. Direct Sourcing →
        // Curation (legacy `bundle_to_curation`) is prohibited until a
        // structured-record fallback ADR exists; legacy persisted decisions
        // are ignored for routing.
        nextStage = 'discovery';
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
 * Advance review-completed items to Promotion with the PR11 blocked-member
 * guard (epic #46 Phase 7 — bulk approval). This is the ONLY approval path
 * that moves reviewed items into the promotion stage; the generic advance
 * route remains for administrative use.
 *
 * Guards per item (all fail closed with a reason, never partially applied):
 * - item must exist;
 * - item must be `review / completed` (review-complete gate already passed);
 * - a hard cohort semantic validation finding (`semanticValidation.status ===
 *   'blocked'`) refuses the advance — the item stays in review (defense in
 *   depth: the review-completion gate is the authority, this guard keeps
 *   blocked members from ever reaching the promotion stage);
 * - nothing else — approval eligibility (durable reviewed state, semantic
 *   gates) is validated by the caller.
 *
 * One transaction; per-item results so partial failures are visible.
 */
export function advanceReviewedItemsToPromotion(
  itemIds: string[],
): { advanced: string[]; refused: Array<{ itemId: string; reason: string }> } {
  if (itemIds.length === 0) return { advanced: [], refused: [] };
  const db = getDb();
  const now = new Date().toISOString();
  const advanced: string[] = [];
  const refused: Array<{ itemId: string; reason: string }> = [];

  db.transaction(() => {
    for (const id of itemIds) {
      const item = findItemById(id);
      if (!item) {
        refused.push({ itemId: id, reason: 'item_not_found' });
        continue;
      }
      if (item.stage !== 'review' || item.stageStatus !== 'completed') {
        refused.push({ itemId: id, reason: `not_eligible:${item.stage}/${item.stageStatus}` });
        continue;
      }
      const semanticValidation = item.curationData?.semanticValidation;
      if (
        semanticValidation &&
        typeof semanticValidation === 'object' &&
        (semanticValidation as { status?: unknown }).status === 'blocked'
      ) {
        const findings = (semanticValidation as { findings?: Array<{ message?: unknown }> }).findings;
        const firstMessage =
          Array.isArray(findings) && findings.length > 0 && typeof findings[0]?.message === 'string'
            ? findings[0].message
            : 'A hard cohort semantic validation finding blocks this item.';
        refused.push({ itemId: id, reason: `semantic_validation_blocked: ${firstMessage}` });
        continue;
      }
      // Universal Category Page requirement (defense in depth): review
      // completion already refuses pageless items, so a review/completed row
      // without an assignment can only be stale data — never approve it into
      // Promotion. Verified-identity resolution stays with the run gate and
      // the promotion mandatory-Pages backstop.
      const assignedPages = item.curationData?.suggestedPages;
      if (!Array.isArray(assignedPages) || assignedPages.length === 0) {
        refused.push({
          itemId: id,
          reason: 'missing_category_page: no Category Page is assigned; assign pages before approval.',
        });
        continue;
      }
      const result = db.query(
        `UPDATE onboarding_items
         SET stage = 'promotion', stage_status = 'pending', error_message = NULL, retry_count = 0,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND stage = 'review' AND stage_status = 'completed'`,
      ).run(now, id);
      if (result.changes > 0) {
        advanced.push(id);
      } else {
        refused.push({ itemId: id, reason: 'concurrent_state_change' });
      }
    }
  })();

  return { advanced, refused };
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


/** @deprecated Use setDiscoverySourceUrl instead (sets stage_status only, no legacy status) */
// fallow-ignore-next-line unused-export
export function updateItemSourceUrl(id: string, url: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    "UPDATE onboarding_items SET source_url = ?, status = ?, stage_status = 'completed', updated_at = ? WHERE id = ?",
  ).run(url, 'source_confirmed', now, id);
}

/**
 * Classification-stage OCR persistence write (packaging-ocr overhaul P2-T5):
 * exact parity with the legacy inline UPDATE in
 * `stages/evidence-extraction.ts` — NO `updated_at` bump, so a stage re-run
 * never churns the row timestamp. Use `updateItemExtractionData` when a
 * timestamped update IS wanted.
 */
export function setItemExtractionDataJson(id: string, extractionDataJson: string): void {
  const db = getDb();
  db.query(
    'UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?',
  ).run(extractionDataJson, id);
}

export function updateItemExtractionData(id: string, extractionDataJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
  ).run(extractionDataJson, now, id);
}

// ─── Packaging-OCR stage persistence (packaging-ocr overhaul P2-T2) ────────────

/**
 * Persist ONE packaging-OCR stage result into the item's extraction_data_json,
 * mirroring the freeze pull-forward's unconditional-overwrite write shape
 * (cohort-curator.ts): `packagingOcrData` / `packagingTitle` / `ocrOutcome` /
 * `ocrInputHash` / `ocrExecutionDigest`. ALL live OCR authority keys —
 * including a null `ocrOutcome`, which REPLACES any stored outcome rather
 * than preserving it — are replaced together so a re-run never leaves
 * mixed-authority state. Repository pattern — callers never hand-roll this
 * read-merge-write.
 */
export interface PersistItemPackagingOcrInput {
  itemId: string;
  packagingOcrData: Record<string, unknown> | null;
  packagingTitle: string | null;
  ocrOutcome: Record<string, unknown> | null;
  ocrInputHash: string | null;
  ocrExecutionDigest: string | null;
  /** P2 baseline-drift guard: when set, the extraction_data_json key
   *  `packagingOcrStageRunId` marks the live OCR keys as STAGE-authored so a
   *  later dual-run comparison never mistakes this stage output for a legacy
   *  inline baseline. The legacy inline write-back path omits it. */
  stageRunId?: string | null;
}

export function persistItemPackagingOcrResult(input: PersistItemPackagingOcrInput): void {
  const row = findExtractionDataJsonRowById(input.itemId);
  if (!row) return;
  let ext: Record<string, unknown> = {};
  if (row.extraction_data_json) {
    try { ext = JSON.parse(String(row.extraction_data_json)) as Record<string, unknown>; } catch { ext = {}; }
  }
  const updatedExt = {
    ...ext,
    packagingOcrData: input.packagingOcrData,
    packagingTitle: input.packagingTitle,
    // Explicit replacement: null clears the key (JSON.stringify drops it) so
    // 'all authority keys replaced together' holds unconditionally. No current
    // caller passes null; the semantics exist to keep the contract honest.
    ocrOutcome: input.ocrOutcome,
    ocrInputHash: input.ocrInputHash,
    ocrExecutionDigest: input.ocrExecutionDigest,
    ...(input.stageRunId ? { packagingOcrStageRunId: input.stageRunId } : {}),
  };
  updateItemExtractionData(input.itemId, JSON.stringify(updatedExt));
}

/**
 * Shadow-only counterpart (P2-T4): writes ONLY the namespaced
 * `shadowPackagingOcrData` key — the live OCR authority keys
 * (`packagingOcrData` / `packagingTitle` / `ocrOutcome` / `ocrInputHash` /
 * `ocrExecutionDigest`) are NEVER touched, so a shadow run can never become a
 * reusable execution authority.
 */
export function persistItemShadowPackagingOcrResult(itemId: string, shadowPackagingOcrData: Record<string, unknown> | null): void {
  const row = findExtractionDataJsonRowById(itemId);
  if (!row) return;
  let ext: Record<string, unknown> = {};
  if (row.extraction_data_json) {
    try { ext = JSON.parse(String(row.extraction_data_json)) as Record<string, unknown>; } catch { ext = {}; }
  }
  const updatedExt = { ...ext, shadowPackagingOcrData };
  updateItemExtractionData(itemId, JSON.stringify(updatedExt));
}

/** Write the item's curation_data_json (used by the legacy worker and by the
 *  cohort member-projection atomic commit — PR3 hardening Commit B / R3). */
export function updateItemCurationData(id: string, curationDataJson: string): void {
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
      } catch { /* malformed JSON -> ignore */ }
    } else if (r.expected_name) {
      displayTitle = r.expected_name;
    } else if (r.extraction_data_json) {
      try {
        const ext = JSON.parse(r.extraction_data_json);
        if (ext?.title) displayTitle = ext.title;
      } catch { /* malformed JSON -> ignore */ }
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
 * Update an item's sourcing decision (audit record). Sets the item to
 * `completed` in its current stage; it does NOT transition stages.
 *
 * Stage transitions from Sourcing are performed exclusively through
 * `fallbackSourcingItemsToDiscovery` (audited `fallback_to_discovery`). No
 * generic helper may recreate the legacy Sourcing → Curation bypass.
 */
/**
 * Write a Sourcing decision onto a row WITHOUT transitioning its stage.
 * Sourcing-stage guarded: only rows currently in the `sourcing` stage are
 * written (audit-only callers / tests); returns false when the CAS fails.
 * Automatic completion MUST go through `completeSourcingWithDecision`.
 */
export function updateSourcingDecision(
  id: string,
  decision: SourcingDecision,
): boolean {
  // ADR 0014: the legacy route is audit-readable but never CREATABLE through
  // any production helper. Historical fixtures use direct SQL instead.
  if (decision.route === 'bundle_to_curation') {
    return false;
  }
  const db = getDb();
  const now = new Date().toISOString();
  const jsonStr = JSON.stringify(decision);

  const result = db.query(
    `UPDATE onboarding_items
     SET sourcing_decision_json = ?, stage_status = 'completed', error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'sourcing'`,
  ).run(jsonStr, now, id);
  return result.changes > 0;
}

/**
 * Route/target matrix for Sourcing completion (ADR 0014). Sourcing advances
 * ONLY to adjacent Discovery; Curation is unreachable.
 */
const SOURCING_COMPLETION_TARGETS: Record<SourcingDecision['route'], PipelineStage> = {
  evidence_to_discovery: 'discovery',
  fallback_to_discovery: 'discovery',
  degraded_fallback_to_discovery: 'discovery',
  distributor_record_to_extraction: 'extraction',
  needs_input_conflict: 'sourcing',
  retry_provider_errors: 'sourcing',
  // Legacy audit value: never creatable or actionable.
  bundle_to_curation: 'sourcing',
};

/**
 * The ONLY automatic Sourcing completion transition (ADR 0014).
 *
 * Guards (all fail closed with a reason, never partially applied):
 * - the row must currently be in the `sourcing` stage;
 * - the requested target stage must match the decision route's matrix
 *   (evidence_to_discovery/fallback_to_discovery → discovery/pending,
 *   needs_input_conflict → sourcing/needs_input,
 *   retry_provider_errors → sourcing/pending);
 * - `bundle_to_curation` is rejected outright;
 * - evidence routes refuse when open hard conflicts remain;
 * - `needs_input_conflict` requires the item to currently be `needs_input`.
 */
export function completeSourcingWithDecision(
  itemId: string,
  decision: SourcingDecision | SourcingDecisionV2,
  targetStage: 'discovery' | 'extraction' | 'sourcing',
): { ok: boolean; reason?: string } {
  const db = getDb();
  const now = new Date().toISOString();

  if (decision.route === 'bundle_to_curation') {
    return { ok: false, reason: 'bundle_to_curation is prohibited (ADR 0014)' };
  }

  const expectedTarget = SOURCING_COMPLETION_TARGETS[decision.route];
  if (expectedTarget !== targetStage) {
    return { ok: false, reason: `route ${decision.route} targets ${expectedTarget}, not ${targetStage}` };
  }

  const item = findItemById(itemId);
  if (!item) return { ok: false, reason: 'item_not_found' };
  if (item.stage !== 'sourcing') {
    return { ok: false, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
  }

  // Automatic/manual distributor routing is gated on the durable entry-policy
  // version (Amendment A): only post-amendment (marker-v1) imports may target
  // Extraction through a distributor record. Marker-v0 items are preserved as
  // operator-controlled Continue-to-Discovery (the legacy fallback).
  if (targetStage === 'extraction' && !isCurrentSourcingEntryPolicy(item.sourcingEntryPolicyVersion)) {
    return { ok: false, reason: 'distributor routing requires sourcing_entry_policy_version=1' };
  }

  // The extraction decision must validate against the strict V2 route schema
  // (MA invariant): distributor Extraction is inexpressible without
  // generation/attempt/provider/hash provenance.
  if (targetStage === 'extraction') {
    const v2 = SourcingDecisionV2Schema.safeParse(decision);
    if (!v2.success) {
      console.warn(
        `[completeSourcingWithDecision] SourcingDecisionV2Schema validation failed for item ${itemId}:`,
        JSON.stringify(v2.error.format()),
      );
      return { ok: false, reason: 'invalid_v2_distributor_decision' };
    }
    if (v2.data.route !== 'distributor_record_to_extraction') {
      return { ok: false, reason: 'extraction target requires distributor_record_to_extraction route' };
    }
  }

  if (targetStage === 'discovery' || targetStage === 'extraction') {
    const openConflict = db
      .query(
        `SELECT 1 FROM onboarding_evidence_conflicts
         WHERE item_id = ? AND severity = 'hard' AND status = 'open'
           AND sourcing_generation_id IS (
             SELECT id FROM sourcing_generations
             WHERE item_id = ?
             ORDER BY rowid DESC LIMIT 1
           )
         LIMIT 1`,
      )
      .get(itemId, itemId);
    if (openConflict) {
      return { ok: false, reason: 'open_hard_conflicts' };
    }
  }

  let nextStatus: StageStatus = 'pending';
  if (decision.route === 'needs_input_conflict') {
    if (item.stageStatus !== 'needs_input') {
      return { ok: false, reason: `needs_input_conflict requires needs_input, got ${item.stageStatus}` };
    }
    nextStatus = 'needs_input';
  }

  const jsonStr = JSON.stringify(decision);
  // Extraction routing atomically binds the item to the distributor record:
  // source_type becomes 'distributor_record' and source_url stays NULL (no
  // fake official URL is ever invented — ADR 0014 Amendment A).
  const result = targetStage === 'extraction'
    ? db.query(
        `UPDATE onboarding_items
         SET sourcing_decision_json = ?, stage = ?, stage_status = ?, source_type = 'distributor_record',
             source_url = NULL, error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND stage = 'sourcing'`,
      ).run(jsonStr, targetStage, nextStatus, now, itemId)
    : db.query(
        `UPDATE onboarding_items
         SET sourcing_decision_json = ?, stage = ?, stage_status = ?, error_message = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND stage = 'sourcing'`,
      ).run(jsonStr, targetStage, nextStatus, now, itemId);

  if (result.changes === 0) {
    return { ok: false, reason: 'transition_failed' };
  }
  return { ok: true };
}

/**
 * Complete Sourcing through the canonical projection authority (Amendment A).
 *
 * Recomputes `buildDistributorRecordProjection` for the item's CURRENT
 * generation with the given operator resolution inputs (candidate/custom/
 * dismiss semantics) applied, then routes exactly as automatic routing does:
 *
 * - qualified → `distributor_record_to_extraction` (marker-v1 only; marker-v0
 *   items are preserved as operator-controlled Continue-to-Discovery);
 * - not qualified (accepted-but-insufficient / no current generation) →
 *   `evidence_to_discovery`.
 *
 * Never the previous blanket evidence_to_discovery final step: a qualified
 * resolution bundle reaches Extraction. All writes go through
 * `completeSourcingWithDecision` (stage guard, route/target matrix, marker
 * gate, open-conflict refusal, V2 decision validation). Returns the outcome
 * with qualification details for the route layer.
 */
export interface CompleteSourcingViaProjectionResult {
  ok: boolean;
  reason?: string;
  qualified: boolean;
  route: 'distributor_record_to_extraction' | 'evidence_to_discovery' | 'fallback_to_discovery' | null;
  reasonCodes?: SourcingProjectionReasonCode[];
  evidenceHash?: string | null;
}

export function completeSourcingViaProjection(
  itemId: string,
  resolutions: ProjectionResolutionInput[] = [],
  options: { strictQualification?: boolean } = {},
): CompleteSourcingViaProjectionResult {
  const item = findItemById(itemId);
  if (!item) {
    return { ok: false, reason: 'item_not_found', qualified: false, route: null };
  }
  if (item.stage !== 'sourcing') {
    return { ok: false, reason: `not_eligible:${item.stage}/${item.stageStatus}`, qualified: false, route: null };
  }
  if (item.stageStatus !== 'needs_input') {
    return { ok: false, reason: `requires needs_input, got ${item.stageStatus}`, qualified: false, route: null };
  }

  const generation = getCurrentSourcingGeneration(itemId);
  // No generation → no generation-scoped evidence can qualify; the legacy
  // (marker-v0 / stranded) item completes via evidence_to_discovery.
  if (!generation) {
    if (options.strictQualification) {
      return { ok: false, reason: 'no_current_generation', qualified: false, route: null, reasonCodes: ['no_accepted_evidence'] };
    }
    const decision: SourcingDecision = {
      route: 'evidence_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    const res = completeSourcingWithDecision(itemId, decision, 'discovery');
    if (!res.ok) return { ok: false, reason: res.reason, qualified: false, route: null };
    return { ok: true, qualified: false, route: 'evidence_to_discovery', evidenceHash: null };
  }

  const attempts = getEvidenceAttemptsByItemAndGeneration(itemId, generation.id);
  const acceptedIds = getCurrentGenerationAcceptedAttemptIds(itemId);

  const projection = buildDistributorRecordProjection({
    itemId,
    itemUpc: item.upc,
    sourcingGenerationId: generation.id,
    attempts,
    acceptedAttemptIds: acceptedIds,
    resolutions,
  });

  const now = new Date().toISOString();

  if (!projection.qualified) {
    // Strict manual action: the operator explicitly chose "use distributor
    // record" — an insufficient projection fails truthfully (the fallback
    // action exists for Continue-to-Discovery).
    if (options.strictQualification) {
      return {
        ok: false,
        reason: 'not_qualified',
        qualified: false,
        route: null,
        reasonCodes: projection.reasonCodes,
        evidenceHash: null,
      };
    }
    const acceptedProviderIds = Array.from(
      new Set(attempts.filter((a) => acceptedIds.includes(a.id)).map((a) => a.providerId)),
    );
    const hasAcceptedEvidence = acceptedIds.length > 0 && acceptedProviderIds.length > 0;
    const decision: SourcingDecisionV2 = hasAcceptedEvidence
      ? {
          schemaVersion: 2,
          route: 'evidence_to_discovery',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: acceptedIds,
          providerIds: acceptedProviderIds,
          sourcingGenerationId: generation.id,
          sourceType: 'official_page',
          target: 'discovery',
          conflicts: [],
          warnings: projection.warnings,
          decidedAt: now,
        }
      : {
          schemaVersion: 2,
          route: 'fallback_to_discovery',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: [],
          providerIds: [],
          sourcingGenerationId: generation.id,
          sourceType: 'official_page',
          target: 'discovery',
          conflicts: [],
          warnings: projection.warnings,
          decidedAt: now,
        };
    const res = completeSourcingWithDecision(itemId, decision, 'discovery');
    if (!res.ok) return { ok: false, reason: res.reason, qualified: false, route: null };
    return { ok: true, qualified: false, route: decision.route, reasonCodes: projection.reasonCodes, evidenceHash: null };
  }

  if (!isCurrentSourcingEntryPolicy(item.sourcingEntryPolicyVersion)) {
    // Marker-v0: qualified evidence still completes to Discovery (legacy
    // operator-controlled cohort never routes to Extraction).
    const acceptedProviderIds = Array.from(
      new Set(attempts.filter((a) => acceptedIds.includes(a.id)).map((a) => a.providerId)),
    );
    const hasAcceptedEvidence = acceptedIds.length > 0 && acceptedProviderIds.length > 0;
    const decision: SourcingDecisionV2 = hasAcceptedEvidence
      ? {
          schemaVersion: 2,
          route: 'evidence_to_discovery',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: acceptedIds,
          providerIds: acceptedProviderIds,
          sourcingGenerationId: generation.id,
          sourceType: 'official_page',
          target: 'discovery',
          conflicts: [],
          warnings: projection.warnings,
          decidedAt: now,
        }
      : {
          schemaVersion: 2,
          route: 'fallback_to_discovery',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: [],
          providerIds: [],
          sourcingGenerationId: generation.id,
          sourceType: 'official_page',
          target: 'discovery',
          conflicts: [],
          warnings: projection.warnings,
          decidedAt: now,
        };
    const res = completeSourcingWithDecision(itemId, decision, 'discovery');
    if (!res.ok) return { ok: false, reason: res.reason, qualified: true, route: null };
    return { ok: true, qualified: true, route: decision.route, evidenceHash: projection.evidenceHash };
  }

  const decision: SourcingDecisionV2 = {
    schemaVersion: 2,
    route: 'distributor_record_to_extraction',
    origin: 'operator_override',
    acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
    providerIds: projection.providerIds,
    sourcingGenerationId: generation.id,
    evidenceHash: projection.evidenceHash,
    sourceType: 'distributor_record',
    target: 'extraction',
    conflicts: [],
    warnings: projection.warnings,
    decidedAt: now,
  };
  const res = completeSourcingWithDecision(itemId, decision, 'extraction');
  if (!res.ok) return { ok: false, reason: res.reason, qualified: true, route: null };
  return {
    ok: true,
    qualified: true,
    route: 'distributor_record_to_extraction',
    evidenceHash: projection.evidenceHash,
  };
}

/**
 * Audit helper: build the operator-override fallback decision written when a
 * stranded Sourcing item is moved to Discovery.
 */
function fallbackSourcingDecision(decidedAt: string, sourcingGenerationId?: string): SourcingDecisionV2 {
  return {
    schemaVersion: 2,
    route: 'fallback_to_discovery',
    origin: 'operator_override',
    acceptedEvidenceAttemptIds: [],
    providerIds: [],
    ...(sourcingGenerationId ? { sourcingGenerationId } : {}),
    sourceType: 'official_page',
    target: 'discovery',
    conflicts: [],
    warnings: [],
    decidedAt,
  };
}

/**
 * Apply the audited fallback transition to a Sourcing row: write a fresh
 * operator-override decision and move it to `discovery/pending`, clearing
 * error/claim/retry state. No-op (returns false) when the row is not
 * currently in the sourcing stage.
 *
 * Evidence-aware audit route (MC item 7): when the item has accepted
 * current-generation evidence the decision is `evidence_to_discovery` with
 * the accepted attempt/provider provenance; otherwise `fallback_to_discovery`.
 */
function applyFallbackTransition(id: string, decidedAt: string): boolean {
  const db = getDb();
  const generation = getCurrentSourcingGeneration(id);
  const acceptedIds = getCurrentGenerationAcceptedAttemptIds(id);
  const attempts = generation ? getEvidenceAttemptsByItemAndGeneration(id, generation.id) : [];
  const providerIds = Array.from(new Set(attempts.filter(a => acceptedIds.includes(a.id)).map(a => a.providerId)));

  const hasEvidence = generation && acceptedIds.length > 0 && providerIds.length > 0;
  const decision: SourcingDecisionV2 = hasEvidence
    ? {
        schemaVersion: 2,
        route: 'evidence_to_discovery',
        origin: 'operator_override',
        acceptedEvidenceAttemptIds: acceptedIds,
        providerIds,
        sourcingGenerationId: generation.id,
        sourceType: 'official_page',
        target: 'discovery',
        conflicts: [],
        warnings: [],
        decidedAt,
      }
    : fallbackSourcingDecision(decidedAt, generation?.id);
  const result = db.query(
    `UPDATE onboarding_items
     SET sourcing_decision_json = ?, stage = 'discovery', stage_status = 'pending', error_message = NULL,
         retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'sourcing'`,
  ).run(JSON.stringify(decision), decidedAt, id);
  return result.changes > 0;
}

/**
 * ADR 0014: an item with OPEN HARD identity conflicts (current generation)
 * can never be moved to Discovery through the operator fallback — conflicts
 * must be resolved through the durable resolution workflow first (the LAST
 * resolution completes the item). Stranded legacy items have no conflicts,
 * so the safety-patch fallback flow is unaffected.
 */
function hasOpenCurrentHardConflicts(id: string): boolean {
  const db = getDb();
  const row = db
    .query(
      `SELECT 1 FROM onboarding_evidence_conflicts
       WHERE item_id = ? AND severity = 'hard' AND status = 'open'
         AND sourcing_generation_id IS (
           SELECT id FROM sourcing_generations
           WHERE item_id = ? ORDER BY rowid DESC LIMIT 1
         )
       LIMIT 1`,
    )
    .get(id, id);
  return !!row;
}

export interface SourcingFallbackResult {
  moved: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Bulk repair: move stranded `sourcing/pending` items to Discovery inside one
 * transaction, writing a fresh audited `fallback_to_discovery`
 * operator-override decision per moved row and clearing error/claim/retry
 * state. Only `sourcing/pending` rows are eligible (the audited stranded
 * cohort); historical evidence rows and all other item payloads are preserved
 * untouched. Duplicate IDs are deduplicated; missing/ineligible IDs are
 * reported, never silently dropped.
 */
export function fallbackSourcingItemsToDiscovery(itemIds: string[]): SourcingFallbackResult {
  if (itemIds.length === 0) return { moved: [], skipped: [] };
  const now = new Date().toISOString();
  const moved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const db = getDb();
  db.transaction(() => {
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = findItemById(id);
      if (!item) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (item.stage !== 'sourcing' || item.stageStatus !== 'pending') {
        skipped.push({ id, reason: `not_eligible:${item.stage}/${item.stageStatus}` });
        continue;
      }
      if (applyFallbackTransition(id, now)) {
        moved.push(id);
      } else {
        skipped.push({ id, reason: 'transition_failed' });
      }
    }
  })();

  return { moved, skipped };
}

export interface SingleItemFallbackResult {
  moved: boolean;
  reason?: string;
}

/**
 * Single-item audited fallback for an operator resolution (any stage status:
 * pending, failed, completed). Used by the resolve-sourcing route; the
 * transition is identical to the bulk repair path.
 */
export function fallbackSourcingItemToDiscovery(id: string): SingleItemFallbackResult {
  const item = findItemById(id);
  if (!item) return { moved: false, reason: 'not_found' };
  if (item.stage !== 'sourcing') {
    return { moved: false, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
  }
  // Fail closed on unresolved hard identity conflicts (ADR 0014).
  if (hasOpenCurrentHardConflicts(id)) {
    return { moved: false, reason: 'open_hard_conflicts' };
  }
  return { moved: applyFallbackTransition(id, new Date().toISOString()) };
}

/**
 * Operator "Continue with Official Site Discovery" for a distributor-source
 * Extraction item (Amendment A, Milestone D).
 *
 * In ONE guarded transaction: set `source_type` back to `official_page`, keep
 * `source_url` NULL (no fake URL is invented), clear the active item
 * extraction payload, move the item to `discovery/pending`, and record the
 * operator override decision (`fallback_to_discovery`). Generations,
 * attempts, conflicts, acceptances, and prior extraction audit rows are
 * preserved untouched. Only extraction-stage items in pending/failed/
 * completed (before Curation) are eligible; later-stage items must use the
 * existing reviewed send-back flow — no post-Review history rewrite.
 *
 * Returns `{ ok: false, reason }` on wrong stage / ownership / source type;
 * never throws.
 */
export function revertToOfficialDiscovery(
  itemId: string,
  workspaceId: string,
): { ok: true } | { ok: false; reason: string } {
  const db = getDb();
  const now = new Date().toISOString();

  // All guards and writes live INSIDE one transaction: a concurrent state
  // change is impossible to observe between check and write, and a guarded
  // UPDATE with an affected-row check rolls back (writes nothing) when the
  // item moved underneath us.
  return db.transaction(() => {
    const item = findItemById(itemId);
    if (!item) return { ok: false as const, reason: 'item_not_found' };
    if (item.sourceType !== 'distributor_record') {
      return { ok: false as const, reason: 'not_distributor_source' };
    }
    // Only extraction-stage items (pending/failed/completed-before-curation)
    // may revert; a completed extraction that already advanced must use the
    // reviewed send-back flow.
    if (item.stage !== 'extraction') {
      return { ok: false as const, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
    }
    if (!['pending', 'failed', 'completed'].includes(item.stageStatus)) {
      return { ok: false as const, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
    }
    // Workspace ownership (fail closed).
    const batch = db
      .query('SELECT workspace_id FROM onboarding_batches WHERE id = ?')
      .get(item.batchId) as { workspace_id: string } | undefined;
    if (!batch || batch.workspace_id !== workspaceId) {
      return { ok: false as const, reason: 'workspace_mismatch' };
    }

    // Strict V2 decision (the only creatable decision format, Amendment A):
    // route fallback_to_discovery with full provenance and operator origin.
    const generationRow = db
      .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(itemId) as { id: string } | undefined;
    const decision = {
      schemaVersion: 2,
      route: 'fallback_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [] as string[],
      providerIds: [] as string[],
      sourcingGenerationId: generationRow?.id,
      sourceType: 'official_page',
      target: 'discovery',
      conflicts: [],
      warnings: ['Operator chose Continue with Official Site Discovery after distributor-record extraction'],
      decidedAt: now,
    };

    const result = db.query(
      `UPDATE onboarding_items
       SET source_type = 'official_page', source_url = NULL, extraction_data_json = NULL,
           sourcing_decision_json = ?, stage = 'discovery', stage_status = 'pending',
           error_message = NULL, retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ? AND stage = 'extraction' AND stage_status IN ('pending', 'failed', 'completed')
         AND source_type = 'distributor_record'`,
    ).run(JSON.stringify(decision), now, itemId);
    if (result.changes === 0) {
      // The guards passed in-transaction but the guarded UPDATE matched no
      // row: a concurrent mutation won the race. Nothing was written.
      return { ok: false as const, reason: 'concurrent_state_change' };
    }

    return { ok: true as const };
  })();
}

export interface ResetForRetryResult {
  /** Items moved to Discovery via the audited sourcing fallback. */
  moved: string[];
  /** Items reset to pending in their current stage (existing semantics). */
  reset: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Capability-aware reset seam. While the Sourcing engine is DISABLED, a reset
 * on a Sourcing item performs the audited `fallback_to_discovery` transition
 * (never resetting in place, which would strand it at `sourcing/pending`);
 * every other stage keeps the existing `resetItemsToPending` semantics.
 */
export function resetItemsForRetry(
  itemIds: string[],
  options: { sourcingEngineEnabled: boolean },
): ResetForRetryResult {
  if (itemIds.length === 0) return { moved: [], reset: [], skipped: [] };
  const db = getDb();
  const moved: string[] = [];
  const reset: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // Fail any active classification runs for every requested item first
  // (existing reset semantics) so a reset never leaves a run racing.
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of itemIds) {
      db.query(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Superseded by reset'
         WHERE onboarding_item_id = ? AND status = 'running'`,
      ).run(now, id);
    }
  })();

  const seen = new Set<string>();
  const toFallback: string[] = [];
  const toResetInPlace: string[] = [];
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = findItemById(id);
    if (!item) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (item.stage === 'sourcing' && !options.sourcingEngineEnabled) {
      toFallback.push(id);
    } else if (item.stage === 'sourcing' && options.sourcingEngineEnabled) {
      // Engine ON: retry stays in Sourcing but supersedes the evidence
      // generation and resets to pending for a clean re-run (ADR 0014).
      // Marker-v0 (pre-Amendment-A) items are excluded: their cohort is
      // operator-controlled Continue-to-Discovery even when the engine is
      // globally ON (MC item 9) — never an automatic re-claim.
      if (item.sourcingEntryPolicyVersion === SOURCING_ENTRY_POLICY_VERSION) {
        toResetInPlace.push(id);
        supersedeCurrentSourcingGeneration(id, 'operator_retry');
      } else {
        toFallback.push(id);
      }
    } else {
      toResetInPlace.push(id);
    }
  }

  if (toFallback.length > 0) {
    // While the engine is disabled, resetting a Sourcing item means the
    // audited operator-override fallback to Discovery (any stage_status —
    // pending/failed/completed — never a stranding in-place reset).
    db.transaction(() => {
      for (const id of toFallback) {
        const res = fallbackSourcingItemToDiscovery(id);
        if (res.moved) {
          moved.push(id);
        } else {
          skipped.push({ id, reason: res.reason ?? 'transition_failed' });
        }
      }
    })();
  }

  if (toResetInPlace.length > 0) {
    resetItemsToPending(toResetInPlace);
    reset.push(...toResetInPlace);
  }

  return { moved, reset, skipped };
}

// ─── Epic #46 Phase 2: automation-owned progression helpers ────────────────────

/**
 * Lightweight row shape for the automatic-continuation sweeps. Carries only
 * the fields the sweeps need so a 2s poll never hydrates full items.
 */
export interface AutoAdvanceRow {
  id: string;
  batch_id: string;
  source_url: string | null;
  source_type: string | null;
  error_message: string | null;
  retry_count: number;
  updated_at: string;
}

const AUTO_ADVANCE_COLUMNS = 'i.id, i.batch_id, i.source_url, i.source_type, i.error_message, i.retry_count, i.updated_at';

/**
 * Discovery items that completed with a confirmed URL (auto-selected by the
 * worker or operator-set via select-source/set-url) — the extraction
 * auto-continuation pool. `source_url IS NOT NULL` is the deterministic
 * distinction from the human-held discovery holds (no-domain-mapped and
 * no-candidate-passed-verification leave the URL NULL).
 */
export function listDiscoveryCompletedWithUrl(workspaceId: string): AutoAdvanceRow[] {
  const db = getDb();
  return db.query(
    `SELECT ${AUTO_ADVANCE_COLUMNS}
     FROM onboarding_items i
     JOIN onboarding_batches b ON b.id = i.batch_id
     WHERE b.workspace_id = ? AND b.status = 'active'
       AND i.stage = 'discovery' AND i.stage_status = 'completed'
       AND i.source_url IS NOT NULL
     ORDER BY i.row_number`,
  ).all(workspaceId) as AutoAdvanceRow[];
}

/**
 * Extraction items whose per-item materialization (official-page scrape OR
 * distributor-record projection) completed with persisted extraction data —
 * the automatic Curation-entry pool (epic #46 audit fix: the happy path needs
 * ZERO manual advance clicks, so Extraction completion auto-continues to
 * Curation readiness). `extraction_data_json IS NOT NULL` is the data guard
 * — applies to both official-page and distributor-record sources.
 */
export function listExtractionCompleted(workspaceId: string): AutoAdvanceRow[] {
  const db = getDb();
  return db.query(
    `SELECT ${AUTO_ADVANCE_COLUMNS}
     FROM onboarding_items i
     JOIN onboarding_batches b ON b.id = i.batch_id
     WHERE b.workspace_id = ? AND b.status = 'active'
       AND i.stage = 'extraction' AND i.stage_status = 'completed'
       AND i.extraction_data_json IS NOT NULL
     ORDER BY i.row_number`,
  ).all(workspaceId) as AutoAdvanceRow[];
}

/**
 * Curation items whose per-SKU pipeline completed — the review auto-entry
 * pool. The semantic-blocked / cohort-parent-in-flight guards live in
 * `src/onboarding/auto-advance.ts` (they need the hydrated curation payload).
 */
export function listCurationCompleted(workspaceId: string): AutoAdvanceRow[] {
  const db = getDb();
  return db.query(
    `SELECT ${AUTO_ADVANCE_COLUMNS}
     FROM onboarding_items i
     JOIN onboarding_batches b ON b.id = i.batch_id
     WHERE b.workspace_id = ? AND b.status = 'active'
       AND i.stage = 'curation' AND i.stage_status = 'completed'
     ORDER BY i.row_number`,
  ).all(workspaceId) as AutoAdvanceRow[];
}

/**
 * Extraction items currently blocked (failed/needs_input) that carry a
 * persisted source URL and are NOT distributor-record sources — the
 * domain-release eligibility pool. Official-page items only: a distributor
 * record has no page and its materialization is deterministic (never
 * released by profile availability).
 */
export function listBlockedExtractionItemsByWorkspace(workspaceId: string): AutoAdvanceRow[] {
  const db = getDb();
  return db.query(
    `SELECT ${AUTO_ADVANCE_COLUMNS}
     FROM onboarding_items i
     JOIN onboarding_batches b ON b.id = i.batch_id
     WHERE b.workspace_id = ? AND b.status = 'active'
       AND i.stage = 'extraction'
       AND i.stage_status IN ('failed', 'needs_input')
       AND (i.source_type IS NULL OR i.source_type != 'distributor_record')
       AND i.source_url IS NOT NULL
     ORDER BY i.row_number`,
  ).all(workspaceId) as AutoAdvanceRow[];
}

/**
 * Guarded discovery/completed (with confirmed URL) → extraction/pending.
 * The `WHERE` re-asserts eligibility so a concurrent mutation can never be
 * double-advanced; returns true only when the row actually changed.
 */
export function advanceDiscoveryToExtraction(itemId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage = 'extraction', stage_status = 'pending', error_message = NULL,
         retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'discovery' AND stage_status = 'completed'
       AND source_url IS NOT NULL`,
  ).run(now, itemId);
  return result.changes > 0;
}

/**
 * Guarded extraction/completed → curation/pending. Same discipline as the
 * other advance helpers: the caller (`src/onboarding/auto-advance.ts`)
 * verifies the cohort-in-flight guard BEFORE calling; the `WHERE` re-asserts
 * the base eligibility so a concurrent mutation can never be double-advanced.
 */
export function advanceExtractionToCuration(itemId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage = 'curation', stage_status = 'pending', error_message = NULL,
         retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'extraction' AND stage_status = 'completed'`,
  ).run(now, itemId);
  return result.changes > 0;
}

/**
 * Guarded curation/completed → review/pending. The caller
 * (`src/onboarding/auto-advance.ts`) verifies the semantic-blocked and
 * cohort-parent-in-flight guards BEFORE calling; the `WHERE` re-asserts the
 * base eligibility only.
 */
export function advanceCurationToReview(itemId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage = 'review', stage_status = 'pending', error_message = NULL,
         retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'curation' AND stage_status = 'completed'`,
  ).run(now, itemId);
  return result.changes > 0;
}

/**
 * Guarded re-queue of a blocked extraction item → extraction/pending. The
 * caller (`src/onboarding/domain-release.ts`) verifies the domain/profile
 * guards; the `WHERE` re-asserts blocked status so releases are idempotent
 * and a concurrent claim can never be clobbered.
 */
export function requeueBlockedExtractionItem(itemId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage_status = 'pending', error_message = NULL, retry_count = 0,
         claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'extraction' AND stage_status IN ('failed', 'needs_input')`,
  ).run(now, itemId);
  return result.changes > 0;
}

/**
 * Guarded release of a per-item Curation claim held behind the family
 * readiness barrier (epic #46 audit fix). Returns the item to
 * `curation/pending` (unclaimed) so a later poll re-evaluates it once its
 * cohort is ready. Only the claim OWNER can release, and only while the row
 * is still `in_progress` — a concurrent rebind is never clobbered.
 */
export function releaseHeldFamilyClaim(itemId: string, workerId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage_status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage_status = 'in_progress' AND claimed_by = ?`,
  ).run(now, itemId, workerId);
  return result.changes > 0;
}

/**
 * Guarded reopen of an APPROVED promotion-stage item whose output was edited
 * by a consequential edit (epic #46 audit fix). The edit invalidated the
 * durable approval; the item must be re-reviewed and re-approved before it
 * can ever export again, so it returns to `review/pending` — the actionable
 * state the Review workspace consumes. No-op for anything else.
 */
export function reopenApprovedForReapproval(itemId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_items
     SET stage = 'review', stage_status = 'pending', error_message = NULL,
         retry_count = 0, claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND stage = 'promotion'`,
  ).run(now, itemId);
  return result.changes > 0;
}

