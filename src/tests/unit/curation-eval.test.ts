// story: e05s03
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import { validatePageAssignmentsWithProvenance } from '../../classification/species-guard';

describe('curation-eval metrics // story: e05s03', () => {
  test('specs/metrics/curation-eval.json exists with hash and baselines', () => {
    const raw = fs.readFileSync('specs/metrics/curation-eval.json', 'utf8');
    expect(raw).toContain('// story: e05s03');
    const evalJson = JSON.parse(raw) as any;
    expect(typeof evalJson.goldsetSha256).toBe('string');
    expect(evalJson.goldsetSha256.length).toBe(64);
    expect(typeof evalJson.metrics.titleVariantDropRate).toBe('number');
    expect(typeof evalJson.baselines.titleVariantDropRateMax).toBe('number');
    expect(typeof evalJson.metrics.speciesGuardFilteredCount).toBe('number');
  });

  test('species-guard reason codes round-trip via provenance helper', () => {
    const evidence = [{ source: 'visual_product_evidence', sourceField: 'species', value: 'cat', sourceId: 'x', evidenceId: 'y' }] as any;
    const pages = ['Dog Food Dry', 'Cat Litter Fresh', 'Fish Flakes'];
    const { dropped } = validatePageAssignmentsWithProvenance(pages, evidence);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    expect(dropped[0]!.reason).toBe('species_incompatible');
    expect(dropped[0]!.species).toBe('cat');
  });

  test('attribute empty-success baseline is zero after e04s01 fix', () => {
    const evalJson = JSON.parse(fs.readFileSync('specs/metrics/curation-eval.json', 'utf8')) as any;
    expect(evalJson.metrics.attributeEmptySuccessBaselineRate).toBe(0);
    expect(evalJson.baselines.attributeEmptySuccessMax).toBeGreaterThanOrEqual(0.01);
  });

  test('goldset divergence within baseline max', () => {
    const evalJson = JSON.parse(fs.readFileSync('specs/metrics/curation-eval.json', 'utf8')) as any;
    expect(evalJson.metrics.llmVsFallbackDivergenceRate).toBeLessThanOrEqual(evalJson.baselines.llmVsFallbackDivergenceMax);
    expect(evalJson.metrics.titleVariantDropRate).toBeLessThanOrEqual(evalJson.baselines.titleVariantDropRateMax);
  });
});
