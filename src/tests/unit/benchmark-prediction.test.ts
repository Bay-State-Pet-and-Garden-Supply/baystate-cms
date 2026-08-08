import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import {
  buildPredictionBundle,
  computePredictionBundleHash,
  validatePredictionBundle,
  extractPredictionsForSku,
  loadPredictionBundle,
} from '../../classification/benchmark-prediction';
import { calibrateThresholds, devPairsFromBundle } from '../../classification/confidence-calibrator';
import type { BenchmarkPredictionEntry } from '../../shared/schemas/classification';

const workspaceId = 'ws-prediction-test';
const CONFIG_HASH = 'c'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-pred-1';

describe('Benchmark prediction bundles', () => {
  let wsPath: string;
  let dbPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `prediction-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
    );
    getDb().run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  function seedRun(sku: string, productType: string | null, abstain = false, confidence = 0.85) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    if (abstain) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'reviewable_abstention', 'null', 0, 'pending', ?)`,
        [randomUUID(), run.id, sku, now]
      );
    } else if (productType) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', ?, ?, 'accepted', ?)`,
        [randomUUID(), run.id, sku, JSON.stringify(productType), confidence, now]
      );
      const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ?').get(run.id) as { id: string };
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
         VALUES (?, ?, 'accepted', NULL, 0, ?)`,
        [randomUUID(), pid.id, now]
      );
    }
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function frozenDataset(skus: string[]): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Prediction Test', 'product_family', 42);
    skus.forEach((sku, i) => {
      benchmarkRepo.insertExample(dataset.id, sku, `fam-${i}`, 'holdout', '{}', JSON.stringify({ productType: sku === 'ABSTAIN' ? 'X' : sku, pageAssignments: [], fieldAssignments: [] }));
    });
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer');
    return dataset.id;
  }

  it('builds and persists a complete bundle bound to the gold examples', () => {
    seedRun('SKU-1', 'Dog Food');
    seedRun('SKU-2', 'Cat Food');
    const datasetId = frozenDataset(['SKU-1', 'SKU-2']);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' });
    expect(bundle.predictions.length).toBe(2);
    expect(bundle.bundleHash).toBe(computePredictionBundleHash(bundle.predictions));

    const persisted = benchmarkRepo.getPredictionBundle(bundle.id)!;
    expect(persisted.bundle_hash).toBe(bundle.bundleHash);
    expect(JSON.parse(persisted.predictions_json).length).toBe(2);
  });

  it('extracts the exact effective revised values from the reviewed run', () => {
    // Seed a run then revise the type via a live decision on a newer run.
    const firstRun = seedRun('SKU-REV', 'Dog Food');
    // Ensure the first run sorts strictly older (started_at ordering).
    getDb().run('UPDATE classification_runs SET started_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', firstRun.id]);
    const run = createRun(workspaceId, 'SKU-REV', CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', '"Dog Food"', 0.85, 'accepted', ?)`,
      [randomUUID(), run.id, 'SKU-REV', now]
    );
    const pid = getDb().query('SELECT id FROM classification_proposals WHERE run_id = ?').get(run.id) as { id: string };
    getDb().run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', '"Dog Food Dry"', 0, ?)`,
      [randomUUID(), pid.id, now]
    );
    getDb().run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);

    const entry = extractPredictionsForSku(workspaceId, 'SKU-REV');
    expect(entry).not.toBeNull();
    expect(entry!.productType).toBe('Dog Food Dry');
  });

  it('fails closed on a missing prediction for a gold example', () => {
    seedRun('SKU-1', 'Dog Food');
    // SKU-2 has no reviewed run at all.
    const datasetId = frozenDataset(['SKU-1', 'SKU-2']);
    expect(() => buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' }))
      .toThrow(/No reviewed-run prediction available/);
  });

  it('fails closed on duplicate example ids', () => {
    const predictions: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    const gold = [{ id: 'e1', productSku: 'SKU-1' }, { id: 'e2', productSku: 'SKU-2' }];
    const hash = computePredictionBundleHash(predictions);
    expect(() => validatePredictionBundle(predictions, gold, hash)).toThrow(/duplicate example id/);
  });

  it('fails closed on a wrong digest', () => {
    const predictions: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    expect(() => validatePredictionBundle(predictions, [{ id: 'e1', productSku: 'SKU-1' }], 'f'.repeat(64)))
      .toThrow(/digest mismatch/);
  });

  it('loadPredictionBundle re-verifies the persisted digest and workspace', () => {
    seedRun('SKU-1', 'Dog Food');
    const datasetId = frozenDataset(['SKU-1']);
    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' });

    const loaded = loadPredictionBundle(workspaceId, datasetId, bundle.id, 'holdout');
    expect(loaded.bundleHash).toBe(bundle.bundleHash);

    expect(() => loadPredictionBundle('other-ws', datasetId, bundle.id, 'holdout')).toThrow(/different workspace/);
  });

  it('fits calibration thresholds ONLY from development-split example-level predictions (train/holdout excluded)', () => {
    // Seed reviewed runs for all SKUs so a complete bundle can be built.
    seedRun('DEV-1', 'Dog Food');
    seedRun('DEV-2', 'Cat Food');
    seedRun('TRAIN-1', 'Dog Food');
    seedRun('HOLD-1', 'Bird Food', false, 0.4);

    // Frozen dataset with train/test(dev)/holdout splits. The development split
    // for calibration is the middle 'test' partition (train|test|holdout).
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Calibration Test', 'product_family', 42);
    const goldFor = (productType: string) => JSON.stringify({ productType, pageAssignments: [], fieldAssignments: [] });
    benchmarkRepo.insertExample(dataset.id, 'DEV-1', 'fam-dev-1', 'test', '{}', goldFor('Dog Food'));
    benchmarkRepo.insertExample(dataset.id, 'DEV-2', 'fam-dev-2', 'test', '{}', goldFor('Cat Food'));
    benchmarkRepo.insertExample(dataset.id, 'TRAIN-1', 'fam-train-1', 'train', '{}', goldFor('Dog Food'));
    benchmarkRepo.insertExample(dataset.id, 'HOLD-1', 'fam-hold-1', 'holdout', '{}', goldFor('Bird Food'));
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer');

    const bundle = buildPredictionBundle(workspaceId, dataset.id, { runLabel: 'Calibration', splitGroup: 'test' });
    // A development-split bundle contains ONLY the test/development examples.
    expect(bundle.predictions.length).toBe(2);

    // Production contract: calibration consumes the development-split bundle
    // (splitGroup 'test'); holdout predictions live in a separate holdout bundle
    // and must never reach the fitter.
    const holdoutBundle = buildPredictionBundle(workspaceId, dataset.id, { runLabel: 'Holdout', splitGroup: 'holdout' });
    expect(holdoutBundle.predictions.length).toBe(1);

    const devExamples = benchmarkRepo.getExamples(dataset.id, 'test');
    const devIds = new Set(devExamples.map((e) => String(e.id)));
    const holdoutIds = new Set(benchmarkRepo.getExamples(dataset.id, 'holdout').map((e) => String(e.id)));
    const goldByExample = new Map(
      benchmarkRepo.getExamples(dataset.id).map((e) => [String(e.id), { productType: (JSON.parse(e.gold_labels_json) as { productType: string }).productType }]),
    );

    // No holdout example may appear in the development bundle used for fitting,
    // and every development-bundle prediction belongs to a development example.
    expect(bundle.predictions.some((p) => holdoutIds.has(p.exampleId))).toBe(false);
    expect(bundle.predictions.every((p) => devIds.has(p.exampleId))).toBe(true);

    // The holdout bundle's predictions are structurally separate and must never
    // reach the fitter: their example ids are all holdout ids.
    expect(holdoutBundle.predictions.every((p) => holdoutIds.has(p.exampleId))).toBe(true);

    const devPairs = devPairsFromBundle(bundle.predictions, goldByExample);
    // Every fitted pair is derived from a development-split prediction (the pair
    // itself carries confidence/correctness only; the split gate is enforced at
    // the prediction-selection boundary above).
    expect(devPairs.length).toBe(2);
    expect(devPairs.every((p) => p.proposalType === 'primary_product_type')).toBe(true);

    const holdoutPairs = devPairsFromBundle(holdoutBundle.predictions, goldByExample);
    expect(holdoutPairs.length).toBe(1);

    const thresholds = calibrateThresholds(devPairs);
    expect(thresholds.productType.abstainBelow).toBeGreaterThanOrEqual(0);
    expect(thresholds.productType.reviewAbove).toBeGreaterThanOrEqual(thresholds.productType.abstainBelow);

    // Fitting on the development pairs alone is deterministic; contaminating the
    // fit with holdout predictions changes the thresholds, proving the split
    // gate is material and must be enforced at the call site.
    const devOnly = calibrateThresholds(devPairs);
    const contaminated = calibrateThresholds([...devPairs, ...holdoutPairs]);
    expect(devOnly).toEqual(calibrateThresholds(devPairs));
    expect(JSON.stringify(contaminated)).not.toBe(JSON.stringify(devOnly));
  });
});
