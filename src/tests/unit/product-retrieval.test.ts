import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import * as embeddingRepo from '../../db/repositories/embedding-repo';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import {
  findSimilarApprovedProducts,
  assertProductionRetrievalAllowed,
  RetrievalPolicyDisabledError,
  buildBenchmarkRetrievalIndexFromDataset,
  searchBenchmarkRetrievalIndex,
} from '../../classification/product-retrieval';
import { benchmarkEmbeddingDocumentId } from '../../classification/retrieval-index';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

const workspaceId = 'ws-retrieval-test';

function disabledFeature() {
  return { state: 'disabled' as const, qualificationReceiptDigest: null, activatedBy: null, activatedAt: null };
}

function enabledFeaturePolicy(): ModelPolicyConfigV2 {
  return {
    defaultProvider: 'ollama',
    defaultModel: 'qwen2.5vl:latest',
    stageOverrides: {},
    imageDataSharing: 'local_only',
    textDataSharing: 'local_only',
    providerLocalities: { ollama: 'local' },
    mlFeatures: {
      productionRetrieval: {
        state: 'enabled',
        qualificationReceiptDigest: 'abc123',
        activatedBy: 'reviewer',
        activatedAt: '2026-01-01T00:00:00.000Z',
      },
      pageReranking: disabledFeature(),
      confidenceCalibration: disabledFeature(),
      productionEmbeddings: disabledFeature(),
    },
  };
}

function disabledRetrievalPolicy(): ModelPolicyConfigV2 {
  const p = enabledFeaturePolicy();
  p.mlFeatures.productionRetrieval = disabledFeature();
  return p;
}

let wsPath: string;
let dbPath: string;

beforeEach(() => {
  wsPath = path.join(os.tmpdir(), `retrieval-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'Test WS',
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

describe('Product Retrieval', () => {
  it('should find similar products based on vector similarity', async () => {
    // Seed embeddings
    const vecQuery = new Float32Array([1.0, 0.0, 0.0]);
    const vecClose = new Float32Array([0.9, 0.1, 0.0]);
    const vecFar = new Float32Array([0.0, 1.0, 0.0]);

    embeddingRepo.upsertEmbedding(
      workspaceId,
      'SKU-CLOSE',
      'nomic-embed-text',
      'Purina Pro Plan Dog Food',
      vecClose,
      'hash1'
    );

    embeddingRepo.upsertEmbedding(
      workspaceId,
      'SKU-FAR',
      'nomic-embed-text',
      'Cat Scratching Post',
      vecFar,
      'hash2'
    );

    const matches = await findSimilarApprovedProducts(
      workspaceId,
      'Purina Dog Food',
      vecQuery,
      {
        minSimilarity: 0.5,
        topK: 5,
        model: 'nomic-embed-text',
        modelPolicy: enabledFeaturePolicy(),
        featurePolicyOptions: { verifiedReceiptDigests: new Set(['abc123']) },
      }
    );

    expect(matches.length).toBe(1);
    expect(matches[0].sku).toBe('SKU-CLOSE');
    expect(matches[0].similarity).toBeGreaterThan(0.8);
  });

  it('should exclude specified SKUs from results', async () => {
    const vecQuery = new Float32Array([1.0, 0.0, 0.0]);
    const vecSimilar = new Float32Array([0.95, 0.05, 0.0]);

    embeddingRepo.upsertEmbedding(
      workspaceId,
      'SKU-SELF',
      'nomic-embed-text',
      'Query Product',
      vecSimilar,
      'hash1'
    );

    const matches = await findSimilarApprovedProducts(
      workspaceId,
      'Query Product',
      vecQuery,
      {
        excludeSkus: ['SKU-SELF'],
        model: 'nomic-embed-text',
        modelPolicy: enabledFeaturePolicy(),
        featurePolicyOptions: { verifiedReceiptDigests: new Set(['abc123']) },
      }
    );

    expect(matches.length).toBe(0);
  });
});

describe('Product Retrieval — production policy gate (fail closed)', () => {
  it('assertProductionRetrievalAllowed throws without a model policy', () => {
    expect(() => assertProductionRetrievalAllowed(null)).toThrow(RetrievalPolicyDisabledError);
    expect(() => assertProductionRetrievalAllowed(undefined)).toThrow(/requires a model policy/);
  });

  it('assertProductionRetrievalAllowed throws when the feature is disabled', () => {
    expect(() => assertProductionRetrievalAllowed(disabledRetrievalPolicy())).toThrow(RetrievalPolicyDisabledError);
  });

  it('assertProductionRetrievalAllowed passes when enabled with receipt + activation audit', () => {
    const verified = new Set(['abc123']);
    expect(() => assertProductionRetrievalAllowed(enabledFeaturePolicy(), { verifiedReceiptDigests: verified })).not.toThrow();
  });

  it('assertProductionRetrievalAllowed throws when the receipt is not verified', () => {
    expect(() => assertProductionRetrievalAllowed(enabledFeaturePolicy(), { verifiedReceiptDigests: new Set() }))
      .toThrow(/not independently verified/);
  });
});

describe('Product Retrieval — benchmark index leakage prevention', () => {
  it('builds a train-only index from a frozen dataset and excludes holdout', async () => {
    const datasetId = benchmarkRepo.createDataset(workspaceId, 'leak-test', 'product_family', 42).id;
    const embed = async (text: string) => {
      if (text.includes('holdout')) return new Float32Array([0, 0, 1]);
      if (text.includes('same-family')) return new Float32Array([0.99, 0.01, 0]);
      return new Float32Array([0.95, 0.05, 0]);
    };

    benchmarkRepo.insertExample(datasetId, 'SKU-TRAIN-1', 'fam-train', 'train',
      JSON.stringify({ evidence: [{ source: 'official_product_page', snippet: 'Purina Dog Food Kibble', reliability: 'high', attributeId: null }] }),
      JSON.stringify({ productType: 'dog-food-dry', pageAssignments: [], fieldAssignments: [] }),
      { sourceRunId: 'r1', sourceConfigHash: 'c1', sourceProductHash: 'p1' });
    benchmarkRepo.insertExample(datasetId, 'SKU-TRAIN-2', 'fam-other', 'train',
      JSON.stringify({ evidence: [{ source: 'official_product_page', snippet: 'Cat Litter Scoop', reliability: 'high', attributeId: null }] }),
      JSON.stringify({ productType: 'cat-litter', pageAssignments: [], fieldAssignments: [] }),
      { sourceRunId: 'r2', sourceConfigHash: 'c1', sourceProductHash: 'p2' });
    // Holdout example: must never enter the index.
    benchmarkRepo.insertExample(datasetId, 'SKU-HOLDOUT', 'fam-holdout', 'holdout',
      JSON.stringify({ evidence: [{ source: 'official_product_page', snippet: 'holdout secret species', reliability: 'high', attributeId: null }] }),
      JSON.stringify({ productType: 'bird-food', pageAssignments: [], fieldAssignments: [] }),
      { sourceRunId: 'r3', sourceConfigHash: 'c1', sourceProductHash: 'p3' });

    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');

    const result = await buildBenchmarkRetrievalIndexFromDataset(workspaceId, datasetId, { embed, expectedDimension: 3 });
    expect(result.builtFrom).toHaveLength(2);
    // No holdout example id in the index.
    const holdoutExamples = benchmarkRepo.getExamples(datasetId, 'holdout');
    for (const ex of holdoutExamples) {
      expect(result.index.has(benchmarkEmbeddingDocumentId(workspaceId, datasetId, ex.id))).toBe(false);
    }

    // Search excludes the query's own SKU and family (same-family leakage).
    const hits = await searchBenchmarkRetrievalIndex(result.index, 'dog food kibble', {
      sku: 'SKU-TRAIN-1',
      familyId: 'fam-train',
    }, { embed, topK: 10, minSimilarity: 0 });
    expect(hits.map(h => h.sku)).toEqual(['SKU-TRAIN-2']);
  });
});
