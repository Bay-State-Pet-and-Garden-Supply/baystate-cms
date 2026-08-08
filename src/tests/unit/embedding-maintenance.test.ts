import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import * as embeddingRepo from '../../db/repositories/embedding-repo';
import {
  runEmbeddingMaintenance,
  computeDesiredEmbeddings,
  planEmbeddingMaintenance,
  loadCurrentIndex,
  EmbeddingPolicyDeniedError,
  EmbeddingMaintenanceLockedError,
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
} from '../../classification/embedding-maintenance';
import { serializeEmbedding } from '../../classification/embedding-client';
import { embeddingDocumentId } from '../../classification/retrieval-index';
import type { ModelPolicyConfigV2, MlFeaturePolicy } from '../../shared/schemas/classification';

const workspaceId = 'ws-embedding-maintenance';
const VEC = () => new Float32Array([1, 0, 0]);

function disabledPolicy(): MlFeaturePolicy {
  return { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null };
}

function policyWith(feature: MlFeaturePolicy): ModelPolicyConfigV2 {
  return {
    defaultProvider: 'ollama',
    defaultModel: 'qwen2.5vl:latest',
    stageOverrides: {},
    imageDataSharing: 'local_only',
    textDataSharing: 'local_only',
    providerLocalities: { ollama: 'local' },
    mlFeatures: {
      productionRetrieval: disabledPolicy(),
      pageReranking: disabledPolicy(),
      confidenceCalibration: disabledPolicy(),
      productionEmbeddings: feature,
    },
  };
}

const evaluationOnlyPolicy = policyWith({ state: 'evaluation_only', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null });
const disabledEmbeddingsPolicy = policyWith(disabledPolicy());

function seedCompletedRun(sku: string, configHash: string | null = 'cfg-hash'): void {
  // config_snapshot_id references classification_config_snapshots(id); a null
  // id with a non-null hash satisfies the FK while keeping the config binding.
  const run = createRun(workspaceId, sku, null, configHash, { sourceKind: 'catalog_product', sourceProductHash: 'src-h' });
  const db = getDb();
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'primary_product_type', '"dog-food-dry"', 0.8, 'accepted', ?)`,
    [run.id, run.id, sku, new Date().toISOString()],
  );
  db.run(
    `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
     VALUES (?, ?, 'accepted', ?, ?)`,
    [run.id, run.id, run.id, new Date().toISOString()],
  );
  completeRun(run.id, 'completed');
  return;
}

function insertRowDirect(
  sku: string,
  model: string,
  vector: Float32Array,
  _extra: Record<string, unknown> = {},
  namespace: 'production' | 'evaluation' = 'production',
): string {
  const db = getDb();
  const id = `row-${sku}-${model}`;
  const now = '2026-01-01T00:00:00.000Z';
  db.run(
    `INSERT INTO product_embeddings (
       id, workspace_id, product_sku, embedding_model, embedding_text, embedding_blob,
       embedding_dim, source_hash, created_at, namespace, provider, schema_version, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, workspaceId, sku, model, `${sku} text`, serializeEmbedding(vector), vector.length, 'legacy-hash', now, namespace, EMBEDDING_PROVIDER, now],
  );
  return id;
}

let wsPath: string;
let dbPath: string;

beforeEach(() => {
  wsPath = path.join(os.tmpdir(), `embedding-maintenance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

afterEach(() => {
  closeDb();
  try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

describe('embedding maintenance — desired-set reconciliation (real maintenance)', () => {
  it('reaches real maintenance: indexes desired products into product_embeddings', async () => {
    seedCompletedRun('SKU-A');
    seedCompletedRun('SKU-B');

    const report = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    });

    expect(report.appliedUpserts).toBe(2);
    const rows = embeddingRepo.getEmbeddingsByNamespace(workspaceId, 'evaluation', EMBEDDING_MODEL);
    expect(rows.map(r => r.product_sku).sort()).toEqual(['SKU-A', 'SKU-B']);
    expect(rows.every(r => r.embedding_dim === 3)).toBe(true);
    expect(rows.every(r => r.schema_version === 1)).toBe(true);
  });

  it('no-ops on the second run when nothing changed', async () => {
    seedCompletedRun('SKU-A');
    const opts = {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation' as const,
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    };
    const first = await runEmbeddingMaintenance(workspaceId, opts);
    expect(first.appliedUpserts).toBe(1);

    const second = await runEmbeddingMaintenance(workspaceId, opts);
    expect(second.appliedUpserts).toBe(0);
    expect(second.plan.noops).toEqual(['SKU-A']);
  });

  it('tombstones stale rows under the grace period and deletes them past it', async () => {
    // A legacy row whose SKU is NOT in the desired set.
    insertRowDirect('SKU-STALE', EMBEDDING_MODEL, VEC(), {}, 'evaluation');
    const recentNow = '2026-01-02T00:00:00.000Z'; // 1 day after the row
    const report = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: recentNow,
    });
    expect(report.appliedTombstones).toBe(1);
    expect(report.appliedDeletes).toBe(0);

    // The stale row is tombstoned (persisted marker), not deleted yet.
    const evalRows = embeddingRepo.getEmbeddingsByNamespace(workspaceId, 'evaluation', EMBEDDING_MODEL);
    expect(evalRows.length).toBe(1);
    expect(evalRows[0].failure_status).toBe('stale_tombstoned');

    const futureNow = '2026-02-02T00:00:00.000Z'; // past the 7-day grace
    const report2 = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: futureNow,
    });
    expect(report2.appliedDeletes).toBe(1);
    expect(embeddingRepo.getEmbeddingsByNamespace(workspaceId, 'evaluation', EMBEDDING_MODEL).length).toBe(0);
  });

  it('deletes wrong-model rows that are not in the desired set', async () => {
    insertRowDirect('SKU-WRONG', 'other-model', VEC(), {}, 'evaluation');
    const report = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    });
    expect(report.plan.deletions).toContain('SKU-WRONG');
    expect(report.appliedDeletes).toBe(1);
  });

  it('upserts the correct model for a desired SKU that had a wrong-model row', async () => {
    seedCompletedRun('SKU-A');
    insertRowDirect('SKU-A', 'other-model', VEC(), {}, 'evaluation');
    const report = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    });
    expect(report.appliedUpserts).toBe(1);
    const rows = embeddingRepo.getEmbeddingsByNamespace(workspaceId, 'evaluation', EMBEDDING_MODEL);
    expect(rows.map(r => r.product_sku)).toContain('SKU-A');
  });

  it('marks corrupt vectors as errors and never indexes them', async () => {
    seedCompletedRun('SKU-CORRUPT');
    // Corrupt blob: NaN bytes.
    const db = getDb();
    db.run(
      `INSERT INTO product_embeddings (
         id, workspace_id, product_sku, embedding_model, embedding_text, embedding_blob,
         embedding_dim, source_hash, created_at, namespace, provider, schema_version, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'evaluation', ?, 1, ?)`,
      ['row-corrupt', workspaceId, 'SKU-CORRUPT', EMBEDDING_MODEL, 'x', Buffer.from(new Float32Array([NaN]).buffer), 1, 'h', '2026-01-01T00:00:00.000Z', EMBEDDING_PROVIDER, '2026-01-01T00:00:00.000Z'],
    );

    const report = await runEmbeddingMaintenance(workspaceId, {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation',
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    });
    expect(report.errors.some(e => e.includes('corrupt_vector'))).toBe(true);
    // The desired upsert replaces the corrupt row with a valid vector, so the
    // final persisted row is healthy (the corruption was surfaced, not reused).
    const row = embeddingRepo.getEmbedding(workspaceId, 'SKU-CORRUPT', EMBEDDING_MODEL, 'evaluation');
    expect(row).not.toBeNull();
    expect(row?.embedding_dim).toBe(3);
    expect(row?.failure_status).toBeNull();
    expect(report.appliedUpserts).toBe(1);
  });

  it('bounds work in resumable batches', async () => {
    seedCompletedRun('SKU-1');
    seedCompletedRun('SKU-2');
    seedCompletedRun('SKU-3');
    const base = {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation' as const,
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    };
    const first = await runEmbeddingMaintenance(workspaceId, { ...base, batchSize: 1 });
    expect(first.processedCount).toBe(1);
    expect(first.hasMore).toBe(true);

    const second = await runEmbeddingMaintenance(workspaceId, { ...base, batchSize: 1, cursor: first.plan.upserts[0] });
    expect(second.processedCount).toBe(1);
    expect(second.hasMore).toBe(true);

    const third = await runEmbeddingMaintenance(workspaceId, { ...base, batchSize: 1, cursor: second.plan.upserts[0] });
    expect(third.processedCount).toBe(1);
    expect(third.hasMore).toBe(false);
    expect(embeddingRepo.getEmbeddingsByNamespace(workspaceId, 'evaluation', EMBEDDING_MODEL).length).toBe(3);
  });

  it('serializes concurrent runs under one maintenance lock', async () => {
    seedCompletedRun('SKU-A');
    const opts = {
      modelPolicy: evaluationOnlyPolicy,
      evaluationRequestToken: 'eval-token',
      namespace: 'evaluation' as const,
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    };
    const first = runEmbeddingMaintenance(workspaceId, opts);
    await expect(runEmbeddingMaintenance(workspaceId, opts)).rejects.toThrow(EmbeddingMaintenanceLockedError);
    await first;
  });
});

describe('embedding maintenance — policy gates (fail closed)', () => {
  it('denies production maintenance without a model policy', async () => {
    seedCompletedRun('SKU-A');
    await expect(runEmbeddingMaintenance(workspaceId, { namespace: 'production', embed: async () => VEC() }))
      .rejects.toThrow(EmbeddingPolicyDeniedError);
  });

  it('denies production maintenance when productionEmbeddings is disabled', async () => {
    seedCompletedRun('SKU-A');
    await expect(runEmbeddingMaintenance(workspaceId, {
      namespace: 'production',
      modelPolicy: disabledEmbeddingsPolicy,
      embed: async () => VEC(),
    })).rejects.toThrow(EmbeddingPolicyDeniedError);
  });

  it('denies evaluation maintenance without an explicit request token', async () => {
    await expect(runEmbeddingMaintenance(workspaceId, {
      namespace: 'evaluation',
      modelPolicy: evaluationOnlyPolicy,
      embed: async () => VEC(),
    })).rejects.toThrow(/evaluationRequestToken/);
  });

  it('denies evaluation maintenance without a feature policy', async () => {
    await expect(runEmbeddingMaintenance(workspaceId, {
      namespace: 'evaluation',
      evaluationRequestToken: 'token',
      embed: async () => VEC(),
    })).rejects.toThrow(EmbeddingPolicyDeniedError);
  });

  it('permits evaluation maintenance with an explicit token and evaluation-only policy', async () => {
    seedCompletedRun('SKU-EVAL');
    const report = await runEmbeddingMaintenance(workspaceId, {
      namespace: 'evaluation',
      evaluationRequestToken: 'eval-token',
      modelPolicy: evaluationOnlyPolicy,
      embed: async () => VEC(),
      now: '2026-02-01T00:00:00.000Z',
    });
    expect(report.appliedUpserts).toBe(1);
  });
});

describe('embedding maintenance — pure helpers', () => {
  it('computeDesiredEmbeddings derives the desired set from accepted decisions', () => {
    seedCompletedRun('SKU-A');
    seedCompletedRun('SKU-B');
    const desired = computeDesiredEmbeddings(workspaceId, 'evaluation');
    expect(desired.map(d => d.sku).sort()).toEqual(['SKU-A', 'SKU-B']);
    expect(desired.every(d => d.configHash === 'cfg-hash')).toBe(true);
    expect(desired.every(d => d.decisionRunId !== null)).toBe(true);
  });

  it('loadCurrentIndex surfaces corrupt rows as failures without dropping the map', () => {
    insertRowDirect('SKU-X', EMBEDDING_MODEL, VEC(), {}, 'evaluation');
    const { entries, errors } = loadCurrentIndex(workspaceId, 'evaluation', EMBEDDING_MODEL, EMBEDDING_PROVIDER, '2026-02-01T00:00:00.000Z');
    expect(entries.has(embeddingDocumentId(workspaceId, 'SKU-X', 'evaluation', EMBEDDING_MODEL))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('planEmbeddingMaintenance classifies no-op/upsert/stale deterministically', () => {
    const id = embeddingDocumentId(workspaceId, 'SKU-KEEP', 'evaluation', EMBEDDING_MODEL);
    const current = new Map([
      [id, {
        id,
        workspaceId,
        sku: 'SKU-KEEP',
        namespace: 'evaluation' as const,
        model: EMBEDDING_MODEL,
        provider: EMBEDDING_PROVIDER,
        dimension: 3,
        schemaVersion: 1,
        vector: VEC(),
        text: 'SKU-KEEP | ',
        sourceHash: 'same',
        configHash: 'cfg',
        decisionRunId: 'r1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        failureStatus: null,
      }],
    ]);
    const desired = [{
      workspaceId,
      sku: 'SKU-KEEP',
      model: EMBEDDING_MODEL,
      provider: EMBEDDING_PROVIDER,
      namespace: 'evaluation' as const,
      text: 'SKU-KEEP | ',
      sourceHash: 'same',
      configHash: 'cfg',
      decisionRunId: 'r1',
    }];
    const plan = planEmbeddingMaintenance(current, desired, '2026-01-02T00:00:00.000Z');
    expect(plan.noops).toEqual(['SKU-KEEP']);
    expect(plan.upserts).toEqual([]);
    expect(plan.stale).toEqual([]);
  });
});
