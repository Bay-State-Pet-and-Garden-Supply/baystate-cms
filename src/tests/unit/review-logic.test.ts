// @vitest-environment node
/**
 * Epic #46 Phase 6 — Review workspace pure-logic unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  applyQueueFilters,
  countReviewableSelection,
  distinctBrands,
  distinctFamilies,
  findNextQueuedItem,
  findNextReviewTarget,
  findPreviousReviewTarget,
  formatReviewProgress,
  hasActiveQueueFilters,
  isReviewed,
  itemDisplayName,
  pruneQueueSelection,
  reviewProgress,
  reviewableSelectionIds,
  selectAllVisible,
  sortForReview,
  toggleQueueSelection,
  warningInfoFromDetail,
  distributorApprovedImages,
  type ReviewQueueFilters,
} from '../../client/components/onboarding/review/review-logic';
import type { OnboardingWorkState, ReviewState } from '../../shared/schemas/onboarding-work-state';
import type { SourceType } from '../../shared/schemas/onboarding';

function makeItem(
  overrides: Partial<OnboardingWorkState> & { itemId: string; name: string },
): OnboardingWorkState {
  return {
    category: 'ready_for_review',
    label: 'Ready for review',
    activity: 'review',
    stage: 'review',
    stageStatus: 'pending',
    upc: '1000000000000',
    brand: null,
    sourceType: 'distributor_record',
    domain: null,
    reviewState: 'unreviewed',
    family: null,
    attentionReason: null,
    attentionAction: null,
    detail: null,
    ...overrides,
  };
}

const a = makeItem({ itemId: 'a', name: 'Alpha', reviewState: 'unreviewed' });
const b = makeItem({ itemId: 'b', name: 'Beta', reviewState: 'reviewed' });
const c = makeItem({ itemId: 'c', name: 'Charlie', reviewState: 'unreviewed' });
const d = makeItem({ itemId: 'd', name: 'Delta', reviewState: 'approved' });
const items = [a, b, c, d];

describe('sortForReview', () => {
  it('puts unreviewed first, then reviewed, then approved/rest', () => {
    const sorted = sortForReview(items);
    expect(sorted.map(i => i.itemId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('breaks ties deterministically by name', () => {
    const x = makeItem({ itemId: 'x', name: 'Zulu' });
    const y = makeItem({ itemId: 'y', name: 'Alpha' });
    expect(sortForReview([x, y]).map(i => i.itemId)).toEqual(['y', 'x']);
  });

  it('handles null reviewState as unreviewed', () => {
    const z = makeItem({ itemId: 'z', name: 'Zed', reviewState: null });
    expect(sortForReview([b, z]).map(i => i.itemId)).toEqual(['z', 'b']);
  });
});

describe('reviewProgress', () => {
  it('computes counts from the loaded set', () => {
    const p = reviewProgress([a, b, c]);
    expect(p.total).toBe(3);
    expect(p.reviewedCount).toBe(1);
    expect(p.unreviewedCount).toBe(2);
    expect(p.remaining).toBe(2);
  });

  it('prefers server totals when provided and clamps', () => {
    const p = reviewProgress([a, b], { total: 212, reviewedTotal: 184 });
    expect(p.total).toBe(212);
    expect(p.reviewedCount).toBe(184);
    expect(p.unreviewedCount).toBe(28);
    expect(p.remaining).toBe(28);
  });

  it('clamps reviewed count to total', () => {
    const p = reviewProgress([a], { total: 5, reviewedTotal: 8 });
    expect(p.reviewedCount).toBe(5);
    expect(p.remaining).toBe(0);
  });

  it('counts approved as reviewed', () => {
    expect(reviewProgress([d]).reviewedCount).toBe(1);
  });
});

describe('formatReviewProgress', () => {
  it('formats the progress line', () => {
    expect(formatReviewProgress({ total: 212, reviewedCount: 184, unreviewedCount: 28, remaining: 28 })).toBe(
      'Reviewed 184 / 212',
    );
  });
});

describe('applyQueueFilters', () => {
  const warnedIds = new Set(['b']);
  const editedIds = new Set(['c']);

  it('filters by review state', () => {
    const f: ReviewQueueFilters = { reviewStates: ['reviewed'] };
    expect(applyQueueFilters(items, f).map(i => i.itemId)).toEqual(['b']);
  });

  it('filters by warnings only', () => {
    const f: ReviewQueueFilters = { warningsOnly: true };
    expect(applyQueueFilters(items, f, { warnedIds }).map(i => i.itemId)).toEqual(['b']);
  });

  it('filters by edited during review', () => {
    const f: ReviewQueueFilters = { editedOnly: true };
    expect(applyQueueFilters(items, f, { editedIds }).map(i => i.itemId)).toEqual(['c']);
  });

  it('filters by family cohort id', () => {
    const withFamily = makeItem({
      itemId: 'f1',
      name: 'Family one',
      family: { cohortId: 'coh-1', label: 'Family One', memberCount: 3, readyCount: 2, blockedCount: 0, waitingOnItemIds: [] },
    });
    const other = makeItem({ itemId: 'f2', name: 'Family two' });
    const f: ReviewQueueFilters = { familyCohortId: 'coh-1' };
    expect(applyQueueFilters([withFamily, other], f).map(i => i.itemId)).toEqual(['f1']);
  });

  it('filters by brand case-insensitively', () => {
    const blue = makeItem({ itemId: 'bl', name: 'Blue Buffalo', brand: 'Blue Buffalo' });
    const other = makeItem({ itemId: 'ot', name: 'Other', brand: 'Purina' });
    const f: ReviewQueueFilters = { brand: 'blue buffalo' };
    expect(applyQueueFilters([blue, other], f).map(i => i.itemId)).toEqual(['bl']);
  });

  it('filters by source type', () => {
    const official: SourceType = 'official_page';
    const withOfficial = makeItem({ itemId: 'o1', name: 'Official', sourceType: official });
    const dist = makeItem({ itemId: 'd1', name: 'Dist', sourceType: 'distributor_record' });
    const f: ReviewQueueFilters = { sourceType: 'official_page' };
    expect(applyQueueFilters([withOfficial, dist], f).map(i => i.itemId)).toEqual(['o1']);
    expect(applyQueueFilters([withOfficial, dist], { sourceType: 'all' }).length).toBe(2);
  });

  it('combined filters compose', () => {
    const warnedReviewed = makeItem({ itemId: 'wr', name: 'Warned Reviewed', reviewState: 'reviewed' });
    const warnedUnreviewed = makeItem({ itemId: 'wu', name: 'Warned Unreviewed', reviewState: 'unreviewed' });
    const f: ReviewQueueFilters = { warningsOnly: true, reviewStates: ['reviewed'] };
    expect(applyQueueFilters([warnedReviewed, warnedUnreviewed], f, { warnedIds: new Set(['wr', 'wu']) }).map(i => i.itemId)).toEqual(['wr']);
  });

  it('hasActiveQueueFilters detects any non-default filter', () => {
    expect(hasActiveQueueFilters({})).toBe(false);
    expect(hasActiveQueueFilters({ sourceType: 'all' })).toBe(false);
    expect(hasActiveQueueFilters({ brand: 'X' })).toBe(true);
    expect(hasActiveQueueFilters({ warningsOnly: true })).toBe(true);
  });
});

describe('findNextReviewTarget', () => {
  it('finds the next unreviewed item after the current', () => {
    const target = findNextReviewTarget(sortForReview(items), 'a');
    expect(target?.itemId).toBe('c');
  });

  it('wraps to the first unreviewed when none remains after the current', () => {
    const target = findNextReviewTarget(sortForReview(items), 'c');
    expect(target?.itemId).toBe('a');
  });

  it('skips ids marked done this session (optimistic review)', () => {
    const done = new Set(['c']);
    const target = findNextReviewTarget(sortForReview(items), 'a', done);
    expect(target?.itemId).toBe('a');
  });

  it('returns null when every item is reviewed/approved', () => {
    const allReviewed = sortForReview([a, c]).map(i => ({ ...i, reviewState: 'reviewed' as ReviewState }));
    expect(findNextReviewTarget(allReviewed, 'a')).toBeNull();
  });

  it('returns null for an empty queue', () => {
    expect(findNextReviewTarget([], null)).toBeNull();
  });

  it('starts from the first unreviewed when no current id', () => {
    expect(findNextReviewTarget(sortForReview(items), null)?.itemId).toBe('a');
  });
});

describe('findPreviousReviewTarget', () => {
  it('returns the previous in sorted order wrapping to the end', () => {
    const sorted = sortForReview(items);
    expect(findPreviousReviewTarget(sorted, 'a')?.itemId).toBe('d');
    expect(findPreviousReviewTarget(sorted, 'b')?.itemId).toBe('c');
  });

  it('returns null for an empty queue', () => {
    expect(findPreviousReviewTarget([], null)).toBeNull();
  });
});

describe('findNextQueuedItem', () => {
  it('returns the next item in sorted order (any state), wrapping to the start', () => {
    const sorted = sortForReview(items);
    expect(sorted.map(i => i.itemId)).toEqual(['a', 'c', 'b', 'd']);
    expect(findNextQueuedItem(sorted, 'a')?.itemId).toBe('c');
    expect(findNextQueuedItem(sorted, 'd')?.itemId).toBe('a');
  });

  it('starts from the first item when no current id', () => {
    expect(findNextQueuedItem(sortForReview(items), null)?.itemId).toBe('a');
  });

  it('returns null for an empty queue', () => {
    expect(findNextQueuedItem([], null)).toBeNull();
  });
});

describe('distinctBrands / distinctFamilies', () => {
  it('returns sorted unique brands ignoring blanks', () => {
    const f1 = makeItem({ itemId: 'x', name: 'X', brand: 'Purina' });
    const f2 = makeItem({ itemId: 'y', name: 'Y', brand: 'Blue Buffalo' });
    const f3 = makeItem({ itemId: 'z', name: 'Z', brand: 'Purina' });
    expect(distinctBrands([f1, f2, f3])).toEqual(['Blue Buffalo', 'Purina']);
  });

  it('dedupes families by cohort id and takes max member count', () => {
    const m1 = makeItem({
      itemId: 'm1',
      name: 'M1',
      family: { cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 3, readyCount: 1, blockedCount: 0, waitingOnItemIds: [] },
    });
    const m2 = makeItem({
      itemId: 'm2',
      name: 'M2',
      family: { cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 4, readyCount: 2, blockedCount: 0, waitingOnItemIds: [] },
    });
    const families = distinctFamilies([m1, m2]);
    expect(families).toEqual([{ cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 4 }]);
  });
});

describe('warningInfoFromDetail', () => {
  it('flags blocked semantic validation and collects messages', () => {
    const info = warningInfoFromDetail({
      semanticValidation: {
        status: 'blocked',
        findings: [{ message: 'Brand conflict within family' }],
      },
    });
    expect(info.blocked).toBe(true);
    expect(info.messages).toEqual(['Brand conflict within family']);
  });

  it('also reads curationData.semanticValidation and consistencyWarnings', () => {
    const info = warningInfoFromDetail({
      item: { curationData: { semanticValidation: { status: 'blocked', findings: [{ message: 'Type mismatch' }] } } },
      consistencyWarnings: [{ message: 'Varied curated titles in family' }],
    });
    expect(info.blocked).toBe(true);
    expect(info.messages).toEqual(['Type mismatch', 'Varied curated titles in family']);
  });

  it('passed validation is not blocked', () => {
    const info = warningInfoFromDetail({ item: { curationData: { semanticValidation: { status: 'passed', findings: [] } } } });
    expect(info.blocked).toBe(false);
    expect(info.messages).toEqual([]);
  });
});

describe('display helpers', () => {
  it('itemDisplayName prefers curated title', () => {
    expect(itemDisplayName(a, 'Curated Alpha')).toBe('Curated Alpha');
    expect(itemDisplayName(a, '  ')).toBe('Alpha');
    expect(itemDisplayName(a, null)).toBe('Alpha');
  });

  it('isReviewed covers reviewed and approved', () => {
    expect(isReviewed(a)).toBe(false);
    expect(isReviewed(b)).toBe(true);
    expect(isReviewed(d)).toBe(true);
  });
});
describe('bulk review selection (epic #46 follow-up, phase 4)', () => {
  it('toggleQueueSelection adds and removes order-stably', () => {
    expect(toggleQueueSelection([], 'x')).toEqual(['x']);
    expect(toggleQueueSelection(['x', 'y'], 'z')).toEqual(['x', 'y', 'z']);
    expect(toggleQueueSelection(['x', 'y'], 'x')).toEqual(['y']);
  });

  it('selectAllVisible dedupes and prunes to the visible set', () => {
    expect(selectAllVisible(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('pruneQueueSelection drops ids that left the queue', () => {
    expect(pruneQueueSelection(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(pruneQueueSelection([], ['a'])).toEqual([]);
  });

  it('countReviewableSelection counts only unreviewed selected items', () => {
    // a = unreviewed, b = reviewed, d = approved (from the shared fixtures)
    expect(countReviewableSelection(['a', 'b', 'd'], [a, b, d])).toBe(1);
    expect(countReviewableSelection(['b'], [a, b, d])).toBe(0);
    expect(countReviewableSelection(['a', 'missing'], [a, b, d])).toBe(1);
  });

  it('reviewableSelectionIds returns EXACTLY the ids the modal count shows (GPT review, MEDIUM)', () => {
    // Hidden/filtered selections are excluded: 'a' is visible+unreviewed,
    // 'b' is visible but reviewed, 'c' is selected but NOT in the visible
    // (filtered) set, 'd' is approved.
    expect(reviewableSelectionIds(['a', 'b', 'c', 'd'], [a, b, d])).toEqual(['a']);
    expect(reviewableSelectionIds(['c'], [a, b, d])).toEqual([]);
    expect(reviewableSelectionIds([], [a, b, d])).toEqual([]);
  });
});

describe('distributorApprovedImages (epic #46 follow-up)', () => {
  it('derives primary + additional from rights-attested approvals', () => {
    const images = distributorApprovedImages({
      distributorImageApprovals: [
        { imageUrl: 'https://cdn.example.com/a.jpg' },
        { imageUrl: 'https://cdn.example.com/b.jpg' },
        { imageUrl: '' },
      ],
    });
    expect(images).toEqual({ primary: 'https://cdn.example.com/a.jpg', additional: ['https://cdn.example.com/b.jpg'] });
  });

  it('returns null when there are no approvals or no extraction', () => {
    expect(distributorApprovedImages(null)).toBeNull();
    expect(distributorApprovedImages(undefined)).toBeNull();
    expect(distributorApprovedImages({})).toBeNull();
    expect(distributorApprovedImages({ distributorImageApprovals: [] })).toBeNull();
  });
});
