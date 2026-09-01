/**
 * Epic #46 — Rapid Review workspace pure logic (Phase 6).
 *
 * Framework-free, unit-testable derivation for the Review queue/inspector:
 * ordering, filters, progress math, next-target selection, warning summary.
 * The server owns durable review state (`workState.reviewState`); this module
 * only derives client presentation from the server's projection.
 */
import type { OnboardingWorkState, ReviewState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { SourceType } from '../../../../shared/schemas/onboarding';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { deriveReadiness } from './review-readiness';
import type { ReviewDraft } from './review-types';

// ─── Review header progress ────────────────────────────────────────────────────

export interface ReviewProgress {
  /** Total items that are Curation-complete and awaiting/in review. */
  total: number;
  /** Items with durable review state 'reviewed' (or approved). */
  reviewedCount: number;
  unreviewedCount: number;
  /** Items still requiring a human review decision. */
  remaining: number;
}

/** Derive progress from the loaded server projection + optional server totals. */
export function reviewProgress(
  items: Array<{ reviewState?: string | null }>,
  serverTotals?: { total: number; reviewedTotal: number },
): ReviewProgress {
  const total = serverTotals ? serverTotals.total : items.length;
  const reviewedCount = serverTotals
    ? serverTotals.reviewedTotal
    : items.filter(i => i.reviewState === 'reviewed' || i.reviewState === 'approved').length;
  const reviewed = Math.max(0, Math.min(reviewedCount, total));
  return {
    total,
    reviewedCount: reviewed,
    unreviewedCount: Math.max(0, total - reviewed),
    remaining: Math.max(0, total - reviewed),
  };
}

export function formatReviewProgress(progress: ReviewProgress): string {
  return `Reviewed ${progress.reviewedCount} / ${progress.total}`;
}

// ─── Queue ordering ────────────────────────────────────────────────────────────

const REVIEW_STATE_ORDER: Record<string, number> = { unreviewed: 0, reviewed: 1, approved: 2, not_ready: 3 };

/**
 * Unreviewed items first (the working queue), then reviewed, then the rest;
 * ties break by sortKey if present, then displayTitle/name (case-insensitive) for determinism.
 */
export function sortForReview<T extends { reviewState?: string | null; sortKey?: string; displayTitle?: string; name?: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const ra = a.reviewState ?? 'unreviewed';
    const rb = b.reviewState ?? 'unreviewed';
    const da = REVIEW_STATE_ORDER[ra] ?? 3;
    const db = REVIEW_STATE_ORDER[rb] ?? 3;
    if (da !== db) return da - db;
    if (a.sortKey && b.sortKey) return a.sortKey.localeCompare(b.sortKey);
    const titleA = a.displayTitle || a.name || '';
    const titleB = b.displayTitle || b.name || '';
    return titleA.localeCompare(titleB);
  });
}

// ─── Filters ───────────────────────────────────────────────────────────────────

export interface ReviewQueueFilters {
  /** Restrict by durable review state (unreviewed | reviewed). */
  reviewStates?: ReviewState[];
  /** Only items with warning/finding data (blocked validation or consistency warnings). */
  warningsOnly?: boolean;
  /** Only items edited during this review session. */
  editedOnly?: boolean;
  /** Gate status filter */
  gateStatus?: 'ready' | 'blocked' | 'unknown';
  /** Restrict to a specific family (cohortId). */
  familyCohortId?: string;
  /** Restrict to a specific brand (workState.brand, case-insensitive). */
  brand?: string;
  sourceType?: SourceType | 'all';
  q?: string;
}

export function applyQueueFilters<
  T extends {
    itemId: string;
    reviewState?: string | null;
    hasWarnings?: boolean;
    warningCodes?: string[];
    family?: { cohortId: string } | null;
    brand?: string | null;
    sourceType?: SourceType | null;
    upc?: string;
    displayTitle?: string;
    name?: string;
  },
>(
  items: T[],
  filters: ReviewQueueFilters,
  ctx: {
    /** Item ids edited during the current review session. */
    editedIds?: Set<string>;
    /** Item ids known to carry warnings (from loaded detail enrichment). */
    warnedIds?: Set<string>;
  } = {},
): T[] {
  const editedIds = ctx.editedIds ?? new Set<string>();
  const warnedIds = ctx.warnedIds ?? new Set<string>();
  return items.filter(item => {
    if (filters.reviewStates && filters.reviewStates.length > 0) {
      const state = item.reviewState ?? 'unreviewed';
      if (!filters.reviewStates.includes(state as any)) return false;
    }
    if (filters.warningsOnly) {
      const hasWarning =
        item.hasWarnings ||
        (item.warningCodes && item.warningCodes.length > 0) ||
        warnedIds.has(item.itemId);
      if (!hasWarning) return false;
    }
    if (filters.editedOnly && !editedIds.has(item.itemId)) return false;
    if (filters.familyCohortId) {
      if (!item.family || item.family.cohortId !== filters.familyCohortId) return false;
    }
    if (filters.brand) {
      const brand = (item.brand ?? '').toLowerCase();
      if (brand !== filters.brand.toLowerCase()) return false;
    }
    if (filters.sourceType && filters.sourceType !== 'all') {
      if ((item.sourceType ?? null) !== filters.sourceType) return false;
    }
    if (filters.q) {
      const q = filters.q.toLowerCase().trim();
      const upc = (item.upc ?? '').toLowerCase();
      const title = (item.displayTitle ?? item.name ?? '').toLowerCase();
      const brand = (item.brand ?? '').toLowerCase();
      const match = upc.includes(q) || title.includes(q) || brand.includes(q);
      if (!match) return false;
    }
    return true;
  });
}

export function hasActiveQueueFilters(filters: ReviewQueueFilters): boolean {
  return countActiveQueueFilters(filters) > 0;
}

/** Number of independently active filter dimensions. */
export function countActiveQueueFilters(filters: ReviewQueueFilters): number {
  let count = 0;
  if (filters.reviewStates && filters.reviewStates.length > 0) count += 1;
  if (filters.warningsOnly) count += 1;
  if (filters.editedOnly) count += 1;
  if (filters.familyCohortId) count += 1;
  if (filters.brand) count += 1;
  if (filters.sourceType && filters.sourceType !== 'all') count += 1;
  if (filters.q && filters.q.trim()) count += 1;
  if (filters.gateStatus) count += 1;
  return count;
}

export interface QueueFilterChip {
  /** Stable key identifying which filter dimension the chip removes. */
  key: 'reviewStates' | 'warningsOnly' | 'editedOnly' | 'familyCohortId' | 'brand' | 'sourceType' | 'q' | 'gateStatus';
  label: string;
}

/** Removable chips for the applied filters. */
export function activeFilterChips(
  filters: ReviewQueueFilters,
  ctx: { familyLabel?: string } = {},
): QueueFilterChip[] {
  const chips: QueueFilterChip[] = [];
  if (filters.reviewStates?.includes('unreviewed')) chips.push({ key: 'reviewStates', label: 'Unreviewed' });
  else if (filters.reviewStates?.includes('reviewed')) chips.push({ key: 'reviewStates', label: 'Reviewed' });
  if (filters.warningsOnly) chips.push({ key: 'warningsOnly', label: '⚠ Warnings' });
  if (filters.editedOnly) chips.push({ key: 'editedOnly', label: 'Edited' });
  if (filters.familyCohortId)
    chips.push({ key: 'familyCohortId', label: ctx.familyLabel ?? filters.familyCohortId });
  if (filters.brand) chips.push({ key: 'brand', label: filters.brand });
  if (filters.sourceType && filters.sourceType !== 'all')
    chips.push({ key: 'sourceType', label: filters.sourceType === 'distributor_record' ? 'Distributor record' : 'Official page' });
  if (filters.gateStatus) chips.push({ key: 'gateStatus', label: `Gate: ${filters.gateStatus}` });
  if (filters.q) chips.push({ key: 'q', label: `Search: ${filters.q}` });
  return chips;
}

/** Remove one chip's dimension from the filter set (pure update). */
export function removeFilterChip(filters: ReviewQueueFilters, key: QueueFilterChip['key']): ReviewQueueFilters {
  const next = { ...filters };
  switch (key) {
    case 'reviewStates':
      delete next.reviewStates;
      break;
    case 'sourceType':
      next.sourceType = 'all';
      break;
    default:
      delete next[key];
  }
  return next;
}

// ─── Next/previous navigation ──────────────────────────────────────────────────

/**
 * Find the next unreviewed item after `currentId` in the sorted queue, wrapping
 * to the start. Skips ids in `alreadyDoneIds` (e.g. items just marked reviewed
 * that have not yet been refreshed from the server).
 */
export function findNextReviewTarget<T extends { itemId: string; reviewState?: string | null }>(
  sorted: T[],
  currentId: string | null,
  alreadyDoneIds?: Set<string>,
): T | null {
  if (sorted.length === 0) return null;
  const done = alreadyDoneIds ?? new Set<string>();
  const start = currentId ? sorted.findIndex(i => i.itemId === currentId) : -1;
  const scan = (from: number) => {
    for (let k = 0; k < sorted.length; k++) {
      const idx = (from + k) % sorted.length;
      const item = sorted[idx];
      if (done.has(item.itemId)) continue;
      const state = item.reviewState ?? 'unreviewed';
      if (state === 'unreviewed') return item;
    }
    return null;
  };
  const after = scan(start + 1);
  if (after) return after;
  // Wrap: scan from the beginning up to (and including) the current item.
  return scan(0);
}

/** Simple previous item in the sorted queue (any state), wrapping to the end. */
export function findPreviousReviewTarget<T extends { itemId: string }>(
  sorted: T[],
  currentId: string | null,
): T | null {
  if (sorted.length === 0) return null;
  const idx = currentId ? sorted.findIndex(i => i.itemId === currentId) : 0;
  const base = idx === -1 ? 0 : idx;
  return sorted[(base - 1 + sorted.length) % sorted.length];
}

/**
 * Next item in the sorted queue (ANY state — plain navigation, unlike
 * `findNextReviewTarget` which only finds unreviewed items), wrapping to the
 * start. Used for Arrow-key navigation in the review queue.
 */
export function findNextQueuedItem<T extends { itemId: string }>(
  sorted: T[],
  currentId: string | null,
): T | null {
  if (sorted.length === 0) return null;
  const idx = currentId ? sorted.findIndex(i => i.itemId === currentId) : -1;
  const base = idx === -1 ? -1 : idx;
  return sorted[(base + 1) % sorted.length];
}

// ─── Grouping helpers ──────────────────────────────────────────────────────────

export interface FamilyFacet {
  cohortId: string;
  label: string;
  memberCount: number;
}

export function distinctBrands(items: Array<{ brand?: string | null }>): string[] {
  const brands = new Set<string>();
  for (const item of items) {
    const brand = (item.brand ?? '').trim();
    if (brand) brands.add(brand);
  }
  return [...brands].sort((a, b) => a.localeCompare(b));
}

export function distinctFamilies(
  items: Array<{ family?: { cohortId: string; label?: string | null; memberCount: number } | null; displayTitle?: string; name?: string }>,
): FamilyFacet[] {
  const byId = new Map<string, FamilyFacet>();
  for (const item of items) {
    if (!item.family) continue;
    const existing = byId.get(item.family.cohortId);
    if (existing) {
      existing.memberCount = Math.max(existing.memberCount, item.family.memberCount);
    } else {
      byId.set(item.family.cohortId, {
        cohortId: item.family.cohortId,
        label: item.family.label ?? item.displayTitle ?? item.name ?? 'Family',
        memberCount: item.family.memberCount,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function sourceTypeLabel(sourceType: SourceType | null | undefined): string {
  return sourceType === 'distributor_record' ? 'Distributor record' : sourceType === 'official_page' ? 'Official page' : 'Unknown source';
}

/** Variant/size hint: derive from curated/imported name when no other data is available. */
export function variantHint(item: { displayTitle?: string; name?: string }): string | null {
  return item.displayTitle || item.name || null;
}

// ─── Warnings / blocking ───────────────────────────────────────────────────────

export interface WarningInfo {
  blocked: boolean;
  messages: string[];
}

/**
 * Collect warning/blocking findings from an item detail response.
 * A blocking semantic validation (status: 'blocked') never allows review
 * completion for that item.
 */
export function warningInfoFromDetail(detail: {
  semanticValidation?: { status?: string; findings?: Array<{ message?: string }> } | null;
  item?: { curationData?: { semanticValidation?: { status?: string; findings?: Array<{ message?: string }> } | null } | null } | null;
  consistencyWarnings?: Array<{ message: string }>;
}): WarningInfo {
  const messages: string[] = [];
  let blocked = false;
  const sv = detail.semanticValidation;
  if (sv && sv.status === 'blocked') {
    blocked = true;
    for (const f of sv.findings ?? []) {
      if (f?.message) messages.push(f.message);
    }
  }
  const curSv = detail.item?.curationData?.semanticValidation;
  if (curSv && curSv.status === 'blocked') {
    blocked = true;
    for (const f of curSv.findings ?? []) {
      if (f?.message) messages.push(f.message);
    }
  }
  for (const w of detail.consistencyWarnings ?? []) {
    if (w?.message) messages.push(w.message);
  }
  return { blocked, messages };
}

// ─── Display helpers ───────────────────────────────────────────────────────────

export function itemDisplayName(
  row: { displayTitle?: string; name?: string; curatedTitle?: string | null },
  curatedTitle?: string | null,
): string {
  const title = curatedTitle?.trim() || row.displayTitle?.trim() || row.curatedTitle?.trim();
  return title ? title : row.name || '';
}

export function isReviewed(workState: { reviewState?: string | null }): boolean {
  const state = workState.reviewState ?? 'unreviewed';
  return state === 'reviewed' || state === 'approved';
}

// ─── Bulk review selection (epic #46 follow-up, GPT plan phase 4) ─────────────

/** Toggle one item in the bulk-review selection (order-stable). */
export function toggleQueueSelection(selectedIds: string[], itemId: string): string[] {
  return selectedIds.includes(itemId)
    ? selectedIds.filter(id => id !== itemId)
    : [...selectedIds, itemId];
}

/** Select every visible (filtered) item. */
export function selectAllVisible(visibleIds: string[]): string[] {
  return Array.from(new Set(visibleIds));
}

/**
 * Toggle a whole group (e.g. one product family's visible members) in the
 * bulk-review selection: if EVERY group id is already selected, remove them
 * all; otherwise add the missing ids. Order-stable and deduped.
 */
export function toggleGroupSelection(selectedIds: string[], groupItemIds: string[]): string[] {
  if (groupItemIds.length === 0) return selectedIds;
  const group = [...new Set(groupItemIds)];
  const allSelected = group.every(id => selectedIds.includes(id));
  if (allSelected) {
    const groupSet = new Set(group);
    return selectedIds.filter(id => !groupSet.has(id));
  }
  const existing = new Set(selectedIds);
  return [...selectedIds, ...group.filter(id => !existing.has(id))];
}

/** Drop ids that are no longer in the queue (prune after reload). */
export function pruneQueueSelection(selectedIds: string[], validIds: string[]): string[] {
  if (selectedIds.length === 0) return selectedIds;
  const valid = new Set(validIds);
  return selectedIds.filter(id => valid.has(id));
}

/** Count of selected items still eligible for bulk review (unreviewed). */
export function countReviewableSelection(
  selectedIds: string[],
  items: Array<{ itemId: string; reviewState?: string | null }>,
): number {
  return reviewableSelectionIds(selectedIds, items).length;
}

/**
 * The EXACT selected ids that are currently reviewable (unreviewed AND in
 * the visible/filtered set).
 */
export function reviewableSelectionIds(
  selectedIds: string[],
  items: Array<{ itemId: string; reviewState?: string | null }>,
): string[] {
  const byId = new Map(items.map(i => [i.itemId, i]));
  return selectedIds.filter(id => {
    const item = byId.get(id);
    return item ? !isReviewed(item) : false;
  });
}

// ─── Distributor imagery display (epic #46 follow-up) ──────────────────────────

export interface DistributorApprovedImages {
  primary: string | null;
  additional: string[];
}

/**
 * The review drawer's image source for distributor records.
 */
export function distributorApprovedImages(
  extraction: { distributorImageApprovals?: Array<{ imageUrl?: string }> } | null | undefined,
): DistributorApprovedImages | null {
  const approvals = extraction?.distributorImageApprovals ?? [];
  const urls = [...new Set(
    approvals
      .map((a) => a?.imageUrl)
      .filter((u): u is string => typeof u === 'string' && u.length > 0),
  )];
  if (urls.length === 0) return null;
  return { primary: urls[0], additional: urls.slice(1) };
}

// ─── Queue grouping by family (epic #46 follow-up) ────────────────────────────

export interface QueueGroup<T = any> {
  key: string;
  type: 'family' | 'individual';
  title: string | null;
  family: any;
  items: T[];
}

export function groupQueueItems<T extends { family?: { cohortId: string; label?: string | null } | null }>(
  items: T[],
): QueueGroup<T>[] {
  const groups: QueueGroup<T>[] = [];
  const familyMap = new Map<string, QueueGroup<T>>();
  const individualGroup: QueueGroup<T> = {
    key: 'individual',
    type: 'individual',
    title: 'Individual Products',
    family: null,
    items: [],
  };

  const hasAnyFamily = items.some(i => Boolean(i.family));

  for (const item of items) {
    if (item.family) {
      const cohortId = item.family.cohortId;
      let group = familyMap.get(cohortId);
      if (!group) {
        group = {
          key: `family:${cohortId}`,
          type: 'family',
          title: item.family.label || 'Product Family',
          family: item.family,
          items: [],
        };
        familyMap.set(cohortId, group);
        groups.push(group);
      }
      group.items.push(item);
    } else {
      individualGroup.items.push(item);
    }
  }

  if (individualGroup.items.length > 0) {
    if (!hasAnyFamily) {
      individualGroup.title = null;
    }
    groups.push(individualGroup);
  }

  return groups;
}

// ─── Bulk-review gate counting (e10s03 & Milestone 1 / P1-C) ─────────────────

/**
 * Check if a single queue row / workState is gate blocked.
 * Fail closed: reviewGateStatus === 'unknown' or 'blocked' is strictly blocked.
 */
export function isGateBlocked(
  row: ReviewQueueRow | OnboardingWorkState,
  detail?: ItemDetailResponse | null,
): boolean {
  // 1. Unknown or blocked queue status is strictly blocking
  if ('reviewGateStatus' in row) {
    if (row.reviewGateStatus === 'blocked' || row.reviewGateStatus === 'unknown') {
      return true;
    }
  }
  // 2. If detail is loaded, check authoritative blockers and warnings
  if (detail) {
    const readiness = deriveReadiness(detail, null);
    if (readiness.blockers.length > 0) return true;
    if (warningInfoFromDetail(detail).blocked) return true;
  } else if (!('reviewGateStatus' in row)) {
    // Legacy workState without detail: derive from workState
    const readiness = deriveReadiness(null, row as OnboardingWorkState);
    if (readiness.blockers.length > 0) return true;
  }
  return false;
}

/**
 * How many of the selected items are blocked by the completeness gate or a
 * blocking warning.
 */
export function countGateBlockedItems(
  ids: string[],
  rowsOrGetView:
    | Array<ReviewQueueRow | OnboardingWorkState>
    | ((id: string) => { detail: ItemDetailResponse | null; workState: any } | null | undefined),
  detailsCache?: Map<string, ItemDetailResponse>,
): number {
  let count = 0;
  if (typeof rowsOrGetView === 'function') {
    for (const id of ids) {
      const view = rowsOrGetView(id);
      if (!view) continue;
      if (deriveReadiness(view.detail, view.workState).blockers.length > 0) count++;
      else if (warningInfoFromDetail(view.detail ?? ({} as ItemDetailResponse)).blocked) count++;
    }
    return count;
  }

  const rowMap = new Map((rowsOrGetView as Array<ReviewQueueRow | OnboardingWorkState>).map(r => [r.itemId, r]));
  for (const id of ids) {
    const row = rowMap.get(id);
    if (!row) continue;
    const detail = detailsCache?.get(id) ?? null;
    if (isGateBlocked(row, detail)) {
      count++;
    }
  }
  return count;
}

// ─── Flag-off save payload (blind review F3) ──────────────────────────────────

/**
 * The flag-off (V1) listing save payload.
 */
export function buildLegacyListingUpdatePayload(draft: ReviewDraft): {
  curation_data: {
    curatedTitle: string | null;
    curatedWeight: string | null;
    curatedDescription: string | null;
    searchKeywords: string | null;
  };
  brandHint: string | null;
} {
  return {
    curation_data: {
      curatedTitle: draft.curatedTitle.trim() || null,
      curatedWeight: draft.curatedWeight.trim() || null,
      curatedDescription: draft.curatedDescription.trim() || null,
      searchKeywords: draft.searchKeywords.trim() || null,
    },
    brandHint: draft.brandHint.trim() || null,
  };
}
