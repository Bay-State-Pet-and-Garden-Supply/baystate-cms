/**
 * Retrieval Index — replaceable vector-index interface.
 *
 * Exact cosine search is isolated behind this interface. Finite-value and
 * dimension validation happen at the boundary, so corrupt or wrong-dimension
 * vectors are ERRORS — never zero-similarity results. The index is a pure
 * in-memory structure; persistence and maintenance live in the embedding
 * repository and maintenance service.
 */

import { sha256Hex } from '../shared/stable-id';
import { cosineSimilarity } from './embedding-client';


const EMBEDDING_SCHEMA_VERSION = 1;

export type EmbeddingNamespace = 'production' | 'evaluation';

/** One vector entry in the index (also the persisted row's in-memory shape). */
export interface VectorEntry {
  /** Stable identity (index key). */
  id: string;
  workspaceId: string;
  sku: string;
  namespace: EmbeddingNamespace;
  model: string;
  provider: string;
  dimension: number;
  schemaVersion: number;
  vector: Float32Array;
  text: string;
  sourceHash: string;
  configHash: string | null;
  decisionRunId: string | null;
  createdAt: string;
  updatedAt: string;
  failureStatus: string | null;
  /** Benchmark family id — leakage prevention at search time. */
  familyId?: string | null;
}

export type RetrievalIndexRecord = VectorEntry;

export interface RetrievalSearchOptions {
  topK?: number;
  minSimilarity?: number;
  excludeIds?: ReadonlySet<string> | string[];
  excludeSkus?: ReadonlySet<string> | string[];
  excludeFamilies?: ReadonlySet<string> | string[];
}

export interface RetrievalIndex {
  upsert(record: VectorEntry): void;
  remove(id: string): boolean;
  search(query: Float32Array, options?: RetrievalSearchOptions): Array<{ entry: VectorEntry; similarity: number }>;
  size(): number;
  has(id: string): boolean;
  ids(): string[];
}

export class RetrievalIndexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalIndexValidationError';
  }
}

/** Backward-compatible alias used by earlier M10 drafts. */
export const VectorValidationError = RetrievalIndexValidationError;

/**
 * Validate a vector: non-finite values, empty vectors, and (when an expected
 * dimension is known) dimension mismatches are hard errors — never silently
 * mapped to zero similarity.
 */
export function assertFiniteVector(vector: Float32Array, label?: string): void {
  if (!(vector instanceof Float32Array)) {
    throw new RetrievalIndexValidationError(`${label ?? 'vector'} is not a Float32Array.`);
  }
  if (vector.length === 0) {
    throw new RetrievalIndexValidationError(`${label ?? 'vector'} is empty.`);
  }
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new RetrievalIndexValidationError(`${label ?? 'vector'} contains a non-finite value at index ${i}.`);
    }
  }
}

/** Alias of assertFiniteVector with an expected-dimension check. */
export function assertValidEmbeddingVector(vector: Float32Array, expectedDimension?: number): void {
  assertFiniteVector(vector, 'embedding vector');
  if (expectedDimension !== undefined && vector.length !== expectedDimension) {
    throw new RetrievalIndexValidationError(
      `Embedding dimension mismatch: expected ${expectedDimension}, got ${vector.length}.`,
    );
  }
}

/** Stable index key for a product's vector entry. */
export function embeddingDocumentId(
  workspaceId: string,
  sku: string,
  namespace?: EmbeddingNamespace,
  model?: string,
): string {
  const payload = {
    namespace: namespace ?? 'production',
    sku,
    model: model ?? '',
    workspaceId,
  };
  return sha256Hex(JSON.stringify(payload));
}

/** Build an in-memory VectorEntry from a persisted row. */
export function vectorEntryFromRow(
  row: {
    id: string;
    workspace_id: string;
    product_sku: string;
    namespace?: string;
    embedding_model: string;
    provider?: string;
    embedding_dim: number;
    schema_version?: number;
    vector: Float32Array;
    embedding_text: string;
    source_hash: string;
    source_config_hash?: string | null;
    config_hash?: string | null;
    decision_run_id?: string | null;
    run_id?: string | null;
    created_at: string;
    updated_at?: string;
    failure_status?: string | null;
  },
  providerFallback = 'ollama',
): VectorEntry {
  return {
    id: embeddingDocumentId(row.workspace_id, row.product_sku, (row.namespace ?? 'production') as EmbeddingNamespace, row.embedding_model),
    workspaceId: row.workspace_id,
    sku: row.product_sku,
    namespace: (row.namespace ?? 'production') as EmbeddingNamespace,
    model: row.embedding_model,
    provider: row.provider ?? providerFallback,
    dimension: row.embedding_dim,
    schemaVersion: row.schema_version ?? 1,
    vector: row.vector,
    text: row.embedding_text,
    sourceHash: row.source_hash,
    configHash: row.source_config_hash ?? row.config_hash ?? null,
    decisionRunId: row.decision_run_id ?? row.run_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    failureStatus: row.failure_status ?? null,
  };
}

/**
 * Exact cosine index over a Map of stable-id → entry. Search is O(n) exact
 * cosine; the query vector must match the index dimension (when fixed).
 */
export class InMemoryRetrievalIndex implements RetrievalIndex {
  private records = new Map<string, VectorEntry>();
  private readonly expectedDimension?: number;

  constructor(expectedDimension?: number) {
    this.expectedDimension = expectedDimension;
  }

  upsert(record: VectorEntry): void {
    assertFiniteVector(record.vector, `entry ${record.sku}`);
    if (this.expectedDimension !== undefined && record.vector.length !== this.expectedDimension) {
      throw new RetrievalIndexValidationError(
        `Embedding dimension mismatch: expected ${this.expectedDimension}, got ${record.vector.length}.`,
      );
    }
    if (this.expectedDimension === undefined && this.records.size > 0) {
      const first = this.records.values().next().value as VectorEntry | undefined;
      if (first && first.vector.length !== record.vector.length) {
        throw new RetrievalIndexValidationError(
          `Embedding dimension mismatch: index holds ${first.vector.length}, got ${record.vector.length}.`,
        );
      }
    }
    this.records.set(record.id, { ...record });
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  size(): number {
    return this.records.size;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  ids(): string[] {
    return Array.from(this.records.keys());
  }

  search(
    query: Float32Array,
    options: RetrievalSearchOptions = {},
  ): Array<{ entry: VectorEntry; similarity: number }> {
    const topK = options.topK ?? 10;
    const minSimilarity = options.minSimilarity ?? 0;
    const excludeIds = new Set(options.excludeIds ?? []);
    const excludeSkus = new Set(options.excludeSkus ?? []);
    const excludeFamilies = new Set(options.excludeFamilies ?? []);

    if (this.records.size > 0) {
      const first = this.records.values().next().value as VectorEntry;
      assertValidEmbeddingVector(query, this.expectedDimension ?? first.vector.length);
    } else {
      assertFiniteVector(query, 'query vector');
    }

    const scored: Array<{ entry: VectorEntry; similarity: number }> = [];
    for (const record of this.records.values()) {
      if (excludeIds.has(record.id)) continue;
      if (record.sku && excludeSkus.has(record.sku)) continue;
      if (record.familyId && excludeFamilies.has(record.familyId)) continue;
      const sim = cosineSimilarity(query, record.vector);
      if (sim >= minSimilarity) scored.push({ entry: record, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
}

/** Build an InMemoryRetrievalIndex from entries, validating every vector. */
export function buildIndexFromEntries(
  entries: VectorEntry[],
  expectedDimension?: number,
): InMemoryRetrievalIndex {
  const index = new InMemoryRetrievalIndex(expectedDimension);
  for (const entry of entries) {
    index.upsert(entry);
  }
  return index;
}

// ─── Benchmark retrieval index (train-only, leakage-free) ─────────────────────

export interface RetrievalHit {
  entry: VectorEntry;
  similarity: number;
}

/** One train-example document candidate for a benchmark index. */
export interface BenchmarkIndexExample {
  id: string;
  workspaceId: string;
  datasetId: string;
  sku: string;
  familyId: string | null;
  text: string;
  vector: Float32Array;
  /** Train-split gold label (never a holdout label). */
  productType: string | null;
}

export interface BuildBenchmarkIndexOptions {
  expectedDimension?: number;
}

export interface BenchmarkIndexBuildResult {
  index: InMemoryRetrievalIndex;
  /** Example ids that were indexed (train split only). */
  builtFrom: string[];
  /** Families present in the index (used for query exclusion). */
  families: string[];
}

/** Stable index key for a benchmark example entry. */
export function benchmarkEmbeddingDocumentId(
  workspaceId: string,
  datasetId: string,
  exampleId: string,
): string {
  return sha256Hex(JSON.stringify({ workspaceId, datasetId, exampleId }));
}

/**
 * Build a benchmark retrieval index from train-split examples only. The
 * caller is responsible for passing only train examples — holdout/test
 * examples and their labels never enter the index, so they cannot leak at
 * search time. Every entry carries its family id so a search can exclude the
 * query's own family (and SKU) to prevent same-family leakage.
 */
export function buildBenchmarkRetrievalIndex(
  examples: BenchmarkIndexExample[],
  options: BuildBenchmarkIndexOptions = {},
): BenchmarkIndexBuildResult {
  const index = new InMemoryRetrievalIndex(options.expectedDimension);
  const builtFrom: string[] = [];
  const families = new Set<string>();
  for (const example of examples) {
    assertFiniteVector(example.vector, `benchmark example ${example.id}`);
    if (options.expectedDimension !== undefined && example.vector.length !== options.expectedDimension) {
      throw new RetrievalIndexValidationError(
        `Benchmark example ${example.id} dimension mismatch: expected ${options.expectedDimension}, got ${example.vector.length}.`,
      );
    }
    const entry: VectorEntry = {
      id: benchmarkEmbeddingDocumentId(example.workspaceId, example.datasetId, example.id),
      workspaceId: example.workspaceId,
      sku: example.sku,
      namespace: 'evaluation',
      model: '',
      provider: '',
      dimension: example.vector.length,
      schemaVersion: EMBEDDING_SCHEMA_VERSION,
      vector: example.vector,
      text: example.text,
      sourceHash: '',
      configHash: null,
      decisionRunId: null,
      createdAt: '',
      updatedAt: '',
      failureStatus: null,
      familyId: example.familyId,
    };
    index.upsert(entry);
    builtFrom.push(example.id);
    if (example.familyId) families.add(example.familyId);
  }
  return { index, builtFrom, families: Array.from(families).sort() };
}
