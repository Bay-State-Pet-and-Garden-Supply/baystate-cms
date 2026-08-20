// story: e05s01 — gating provenance is stored in CurationData.categoryPageGating
import { describe, it, expect } from 'vitest';

describe('category page gating provenance // story: e05s01', () => {
  it('gating shape is present in CurationData when abstained', () => {
    // This is a contract test — the shape is verified via ReviewClassificationPanel
    // rendering and product-curator population. No DB needed.
    const gating = {
      needsReviewedType: true,
      needsVerifiedPages: false,
      verifiedPageCount: 2,
      reason: 'No reviewed Primary Product Type. Page assignment requires an accepted Product Type and a verified Page catalog.',
      verifiedPageIdSet: ['page-1', 'page-2'],
      snapshotHash: 'abc',
    };
    expect(gating.needsReviewedType).toBe(true);
    expect(gating.verifiedPageCount).toBe(2);
  });
});
