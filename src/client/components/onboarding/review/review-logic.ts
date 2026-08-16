/**
 * Epic #46 — Rapid Review workspace pure logic (Phase 6).
 *
 * Framework-free, unit-testable derivation for the Review queue/inspector:
 * ordering, filters, progress math, next-target selection, warning summary.
 * The server owns durable review state (`workState.reviewState`); this module
 * only derives client presentation from the server's projection.
 */
import type { OnboardingWorkState, ReviewState } from '../../../../shared/schemas/onboarding-work-state';
import type { SourceType } from '../../../../shared/schemas/onboarding';

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
  items: OnboardingWorkState[],
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
 * ties break by name (case-insensitive) for determinism.
 */
export function sortForReview(items: OnboardingWorkState[]): OnboardingWorkState[] {
  return [...items].sort((a, b) => {
    const ra = a.reviewState ?? 'unreviewed';
    const rb = b.reviewState ?? 'unreviewed';
    const da = REVIEW_STATE_ORDER[ra] ?? 3;
    const db = REVIEW_STATE_ORDER[rb] ?? 3;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
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
  /** Restrict to a specific family (cohortId). */
  familyCohortId?: string;
  /** Restrict to a specific brand (workState.brand, case-insensitive). */
  brand?: string;
  sourceType?: SourceType | 'all';
}

export function applyQueueFilters(
  items: OnboardingWorkState[],
  filters: ReviewQueueFilters,
  ctx: {
    /** Item ids edited during the current review session. */
    editedIds?: Set<string>;
    /** Item ids known to carry warnings (from loaded detail enrichment). */
    warnedIds?: Set<string>;
  } = {},
): OnboardingWorkState[] {
  const editedIds = ctx.editedIds ?? new Set<string>();
  const warnedIds = ctx.warnedIds ?? new Set<string>();
  return items.filter(item => {
    if (filters.reviewStates && filters.reviewStates.length > 0) {
      const state = item.reviewState ?? 'unreviewed';
      if (!filters.reviewStates.includes(state)) return false;
    }
    if (filters.warningsOnly && !warnedIds.has(item.itemId)) return false;
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
    return true;
  });
}

export function hasActiveQueueFilters(filters: ReviewQueueFilters): boolean {
  return Boolean(
    filters.reviewStates?.length ||
      filters.warningsOnly ||
      filters.editedOnly ||
      filters.familyCohortId ||
      filters.brand ||
      (filters.sourceType && filters.sourceType !== 'all'),
  );
}

// ─── Next/previous navigation ──────────────────────────────────────────────────

/**
 * Find the next unreviewed item after `currentId` in the sorted queue, wrapping
 * to the start. Skips ids in `alreadyDoneIds` (e.g. items just marked reviewed
 * that have not yet been refreshed from the server).
 */
export function findNextReviewTarget(
  sorted: OnboardingWorkState[],
  currentId: string | null,
  alreadyDoneIds?: Set<string>,
): OnboardingWorkState | null {
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
export function findPreviousReviewTarget(
  sorted: OnboardingWorkState[],
  currentId: string | null,
): OnboardingWorkState | null {
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
export function findNextQueuedItem(
  sorted: OnboardingWorkState[],
  currentId: string | null,
): OnboardingWorkState | null {
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

export function distinctBrands(items: OnboardingWorkState[]): string[] {
  const brands = new Set<string>();
  for (const item of items) {
    const brand = (item.brand ?? '').trim();
    if (brand) brands.add(brand);
  }
  return [...brands].sort((a, b) => a.localeCompare(b));
}

export function distinctFamilies(items: OnboardingWorkState[]): FamilyFacet[] {
  const byId = new Map<string, FamilyFacet>();
  for (const item of items) {
    if (!item.family) continue;
    const existing = byId.get(item.family.cohortId);
    if (existing) {
      existing.memberCount = Math.max(existing.memberCount, item.family.memberCount);
    } else {
      byId.set(item.family.cohortId, {
        cohortId: item.family.cohortId,
        label: item.family.label ?? item.name,
        memberCount: item.family.memberCount,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function sourceTypeLabel(sourceType: SourceType | null | undefined): string {
  return sourceType === 'distributor_record' ? 'Distributor record' : sourceType === 'official_page' ? 'Official page' : 'Unknown source';
}

/** Variant/size hint: workState has no weight — derive from curated/imported name when no other data is available. */
export function variantHint(item: OnboardingWorkState): string | null {
  return item.name || null;
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
  workState: OnboardingWorkState,
  curatedTitle?: string | null,
): string {
  const title = curatedTitle?.trim();
  return title ? title : workState.name;
}

export function isReviewed(workState: OnboardingWorkState): boolean {
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

/** Drop ids that are no longer in the queue (prune after reload). */
export function pruneQueueSelection(selectedIds: string[], validIds: string[]): string[] {
  if (selectedIds.length === 0) return selectedIds;
  const valid = new Set(validIds);
  return selectedIds.filter(id => valid.has(id));
}

/** Count of selected items still eligible for bulk review (unreviewed). */
export function countReviewableSelection(
  selectedIds: string[],
  items: OnboardingWorkState[],
): number {
  return reviewableSelectionIds(selectedIds, items).length;
}

/**
 * The EXACT selected ids that are currently reviewable (unreviewed AND in
 * the visible/filtered set). The bulk-review modal count and the submitted
 * payload must refer to the same set (GPT review, MEDIUM).
 */
export function reviewableSelectionIds(
  selectedIds: string[],
  items: OnboardingWorkState[],
): string[] {
  const byId = new Map(items.map(i => [i.itemId, i]));
  return selectedIds.filter(id => {
    const item = byId.get(id);
    return item ? !isReviewed(item) : false;
  });
}
