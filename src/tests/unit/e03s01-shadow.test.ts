/**
 * e03s01 Task2 v1/v2 shadow on frozen dataset — vitest pure (story: e03s01)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createDataset, insertExample, markFamilyReviewComplete, freezeDataset } from '../../db/repositories/benchmark-repo';
import { runShadowComparison, resolveShadowAdjudication } from '../../product-intelligence/evaluation/shadow';
import type { PiComparison } from '../../product-intelligence/evaluation/metrics';

function skuComp(sku: string, outcome: PiComparison['outcome']): { sku: string; comparison: PiComparison } {
  return { sku, comparison: fakeComp(outcome) };
}

function fakeComp(outcome: PiComparison['outcome']): PiComparison {
  return {
    outcome,
    identity: { exactProductHit: true, exactVariantHit: null, parentOnlyCorrect: null, wrongVariantCorrect: null, abstentionCorrect: null },
    fields: { precision: 1, recall: 1, perField: {}, predictedFacts: 1 },
    unsupportedClaims: 0,
    evidenceCoverage: { fieldsCompared: 1, withMethod: 1, withSourcePath: 1, coverage: 1 },
    image: { exactProductCorrect: null, exactVariantCorrect: null, rightsRejectionCorrect: null },
    classification: { productTypeAccurate: null, attributePrecision: null, attributeCoverage: null, pagePrecision: null, pageRecall: null, pageExactSet: null },
    conflicts: { goldHasMisleading: false, detectedAny: null, falseConflict: false },
    ops: { durationMs: 100, costUsd: 0.01, toolCalls: 2, deniedToolCalls: 0 },
  };
}

describe('shadow v1/v2 comparison', () => {
  let wsPath: string;
  let datasetId: string;
  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `e03-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    // Ensure shadow table additive (if missing, shadow code is best-effort)
    try {
      getDb().run(`CREATE TABLE IF NOT EXISTS shadow_comparisons (id TEXT PRIMARY KEY, dataset_id TEXT, dataset_hash TEXT, sku TEXT, v1_outcome TEXT, v2_outcome TEXT, adjudication TEXT, created_at TEXT)`);
    } catch {}
    const wsId = 'ws-shadow-test';
    getDb().run(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status) VALUES (?, 'WS', ?, '', ?, ?, 'complete')`, [wsId, wsPath, new Date().toISOString(), new Date().toISOString()]);
    const ds = createDataset(wsId, 'shadow-ds', 'random', 42);
    insertExample(ds.id, '085000079585', '085000079585', 'test', JSON.stringify({ gtin: '085000079585', registerName: 'STELLA', expectedPageUrl: 'https://x/p/1' }), JSON.stringify({ identity: { exactProduct: true }, expectedEvidence: [{ field: 'size', extractionMethod: 'json_ld' }], misleadingSources: [], difficultyTags: [] }));
    insertExample(ds.id, '070628048161', '070628048161', 'test', JSON.stringify({ gtin: '070628048161', registerName: 'BLUE 24LB WRONG', expectedPageUrl: 'https://x/p/2' }), JSON.stringify({ identity: { wrongVariant: true }, expectedEvidence: [], misleadingSources: [{ domain: 'chewy.com', reason: 'wrong size' }], difficultyTags: [] }));
    markFamilyReviewComplete(ds.id, 't');
    freezeDataset(ds.id, 't');
    datasetId = ds.id;
  });
  it('runs v1/v2 on identical seeds, never mutates state, adjudicates non-deterministic', () => {
    const report = runShadowComparison({ datasetId, v1Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'wrong_variant')], v2Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'wrong_variant')] });
    expect(report.evaluated).toBe(2);
    expect(report.deltas.quality).not.toBeNull();
    expect(report.pairs[1].adjudication).toBe('needs_reviewer');
    expect(report.adjudicationNotes.length).toBeGreaterThan(0);
    // Each pair exposes a stable UUID linking to shadow_comparisons.
    for (const p of report.pairs) {
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
      const row = getDb().query('SELECT COUNT(*) as c FROM shadow_comparisons WHERE id = ?').get(p.id) as { c: number };
      expect(row.c).toBe(1);
    }
    // Verify shadow writes did not affect benchmark_examples
    const examples = getDb().query('SELECT COUNT(*) as c FROM benchmark_examples WHERE dataset_id = ?').get(datasetId) as { c: number };
    expect(examples.c).toBe(2);
  });

  it('pairs by identical frozen seed SKU, skips when v1/v2 length mismatch', () => {
    // v1 has both SKUs, v2 has only the first — second SKU must be skipped.
    const report = runShadowComparison({
      datasetId,
      v1Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'submitted')],
      v2Comparisons: [skuComp('085000079585', 'submitted')],
    });
    expect(report.evaluated).toBe(1);
    expect(report.pairs[0].sku).toBe('085000079585');
    expect(report.adjudicationNotes.some((n) => n.includes('070628048161') && n.includes('missing'))).toBe(true);
  });

  it('pairs strictly by SKU, not array order', () => {
    // v1 supplies SKUs in reverse order; pairing must follow SKU, not index.
    const report = runShadowComparison({
      datasetId,
      v1Comparisons: [skuComp('070628048161', 'wrong_variant'), skuComp('085000079585', 'submitted')],
      v2Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'wrong_variant')],
    });
    expect(report.evaluated).toBe(2);
    const bySku = new Map(report.pairs.map((p) => [p.sku, p.v1Outcome]));
    expect(bySku.get('085000079585')).toBe('submitted');
    expect(bySku.get('070628048161')).toBe('wrong_variant');
  });

  it('reports humanCorrection delta and per-version rates from outcomes', () => {
    const report = runShadowComparison({
      datasetId,
      v1Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'wrong_variant')],
      v2Comparisons: [skuComp('085000079585', 'submitted'), skuComp('070628048161', 'submitted')],
    });
    // v1 needs correction on 1/2 (wrong_variant), v2 needs 0/2 -> delta = -0.5.
    expect(report.humanCorrectionRates.v1Rate).toBeCloseTo(0.5);
    expect(report.humanCorrectionRates.v2Rate).toBeCloseTo(0);
    expect(report.deltas.humanCorrection).toBeCloseTo(-0.5);
  });

  it('persists durable reviewer adjudication linked to the pair id', () => {
    const report = runShadowComparison({ datasetId, v1Comparisons: [skuComp('085000079585', 'submitted')], v2Comparisons: [skuComp('085000079585', 'submitted')] });
    const pairId = report.pairs[0].id;
    expect(() => resolveShadowAdjudication(pairId, '085000079585', 'confirmed', 'reviewer-1')).not.toThrow();
    const rows = getDb().query('SELECT COUNT(*) as c FROM shadow_adjudications WHERE shadow_comparison_id = ?').get(pairId) as { c: number };
    expect(rows.c).toBe(1);
  });
});
