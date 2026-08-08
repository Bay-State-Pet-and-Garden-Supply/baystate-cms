import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import {
  evaluateQualificationGate,
  buildQualificationReceiptPayload,
  buildQualificationReceiptDigest,
  createQualificationReceiptId,
} from '../../classification/benchmark-qualification';
import type { EvalMetrics } from '../../shared/schemas/classification';

function fullMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    productType: {
      top1Accuracy: 0.92,
      macroF1: 0.9,
      confusionPairs: [],
      support: 220,
      coverage: 0.95,
      perClassSupport: { 'Dog Food': 40, 'Cat Food': 35, 'Treats': 25 },
    },
    pages: { precisionAtK: 0, recallAtK: 0, exactSetAccuracy: 0, blocked: false, blockedReason: null },
    fields: { targetAccuracy: {}, targetSupport: {} },
    safety: { crossSpeciesCount: 0, crossSpeciesExamples: [], claimSafetyViolations: 0, controlledValueViolations: 0 },
    abstention: { abstainedPercent: 5, accuracyOfNonAbstained: 0.95 },
    operations: { correctionsPerHundred: 3 },
    calibration: { ece: 0.03, bins: [] },
    pairedDelta: {
      primaryMetric: 'productType.top1Accuracy',
      deltaMean: 0.12,
      deltaLower95: 0.05,
      deltaUpper95: 0.2,
      bootstrapRuns: 2000,
    },
    ...overrides,
  };
}

const workspaceId = 'ws-qualification-test';

describe('Benchmark qualification gate', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `qualification-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  it('qualifies when every gate criterion is met', () => {
    const result = evaluateQualificationGate(fullMetrics(), 240);
    expect(result.qualified).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('reports insufficient_sample when holdout < 200', () => {
    const result = evaluateQualificationGate(fullMetrics(), 199);
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('insufficient_sample'))).toBe(true);
  });

  it('rejects insufficient per-class support (< 20)', () => {
    const metrics = fullMetrics({
      productType: { ...fullMetrics().productType, perClassSupport: { 'Dog Food': 19, 'Cat Food': 30 } },
    });
    const result = evaluateQualificationGate(metrics, 240);
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('insufficient_class_support'))).toBe(true);
  });

  it('rejects low coverage (< 0.80)', () => {
    const metrics = fullMetrics({ productType: { ...fullMetrics().productType, coverage: 0.75 } });
    const result = evaluateQualificationGate(metrics, 240);
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('coverage'))).toBe(true);
  });

  it('rejects any safety violation', () => {
    const metrics = fullMetrics({ safety: { crossSpeciesCount: 1, crossSpeciesExamples: ['x'], claimSafetyViolations: 0, controlledValueViolations: 0 } });
    const result = evaluateQualificationGate(metrics, 240);
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('safety_violations'))).toBe(true);
  });

  it('rejects a paired delta whose lower 95% CI is not above zero', () => {
    const metrics = fullMetrics({ pairedDelta: { primaryMetric: 'productType.top1Accuracy', deltaMean: 0.01, deltaLower95: -0.02, deltaUpper95: 0.05, bootstrapRuns: 2000 } });
    const result = evaluateQualificationGate(metrics, 240);
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('paired_delta_not_significant'))).toBe(true);
  });

  it('rejects non-regression floor failures', () => {
    const result = evaluateQualificationGate(fullMetrics(), 240, {
      nonRegressionFloors: [{ metric: 'productType.top1Accuracy', floor: 0.95, actual: 0.92 }],
    });
    expect(result.qualified).toBe(false);
    expect(result.reasons.some(r => r.startsWith('non_regression_floor'))).toBe(true);
  });

  it('persists a content-addressed receipt whose digest binds the gate', () => {
    const metrics = fullMetrics();
    const qualification = evaluateQualificationGate(metrics, 240);

    // Build a real frozen dataset so FK constraints are satisfied.
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Receipt Test', 'product_family', 42);
    benchmarkRepo.insertExample(dataset.id, 'SKU-1', 'fam-1', 'holdout', '{}', JSON.stringify({ productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] }));
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer');
    const frozen = benchmarkRepo.freezeDataset(dataset.id, 'reviewer');

    const payload = buildQualificationReceiptPayload({
      datasetId: dataset.id,
      datasetHash: frozen.dataset_hash ?? 'd'.repeat(64),
      predictionBundleId: 'bundle-1',
      bundleHash: 'e'.repeat(64),
      holdoutSize: 240,
      metrics,
      qualification,
      generatedBy: 'reviewer',
    });
    const digest = buildQualificationReceiptDigest(payload);
    const receiptId = benchmarkRepo.insertQualificationReceipt({
      datasetId: dataset.id,
      datasetHash: frozen.dataset_hash ?? 'd'.repeat(64),
      predictionBundleId: 'bundle-1',
      bundleHash: 'e'.repeat(64),
      holdoutSize: 240,
      coverage: metrics.productType.coverage,
      minClassSupport: 25,
      violations: { crossSpecies: 0, claimSafety: 0, controlledValue: 0 },
      primaryMetric: metrics.pairedDelta.primaryMetric,
      deltaLower95: metrics.pairedDelta.deltaLower95,
      nonRegressionFloorsMet: true,
      qualified: true,
      reasons: [],
      digest,
      generatedBy: 'reviewer',
    });

    const persisted = benchmarkRepo.getQualificationReceipt(receiptId)!;
    expect(persisted.digest).toBe(digest);
    expect(persisted.qualified).toBe(1);
    expect(persisted.dataset_hash).toBe(frozen.dataset_hash ?? 'd'.repeat(64));

    // Same payload → same digest (deterministic).
    const digest2 = buildQualificationReceiptDigest(buildQualificationReceiptPayload({
      datasetId: dataset.id,
      datasetHash: frozen.dataset_hash ?? 'd'.repeat(64),
      predictionBundleId: 'bundle-1',
      bundleHash: 'e'.repeat(64),
      holdoutSize: 240,
      metrics,
      qualification,
      generatedBy: 'reviewer',
    }));
    expect(digest2).toBe(digest);

    expect(createQualificationReceiptId()).toBeTruthy();
  });
});
