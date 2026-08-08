import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { evaluateBenchmark } from '../../classification/benchmark-evaluator';
import { buildPredictionBundle } from '../../classification/benchmark-prediction';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';

const workspaceId = 'ws-eval-test';
const CONFIG_HASH = 'b'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-eval-1';

describe('Benchmark Evaluator', () => {
  let wsPath: string;
  let dbPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `eval-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();

    const db = getDb();
    try {
      db.run(
        `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
         VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
        [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
      );
    } catch { /* row may already exist on re-init */ }
    getDb().run(
      `INSERT INTO classification_config_snapshots
         (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  function seedProductRun(sku: string, proposedType: string, proposedPages: string[], isAbstained = false) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();

    if (isAbstained) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'reviewable_abstention', 'null', 0, 'pending', ?)`,
        [randomUUID(), run.id, sku, now]
      );
    } else {
      if (proposedType) {
        db.run(
          `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
           VALUES (?, ?, ?, 'primary_product_type', ?, 0.9, 'accepted', ?)`,
          [randomUUID(), run.id, sku, JSON.stringify(proposedType), now]
        );
        const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?').get(run.id, 'primary_product_type') as { id: string };
        const decisionId = randomUUID();
        db.run(
          `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
           VALUES (?, ?, 'accepted', NULL, 0, ?)`,
          [decisionId, pid.id, now]
        );
      }
      for (const page of proposedPages) {
        db.run(
          `INSERT INTO classification_proposals (id, run_id, product_sku, target_id, proposal_type, proposed_value_json, confidence, status, created_at)
           VALUES (?, ?, ?, ?, 'category_page', ?, 0.8, 'accepted', ?)`,
          [randomUUID(), run.id, sku, page, JSON.stringify(page), now]
        );
        const pagePid = db.query('SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ? AND target_id = ?').get(run.id, 'category_page', page) as { id: string };
        const pageDecisionId = randomUUID();
        db.run(
          `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
           VALUES (?, ?, 'accepted', NULL, 0, ?)`,
          [pageDecisionId, pagePid.id, now]
        );
      }
    }

    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function prepareFrozenDataset(name: string, examples: Array<{ sku: string; family: string; split: 'train' | 'test' | 'holdout'; gold: unknown }>): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, name, 'product_family', 42);
    for (const example of examples) {
      benchmarkRepo.insertExample(
        dataset.id,
        example.sku,
        example.family,
        example.split,
        JSON.stringify({ evidence: [{ snippet: `${example.sku} product` }] }),
        JSON.stringify(example.gold),
      );
    }
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer-1');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer-1');
    return dataset.id;
  }

  it('should evaluate metrics from a frozen dataset + persisted prediction bundle', async () => {
    seedProductRun('SKU-1', 'Dog Food Dry', []);
    seedProductRun('SKU-2', 'Cat Food', []);

    const datasetId = prepareFrozenDataset('Test Dataset', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food Dry', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'SKU-2', family: 'fam-2', split: 'test', gold: { productType: 'Cat Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Predictions', splitGroup: 'test' });
    expect(bundle.predictions.length).toBe(2);

    const { metrics, qualification, predictionBundleId } = await evaluateBenchmark(datasetId, {
      runLabel: 'Test Eval',
      splitGroup: 'test',
      predictionBundleId: bundle.id,
    });

    expect(metrics.productType.top1Accuracy).toBe(1);
    expect(metrics.productType.coverage).toBe(1);
    expect(metrics.safety.crossSpeciesCount).toBe(0);
    expect(metrics.abstention.abstainedPercent).toBe(0);
    expect(predictionBundleId).toBe(bundle.id);
    // Limited population cannot qualify production ML.
    expect(qualification.qualified).toBe(false);
    expect(qualification.reasons.some(r => r.startsWith('insufficient_sample'))).toBe(true);
  });

  it('should detect cross-species violations', async () => {
    // Run predicts a Cat page for a dog product.
    seedProductRun('DOG-1', 'Dog Food', ['Cat Food Dry']);
    seedProductRun('DOG-2', 'Dog Food', []);

    const datasetId = prepareFrozenDataset('Species Test', [
      { sku: 'DOG-1', family: 'fam-dog', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'DOG-2', family: 'fam-dog', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Cross Species', splitGroup: 'test' });
    const { metrics } = await evaluateBenchmark(datasetId, { runLabel: 'Cross Species Eval', splitGroup: 'test', predictionBundleId: bundle.id });

    expect(metrics.safety.crossSpeciesCount).toBeGreaterThan(0);
  });

  it('reports blocked_missing_verified_page_gold when Page gold exists', async () => {
    const datasetId = prepareFrozenDataset('Page Gold Test', [
      {
        sku: 'SKU-P1',
        family: 'fam-p1',
        split: 'test',
        gold: { productType: 'Dog Food', pageAssignments: [{ pageName: 'Dog Food' }], fieldAssignments: [] },
      },
    ]);
    // No reviewed run exists for SKU-P1, so a bundle cannot be built — this
    // demonstrates the fail-closed prediction gate. For the blocked flag, we
    // evaluate a manually persisted bundle instead.
    const predictions = [{
      exampleId: '',
      productSku: 'SKU-P1',
      productType: 'Dog Food',
      pageAssignments: ['Dog Food'],
      fieldAssignments: [],
      abstained: false,
      confidence: 0.9,
      claimTargets: [],
    }];
    const goldExamples = benchmarkRepo.getExamples(datasetId, 'test');
    predictions[0].exampleId = goldExamples[0].id;

    const { computePredictionBundleHash, validatePredictionBundle } = await import('../../classification/benchmark-prediction');
    const bundleHash = computePredictionBundleHash(predictions);
    validatePredictionBundle(predictions, goldExamples.map(e => ({ id: e.id, productSku: e.product_sku })), bundleHash);
    benchmarkRepo.createPredictionBundle(datasetId, workspaceId, 'Manual', 'test', JSON.stringify(predictions), bundleHash);

    const { metrics } = await evaluateBenchmark(datasetId, { runLabel: 'Blocked Eval', splitGroup: 'test' });
    expect(metrics.pages.blocked).toBe(true);
    expect(metrics.pages.blockedReason).toBe('blocked_missing_verified_page_gold');
  });

  it('fails closed when no prediction bundle exists', async () => {
    const datasetId = prepareFrozenDataset('No Bundle', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    await expect(evaluateBenchmark(datasetId, { runLabel: 'Eval', splitGroup: 'test' })).rejects.toThrow(/No prediction bundle found/);
  });

  it('fails closed on a wrong-digest persisted bundle', async () => {
    const datasetId = prepareFrozenDataset('Wrong Digest', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);
    benchmarkRepo.createPredictionBundle(datasetId, workspaceId, 'Bad', 'test', JSON.stringify([{
      exampleId: 'x',
      productSku: 'SKU-1',
      productType: 'Dog Food',
      pageAssignments: [],
      fieldAssignments: [],
      abstained: false,
      confidence: 0.9,
      claimTargets: [],
    }]), 'f'.repeat(64));

    await expect(evaluateBenchmark(datasetId, { runLabel: 'Eval', splitGroup: 'test' })).rejects.toThrow(/digest mismatch/);
  });

  it('produces deterministic paired bootstrap intervals for identical inputs', async () => {
    seedProductRun('SKU-1', 'Dog Food Dry', []);
    seedProductRun('SKU-2', 'Cat Food', []);

    const datasetId = prepareFrozenDataset('Bootstrap Test', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food Dry', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'SKU-2', family: 'fam-2', split: 'test', gold: { productType: 'Cat Food', pageAssignments: [], fieldAssignments: [] } },
    ]);
    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Bootstrap', splitGroup: 'test' });

    const first = await evaluateBenchmark(datasetId, { runLabel: 'Eval A', splitGroup: 'test', predictionBundleId: bundle.id });
    const second = await evaluateBenchmark(datasetId, { runLabel: 'Eval B', splitGroup: 'test', predictionBundleId: bundle.id });

    expect(first.metrics.pairedDelta.deltaLower95).toBe(second.metrics.pairedDelta.deltaLower95);
    expect(first.metrics.pairedDelta.deltaUpper95).toBe(second.metrics.pairedDelta.deltaUpper95);
    expect(first.metrics.pairedDelta.bootstrapRuns).toBeGreaterThan(0);
  });
});
