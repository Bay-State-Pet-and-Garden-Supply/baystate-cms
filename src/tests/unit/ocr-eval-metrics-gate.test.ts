/**
 * Packaging-OCR eval metrics, rollout gate, and golden-dataset validation
 * (packaging-OCR overhaul P3-T1/T3). Pure modules — runs under plain vitest
 * (no DB, no transport).
 */
import { describe, it, expect } from 'vitest';
import {
  ARRAY_JACCARD_MATCH_THRESHOLD,
  DEFAULT_ROLLOUT_THRESHOLDS,
  OCR_SCALAR_FIELDS,
  aggregateCandidateReport,
  evaluateRolloutGate,
  fieldMatches,
  upcMatches,
  type OcrComparisonReport,
  type OcrItemOutcome,
} from '../../onboarding/ocr-eval/metrics';
import {
  GOLDEN_DATASET_SCHEMA_VERSION,
  computeGoldenDatasetDigest,
  decodeInlineImage,
  isInlineImageRef,
  loadGoldenDatasetFromJson,
  type GoldenOcrExpected,
} from '../../onboarding/ocr-eval/golden-dataset';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

// ─── golden dataset ─────────────────────────────────────────────────────────

function validEntryJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-a',
    imageRef: 'images/a.jpg',
    expected: {
      productName: 'Dog Treats',
      brand: 'Acme',
      species: ['dog'],
      upc: '036000291452',
      flavorVariety: null,
      color: null,
      material: null,
      size: null,
      weight: null,
      count: null,
      lifeStage: null,
      breedSize: null,
      productForm: null,
      healthConcernFunction: [],
      dietaryLabels: [],
      ingredients: [],
      ingredientKeywords: [],
      claims: [],
      visibleTextLines: [],
    },
    ...overrides,
  };
}

function validDatasetJson(entries: Array<Record<string, unknown>> = [validEntryJson()]) {
  return JSON.stringify({ schemaVersion: GOLDEN_DATASET_SCHEMA_VERSION, name: 'gold-v1', entries });
}

describe('golden dataset loading', () => {
  it('validates and digests a well-formed dataset', () => {
    const loaded = loadGoldenDatasetFromJson(validDatasetJson());
    expect(loaded.name).toBe('gold-v1');
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical digests for equivalent JSON with different key order/whitespace', () => {
    const compact = loadGoldenDatasetFromJson(validDatasetJson());
    const pretty = loadGoldenDatasetFromJson(
      JSON.stringify(JSON.parse(validDatasetJson()), null, 4),
    );
    const reordered = loadGoldenDatasetFromJson(
      JSON.stringify({
        entries: [JSON.parse(JSON.stringify(validEntryJson()))],
        name: 'gold-v1',
        schemaVersion: GOLDEN_DATASET_SCHEMA_VERSION,
      }),
    );
    expect(pretty.digest).toBe(compact.digest);
    // computeGoldenDatasetDigest canonicalizes regardless of insertion order
    expect(reordered.digest).toBe(compact.digest);
    expect(computeGoldenDatasetDigest(JSON.parse(validDatasetJson()))).toBe(compact.digest);
  });

  it('changes the digest when a label changes', () => {
    const a = loadGoldenDatasetFromJson(validDatasetJson());
    const edited = validEntryJson();
    (edited.expected as Record<string, unknown>).brand = 'Other';
    const b = loadGoldenDatasetFromJson(validDatasetJson([edited]));
    expect(b.digest).not.toBe(a.digest);
  });

  it('rejects duplicate entry ids', () => {
    expect(() =>
      loadGoldenDatasetFromJson(validDatasetJson([validEntryJson(), validEntryJson()])),
    ).toThrow(/duplicate entry id/);
  });

  it('rejects imageRefs escaping the dataset directory', () => {
    expect(() =>
      loadGoldenDatasetFromJson(
        validDatasetJson([validEntryJson({ id: 'evil', imageRef: '../secrets.png' })]),
      ),
    ).toThrow(/escapes the dataset directory/);
  });

  it('rejects invalid UPC labels', () => {
    const entry = validEntryJson();
    (entry.expected as Record<string, unknown>).upc = '12345'; // too short
    expect(() => loadGoldenDatasetFromJson(validDatasetJson([entry]))).toThrow();
  });

  it('accepts PARTIAL labels: omitted keys mean "not hand labeled", not asserted absence (FIX-3)', () => {
    const entry = validEntryJson({
      expected: { productName: 'Partial Dog Treats', upc: '036000291452' },
    });
    const loaded = loadGoldenDatasetFromJson(validDatasetJson([entry]));
    const expected = loaded.entries[0]!.expected as unknown as Record<string, unknown>;
    expect(expected.productName).toBe('Partial Dog Treats');
    // Omitted keys are ABSENT (no silent default([]) injection).
    expect(Object.prototype.hasOwnProperty.call(expected, 'brand')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(expected, 'species')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(expected, 'visibleTextLines')).toBe(false);
  });

  it('fails closed on a FUTURE schemaVersion (FIX-9)', () => {
    const future = JSON.stringify({
      schemaVersion: GOLDEN_DATASET_SCHEMA_VERSION + 1,
      name: 'from-the-future',
      entries: [validEntryJson()],
    });
    expect(() => loadGoldenDatasetFromJson(future)).toThrow(/newer than the supported version/);
  });

  it('supports inline base64 imageRefs with round-trip decoding', () => {
    const bytes = Buffer.alloc(2048, 7);
    const ref = `inline:${bytes.toString('base64')}`;
    expect(isInlineImageRef({ imageRef: ref })).toBe(true);
    expect(decodeInlineImage({ imageRef: ref })!.equals(bytes)).toBe(true);
    expect(decodeInlineImage({ imageRef: 'inline:not-base64!!!' })).toBeNull();
    expect(isInlineImageRef({ imageRef: 'images/a.jpg' })).toBe(false);
  });
});

// ─── field comparison semantics ──────────────────────────────────────────────

const LABEL: GoldenOcrExpected = {
  productName: 'Wormeze Liquid',
  brand: 'acme pet',
  species: ['dog', 'puppy'],
  upc: '036000291452',
  flavorVariety: null,
  color: null,
  material: null,
  size: '8 oz',
  weight: null,
  count: null,
  lifeStage: null,
  breedSize: null,
  productForm: null,
  healthConcernFunction: [],
  dietaryLabels: ['grain free', 'natural'],
  ingredients: [],
  ingredientKeywords: [],
  claims: [],
  visibleTextLines: [],
};

function pred(partial: Partial<PackagingOcrData>): PackagingOcrData {
  return {
    productName: null, brand: null, species: [], upc: null, flavorVariety: null,
    color: null, material: null, size: null, weight: null, count: null,
    lifeStage: null, breedSize: null, productForm: null, healthConcernFunction: [],
    dietaryLabels: [], ingredients: [], ingredientKeywords: [], claims: [],
    visibleTextLines: [], confidenceByField: {}, metadata: null,
    ...partial,
  } as PackagingOcrData;
}

describe('fieldMatches normalization rules', () => {
  it('matches UPC digit-exact only', () => {
    expect(upcMatches('036000291452', LABEL.upc)).toBe(true);
    expect(upcMatches('3600029145', LABEL.upc)).toBe(false);
    expect(upcMatches(null, LABEL.upc)).toBe(false);
    expect(fieldMatches('upc', pred({ upc: '036000291452' }), LABEL)).toBe(true);
    expect(fieldMatches('upc', pred({ upc: null }), LABEL)).toBe(false);
  });

  it('case-folds and trims scalar strings', () => {
    expect(fieldMatches('brand', pred({ brand: '  ACME Pet ' }), LABEL)).toBe(true);
    expect(fieldMatches('productName', pred({ productName: 'wormeze liquid' }), LABEL)).toBe(true);
    expect(fieldMatches('productName', pred({ productName: 'Other Product' }), LABEL)).toBe(false);
  });

  it('treats labeled-null scalars matched by null and hallucinations otherwise', () => {
    expect(fieldMatches('flavorVariety', pred({}), LABEL)).toBe(true);
    expect(fieldMatches('flavorVariety', pred({ flavorVariety: 'Phantom Flavor' }), LABEL)).toBe(false);
  });

  it('scores array fields via Jaccard set overlap', () => {
    expect(ARRAY_JACCARD_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(fieldMatches('species', pred({ species: ['Dog'] }), LABEL)).toBe(true);
    expect(fieldMatches('species', pred({ species: ['cat'] }), LABEL)).toBe(false);
    expect(fieldMatches('dietaryLabels', pred({ dietaryLabels: ['Natural', 'Grain Free', 'raw'] }), LABEL)).toBe(true);
    expect(fieldMatches('dietaryLabels', pred({ dietaryLabels: ['vegan', 'keto', 'raw', 'lite'] }), LABEL)).toBe(false);
  });

  it('scores labeled-null fields as false when the prediction hallucinates', () => {
    expect(fieldMatches('weight', pred({ weight: '5 lb' }), LABEL)).toBe(false);
  });

  it('scores a labeled-null UPC like other labeled-null scalars', () => {
    const NULL_UPC_LABEL: GoldenOcrExpected = { ...LABEL, upc: null };
    // Null prediction on a null label = match.
    expect(fieldMatches('upc', pred({ upc: null }), NULL_UPC_LABEL)).toBe(true);
    expect(fieldMatches('upc', pred({}), NULL_UPC_LABEL)).toBe(true);
    // Non-null prediction on a null label = hallucination (miss).
    expect(fieldMatches('upc', pred({ upc: '036000291452' }), NULL_UPC_LABEL)).toBe(false);
    expect(fieldMatches('upc', pred({ upc: '999999999999' }), NULL_UPC_LABEL)).toBe(false);
  });

  it('skips fields OMITTED from a partial label (FIX-3)', () => {
    const partialLabel = { productName: 'Wormeze Liquid', upc: '036000291452' } as unknown as GoldenOcrExpected;
    // Unlabeled fields return null (not scored) even when the prediction has data.
    expect(fieldMatches('brand', pred({ brand: 'Acme' }), partialLabel)).toBeNull();
    expect(fieldMatches('species', pred({ species: ['dog'] }), partialLabel)).toBeNull();
    expect(fieldMatches('flavorVariety', pred({ flavorVariety: 'X' }), partialLabel)).toBeNull();
    // Labeled fields still score normally.
    expect(fieldMatches('productName', pred({ productName: 'wormeze liquid' }), partialLabel)).toBe(true);
  });
});

// ─── aggregation + gate ───────────────────────────────────────────────────────

function outcome(ok: boolean, data: PackagingOcrData | null, entryId = 'e1', reasonCode?: string, latencyMs = 100): OcrItemOutcome {
  return ok ? { entryId, ok: true, latencyMs, data } : { entryId, ok: false, latencyMs, reasonCode };
}

const ENTRY_IDS = Array.from({ length: 30 }, (_, i) => `e${i}`);

function syntheticOutcomes(upcCorrectCount: number): OcrItemOutcome[] {
  return ENTRY_IDS.map((id, i) => {
    const d = pred({
      upc: i < upcCorrectCount ? '036000291452' : '999999999999',
      productName: 'Wormeze Liquid',
    });
    return outcome(true, d, id, undefined, 1000 + i * 10);
  });
}

function labelFor(id: string): { id: string; expected: GoldenOcrExpected } {
  return { id, expected: LABEL };
}

describe('aggregateCandidateReport', () => {
  const entries = ENTRY_IDS.map(labelFor);

  it('computes match/hallucination/empty/parse/latency stats', () => {
    const outcomes = [
      ...syntheticOutcomes(28),
      outcome(false, null, 'extra-fail', 'unparseable_json', 50),
    ];
    const report = aggregateCandidateReport('candidate', outcomes, { baselineModel: 'baseline', datasetEntries: entries });
    expect(report.samples).toBe(31);
    expect(report.parseSuccessRate).toBeCloseTo(30 / 31);
    expect(report.failureReasonCounts['unparseable_json']).toBe(1);
    expect(report.fieldMatch.upc!.comparable).toBe(30);
    expect(report.fieldMatch.upc!.matched).toBe(28);
    expect(report.latencyP50Ms).toBeGreaterThan(0);
    expect(report.latencyP95Ms).toBeGreaterThanOrEqual(report.latencyP50Ms);
    // hallucination over labeled-null fields: flavorVariety..productForm are null-labeled
    // predictions leave them null ⇒ rate 0.
    expect(report.hallucinationRate).toBe(0);
    expect(report.emptyRate).toBeCloseTo(1 / 31);
    expect(report.vsBaseline.hasBaseline).toBe(false);
    expect(report.vsBaseline.upcAccuracyDelta).toBeNull();
  });

  it('attaches baseline deltas when a baseline report is supplied', () => {
    const baseline = aggregateCandidateReport('baseline', syntheticOutcomes(30), { baselineModel: 'baseline', datasetEntries: entries });
    const candidate = aggregateCandidateReport('candidate', syntheticOutcomes(28), { baselineModel: 'baseline', baselineReport: baseline, datasetEntries: entries });
    expect(candidate.vsBaseline.hasBaseline).toBe(true);
    expect(candidate.vsBaseline.upcAccuracyDelta).not.toBeNull();
    expect(candidate.vsBaseline.baselineLatencyP95Ms).toBe(baseline.latencyP95Ms);
    expect(candidate.vsBaseline.emptyRateDelta).toBe(0);
  });

  it('counts hallucinated values on labeled-null fields', () => {
    const one = ENTRY_IDS.slice(0, 1).map(labelFor);
    const outcomes = [outcome(true, pred({ flavorVariety: 'Ghost Flavor' }), 'e0')];
    const report = aggregateCandidateReport('c', outcomes, { datasetEntries: one });
    expect(report.hallucinationRate).toBeGreaterThan(0);
  });

  it('excludes failed attempts from the hallucination-rate denominator', () => {
    const entries = [labelFor('e0'), labelFor('e1')];
    const outcomes = [
      outcome(true, pred({ flavorVariety: 'Ghost Flavor' }), 'e0'),
      outcome(false, null, 'e1', 'unparseable_json'),
    ];
    const report = aggregateCandidateReport('c', outcomes, { datasetEntries: entries });
    // Only the ok attempt contributes labeled-null scalar fields; counting
    // the failed attempt's would deflate the rate from 1/8 to 1/16.
    const nullLabeledCount = OCR_SCALAR_FIELDS.filter(f => (LABEL as Record<string, unknown>)[f] === null).length;
    expect(nullLabeledCount).toBeGreaterThan(0);
    expect(report.hallucinationRate).toBeCloseTo(1 / nullLabeledCount);
  });

  it('excludes OMITTED (undefined/unlabeled) fields from the hallucination-rate denominator (FIX-3)', () => {
    const outcomes = [outcome(true, pred({ flavorVariety: 'Ghost Flavor' }), 'e0')];
    // Partial label: ONLY productName is labeled — every other scalar is
    // omitted/unlabeled and must NOT enter the hallucination denominator.
    // With zero labeled-null scalars the rate is not computable (null),
    // proving the ghost flavorVariety prediction was never scored.
    const report = aggregateCandidateReport('c', outcomes, {
      datasetEntries: [{ id: 'e0', expected: { productName: 'Wormeze Liquid' } as unknown as GoldenOcrExpected }],
    });
    expect(report.hallucinationRate).toBeNull();
  });
});

function reportWith(overrides: {
  samples?: number;
  upcAccuracyDelta?: number | null;
  hallucinationRateDelta?: number | null;
  emptyRateDelta?: number | null;
  parseSuccessRate?: number;
  latencyP95Ratio?: number | null;
}): OcrComparisonReport {
  const samples = overrides.samples ?? 30;
  const baseP95 = 5000;
  const ratio = overrides.latencyP95Ratio ?? 1;
  const upcRate = 0.9;
  return {
    candidateModel: 'candidate',
    baselineModel: 'baseline',
    samples,
    fieldMatch: {
      upc: { matched: Math.round(upcRate * samples), comparable: samples, rate: upcRate, wilsonLower: 0, wilsonUpper: 1 },
    },
    upcAccuracy: upcRate,
    hallucinationRate: 0.05,
    emptyRate: 0.02,
    parseSuccessRate: overrides.parseSuccessRate ?? 0.97,
    latencyP50Ms: 3000,
    latencyP95Ms: baseP95 * ratio,
    failureReasonCounts: {},
    vsBaseline: {
      hasBaseline: true,
      upcAccuracyDelta: overrides.upcAccuracyDelta ?? -0.01,
      hallucinationRateDelta: overrides.hallucinationRateDelta ?? 0,
      emptyRateDelta: overrides.emptyRateDelta ?? 0,
      parseSuccessRateDelta: 0,
      latencyP50DeltaMs: 0,
      latencyP95DeltaMs: baseP95 * (ratio - 1),
      baselineLatencyP50Ms: 3000,
      baselineLatencyP95Ms: baseP95,
    },
  };
}

describe('evaluateRolloutGate (pre-registered thresholds)', () => {
  it('passes a report meeting every criterion', () => {
    const gate = evaluateRolloutGate(reportWith({}));
    expect(gate.pass).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('denies below-minimum sample sizes even when every rate passes', () => {
    const gate = evaluateRolloutGate(reportWith({ samples: 10 }));
    expect(gate.pass).toBe(false);
    expect(gate.failures.some(f => f.startsWith('min_sample_size'))).toBe(true);
  });

  it('denies UPC regression beyond tolerance', () => {
    const gate = evaluateRolloutGate(reportWith({ upcAccuracyDelta: -0.05 }));
    expect(gate.pass).toBe(false);
    expect(gate.failures.some(f => f.includes('upc_accuracy_delta'))).toBe(true);
  });

  it('allows UPC regression within tolerance', () => {
    expect(evaluateRolloutGate(reportWith({ upcAccuracyDelta: -DEFAULT_ROLLOUT_THRESHOLDS.upcAccuracyTolerance })).pass).toBe(true);
  });

  it('denies hallucination-rate increase over baseline', () => {
    const gate = evaluateRolloutGate(reportWith({ hallucinationRateDelta: 0.02 }));
    expect(gate.failures.some(f => f.includes('hallucination_rate'))).toBe(true);
  });

  it('denies parse-success below the absolute floor and latency beyond 2× baseline', () => {
    expect(evaluateRolloutGate(reportWith({ parseSuccessRate: 0.9 })).failures.some(f => f.includes('parse_success_rate'))).toBe(true);
    expect(evaluateRolloutGate(reportWith({ latencyP95Ratio: 2.5 })).failures.some(f => f.includes('latency_p95_ratio'))).toBe(true);
    expect(evaluateRolloutGate(reportWith({ latencyP95Ratio: 2 })).pass).toBe(true);
  });

  it('fails closed when baseline comparisons are missing', () => {
    const report = reportWith({});
    report.vsBaseline.upcAccuracyDelta = null;
    report.vsBaseline.baselineLatencyP95Ms = null;
    const gate = evaluateRolloutGate(report);
    expect(gate.pass).toBe(false);
  });
});
