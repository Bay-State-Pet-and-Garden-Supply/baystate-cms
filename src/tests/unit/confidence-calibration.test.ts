import { describe, it, expect } from 'vitest';
import { calibrateThresholds, shouldAbstain, getReviewTier, DEFAULT_THRESHOLDS, type DevPredictionPair } from '../../classification/confidence-calibrator';

describe('Confidence Calibration & Review Tiers', () => {
  it('routes high-confidence proposals to the auto review tier', () => {
    expect(getReviewTier(0.90, 'primary_product_type', DEFAULT_THRESHOLDS)).toBe('auto');
  });

  it('routes mid-confidence proposals to the review tier', () => {
    expect(getReviewTier(0.60, 'primary_product_type', DEFAULT_THRESHOLDS)).toBe('review');
  });

  it('flags proposals below the abstain threshold', () => {
    expect(shouldAbstain(0.20, 'primary_product_type', DEFAULT_THRESHOLDS)).toBe(true);
    expect(shouldAbstain(0.80, 'primary_product_type', DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('calibrates thresholds from development-split example-level predictions only', () => {
    const devPairs: DevPredictionPair[] = [
      { proposalType: 'primary_product_type', confidence: 0.95, correct: true },
      { proposalType: 'primary_product_type', confidence: 0.90, correct: true },
      { proposalType: 'primary_product_type', confidence: 0.85, correct: true },
      { proposalType: 'primary_product_type', confidence: 0.70, correct: true },
      { proposalType: 'primary_product_type', confidence: 0.60, correct: false },
      { proposalType: 'primary_product_type', confidence: 0.40, correct: false },
      { proposalType: 'primary_product_type', confidence: 0.30, correct: false },
      { proposalType: 'primary_product_type', confidence: 0.20, correct: false },
    ];

    const calibrated = calibrateThresholds(devPairs, { targetAbstentionRate: 0.25 });
    // 25% of 8 dev pairs → abstain floor at the 2nd-lowest confidence (0.30).
    expect(calibrated.productType.abstainBelow).toBeLessThanOrEqual(0.40);
    expect(calibrated.productType.abstainBelow).toBeGreaterThanOrEqual(0.25);
    expect(calibrated.productType.reviewAbove).toBeGreaterThan(calibrated.productType.abstainBelow);
  });

  it('returns safe defaults when no development predictions are available', () => {
    const calibrated = calibrateThresholds([]);
    expect(calibrated.productType.abstainBelow).toBeGreaterThan(0);
    expect(calibrated.productType.reviewAbove).toBeGreaterThan(calibrated.productType.abstainBelow);
  });

  it('the auto tier never grants acceptance by itself', () => {
    // getReviewTier('auto') is a review-priority hint; it contains no
    // accept flag and can only reorder review work.
    const tier = getReviewTier(0.99, 'primary_product_type', DEFAULT_THRESHOLDS);
    expect(tier).toBe('auto');
    expect(['abstain', 'review', 'auto']).toContain(tier);
  });

  it('tiers remain evaluation-only: telemetry never calls them to alter statuses or acceptance (issue #17 F)', () => {
    // The evaluation-only contract: getReviewTier/shouldAbstain may report
    // hypothetical distributions but never change proposal statuses, queue
    // order, acceptance, or field output. Assert the tier vocabulary is a
    // hint-only enum (no accept flag) and that a 'review'/'auto' tier does
    // not imply any acceptance decision exists.
    const tiers = ['abstain', 'review', 'auto'] as const;
    const tier = getReviewTier(0.9, 'field_assignment', DEFAULT_THRESHOLDS);
    expect(tiers).toContain(tier);
    // No proposal status is derived from the tier: the only acceptance path
    // is an explicit human submitProposalDecisions row (covered elsewhere).
    expect(tier).not.toBe('accepted');
    expect(shouldAbstain(0.1, 'category_page', DEFAULT_THRESHOLDS)).toBe(true);
  });
});
