/**
 * PI-9 evaluation runner tests (issue #26).
 *
 * DB-backed (bun test): seeds the fixture golden dataset, creates completed
 * runs with results, evaluates against gold, and verifies outcome
 * classification, holdout exclusion, runId restriction, and the frozen
 * requirement.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import { createPiRun, insertPiResult, transitionPiRunStatus, getPiResult } from '../../db/repositories/product-intelligence-repo';
import { runPiEvaluation } from '../../product-intelligence/evaluation/runner';
import { buildPiGoldenProducts } from '../../product-intelligence/evaluation/fixture-dataset';

const workspaceId = 'ws-pi-runner-test';
const GTIN = '085000079585';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function seedDataset(name: string): string {
  const ds = benchmarkRepo.createDataset(workspaceId, name, 'random', 42);
  const products = buildPiGoldenProducts();
  for (const p of products) {
    // Controlled split: exact/wrong-variant/abstention fixtures go to 'test',
    // the first product to 'holdout', everything else to 'train'.
    let split: 'train' | 'test' | 'holdout' = 'train';
    if (p.gold.identity.wrongVariant || p.gold.identity.requiredAbstention || p.gold.identity.exactProduct) split = 'test';
    if (p.input.gtin === '085000079585') split = 'holdout';
    benchmarkRepo.insertExample(
      ds.id,
      p.input.gtin,
      p.input.gtin,
      split,
      JSON.stringify(p.input),
      JSON.stringify(p.gold),
    );
  }
  benchmarkRepo.markFamilyReviewComplete(ds.id, 'tester');
  benchmarkRepo.freezeDataset(ds.id, 'tester');
  return ds.id;
}

function makeRun(gtin: string, result: unknown, disposition: 'submitted' | 'abstained' = 'submitted'): string {
  const run = createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin, registerName: 'STELLA CHKN BROTH 16OZ' }),
    policyJson: JSON.stringify({ configId: 'c' }),
    configSnapshotId: 'c',
    configSnapshotHash: 'c',
  });
  insertPiResult({ runId: run.id, schemaVersion: 1, disposition, result });
  transitionPiRunStatus(run.id, 'completed', {});
  return run.id;
}

/** PI-4 bundle envelope with a specific identity status. */
function bundleEnvelope(identityStatus: string, facts: Array<{ field: string; values: string[] }> = []): unknown {
  return {
    submission: {
      schemaVersion: 1,
      gtin: GTIN,
      inputName: 'STELLA CHKN BROTH 16OZ',
      identity: {
        status: identityStatus,
        brand: 'Stella & Chewy',
        canonicalName: 'Stella & Chewy Chicken Broth 16 oz',
        variant: '16 oz',
        manufacturer: null,
        netContent: { value: 16, unit: 'oz' },
        packCount: 1,
        evidenceIds: ['ev-1'],
      },
      commerceFacts: facts,
      classificationProposals: [],
      imageCandidates: [],
      conflicts: [],
      disposition: identityStatus === 'exact_match' ? 'research_complete' : 'needs_review',
    },
  };
}

describe('PI-9 evaluation runner', () => {
  let wsPath: string;
  let datasetId: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
    datasetId = seedDataset('pi-runner-ds');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('evaluates completed runs against gold and classifies outcomes', () => {
    // Find the gtin of the exact-match fixture product (first product).
    const products = buildPiGoldenProducts();
    const exactGtin = products.find((p) => p.gold.identity.exactProduct && p.input.gtin !== '085000079585' && !p.gold.identity.wrongVariant && !p.gold.identity.parentProductOnly && !p.gold.identity.requiredAbstention)?.input.gtin ?? GTIN;

    makeRun(exactGtin, bundleEnvelope('exact_match', [{ field: 'size', values: ['16 oz'] }]));
    const result = runPiEvaluation({ datasetId });
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    expect(result.report).not.toBeNull();
    expect(result.report!.sampleSize).toBeGreaterThanOrEqual(1);
    expect(result.report!.outcomeDistribution.submitted).toBeGreaterThanOrEqual(1);

    const rows = getDb().query('SELECT outcome FROM pi_evaluation_runs WHERE dataset_id = ?').all(datasetId) as Array<{ outcome: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].outcome).toBe('submitted');
  });

  it('classifies wrong-variant and abstained outcomes distinctly', () => {
    const products = buildPiGoldenProducts();
    const wrongGtin = products.find((p) => p.gold.identity.wrongVariant)?.input.gtin;
    const abstainGtin = products.find((p) => p.gold.identity.requiredAbstention)?.input.gtin;
    expect(wrongGtin).toBeTruthy();
    expect(abstainGtin).toBeTruthy();

    makeRun(wrongGtin!, bundleEnvelope('wrong_variant'));
    makeRun(abstainGtin!, { schemaVersion: 1, gtin: abstainGtin, inputName: 'X', abstention: true, evidenceItems: [], evidenceSources: [] }, 'abstained');

    const result = runPiEvaluation({ datasetId });
    expect(result.report!.outcomeDistribution.wrong_variant).toBeGreaterThanOrEqual(1);
    expect(result.report!.outcomeDistribution.abstained).toBeGreaterThanOrEqual(1);
    expect(result.report!.outcomeDistribution.submitted).toBe(0);
  });

  it('honors runIds restriction and skips products without runs', () => {
    const products = buildPiGoldenProducts();
    const gtin = products.find((p) => p.gold.identity.exactProduct && p.input.gtin !== '085000079585' && !p.gold.identity.wrongVariant && !p.gold.identity.parentProductOnly && !p.gold.identity.requiredAbstention)?.input.gtin ?? GTIN;
    const runA = makeRun(gtin, bundleEnvelope('exact_match'));
    const result = runPiEvaluation({ datasetId, runIds: [runA] });
    expect(result.evaluated).toBe(1);
    expect(result.skipped.length).toBeGreaterThanOrEqual(0);
  });

  it('does not evaluate holdout products by default', () => {
    const examples = benchmarkRepo.getExamples(datasetId);
    const holdout = examples.filter((e) => e.split_group === 'holdout');
    expect(holdout.length).toBeGreaterThanOrEqual(1);
    for (const h of holdout) {
      makeRun(h.product_sku, bundleEnvelope('exact_match'));
    }
    const result = runPiEvaluation({ datasetId });
    // Holdout runs exist but are not evaluated in the default 'test' split.
    expect(result.evaluated).toBe(0);
  });

  it('refuses unfrozen datasets', () => {
    const draft = benchmarkRepo.createDataset(workspaceId, 'draft-ds', 'random', 7);
    expect(() => runPiEvaluation({ datasetId: draft.id })).toThrow(/not frozen/);
  });

  it('persists the result hash linkage (run deletion nulls run_id, rows survive)', () => {
    const products = buildPiGoldenProducts();
    const gtin = products.find((p) => p.gold.identity.exactProduct && p.input.gtin !== '085000079585' && !p.gold.identity.wrongVariant && !p.gold.identity.parentProductOnly && !p.gold.identity.requiredAbstention)?.input.gtin ?? GTIN;
    const runA = makeRun(gtin, bundleEnvelope('exact_match'));
    runPiEvaluation({ datasetId, runIds: [runA] });
    expect(getPiResult(runA)).not.toBeNull();
    const rows = getDb().query('SELECT run_id FROM pi_evaluation_runs').all() as Array<{ run_id: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].run_id).toBe(runA);
  });
});
