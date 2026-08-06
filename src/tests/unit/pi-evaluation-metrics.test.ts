/**
 * PI-9 evaluation metrics engine tests (issue #26).
 *
 * Pure module tests — vitest, node environment.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRunOutcome,
  extractPredictionFromResult,
  comparePredictionToGold,
  aggregatePiComparisons,
  wilsonInterval,
  type PiPrediction,
  type PiComparison,
} from '../../product-intelligence/evaluation/metrics';
import { PiGoldLabelsSchema } from '../../product-intelligence/evaluation/gold';

const goldOf = (partial: Record<string, unknown>) =>
  PiGoldLabelsSchema.parse(partial);

describe('classifyRunOutcome', () => {
  it('covers the full outcome taxonomy', () => {
    expect(classifyRunOutcome('cancelled', null, null, null)).toBe('cancelled');
    expect(classifyRunOutcome('failed', 'policy_denied', null, null)).toBe('policy_denied');
    expect(classifyRunOutcome('failed', 'model_unavailable', null, null)).toBe('not_configured');
    expect(classifyRunOutcome('failed', 'deadline_exceeded', null, null)).toBe('failed');
    expect(classifyRunOutcome('completed', null, 'unavailable', null)).toBe('unavailable');
    expect(classifyRunOutcome('completed', null, 'abstained', 'parent_product_only')).toBe('parent_product_only');
    expect(classifyRunOutcome('completed', null, 'abstained', 'wrong_variant')).toBe('wrong_variant');
    expect(classifyRunOutcome('completed', null, 'abstained', 'insufficient_evidence')).toBe('abstained');
    expect(classifyRunOutcome('completed', null, 'submitted', null)).toBe('submitted');
    // Unknown status falls through to failed.
    expect(classifyRunOutcome('running', null, null, null)).toBe('failed');
  });
});

describe('extractPredictionFromResult', () => {
  it('extracts a PI-4 bundle nested under submission', () => {
    const prediction = extractPredictionFromResult(
      JSON.stringify({
        submission: {
          identity: { status: 'exact_match', brand: 'Stella', canonicalName: 'Stella Broth 16 oz', variant: '16 oz' },
          commerceFacts: [
            { field: 'size', values: ['16 oz'], method: 'json_ld' },
            { field: 'flavor', values: ['chicken'], method: 'json_ld', sourcePath: 'json_ld.product.name' },
          ],
          imageCandidates: [
            { url: 'https://cdn.example.com/i.jpg', rightsStatus: 'supplier_authorized', commerceApproved: true },
          ],
          conflicts: [{ field: 'title_conflict', severity: 'blocking' }],
        },
      }),
    );
    expect(prediction).not.toBeNull();
    expect(prediction?.identityStatus).toBe('exact_match');
    expect(prediction?.title).toBe('Stella Broth 16 oz');
    expect(prediction?.facts).toHaveLength(2);
    expect(prediction?.facts[0]).toMatchObject({ field: 'size', value: '16 oz', method: 'json_ld' });
    expect(prediction?.facts[1].sourcePath).toBe('json_ld.product.name');
    expect(prediction?.imageRights).toBe('approved');
    expect(prediction?.imageCommerceApproved).toBe(true);
    expect(prediction?.conflicts).toHaveLength(1);
  });

  it('extracts a PI-1 envelope (top level, fallback)', () => {
    const prediction = extractPredictionFromResult(
      JSON.stringify({
        identity: { gtinMatch: 'exact' },
        productProposal: {
          title: 'Stella Broth',
          brand: 'Stella',
          fields: [{ field: 'size', value: '16 oz' }],
        },
        images: [{ url: 'https://cdn.example.com/i.jpg', rightsStatus: 'confirmed', identityMatch: 'exact' }],
      }),
    );
    expect(prediction?.identityStatus).toBe('exact_match');
    expect(prediction?.title).toBe('Stella Broth');
    expect(prediction?.imageCommerceApproved).toBe(true);
    expect(prediction?.facts[0]).toMatchObject({ field: 'size', value: '16 oz' });
  });

  it('returns null for malformed JSON', () => {
    expect(extractPredictionFromResult('not json')).toBeNull();
    expect(extractPredictionFromResult(null)).toBeNull();
  });
});

describe('comparePredictionToGold', () => {
  const exactPrediction: PiPrediction = {
    identityStatus: 'exact_match',
    brand: 'Stella',
    title: 'Stella Broth 16 oz',
    variant: '16 oz',
    facts: [
      { field: 'size', value: '16 oz', method: 'json_ld', sourcePath: 'json_ld.product.size' },
      { field: 'flavor', value: 'chicken', method: 'json_ld', sourcePath: 'json_ld.product.name' },
    ],
    imageUrl: 'https://cdn.example.com/i.jpg',
    imageRights: 'approved',
    imageCommerceApproved: true,
    productType: 'dog_treats',
    attributes: [],
    categoryPages: ['dog-treats'],
    conflicts: [],
  };

  it('scores an exact success', () => {
    const gold = goldOf({
      identity: { exactProduct: true, exactVariant: true },
      requiredFacts: [
        { field: 'size', value: '16 oz' },
        { field: 'flavor', value: 'chicken' },
      ],
      expectedEvidence: [{ field: 'size', extractionMethod: 'json_ld', sourcePath: 'json_ld.product.size' }],
      expectedClassification: { productType: 'dog_treats', categoryPages: ['dog-treats'] },
    });
    const c = comparePredictionToGold(exactPrediction, gold, 'submitted');
    expect(c.identity.exactProductHit).toBe(true);
    expect(c.identity.exactVariantHit).toBe(true);
    expect(c.fields.recall).toBe(1);
    expect(c.fields.precision).toBe(1);
    expect(c.unsupportedClaims).toBe(0);
    expect(c.evidenceCoverage.coverage).toBe(1);
    expect(c.classification.productTypeAccurate).toBe(true);
    expect(c.classification.pageExactSet).toBe(true);
    expect(c.conflicts.falseConflict).toBe(false);
  });

  it('rewards correct abstention for wrong-size retailer (wrong variant)', () => {
    const gold = goldOf({
      identity: { exactProduct: false, exactVariant: false, wrongVariant: true },
      misleadingSources: [{ domain: 'chewy.com', reason: 'wrong size' }],
    });
    const c = comparePredictionToGold(null, gold, 'wrong_variant');
    expect(c.identity.wrongVariantCorrect).toBe(true);
    expect(c.identity.exactProductHit).toBe(true); // didn't claim exact = correct negative
  });

  it('rewards parent-product-only detection', () => {
    const gold = goldOf({
      identity: { exactProduct: false, exactVariant: false, parentProductOnly: true },
    });
    const c = comparePredictionToGold(null, gold, 'parent_product_only');
    expect(c.identity.parentOnlyCorrect).toBe(true);
    expect(c.identity.abstentionCorrect).toBeNull();
  });

  it('rewards correct abstention', () => {
    const gold = goldOf({ identity: { exactProduct: false, requiredAbstention: true } });
    const c = comparePredictionToGold(null, gold, 'abstained');
    expect(c.identity.abstentionCorrect).toBe(true);
  });

  it('flags unsupported claims and misses', () => {
    const gold = goldOf({
      identity: { exactProduct: true },
      requiredFacts: [{ field: 'size', value: '16 oz' }],
    });
    const prediction: PiPrediction = {
      ...exactPrediction,
      facts: [
        { field: 'size', value: 'wrong value entirely', method: null, sourcePath: null },
        { field: 'made_up_field', value: 'xyz', method: null, sourcePath: null },
      ],
    };
    const c = comparePredictionToGold(prediction, gold, 'submitted');
    expect(c.fields.recall).toBe(0);
    expect(c.unsupportedClaims).toBe(1); // made_up_field
    expect(c.fields.perField.size.recall).toBe(0);
  });

  it('scores image rights rejection (unknown rights must not be approved)', () => {
    const gold = goldOf({
      identity: { exactProduct: true },
      expectedImage: { identityMatch: 'exact', rightsStatus: 'unknown' },
    });
    // Agent asserted commerce approval despite unknown rights -> rejection fails.
    const bad: PiPrediction = { ...exactPrediction, imageRights: 'unknown', imageCommerceApproved: true };
    const c = comparePredictionToGold(bad, gold, 'submitted');
    // It claimed exact-product approval despite unknown rights: the approval
    // claim is wrong (rejection failed) even though it did claim exactness.
    expect(c.image.rightsRejectionCorrect).toBe(false);
    expect(c.image.exactProductCorrect).toBe(true);
    const good: PiPrediction = { ...exactPrediction, imageRights: 'unknown', imageCommerceApproved: false };
    const c2 = comparePredictionToGold(good, gold, 'submitted');
    expect(c2.image.rightsRejectionCorrect).toBe(true);
    expect(c2.image.exactProductCorrect).toBe(false);
  });

  it('detects conflicts when gold has misleading sources', () => {
    const gold = goldOf({
      identity: { exactProduct: true },
      misleadingSources: [{ domain: 'x.example', reason: 'bad' }],
    });
    const noConflict: PiPrediction = { ...exactPrediction, conflicts: [] };
    expect(comparePredictionToGold(noConflict, gold, 'submitted').conflicts.detectedAny).toBe(false);
    const withConflict: PiPrediction = {
      ...exactPrediction,
      conflicts: [{ field: 'size_conflict', severity: 'blocking' }],
    };
    expect(comparePredictionToGold(withConflict, gold, 'submitted').conflicts.detectedAny).toBe(true);
  });

  it('passes ops through', () => {
    const gold = goldOf({ identity: { exactProduct: true } });
    const c = comparePredictionToGold(exactPrediction, gold, 'submitted', {
      durationMs: 4200,
      costUsd: 0.13,
      toolCalls: 9,
      deniedToolCalls: 1,
    });
    expect(c.ops).toEqual({ durationMs: 4200, costUsd: 0.13, toolCalls: 9, deniedToolCalls: 1 });
  });
});

describe('aggregatePiComparisons', () => {
  const mk = (over: Partial<PiComparison>): PiComparison => ({
    outcome: 'submitted',
    identity: {
      exactProductHit: true,
      exactVariantHit: true,
      parentOnlyCorrect: null,
      wrongVariantCorrect: null,
      abstentionCorrect: null,
    },
    fields: { precision: 1, recall: 1, perField: {}, predictedFacts: 2 },
    unsupportedClaims: 0,
    evidenceCoverage: { fieldsCompared: 1, withMethod: 1, withSourcePath: 1, coverage: 1 },
    image: { exactProductCorrect: true, exactVariantCorrect: null, rightsRejectionCorrect: null },
    classification: { productTypeAccurate: true, attributePrecision: null, attributeCoverage: null, pagePrecision: null, pageRecall: null, pageExactSet: true },
    conflicts: { goldHasMisleading: false, detectedAny: null, falseConflict: false },
    ops: { durationMs: 1000, costUsd: 0.1, toolCalls: 5, deniedToolCalls: 0 },
    ...over,
  });

  it('computes rates over non-null booleans', () => {
    const report = aggregatePiComparisons([
      mk({ identity: { exactProductHit: true, exactVariantHit: null, parentOnlyCorrect: null, wrongVariantCorrect: null, abstentionCorrect: null } }),
      mk({ identity: { exactProductHit: false, exactVariantHit: null, parentOnlyCorrect: null, wrongVariantCorrect: null, abstentionCorrect: null } }),
    ]);
    expect(report.sampleSize).toBe(2);
    expect(report.rates['identity.exactProductHit']).toBe(0.5);
    expect(report.rates['identity.exactVariantHit']).toBeNull();
    expect(report.outcomeDistribution.submitted).toBe(2);
    expect(report.ops.avgDurationMs).toBe(1000);
    expect(report.ops.totalCostUsd).toBe(0.2);
    expect(report.ops.avgToolCalls).toBe(5);
  });

  it('emits sample-size warnings', () => {
    const five = aggregatePiComparisons([mk({}), mk({}), mk({}), mk({}), mk({})]);
    expect(five.sampleSizeWarning).toBe('very_small');
    const twenty = aggregatePiComparisons(Array.from({ length: 20 }, () => mk({})));
    expect(twenty.sampleSizeWarning).toBe('small');
    const forty = aggregatePiComparisons(Array.from({ length: 40 }, () => mk({})));
    expect(forty.sampleSizeWarning).toBe('none');
  });
});

describe('wilsonInterval', () => {
  it('bounds a perfect rate from below above 0.5 for n=30', () => {
    const { lower, upper } = wilsonInterval(1, 30);
    expect(lower).toBeGreaterThan(0.5);
    expect(upper).toBeLessThanOrEqual(1);
  });
  it('bounds a zero rate from above below 0.5 for n=30', () => {
    const { lower, upper } = wilsonInterval(0, 30);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThan(0.5);
  });
  it('returns zeros for n<=0', () => {
    expect(wilsonInterval(0.5, 0)).toEqual({ lower: 0, upper: 0 });
  });
});
