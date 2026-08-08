import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';

const workspaceId = 'ws-lifecycle-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()]
  );
}

describe('Benchmark dataset lifecycle', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  function draftDataset(name = 'Draft'): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, name, 'product_family', 42);
    benchmarkRepo.insertExample(dataset.id, 'SKU-1', 'fam-1', 'test', '{}', JSON.stringify({ productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] }));
    benchmarkRepo.insertExample(dataset.id, 'SKU-2', 'fam-2', 'holdout', '{}', JSON.stringify({ productType: 'Cat Food', pageAssignments: [], fieldAssignments: [] }));
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    return dataset.id;
  }

  it('starts in draft and transitions to frozen after family review', () => {
    const datasetId = draftDataset();

    const before = benchmarkRepo.getDataset(datasetId)!;
    expect(before.status).toBe('draft');
    expect(before.dataset_hash).toBeNull();

    // Freeze without family review must be refused.
    expect(() => benchmarkRepo.freezeDataset(datasetId, 'reviewer')).toThrow(/family grouping/i);

    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer-1');
    const frozen = benchmarkRepo.freezeDataset(datasetId, 'reviewer-1');
    expect(frozen.status).toBe('frozen');
    expect(frozen.dataset_hash).toBeTruthy();
    expect(frozen.frozen_at).toBeTruthy();

    // Double-freeze refused.
    expect(() => benchmarkRepo.freezeDataset(datasetId, 'reviewer')).toThrow(/already frozen/i);
  });

  it('freeze is content-addressed: same examples → same dataset hash', () => {
    const a = draftDataset();
    const b = draftDataset();
    benchmarkRepo.markFamilyReviewComplete(a, 'reviewer');
    benchmarkRepo.markFamilyReviewComplete(b, 'reviewer');
    const hashA = benchmarkRepo.freezeDataset(a, 'reviewer').dataset_hash;
    const hashB = benchmarkRepo.freezeDataset(b, 'reviewer').dataset_hash;
    expect(hashA).toBe(hashB);
  });

  it('frozen examples cannot be modified or deleted', () => {
    const datasetId = draftDataset();
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');

    const examples = benchmarkRepo.getExamples(datasetId);
    const exampleId = examples[0].id;

    expect(() => benchmarkRepo.insertExample(datasetId, 'SKU-3', 'fam-3', 'test', '{}', '{}')).toThrow(/immutable/);
    expect(() => benchmarkRepo.updateExampleGoldLabels(datasetId, exampleId, '{}')).toThrow(/immutable/);
    expect(() => benchmarkRepo.deleteExample(datasetId, exampleId)).toThrow(/immutable/);
  });

  it('retires a frozen dataset', () => {
    const datasetId = draftDataset();
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');
    const retired = benchmarkRepo.retireDataset(datasetId);
    expect(retired.status).toBe('retired');
    expect(retired.retired_at).toBeTruthy();
  });

  it('refuses to retire a non-frozen dataset', () => {
    const datasetId = draftDataset();
    // A draft cannot be retired directly (must pass family review + freeze first).
    expect(() => benchmarkRepo.retireDataset(datasetId)).toThrow(/frozen/i);
    // A re-retired (already retired) dataset is also refused.
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');
    benchmarkRepo.retireDataset(datasetId);
    expect(() => benchmarkRepo.retireDataset(datasetId)).toThrow(/frozen/i);
  });

  it('enforces workspace ownership on dataset lookup', () => {
    const datasetId = draftDataset();
    // Another workspace must not see it.
    expect(benchmarkRepo.getDatasetForWorkspace(datasetId, 'other-ws')).toBeNull();
    expect(benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId)).not.toBeNull();
    // listDatasets is scoped.
    expect(benchmarkRepo.listDatasets('other-ws')).toEqual([]);
    expect(benchmarkRepo.listDatasets(workspaceId).length).toBe(1);
  });

  it('prediction bundles require a frozen dataset', () => {
    const datasetId = draftDataset();
    expect(() => benchmarkRepo.createPredictionBundle(datasetId, workspaceId, 'r', 'test', '[]', '0'.repeat(64)))
      .toThrow(/require a frozen dataset/i);
  });
});
