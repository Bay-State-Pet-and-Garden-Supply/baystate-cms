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
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { CurationCohortView } from '../shared/schemas/cohorts';
import {
  type WorkStateCategory,
  type WorkActivity,
  type AttentionReason,
  type AttentionAction,
  type ReviewState,
  type OnboardingWorkState,
  type BatchWorkState,
  type WorkStateCounts,
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
  const views: CurationCohortView[] = listCohortsByBatch(batchId).map(cohort => buildCohortView(cohort, items));
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
  return { reviewStates, cohortByItem, changeSetStatusBySku, candidateCountByItem };
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
}

function build(
  item: OnboardingItem,
  row: OnboardingReviewState | undefined,
  cohort: FamilyCohortState | null,
  input: DerivationInput,
): OnboardingWorkState {
  return {
    itemId: item.id,
    category: input.category,
    activity: input.activity ?? null,
    label: input.label,
    detail: input.detail ?? null,
    attentionReason: input.attentionReason ?? null,
    attentionAction: input.attentionAction ?? null,
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
    upc: item.upc,
    name: item.name,
    brand: item.brandHint ?? null,
    sourceType: item.sourceType,
    domain: normalizeHost(item.sourceUrl),
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
        // Epic #46 review remediation (fix 2): a `curation / completed` item
        // whose semantic validation is BLOCKED is NOT ready for review — the
        // automation side refuses to advance it (auto-advance guard) and the
        // review-completion gate refuses it. Projecting it as ready_for_review
        // would create two contradictory authorities and a dead end in the
        // Review queue. It surfaces as Needs Attention with the first finding.
        const semanticValidation = item.curationData?.semanticValidation;
        if (semanticValidation?.status === 'blocked') {
          const firstMessage =
            Array.isArray(semanticValidation.findings) &&
            semanticValidation.findings.length > 0 &&
            typeof semanticValidation.findings[0]?.message === 'string'
              ? (semanticValidation.findings[0]!.message as string)
              : 'A hard cohort semantic validation finding blocks this item.';
          return attention(
            'semantic_validation_blocked',
            'resolve_semantic_conflict',
            'Curation blocked by semantic validation',
            firstMessage,
          );
        }
        return build(item, row, cohort, { category: 'ready_for_review', activity: 'review', label: 'Ready for review' });
      }
      if (item.stageStatus === 'failed') {
        return attention('processing_failed', 'retry_processing', 'Curation failed');
      }
      // pending / in_progress → family barrier or cohort/legacy curation.
      if (cohort) {
        if (cohort.cohortState === 'ready' || cohort.cohortStatus === 'ready') {
          return build(item, row, cohort, { category: 'processing', activity: 'curation', label: 'Curating product family' });
        }
        if (cohort.cohortState === 'blocked') {
          return build(item, row, cohort, {
            category: 'waiting_on_family',
            activity: 'curation',
            label: 'Family blocked',
            detail: cohort.blockedReason,
          });
        }
        return build(item, row, cohort, {
          category: 'waiting_on_family',
          activity: 'curation',
          label: 'Family not ready yet',
          detail: cohort.blockedReason ?? `Waiting on ${cohort.waitingOnItemIds.length} sibling${cohort.waitingOnItemIds.length === 1 ? '' : 's'}`,
        });
      }
      return build(item, row, cohort, { category: 'processing', activity: 'curation', label: 'Curating product' });
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
  };
  return deriveItemWorkState(item, ctx);
}
