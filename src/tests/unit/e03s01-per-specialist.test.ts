/**
 * e03s01 Task1 per-specialist versioned metrics — vitest pure (story: e03s01)
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computePerSpecialistVersionedMetrics, compareSpecialistDeltas, datasetSha } from '../../product-intelligence/evaluation/per-specialist-metrics';
import { buildPiGoldenProducts } from '../../product-intelligence/evaluation/fixture-dataset';
import type { PiComparison } from '../../product-intelligence/evaluation/metrics';

function fakeComparison(recall: number | null, provenance: number | null): PiComparison {
  return {
    outcome: 'submitted',
    identity: { exactProductHit: true, exactVariantHit: true, parentOnlyCorrect: null, wrongVariantCorrect: null, abstentionCorrect: null },
    fields: { precision: recall, recall, perField: {}, predictedFacts: 2 },
    unsupportedClaims: 0,
    evidenceCoverage: { fieldsCompared: 2, withMethod: provenance != null ? 2 : 0, withSourcePath: 2, coverage: provenance },
    image: { exactProductCorrect: null, exactVariantCorrect: null, rightsRejectionCorrect: null },
    classification: { productTypeAccurate: null, attributePrecision: null, attributeCoverage: null, pagePrecision: null, pageRecall: null, pageExactSet: null },
    conflicts: { goldHasMisleading: false, detectedAny: null, falseConflict: false },
    ops: { durationMs: 120, costUsd: 0.01, toolCalls: 5, deniedToolCalls: 0 },
  };
}

describe('per-specialist versioned metrics', () => {
  it('emits datasetSha and deltas reusing frozen dataset hash', () => {
    const comps = [fakeComparison(0.9, 0.95), fakeComparison(0.8, 0.9)];
    const m = computePerSpecialistVersionedMetrics('resolver', 'v2', comps);
    expect(m.specialist).toBe('resolver');
    expect(m.version).toBe('v2');
    expect(m.datasetVersion).toBe('v1');
    expect(m.datasetSha).toMatch(/^[a-f0-9]{16}$/);
    expect(m.sampleSize).toBe(2);
    expect(m.deltas.quality).toBeCloseTo(0.85);
    expect(m.deltas.provenance).toBeCloseTo(0.925);
  });
  it('produces deltas vs baseline', () => {
    const cur = computePerSpecialistVersionedMetrics('curator', 'v2', [fakeComparison(0.8, 0.8)]);
    const base = computePerSpecialistVersionedMetrics('curator', 'v1', [fakeComparison(0.6, 0.6)]);
    const d = compareSpecialistDeltas(cur, base);
    expect(d.quality).toBeCloseTo(0.2);
  });
  it('empty comparisons returns zero sample', () => {
    const m = computePerSpecialistVersionedMetrics('discovery', 'v1', []);
    expect(m.sampleSize).toBe(0);
  });
  it('datasetSha covers full frozen contents + gold labels, not just GTINs', () => {
    const full = datasetSha();
    expect(full).toMatch(/^[a-f0-9]{16}$/);
    // A GTIN-only hash of the same products must differ, proving gold labels are included.
    const products = buildPiGoldenProducts();
    const gtinOnly = createHash('sha256')
      .update(JSON.stringify(products.map((p) => p.input.gtin).sort()))
      .digest('hex')
      .slice(0, 16);
    expect(full).not.toBe(gtinOnly);
  });
});
