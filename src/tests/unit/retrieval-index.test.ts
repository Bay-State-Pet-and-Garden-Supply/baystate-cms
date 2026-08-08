import { describe, expect, it } from 'vitest';
import {
  InMemoryRetrievalIndex,
  RetrievalIndexValidationError,
  VectorValidationError,
  assertFiniteVector,
  assertValidEmbeddingVector,
  embeddingDocumentId,
  benchmarkEmbeddingDocumentId,
  buildBenchmarkRetrievalIndex,
  buildIndexFromEntries,
  vectorEntryFromRow,
} from '../../classification/retrieval-index';
import type { VectorEntry, BenchmarkIndexExample } from '../../classification/retrieval-index';

function entry(overrides: Partial<VectorEntry> = {}): VectorEntry {
  return {
    id: 'e1',
    workspaceId: 'ws',
    sku: 'SKU-1',
    namespace: 'production',
    model: 'nomic-embed-text',
    provider: 'ollama',
    dimension: 3,
    schemaVersion: 1,
    vector: new Float32Array([1, 0, 0]),
    text: 'Dog Food',
    sourceHash: 'h1',
    configHash: null,
    decisionRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureStatus: null,
    ...overrides,
  };
}

describe('InMemoryRetrievalIndex', () => {
  it('returns exact cosine hits sorted by similarity', () => {
    const index = new InMemoryRetrievalIndex();
    index.upsert(entry({ id: 'a', sku: 'SKU-A', vector: new Float32Array([0.9, 0.1, 0]) }));
    index.upsert(entry({ id: 'b', sku: 'SKU-B', vector: new Float32Array([0.1, 0.9, 0]) }));
    const hits = index.search(new Float32Array([1, 0, 0]), { topK: 2, minSimilarity: 0 });
    expect(hits.map(h => h.entry.sku)).toEqual(['SKU-A', 'SKU-B']);
    expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
  });

  it('excludes ids, skus, and families at search time', () => {
    const index = new InMemoryRetrievalIndex();
    index.upsert(entry({ id: 'self', sku: 'QUERY-SKU', familyId: 'fam-query', vector: new Float32Array([0.99, 0.01, 0]) }));
    index.upsert(entry({ id: 'fam', sku: 'SKU-FAM', familyId: 'fam-query', vector: new Float32Array([0.98, 0.02, 0]) }));
    index.upsert(entry({ id: 'other', sku: 'SKU-OTHER', familyId: 'fam-other', vector: new Float32Array([0.95, 0.05, 0]) }));
    const hits = index.search(new Float32Array([1, 0, 0]), {
      topK: 10,
      minSimilarity: 0,
      excludeSkus: ['QUERY-SKU'],
      excludeFamilies: ['fam-query'],
    });
    expect(hits.map(h => h.entry.sku)).toEqual(['SKU-OTHER']);
  });

  it('treats corrupt (non-finite) vectors as errors at upsert', () => {
    const index = new InMemoryRetrievalIndex();
    const bad = entry({ vector: new Float32Array([1, NaN, 0]) });
    expect(() => index.upsert(bad)).toThrow(RetrievalIndexValidationError);
    expect(index.size()).toBe(0);
  });

  it('treats wrong-dimension vectors as errors, never zero similarity', () => {
    const index = new InMemoryRetrievalIndex(3);
    expect(() => index.upsert(entry({ vector: new Float32Array([1, 0]) }))).toThrow(/dimension mismatch/i);
    index.upsert(entry({ vector: new Float32Array([1, 0, 0]) }));
    // Query with a mismatched dimension must throw, not return zero hits.
    expect(() => index.search(new Float32Array([1, 0]), {})).toThrow(/dimension mismatch/i);
  });

  it('rejects an empty vector', () => {
    const index = new InMemoryRetrievalIndex();
    expect(() => index.upsert(entry({ vector: new Float32Array(0) }))).toThrow(/empty/i);
  });

  it('supports remove/has/ids/size', () => {
    const index = buildIndexFromEntries([entry({ id: 'x' }), entry({ id: 'y', sku: 'SKU-Y' })]);
    expect(index.size()).toBe(2);
    expect(index.has('x')).toBe(true);
    expect(index.ids().sort()).toEqual(['x', 'y']);
    expect(index.remove('x')).toBe(true);
    expect(index.size()).toBe(1);
  });
});

describe('validation helpers', () => {
  it('assertFiniteVector rejects NaN/Infinity and empty arrays', () => {
    expect(() => assertFiniteVector(new Float32Array([1, NaN]), 'v')).toThrow(/non-finite/);
    expect(() => assertFiniteVector(new Float32Array([1, Infinity]), 'v')).toThrow(/non-finite/);
    expect(() => assertFiniteVector(new Float32Array(0), 'v')).toThrow(/empty/);
    expect(() => assertFiniteVector(new Float32Array([1, 2]))).not.toThrow();
  });

  it('assertValidEmbeddingVector enforces an expected dimension', () => {
    expect(() => assertValidEmbeddingVector(new Float32Array([1, 2]), 3)).toThrow(/dimension mismatch/);
    expect(() => assertValidEmbeddingVector(new Float32Array([1, 2, 3]), 3)).not.toThrow();
  });

  it('VectorValidationError is an alias of RetrievalIndexValidationError', () => {
    expect(VectorValidationError).toBe(RetrievalIndexValidationError);
  });
});

describe('stable ids', () => {
  it('embeddingDocumentId is deterministic and namespace/model-sensitive', () => {
    expect(embeddingDocumentId('ws', 'SKU-1')).toBe(embeddingDocumentId('ws', 'SKU-1'));
    expect(embeddingDocumentId('ws', 'SKU-1')).not.toBe(embeddingDocumentId('ws', 'SKU-2'));
    expect(embeddingDocumentId('ws', 'SKU-1', 'evaluation')).not.toBe(embeddingDocumentId('ws', 'SKU-1', 'production'));
  });

  it('benchmarkEmbeddingDocumentId is deterministic per example', () => {
    expect(benchmarkEmbeddingDocumentId('ws', 'ds', 'ex')).toBe(benchmarkEmbeddingDocumentId('ws', 'ds', 'ex'));
    expect(benchmarkEmbeddingDocumentId('ws', 'ds', 'ex')).not.toBe(benchmarkEmbeddingDocumentId('ws', 'ds', 'ex2'));
  });
});

describe('benchmark retrieval index (train-only, leakage-free)', () => {
  function benchExample(overrides: Partial<BenchmarkIndexExample> = {}): BenchmarkIndexExample {
    return {
      id: 'ex1',
      workspaceId: 'ws',
      datasetId: 'ds',
      sku: 'SKU-1',
      familyId: 'family-1',
      text: 'dog food kibble',
      vector: new Float32Array([1, 0, 0]),
      productType: 'dog-food-dry',
      ...overrides,
    };
  }

  it('builds an index from train examples only (holdout never enters)', () => {
    const train = [
      benchExample({ id: 'train-1', sku: 'SKU-A', familyId: 'fam-a' }),
      benchExample({ id: 'train-2', sku: 'SKU-B', familyId: 'fam-b', vector: new Float32Array([0.8, 0.2, 0]) }),
    ];
    const result = buildBenchmarkRetrievalIndex(train, { expectedDimension: 3 });
    expect(result.builtFrom).toEqual(['train-1', 'train-2']);
    // A holdout example is simply never passed in — nothing can leak.
    const holdout = benchExample({ id: 'holdout-1', sku: 'SKU-H', familyId: 'fam-h', productType: 'cat-litter' });
    expect(result.index.has(benchmarkEmbeddingDocumentId('ws', 'ds', holdout.id))).toBe(false);
    expect(result.index.ids()).toHaveLength(2);
    expect(result.families).toEqual(['fam-a', 'fam-b']);
  });

  it('search excludes the query SKU and family (no same-family leakage)', () => {
    const index = buildBenchmarkRetrievalIndex([
      benchExample({ id: 'a', sku: 'SKU-A', familyId: 'fam-q', vector: new Float32Array([0.99, 0.01, 0]) }),
      benchExample({ id: 'b', sku: 'SKU-B', familyId: 'fam-q', vector: new Float32Array([0.97, 0.03, 0]) }),
      benchExample({ id: 'c', sku: 'SKU-C', familyId: 'fam-other', vector: new Float32Array([0.95, 0.05, 0]) }),
    ], { expectedDimension: 3 }).index;

    const hits = index.search(new Float32Array([1, 0, 0]), {
      topK: 10,
      minSimilarity: 0,
      excludeSkus: ['SKU-A'],
      excludeFamilies: ['fam-q'],
    });
    expect(hits.map(h => h.entry.sku)).toEqual(['SKU-C']);
  });

  it('rejects a wrong-dimension benchmark example', () => {
    expect(() => buildBenchmarkRetrievalIndex([
      benchExample({ vector: new Float32Array([1, 0]) }),
    ], { expectedDimension: 3 })).toThrow(/dimension mismatch/i);
  });
});

describe('vectorEntryFromRow', () => {
  it('maps legacy and v2 column names with nullish fallbacks', () => {
    const entry = vectorEntryFromRow({
      id: 'row-1',
      workspace_id: 'ws',
      product_sku: 'SKU-1',
      namespace: 'evaluation',
      embedding_model: 'm',
      provider: 'ollama',
      embedding_dim: 3,
      schema_version: 1,
      vector: new Float32Array([1, 2, 3]),
      embedding_text: 'text',
      source_hash: 'h',
      source_config_hash: null,
      decision_run_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(entry.namespace).toBe('evaluation');
    expect(entry.configHash).toBeNull();
    expect(entry.decisionRunId).toBeNull();
    expect(entry.failureStatus).toBeNull();
    expect(entry.updatedAt).toBe(entry.createdAt);
  });
});
