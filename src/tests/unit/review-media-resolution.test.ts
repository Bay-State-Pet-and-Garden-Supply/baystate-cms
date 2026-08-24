// story: e10s04 — resolveEffectiveImages (review-time mirror of the promoter
// downloader input chain, including OVERWRITE suppression semantics).
import { describe, it, expect } from 'bun:test';
import {
  resolveEffectiveImages,
  type ReviewCompletenessContext,
} from '../../classification/review-completeness';

const A = 'https://img.example/a.jpg';
const B = 'https://img.example/b.jpg';
const C = 'https://img.example/c.jpg';

function ctx(overrides: Partial<ReviewCompletenessContext>): ReviewCompletenessContext {
  return {
    sourceType: 'official_page',
    itemName: null,
    itemPrice: null,
    brandHint: null,
    extractionData: null,
    resolvedBrandName: null,
    hasPendingProposals: false,
    verifiedPageAssignmentCount: 0,
    unverifiedAcceptedPageCount: 0,
    ...overrides,
  };
}

describe('resolveEffectiveImages (e10s04)', () => {
  it('falls back to the untouched extraction chain when no selection exists', () => {
    const result = resolveEffectiveImages(
      ctx({ extractionData: { primaryImage: A, additionalImages: [B, C] } }),
    );
    expect(result).toEqual({ primaryImage: A, additionalImages: [B, C] });
  });

  it('honors a designated primary and explicit additional ordering first', () => {
    const result = resolveEffectiveImages(
      ctx({
        extractionData: { primaryImage: A, additionalImages: [B, C] },
        reviewedMedia: { primaryImage: C, orderedAdditional: [A], suppressed: [] },
      }),
    );
    expect(result).toEqual({ primaryImage: C, additionalImages: [A] });
  });

  it('drops suppressed URLs from consideration (OVERWRITE semantics)', () => {
    const result = resolveEffectiveImages(
      ctx({
        extractionData: { primaryImage: A, additionalImages: [B, C] },
        reviewedMedia: { primaryImage: null, orderedAdditional: [], suppressed: [B] },
      }),
    );
    expect(result).toEqual({ primaryImage: A, additionalImages: [C] });
  });

  it('NEVER resolves a suppressed extraction primary — hiding it must surface missing_primary_image', () => {
    const result = resolveEffectiveImages(
      ctx({
        extractionData: { primaryImage: A, additionalImages: [] },
        reviewedMedia: { primaryImage: null, orderedAdditional: [], suppressed: [A] },
      }),
    );
    expect(result.primaryImage).toBeNull();
  });

  it('a designated primary that is suppressed is ignored; unsuppressed fallback wins', () => {
    const result = resolveEffectiveImages(
      ctx({
        extractionData: { primaryImage: A, additionalImages: [B] },
        reviewedMedia: { primaryImage: B, orderedAdditional: [], suppressed: [B] },
      }),
    );
    expect(result.primaryImage).toBe(A);
  });

  it('a designated primary that is suppressed with NO usable fallback resolves to null', () => {
    const result = resolveEffectiveImages(
      ctx({
        extractionData: { primaryImage: A, additionalImages: [] },
        reviewedMedia: { primaryImage: B, orderedAdditional: [], suppressed: [A, B] },
      }),
    );
    expect(result.primaryImage).toBeNull();
    expect(result.additionalImages).toEqual([]);
  });

  it('distributor rows draw only from approved images; suppression filters them', () => {
    const result = resolveEffectiveImages(
      ctx({
        sourceType: 'distributor_record',
        extractionData: {
          distributorImageApprovals: [{ imageUrl: A }, { imageUrl: B }, { imageUrl: C }],
        },
        reviewedMedia: { primaryImage: null, orderedAdditional: [], suppressed: [A] },
      }),
    );
    expect(result).toEqual({ primaryImage: B, additionalImages: [C] });
  });

  it('distributor designation is honored only while still approved and unsuppressed', () => {
    const designated = resolveEffectiveImages(
      ctx({
        sourceType: 'distributor_record',
        extractionData: {
          distributorImageApprovals: [{ imageUrl: A }, { imageUrl: B }],
        },
        reviewedMedia: { primaryImage: B, orderedAdditional: [], suppressed: [] },
      }),
    );
    expect(designated.primaryImage).toBe(B);

    // Designated URL no longer in the approved set → falls back to first approved.
    const staleDesignation = resolveEffectiveImages(
      ctx({
        sourceType: 'distributor_record',
        extractionData: { distributorImageApprovals: [{ imageUrl: A }] },
        reviewedMedia: { primaryImage: B, orderedAdditional: [], suppressed: [] },
      }),
    );
    expect(staleDesignation.primaryImage).toBe(A);
  });
});
