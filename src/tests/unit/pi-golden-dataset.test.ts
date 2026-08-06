/**
 * PI-9 golden dataset tests (issue #26).
 *
 * DB-backed (bun test): seeds the built-in PI fixture set into the #14
 * benchmark tables, verifies the freeze/holdout/hash lifecycle, and pins
 * content-addressed versioning (identical examples => identical dataset hash).
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
import {
  buildPiGoldenProducts,
  PI_GOLDEN_DATASET_NAME,
  PI_GOLDEN_DATASET_VERSION,
} from '../../product-intelligence/evaluation/fixture-dataset';
import { PiDifficultyTagSchema } from '../../product-intelligence/evaluation/gold';

const workspaceId = 'ws-pi-golden-test';

/** Mirrors the #14 deterministic FNV-1a family split (not exported). */
function splitForFamily(
  familyId: string,
  splitSeed: number,
  holdoutPercent: number,
): 'train' | 'test' | 'holdout' {
  let hash = 0x811c9dc5;
  const input = `${familyId}:${splitSeed}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const score = (hash >>> 0) % 100;
  if (score < holdoutPercent) return 'holdout';
  if (score < holdoutPercent * 2) return 'test';
  return 'train';
}

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

describe('PI golden dataset (fixture)', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-golden-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function seedDataset(name: string): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, name, 'product_family', 42);
    for (const product of buildPiGoldenProducts()) {
      benchmarkRepo.insertExample(
        dataset.id,
        product.input.gtin,
        product.input.gtin,
        splitForFamily(product.input.gtin, 42, 20),
        JSON.stringify(product.input),
        JSON.stringify(product.gold),
      );
    }
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    return dataset.id;
  }

  it('covers all 16 difficulty tags with one product each', () => {
    const products = buildPiGoldenProducts();
    const tags = new Set<string>();
    for (const product of products) {
      for (const tag of product.gold.difficultyTags) tags.add(tag);
    }
    expect(tags.size).toBe(PiDifficultyTagSchema.options.length);
    for (const option of PiDifficultyTagSchema.options) {
      expect(tags.has(option), `missing difficulty tag ${option}`).toBe(true);
    }
    expect(products).toHaveLength(16);
  });

  it('seeds a draft dataset and freezes it after family review', () => {
    const datasetId = seedDataset('pi-golden-v1');
    const before = benchmarkRepo.getDataset(datasetId)!;
    expect(before.status).toBe('draft');
    expect(before.total_examples).toBe(16);

    expect(() => benchmarkRepo.freezeDataset(datasetId, 'reviewer')).toThrow(/family grouping/i);
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer-1');
    const frozen = benchmarkRepo.freezeDataset(datasetId, 'reviewer-1');
    expect(frozen.status).toBe('frozen');
    expect(frozen.dataset_hash).toBeTruthy();
  });

  it('assigns holdout and test splits deterministically', () => {
    const datasetId = seedDataset('pi-golden-v1');
    const examples = benchmarkRepo.getExamples(datasetId);
    const splits = examples.map((e) => e.split_group);
    expect(splits.some((s) => s === 'holdout')).toBe(true);
    expect(splits.some((s) => s === 'test')).toBe(true);
    // Determinism: same family + seed -> same split.
    const first = examples[0];
    expect(first.split_group).toBe(splitForFamily(first.product_sku, 42, 20));
  });

  it('is content-addressed: identical examples produce the same dataset hash', () => {
    const a = seedDataset('pi-golden-v1');
    const b = seedDataset('pi-golden-v1-dup');
    benchmarkRepo.markFamilyReviewComplete(a, 'r');
    benchmarkRepo.markFamilyReviewComplete(b, 'r');
    const frozenA = benchmarkRepo.freezeDataset(a, 'r');
    const frozenB = benchmarkRepo.freezeDataset(b, 'r');
    expect(frozenA.dataset_hash).toBeTruthy();
    expect(frozenB.dataset_hash).toBe(frozenA.dataset_hash);
    // Frozen datasets are immutable.
    expect(() =>
      benchmarkRepo.insertExample(a, 'SKU-X', 'fam-x', 'test', '{}', '{}'),
    ).toThrow(/immutable/i);
  });

  it('exposes the version constants and parses gold labels back', () => {
    expect(PI_GOLDEN_DATASET_NAME).toBe('pi-golden-v1');
    expect(PI_GOLDEN_DATASET_VERSION).toBe('v1');
    const datasetId = seedDataset(PI_GOLDEN_DATASET_NAME);
    const example = benchmarkRepo.getExamples(datasetId)[0];
    const gold = JSON.parse(example.gold_labels_json) as { identity?: { exactProduct?: boolean } };
    expect(typeof gold.identity?.exactProduct).toBe('boolean');
  });
});
