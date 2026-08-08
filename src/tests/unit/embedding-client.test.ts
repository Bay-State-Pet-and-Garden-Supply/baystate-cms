import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  generateEmbedding,
  fetchEmbedding,
  validateEmbeddingResponse,
  EmbeddingResponseError,
  buildEmbeddingDocument,
  computeEmbeddingDocumentHash,
  computeEmbeddingDocumentId,
  canonicalEmbeddingText,
  EMBEDDING_DOCUMENT_VERSION,
} from '../../classification/embedding-client';
import type { EmbeddingDocumentInput } from '../../classification/embedding-client';

function mockFetchOk(embeddings: number[][]): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ embeddings }), { status: 200 })) as unknown as typeof fetch;
}

function docInput(overrides: Partial<EmbeddingDocumentInput> = {}): EmbeddingDocumentInput {
  return {
    sku: 'SKU-1',
    text: 'Purina Pro Plan Dog Food',
    sourceHash: 'source-hash-1',
    configHash: 'config-hash-1',
    decisionHash: 'decision-hash-1',
    model: 'nomic-embed-text',
    provider: 'ollama',
    namespace: 'production',
    runId: 'run-1',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Embedding Client — vector utilities', () => {
  it('should compute cosine similarity for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('should compute cosine similarity for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should compute cosine similarity for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should return 0 for mismatched vector lengths', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should serialize and deserialize Float32Array losslessly', () => {
    const original = new Float32Array([0.123456, -0.987654, 3.14159]);
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 6);
    }
  });
});

describe('Embedding Client — mocked HTTP (no live calls)', () => {
  it('generateEmbedding uses the injected fetch and never the network', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 }));
    const fetchImpl = mock as unknown as typeof fetch;
    const vector = await generateEmbedding('dog food', {
      model: 'm',
      baseUrl: 'http://mock.invalid',
      fetchImpl,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(url)).toContain('mock.invalid/api/embed');
    expect(init.method).toBe('POST');
    expect(vector).toEqual(new Float32Array([0.1, 0.2, 0.3]));
  });

  it('fetchEmbedding returns the vector plus schema version', async () => {
    const fetchImpl = mockFetchOk([[1, 0, 0]]);
    const result = await fetchEmbedding('text', { model: 'm', provider: 'ollama', fetch: fetchImpl });
    expect(result.vector).toEqual(new Float32Array([1, 0, 0]));
    expect(result.schemaVersion).toBe(1);
    expect(result.model).toBe('m');
  });

  it('rejects an HTTP error response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(generateEmbedding('x', { baseUrl: 'http://mock.invalid', fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('rejects a malformed or empty embeddings payload', async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ embeddings: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(generateEmbedding('x', { baseUrl: 'http://mock.invalid', fetchImpl: empty })).rejects.toThrow(EmbeddingResponseError);
    const missing = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(generateEmbedding('x', { baseUrl: 'http://mock.invalid', fetchImpl: missing })).rejects.toThrow(EmbeddingResponseError);
  });

  it('rejects non-finite values in the embedding response', () => {
    expect(() => validateEmbeddingResponse([[1, NaN]])).toThrow(EmbeddingResponseError);
    expect(() => validateEmbeddingResponse([[1, Infinity]])).toThrow(EmbeddingResponseError);
    expect(() => validateEmbeddingResponse([[1]])).not.toThrow();
  });
});

describe('Embedding Client — versioned canonical documents', () => {
  it('buildEmbeddingDocument binds stable fields and is deterministic', () => {
    const a = buildEmbeddingDocument(docInput());
    const b = buildEmbeddingDocument(docInput());
    expect(a.documentHash).toBe(b.documentHash);
    expect(a.id).toBe(b.id);
    expect(a.version).toBe(EMBEDDING_DOCUMENT_VERSION);
    expect(a.schemaVersion).toBe(1);
    expect(a.namespace).toBe('production');
  });

  it('document hash is sensitive to source/config/decision provenance', () => {
    const base = computeEmbeddingDocumentHash(docInput());
    expect(computeEmbeddingDocumentHash(docInput({ sourceHash: 'different' }))).not.toBe(base);
    expect(computeEmbeddingDocumentHash(docInput({ configHash: 'different' }))).not.toBe(base);
    expect(computeEmbeddingDocumentHash(docInput({ decisionHash: 'different' }))).not.toBe(base);
    expect(computeEmbeddingDocumentHash(docInput({ namespace: 'evaluation' }))).not.toBe(base);
  });

  it('document id is stable across identical semantic inputs', () => {
    expect(computeEmbeddingDocumentId(docInput())).toBe(computeEmbeddingDocumentId(docInput()));
    expect(computeEmbeddingDocumentId(docInput({ namespace: 'evaluation' }))).not.toBe(
      computeEmbeddingDocumentId(docInput({ namespace: 'production' })),
    );
  });

  it('canonicalEmbeddingText normalizes name/brand/parts', () => {
    expect(canonicalEmbeddingText({ sku: 'SKU', name: 'Dog Food', brand: 'Purina', textParts: ['a', 'b'] }))
      .toBe('Dog Food | Purina | a b');
    expect(canonicalEmbeddingText({ sku: 'SKU', name: '' })).toBe('SKU |  |');
  });
});
