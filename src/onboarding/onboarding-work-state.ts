/**
 * Epic #46 Phase 1 — server-owned operator work-state projection.
 *
 * The client renders the Batch Workspace from this projection and never
 * reverse-engineers `stage` / `stage_status` / error strings / source
 * metadata / cohort state / feature flags into human meaning.
 *
 * Derivation joins:
 * - onboarding item stage/stage_status/sourceType/sourceUrl/errorMessage;
 * - discovery candidate presence (onboarding_sources);
 * - canonical cohort readiness (ADR 0013 — `curation-cohort-service`);
 * - durable review/approval state (`onboarding_review_state`);
 * - change-set lifecycle state for promoted items (draft/reviewing/approved/
 *   pushed) so "exported" is only reported after a verified terminal op.
 *
 * The mapping table follows the epic #46 test plan EXACTLY (each internal
 * state maps to one operator category/label/attention pair).
 */
import { listItemsByBatch, findItemById } from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listSourcesByItem } from '../db/repositories/onboarding-source-repo';
import { listCohortsByBatch } from '../db/repositories/curation-cohort-repo';
import { buildCohortView } from './curation-cohort-service';
import {
  listReviewStates,
  getReviewState,
  type OnboardingReviewState,
} from '../db/repositories/onboarding-review-repo';
import { listChangeSetStatusBySkus } from '../db/repositories/change-set-repo';
import { convertToLbs } from '../shared/weight-converter';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { CurationCohortView } from '../shared/schemas/cohorts';
import { getDb } from '../db/connection';
import {
  type WorkStateCategory,
  type WorkActivity,
  type AttentionReason,
  type AttentionAction,
  type ReviewState,
  type OnboardingWorkState,
  type BatchWorkState,
  type WorkStateCounts,
  type FindingCode,
  type SuggestedAction,
  type FindingDetail,
  FindingCodeEnum,
  SuggestedActionEnum,
  EMPTY_WORK_STATE_COUNTS,
} from '../shared/schemas/onboarding-work-state';

// ─── Context ───────────────────────────────────────────────────────────────────

/** Per-item canonical family context (ADR 0013 cohort readiness). */
export interface FamilyCohortState {
  cohortId: string;
  label: string | null;
  memberCount: number;
  readyCount: number;
  blockedCount: number;
  waitingOnItemIds: string[];
  /** Persisted cohort status: forming | waiting | ready | superseded. */
  cohortStatus: string;
  /** Derived readiness state: ready | waiting | blocked. */
  cohortState: 'ready' | 'waiting' | 'blocked';
  blockedReason: string | null;
}

/** Batch-level projection inputs, loaded once per batch. */
export interface WorkStateContext {
  reviewStates: Map<string, OnboardingReviewState>;
  cohortByItem: Map<string, FamilyCohortState>;
  changeSetStatusBySku: Map<string, string>;
  candidateCountByItem: Map<string, number>;
  variantResolutionByItem: Map<string, { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string }>;
}

function loadVariantResolutionByItem(itemIds: string[]): Map<string, { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string }> {
  if (itemIds.length === 0) return new Map();
  try {
    const db = getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM onboarding_variant_resolutions WHERE onboarding_item_id IN (${placeholders}) AND superseded_at IS NULL`)
      .all(...itemIds) as Array<{
      id: string;
      onboarding_item_id: string;
      status: string;
      candidates_json: string;
      identity_matrix_hash: string;
      platform: string;
    }>;
    const map = new Map<string, { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string }>();
    for (const r of rows) {
      let candidates: unknown[] = [];
      try { candidates = JSON.parse(r.candidates_json); } catch { candidates = []; }
      map.set(r.onboarding_item_id, {
        id: r.id,
        status: r.status,
        candidates,
        identityMatrixHash: r.identity_matrix_hash,
        platform: r.platform,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

export interface WorkStateFilters {
  category?: WorkStateCategory;
  q?: string;
  domain?: string;
  sourceType?: 'official_page' | 'distributor_record';
  cohortId?: string;
  reviewState?: ReviewState;
  limit?: number;
  offset?: number;
}

// ─── Context builders ──────────────────────────────────────────────────────────

function normalizeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Build the per-item cohort map from the batch's ACTIVE candidate cohorts.
 * Reuses the caller's loaded items (one batch load, one extraction-binding
 * load inside `buildCohortView`).
 */
export function buildCohortContext(batchId: string, items: OnboardingItem[]): Map<string, FamilyCohortState> {
  // Include superseded cohorts: family grouping is display context for Review
  // (and historical audit), and a family whose cohort was superseded after its
  // members were curated must still render grouped. Processing never reads this
  // map — the claim queue selects `status = 'ready'` rows directly.
  const views: CurationCohortView[] = listCohortsByBatch(batchId, { includeSuperseded: true }).map(cohort => buildCohortView(cohort, items));
  const map = new Map<string, FamilyCohortState>();
  for (const view of views) {
    // `waitingOn` excludes blocked members, so memberCount - readyCount -
    // waitingOn.length is the blocked count.
    const blockedCount = Math.max(0, view.memberCount - view.readyCount - view.waitingOn.length);
    for (const member of view.members) {
      map.set(member.onboardingItemId, {
        cohortId: view.cohort.id,
        label: view.cohort.groupLabel,
        memberCount: view.memberCount,
        readyCount: view.readyCount,
        blockedCount,
        waitingOnItemIds: view.waitingOn
          .filter(entry => entry.itemId !== member.onboardingItemId)
          .map(entry => entry.itemId),
        cohortStatus: view.cohort.status,
        cohortState: view.state,
        blockedReason: view.blockedReason,
      });
    }
  }
  return map;
}

/** Build the full batch projection context (one batch-level load per source). */
export function buildBatchWorkStateContext(batchId: string, items: OnboardingItem[]): WorkStateContext {
  const reviewStates = listReviewStates(batchId);
  const cohortByItem = buildCohortContext(batchId, items);
  const promotedSkus = items
    .filter(item => item.stage === 'promotion')
    .map(item => item.upc);
  // Workspace-scoped change-set status (epic #46 fix 3): identical SKUs in
  // other workspaces must never leak a pushed/draft status into this batch.
  const workspaceId = findBatchById(batchId)?.workspaceId ?? '';
  const changeSetStatusBySku = listChangeSetStatusBySkus(workspaceId, promotedSkus);
  const candidateCountByItem = new Map<string, number>();
  for (const item of items) {
    if (item.stage === 'discovery') {
      candidateCountByItem.set(item.id, listSourcesByItem(item.id).length);
    }
  }
  const variantResolutionByItem = loadVariantResolutionByItem(items.map(i => i.id));
  return { reviewStates, cohortByItem, changeSetStatusBySku, candidateCountByItem, variantResolutionByItem };
}

// ─── Derivation helpers ────────────────────────────────────────────────────────

function deriveReviewState(item: OnboardingItem, row: OnboardingReviewState | undefined): ReviewState {
  // Durable record wins whenever present: an invalidated record is UNREVIEWED
  // (the legacy stage-based inference must never override it).
  if (row) {
    if (row.approvedAt && !row.reviewInvalidatedAt) return 'approved';
    if (row.reviewInvalidatedAt) return 'unreviewed';
    if (row.reviewedAt) return 'reviewed';
    return 'unreviewed';
  }
  // Legacy-inferred reviewed: the durable table backfills existing
  // review-completed/promoted items at migration time; `review / completed`
  // is the legacy review-complete marker before that migration runs.
  if (item.stage === 'review' && item.stageStatus === 'completed') return 'reviewed';
  if (item.stage === 'promotion' && item.stageStatus === 'completed') return 'reviewed';
  if (item.stage === 'curation' && item.stageStatus === 'completed') return 'unreviewed';
  if (item.stage === 'review') return 'unreviewed';
  return 'not_ready';
}

interface DerivationInput {
  category: WorkStateCategory;
  activity?: WorkActivity | null;
  label: string;
  detail?: string | null;
  attentionReason?: AttentionReason | null;
  attentionAction?: AttentionAction | null;
  findingCode?: FindingCode | null;
  findingSummary?: string | null;
  conflictingValues?: string[] | null;
  suggestedAction?: SuggestedAction | null;
  findingDetails?: FindingDetail[] | null;
  variantResolution?: { id: string; status: string; candidates: unknown[]; identityMatrixHash: string; platform: string } | null;
}

/** Map a semantic finding code to the granular curation sub-activity it blocks. */
function curationSubActivityForFindingCode(code: string | undefined | null): WorkActivity | null {
  switch (code) {
    case 'family_product_type':
      return 'cohort_freezing';
    case 'family_brand':
      return 'semantic_validation';
    case 'coordinated_title':
      return 'title_coordination';
    case 'coordinated_page':
    case 'coordinated_page_name_mismatch':
      return 'page_coordination';
    case 'member_attribute_applicability':
    case 'member_cardinality':
      return 'attribute_curation';
    default:
      return null;
  }
}

/** Map a persisted classification stage name to the granular WorkActivity for observability. */
function stageNameToWorkActivity(stageName: string): WorkActivity | null {
  switch (stageName) {
    case 'packaging_ocr':
      return 'packaging_ocr';
    case 'evidence_extraction':
      return 'cohort_freezing';
    case 'name_consolidation':
      return 'title_coordination';
    case 'category_page_proposals':
      return 'page_coordination';
    case 'attribute_applicability':
    case 'product_attribute_proposals':
      return 'attribute_curation';
    case 'primary_product_type_proposal':
      return 'cohort_freezing';
    default:
      return null;
  }
}

/** Derive the most specific curation sub-activity for a curation-stage item. */
function deriveCurationSubActivity(item: OnboardingItem): WorkActivity {
  const curData = item.curationData as Record<string, unknown> | null;
  const sv = curData?.semanticValidation as { status?: string; findings?: unknown } | undefined;
  if (sv?.status === 'blocked' && Array.isArray(sv.findings) && sv.findings.length > 0) {
    const first = sv.findings[0] as Record<string, unknown> | null;
    const firstCode = first && typeof first === 'object' && typeof (first as Record<string, unknown>).code === 'string' ? (first as Record<string, unknown>).code as string : null;
    const mapped = curationSubActivityForFindingCode(firstCode);
    if (mapped) return mapped;
  }
  // Live run stage projection: check cohort run and classification stage results for
  // in-progress curation sub-stage. This is the authoritative source for active work.
  try {
    // 1) Cohort run lease state: freezing/running cohorts are in cohort_freezing
    const cohortRunRow = getDb()
      .query("SELECT status FROM classification_cohort_runs WHERE cohort_id IN (SELECT cohort_id FROM curation_cohort_members WHERE onboarding_item_id = ?) AND status IN ('freezing','running') LIMIT 1")
      .get(item.id) as { status: string } | undefined;
    if (cohortRunRow) {
      if (cohortRunRow.status === 'freezing') return 'cohort_freezing';
      // running cohort → look at child classification run stage
    }
    // 2) Per-item classification run stages (authoritative granular stage)
    const curRunId = (curData as Record<string, unknown> | null)?.classificationRunId;
    const runId = typeof curRunId === 'string' && curRunId.length > 0 ? curRunId : null;
    const lookupId = runId ?? getDb().query(
      "SELECT id FROM classification_runs WHERE onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(item.id) as { id: string } | undefined;
    const effectiveRunId = runId ?? (lookupId && typeof (lookupId as unknown as string) === 'string' ? (lookupId as unknown as string) : (lookupId as { id: string } | undefined)?.id ?? null);
    if (effectiveRunId) {
      const stageRows = getDb()
        .query("SELECT stage_name, status FROM classification_stage_results WHERE run_id = ? ORDER BY started_at ASC")
        .all(effectiveRunId) as Array<{ stage_name: string; status: string }>;
      // Prefer a stage currently running
      for (const r of stageRows) {
        if (r.status === 'running') {
          const mapped = stageNameToWorkActivity(r.stage_name);
          if (mapped) return mapped;
        }
      }
      // Otherwise the first pending stage after last succeeded
      let lastSucceededIdx = -1;
      for (let i = 0; i < stageRows.length; i++) {
        if (stageRows[i].status === 'succeeded' || stageRows[i].status === 'abstained') lastSucceededIdx = i;
        else break;
      }
      const nextPending = stageRows[lastSucceededIdx + 1];
      if (nextPending && nextPending.status === 'pending') {
        const mapped = stageNameToWorkActivity(nextPending.stage_name);
        if (mapped) return mapped;
      }
      // Fallback: last running-pending heuristic not matched, check for any pending
      for (const r of stageRows) {
        if (r.status === 'pending') {
          const mapped = stageNameToWorkActivity(r.stage_name);
          if (mapped) return mapped;
        }
      }
    }
  } catch {
    // Projection must never throw; fall through to curation
  }
  return 'curation';
}

function safeFindingCode(value: unknown): FindingCode | null {
  if (typeof value !== 'string') return null;
  const parsed = FindingCodeEnum.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeSuggestedAction(value: unknown): SuggestedAction | null {
  if (typeof value !== 'string') return null;
  const parsed = SuggestedActionEnum.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractFindingDetails(curationData: Record<string, unknown> | null): {
  findingCode: FindingCode | null;
  findingSummary: string | null;
  conflictingValues: string[] | null;
  suggestedAction: SuggestedAction | null;
  findingDetails: FindingDetail[] | null;
} {
  const svRaw = (curationData as Record<string, unknown> | null)?.semanticValidation;
  if (!svRaw || typeof svRaw !== 'object' || Array.isArray(svRaw)) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  const sv = svRaw as { status?: unknown; findings?: unknown };
  if (!Array.isArray(sv.findings) || sv.findings.length === 0) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  // Guard each entry: must be non-null object
  const validFindings = sv.findings.filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object' && !Array.isArray(f));
  if (validFindings.length === 0) {
    return { findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null };
  }
  const first = validFindings[0];
  const findingCode = safeFindingCode(first.code);
  const findingSummary = typeof first.message === 'string' ? first.message : null;
  const conflictingValues = Array.isArray(first.conflictingValues)
    ? (first.conflictingValues as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;
  const suggestedAction = safeSuggestedAction(first.suggestedAction);
  // Fallback summary: use stored message even when code fails enum validation
  const fallbackSummary = findingSummary ?? (typeof first.message === 'string' ? first.message : null);
  const findingDetails: FindingDetail[] = validFindings
    .filter(f => typeof f.code === 'string' && typeof f.message === 'string' && safeFindingCode(f.code) !== null)
    .map(f => ({
      code: safeFindingCode(f.code) as FindingCode,
      memberSku: typeof f.memberSku === 'string' ? f.memberSku : '',
      message: f.message as string,
      conflictingValues: Array.isArray(f.conflictingValues)
        ? (f.conflictingValues as unknown[]).filter((v): v is string => typeof v === 'string')
        : null,
      suggestedAction: safeSuggestedAction(f.suggestedAction),
    }));
  return {
    findingCode,
    findingSummary: findingSummary ?? fallbackSummary,
    conflictingValues: conflictingValues && conflictingValues.length > 0 ? conflictingValues : null,
    suggestedAction,
    findingDetails: findingDetails.length > 0 ? findingDetails : null,
  };
}

/** Centralized semantic-block projection. Returns needs_attention input when blocked, else null. */
function semanticBlockedInput(item: OnboardingItem): DerivationInput | null {
  const sv = (item.curationData as Record<string, unknown> | null)?.semanticValidation as { status?: unknown; findings?: unknown } | undefined;
  if (!sv || sv.status !== 'blocked') return null;
  const curData = item.curationData as Record<string, unknown> | null;
  const extracted = extractFindingDetails(curData);
  const findings = Array.isArray((sv as Record<string, unknown>).findings) ? (sv as Record<string, unknown>).findings as unknown[] : [];
  const firstMessage =
    extracted.findingSummary ??
    (findings.length > 0 && findings[0] !== null && typeof findings[0] === 'object' && typeof (findings[0] as Record<string, unknown>).message === 'string'
      ? ((findings[0] as Record<string, unknown>).message as string)
      : 'A hard cohort semantic validation finding blocks this item.');
  const granularActivity = deriveCurationSubActivity(item);
  return {
    category: 'needs_attention',
    activity: granularActivity !== 'curation' ? granularActivity : null,
    label: 'Curation blocked by semantic validation',
    detail: firstMessage,
    attentionReason: 'semantic_validation_blocked',
    attentionAction: 'resolve_semantic_conflict',
    findingCode: extracted.findingCode,
    findingSummary: extracted.findingSummary ?? firstMessage,
    conflictingValues: extracted.conflictingValues,
    suggestedAction: extracted.suggestedAction,
    findingDetails: extracted.findingDetails,
  };
}

function build(
  item: OnboardingItem,
  row: OnboardingReviewState | undefined,
  cohort: FamilyCohortState | null,
  input: DerivationInput,
): OnboardingWorkState {
  const extData = item.extractionData as Record<string, unknown> | null;
  const curData = item.curationData as Record<string, unknown> | null;

  const curatedTitle =
    typeof curData?.curatedTitle === 'string' && curData.curatedTitle.trim().length > 0
      ? curData.curatedTitle.trim()
      : typeof curData?.name === 'string' && curData.name.trim().length > 0
      ? curData.name.trim()
      : typeof extData?.title === 'string' && extData.title.trim().length > 0
      ? extData.title.trim()
      : null;

  const approvals = (extData?.distributorImageApprovals as Array<{ imageUrl?: string }>) ?? [];
  const distributorPrimary = approvals.find(
    (a) => typeof a?.imageUrl === 'string' && a.imageUrl.trim().length > 0,
  )?.imageUrl;
  const candidatePrimary = (extData?.distributorImageCandidates as Array<{ url?: string }>)?.find(
    (c) => typeof c?.url === 'string' && c.url.trim().length > 0,
  )?.url;

  const imageUrl =
    typeof extData?.primaryImage === 'string' && extData.primaryImage.trim().length > 0
      ? extData.primaryImage.trim()
      : distributorPrimary ?? candidatePrimary ?? null;

  const description =
    typeof curData?.curatedDescription === 'string' && curData.curatedDescription.trim().length > 0
      ? curData.curatedDescription.trim()
      : typeof extData?.description === 'string' && extData.description.trim().length > 0
      ? extData.description.trim()
      : null;

  const sizeAttr = (extData?.variantAttributes as Record<string, any> | undefined)?.size;
  const rawWeight =
    typeof curData?.curatedWeight === 'string' && curData.curatedWeight.trim().length > 0
      ? curData.curatedWeight.trim()
      : typeof extData?.weight === 'number' || typeof extData?.weight === 'string'
      ? String(extData.weight).trim()
      : typeof sizeAttr === 'string' && sizeAttr.trim().length > 0
      ? sizeAttr.trim()
      : convertToLbs(item.name) ?? null;

  const weight =
    rawWeight != null && rawWeight.length > 0
      ? /^\d+(\.\d+)?$/.test(rawWeight)
        ? `${parseFloat(rawWeight)} lbs`
        : rawWeight
      : null;

  return {
    itemId: item.id,
    category: input.category,
    activity: input.activity ?? null,
    label: input.label,
    detail: input.detail ?? null,
    attentionReason: input.attentionReason ?? null,
    attentionAction: input.attentionAction ?? null,
    findingCode: input.findingCode ?? null,
    findingSummary: input.findingSummary ?? null,
    conflictingValues: input.conflictingValues ?? null,
    suggestedAction: input.suggestedAction ?? null,
    findingDetails: input.findingDetails ?? null,
    family: cohort
      ? {
          cohortId: cohort.cohortId,
          label: cohort.label,
          memberCount: cohort.memberCount,
          readyCount: cohort.readyCount,
          blockedCount: cohort.blockedCount,
          waitingOnItemIds: cohort.waitingOnItemIds,
        }
      : null,
    reviewState: deriveReviewState(item, row),
    stage: item.stage,
    stageStatus: item.stageStatus,
    variantResolution: (input as any).variantResolution ?? null,
    upc: item.upc,
    name: item.name,
    brand: item.brandHint ?? (typeof extData?.brand === 'string' ? extData.brand : null),
    sourceType: item.sourceType,
    domain: normalizeHost(item.sourceUrl),
    curatedTitle,
    imageUrl,
    description,
    weight,
  };
}

// ─── The mapping table ─────────────────────────────────────────────────────────

/**
 * Derive the operator work state for ONE item. Pure given the batch context;
 * the mapping follows the epic #46 test plan.
 */
export function deriveItemWorkState(item: OnboardingItem, ctx: WorkStateContext): OnboardingWorkState {
  const row = ctx.reviewStates.get(item.id);
  const cohort = ctx.cohortByItem.get(item.id) ?? null;
  const error = item.errorMessage ?? null;
  const isProfileFailure = error !== null && /no extractor profile|profile required/i.test(error);
  const isNoUrlFailure = error !== null && /no confirmed source url/i.test(error);

  const attention = (
    attentionReason: AttentionReason,
    attentionAction: AttentionAction,
    label: string,
    detail: string | null = error,
  ): OnboardingWorkState =>
    build(item, row, cohort, {
      category: 'needs_attention',
      activity: null,
      label,
      detail,
      attentionReason,
      attentionAction,
    });

  // ── Terminal / out-of-flow states ────────────────────────────────────────
  if (item.stageStatus === 'skipped') {
    return build(item, row, cohort, { category: 'skipped', label: 'Skipped', detail: error });
  }

  // Held products waiting on preflight / brand resolution
  if (item.isHeld) {
    if (item.heldReason === 'missing_brand' || !item.brandHint || item.brandHint.trim().length === 0) {
      return attention(
        'brand_not_provided',
        'assign_brand',
        'Brand assignment required',
        'Product is held awaiting brand assignment before running.',
      );
    }
    return attention(
      'processing_failed',
      'retry_processing',
      'Product held',
      item.heldReason ?? 'Product is held awaiting release.',
    );
  }

  // Centralized semantic-block projection: curation AND review rows with a
  // persisted blocked semantic validation surface as needs_attention BEFORE
  // any ready_for_review inference. Promotion does not re-project semantic
  // blocks (those rows advance beyond curation only after the block clears).
  const semanticBlock = semanticBlockedInput(item);
  if (semanticBlock && (item.stage === 'curation' || item.stage === 'review')) {
    return build(item, row, cohort, semanticBlock);
  }

  // ── Variant resolution choose_variant projection (M6) ─────────────────
  // When a current unresolved variant matrix exists and item is parked for input, surface choose_variant
  const variantRes = ctx.variantResolutionByItem?.get(item.id);
  if (
    variantRes &&
    (variantRes.status === 'ambiguous' || variantRes.status === 'no_match' || variantRes.status === 'stale') &&
    (item.stage === 'discovery' || item.stage === 'extraction') &&
    item.stageStatus === 'needs_input'
  ) {
    const { getEffectiveVariantResolutionMode } = require('./variant-flags');
    if (getEffectiveVariantResolutionMode() === 'active') {
      return build(item, row, cohort, {
        category: 'needs_attention',
        activity: null,
        label: 'Choose product variant',
        detail: 'Multiple variants detected — choose the exact variant.',
        attentionReason: 'choose_variant',
        attentionAction: 'choose_variant',
        variantResolution: variantRes as any,
      });
    }
  }

  switch (item.stage) {
    case 'promotion': {
      if (item.stageStatus === 'completed') {
        const changeSetStatus = ctx.changeSetStatusBySku.get(item.upc);
        // Verified terminal export: the change set holding this SKU was
        // pushed. Never report exported otherwise.
        if (changeSetStatus === 'pushed') {
          return build(item, row, cohort, { category: 'completed', activity: 'export', label: 'Exported', detail: 'Change set pushed to the store' });
        }
        return build(item, row, cohort, {
          category: 'ready_to_export',
          activity: 'export',
          label: 'Ready to export',
          detail: changeSetStatus ? `Export drafts created (change set ${changeSetStatus})` : 'Export drafts created',
        });
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Export failed');
      }
      // Epic #46 audit fix: 'approved' is a DURABLE release decision, never a
      // stage inference. A promotion-stage item without a durable approval
      // (legacy diagnostics advance, pre-epic promoted rows without backfill,
      // or an approval cleared by a consequential edit that is still in
      // promotion) is NOT approved — it projects back into Ready-for-Review
      // so the operator re-approves before any export path can run.
      if (row?.approvedAt && !row.reviewInvalidatedAt) {
        return build(item, row, cohort, { category: 'approved', activity: 'export', label: 'Approved — ready to export', detail: error });
      }
      return build(item, row, cohort, {
        category: 'ready_for_review',
        activity: 'review',
        label: row?.reviewedAt && !row.reviewInvalidatedAt ? 'Reviewed — pending approval' : 'Ready for review',
        detail: 'Awaiting bulk approval',
      });
    }

    case 'review': {
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Review failed');
      }
      return build(item, row, cohort, {
        category: 'ready_for_review',
        activity: 'review',
        label: row?.approvedAt && !row.reviewInvalidatedAt
          ? 'Approved'
          : row?.reviewedAt && !row.reviewInvalidatedAt
            ? 'Reviewed — ready to approve'
            : 'Ready for review',
      });
    }

    case 'curation': {
      if (item.stageStatus === 'completed') {
        // Semantic blocks are already handled by the centralized check above;
        // this branch is reached only for non-blocked completed curation.
        return build(item, row, cohort, { category: 'ready_for_review', activity: 'review', label: 'Ready for review' });
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Curation failed');
      }
      // pending / in_progress → family barrier or cohort/legacy curation.
      const granularActivity = deriveCurationSubActivity(item);
      const activityForProcessing = granularActivity !== 'curation' ? granularActivity : 'curation';
      if (cohort) {
        if (cohort.cohortState === 'ready' || cohort.cohortStatus === 'ready') {
          return build(item, row, cohort, { category: 'processing', activity: activityForProcessing, label: 'Curating product family' });
        }
        if (cohort.cohortState === 'blocked') {
          return build(item, row, cohort, {
            category: 'waiting_on_family',
            activity: activityForProcessing,
            label: 'Family blocked',
            detail: cohort.blockedReason,
          });
        }
        return build(item, row, cohort, {
          category: 'waiting_on_family',
          activity: activityForProcessing,
          label: 'Family not ready yet',
          detail: cohort.blockedReason ?? `Waiting on ${cohort.waitingOnItemIds.length} sibling${cohort.waitingOnItemIds.length === 1 ? '' : 's'}`,
        });
      }
      return build(item, row, cohort, { category: 'processing', activity: activityForProcessing, label: 'Curating product' });
    }

    case 'extraction': {
      if (item.sourceType === 'distributor_record') {
        if (item.stageStatus === 'failed') {
          return attention('processing_failed', 'retry_extraction', 'Distributor materialization failed');
        }
        if (item.stageStatus === 'completed') {
          return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Distributor materialization complete' });
        }
        return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Materializing distributor data' });
      }
      // official page
      if (item.stageStatus === 'needs_input') {
        return attention('verify_official_url', 'verify_official_url', 'Extraction needs attention', error ?? 'Extraction paused for operator input');
      }
      if (item.stageStatus === 'failed') {
        if (isProfileFailure) {
          return attention('extractor_profile_required', 'setup_extractor_profile', 'Extractor profile required');
        }
        if (isNoUrlFailure) {
          return attention('no_official_url', 'choose_official_url', 'Official product page needed');
        }
        return attention('extraction_profile_failed', 'retry_extraction', 'Extraction failed');
      }
      if (item.stageStatus === 'completed') {
        return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Extraction complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'extraction', label: 'Extracting product data' });
    }

    case 'discovery': {
      if (item.stageStatus === 'needs_input') {
        if (!item.brandHint || item.brandHint.trim().length === 0) {
          return attention(
            'brand_not_provided',
            'assign_brand',
            'Brand assignment required',
            'Assign a brand so discovery can search the brand’s official site.',
          );
        }
        const candidates = ctx.candidateCountByItem.get(item.id) ?? 0;
        if (candidates > 0) {
          return attention('verify_official_url', 'verify_official_url', 'Verify official product page');
        }
        return attention('no_official_url', 'choose_official_url', 'No official product page found');
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Official site search failed');
      }
      if (item.stageStatus === 'completed') {
        // The worker records manual-review candidates as completed with a
        // deterministic needs_review reason; otherwise auto-selection succeeded.
        if (error && /needs_review/i.test(error)) {
          const candidates = ctx.candidateCountByItem.get(item.id) ?? 0;
          if (candidates > 0) {
            return attention('verify_official_url', 'verify_official_url', 'Verify official product page', error);
          }
          return attention('no_official_url', 'choose_official_url', 'No official product page found', error);
        }
        if (error && /no matching product pages|no sources found/i.test(error)) {
          return attention('no_official_url', 'choose_official_url', 'No official product page found', error);
        }
        return build(item, row, cohort, { category: 'processing', activity: 'official_site_search', label: 'Official site search complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'official_site_search', label: 'Searching official site' });
    }

    case 'sourcing': {
      if (item.stageStatus === 'needs_input') {
        return attention('source_conflict', 'resolve_source_conflict', 'Distributor match needs decision', error);
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Distributor lookup failed');
      }
      if (item.stageStatus === 'completed') {
        return build(item, row, cohort, { category: 'processing', activity: 'distributor_lookup', label: 'Distributor lookup complete' });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'distributor_lookup', label: 'Running distributor lookups' });
    }

    default:
      return build(item, row, cohort, { category: 'processing', label: 'Processing' });
  }
}

// ─── Batch-level API ───────────────────────────────────────────────────────────

function initCounts(): WorkStateCounts {
  return { ...EMPTY_WORK_STATE_COUNTS };
}

/** Human label for the source type (used by the free-text search haystack). */
function sourceTypeLabel(sourceType: OnboardingWorkState['sourceType']): string {
  if (sourceType === 'distributor_record') return 'distributor record';
  if (sourceType === 'official_page') return 'official page';
  return '';
}

function matchesFilters(state: OnboardingWorkState, filters: WorkStateFilters): boolean {
  if (filters.category && state.category !== filters.category) return false;
  if (filters.reviewState && state.reviewState !== filters.reviewState) return false;
  if (filters.sourceType && state.sourceType !== filters.sourceType) return false;
  // Dimensional filter: domain matches the item's OWN normalized host ONLY
  // (epic #46 fix 5). A family label that merely CONTAINS the domain string
  // is not a domain match — domain=purina must never match the family
  // "Purina Pro Plan" when the item's source domain is unrelated.
  if (filters.domain) {
    const needle = filters.domain.toLowerCase().replace(/^www\./, '');
    const domainMatch = state.domain?.toLowerCase() === needle || state.domain?.toLowerCase().endsWith(`.${needle}`);
    if (!domainMatch) return false;
  }
  if (filters.cohortId && state.family?.cohortId !== filters.cohortId) return false;
  if (filters.q) {
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    // Free-text search covers the epic's full contract: UPC, name/title,
    // Brand, domain, source type, family/cohort label, and work-state label +
    // category.
    const haystack = [
      state.upc,
      state.name,
      state.brand ?? '',
      state.label,
      state.domain ?? '',
      sourceTypeLabel(state.sourceType),
      state.family?.label ?? '',
      state.category,
    ].join(' ').toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** Project every item in a batch into work states with category counts. */
export function getBatchWorkState(batchId: string, filters: WorkStateFilters = {}): BatchWorkState {
  const items = listItemsByBatch(batchId);
  const ctx = buildBatchWorkStateContext(batchId, items);
  const allStates = items.map(item => deriveItemWorkState(item, ctx));

  const counts = initCounts();
  for (const state of allStates) {
    counts[state.category] += 1;
  }

  const filtered = allStates.filter(state => matchesFilters(state, filters));
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 500) : 100;
  const offset = filters.offset && filters.offset > 0 ? filters.offset : 0;
  const paged = filtered.slice(offset, offset + limit);

  return { batchId, counts, items: paged, total: filtered.length };
}

/** Work-state counts only (batch summary payload, Phase 3 shell). */
export function getBatchWorkStateCounts(batchId: string): WorkStateCounts {
  const items = listItemsByBatch(batchId);
  const ctx = buildBatchWorkStateContext(batchId, items);
  const counts = initCounts();
  for (const item of items) {
    counts[deriveItemWorkState(item, ctx).category] += 1;
  }
  return counts;
}

/** Project a batch's items using an ALREADY-LOADED item list (items route). */
export function getBatchWorkStateForItems(batchId: string, items: OnboardingItem[]): {
  byItem: Map<string, OnboardingWorkState>;
  counts: WorkStateCounts;
} {
  const ctx = buildBatchWorkStateContext(batchId, items);
  const counts = initCounts();
  const byItem = new Map<string, OnboardingWorkState>();
  for (const item of items) {
    const state = deriveItemWorkState(item, ctx);
    byItem.set(item.id, state);
    counts[state.category] += 1;
  }
  return { byItem, counts };
}

/** Single-item projection (item detail API). */
export function getItemWorkState(itemId: string): OnboardingWorkState | undefined {
  const item = findItemById(itemId) as OnboardingItem | undefined;
  if (!item) return undefined;
  const reviewRow = getReviewState(itemId);
  const workspaceId = findBatchById(item.batchId)?.workspaceId ?? '';
  const ctx: WorkStateContext = {
    reviewStates: new Map(reviewRow ? [[item.id, reviewRow]] : []),
    cohortByItem: buildCohortContext(item.batchId, listItemsByBatch(item.batchId)),
    changeSetStatusBySku: item.stage === 'promotion' ? listChangeSetStatusBySkus(workspaceId, [item.upc]) : new Map(),
    candidateCountByItem: item.stage === 'discovery'
      ? new Map([[item.id, listSourcesByItem(item.id).length]])
      : new Map(),
    variantResolutionByItem: loadVariantResolutionByItem([item.id]),
  };
  return deriveItemWorkState(item, ctx);
}
