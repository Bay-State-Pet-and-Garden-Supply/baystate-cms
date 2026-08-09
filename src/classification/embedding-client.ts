/**
 * Local embedding client using Ollama API + Float32Array vector utilities.
 *
 * The client is testable through an injectable fetch implementation; tests
 * mock HTTP and never perform live model requests. Document building is
 * deterministic: the document hash binds the stable identity fields
 * (version, schema version, namespace, SKU, text, source/config/decision
 * hashes, model, provider) and never the wall-clock timestamp.
 */

import { sha256Hex } from '../shared/stable-id';

export const EMBEDDING_DOCUMENT_VERSION = 2;
const EMBEDDING_DOCUMENT_SCHEMA_VERSION = 1;
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_EMBEDDING_PROVIDER = 'ollama';

export type EmbeddingNamespace = 'production' | 'evaluation';

export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseError';
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function deserializeEmbedding(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) {
    view[i] = buf[i];
  }
  return new Float32Array(ab);
}

export interface EmbeddingRequestOptions {
  model?: string;
  baseUrl?: string;
  /** Injectable fetch implementation for mocked-HTTP tests. */
  fetchImpl?: typeof fetch;
}

export interface EmbeddingResponseShape {
  embeddings?: number[][];
}

/** Validate a raw embedding response: non-empty and every value finite. */
export function validateEmbeddingResponse(embeddings: number[][] | undefined): Float32Array {
  if (!embeddings || !Array.isArray(embeddings) || embeddings.length === 0 || !Array.isArray(embeddings[0])) {
    throw new EmbeddingResponseError('Embedding call returned an empty or malformed response.');
  }
  const first = embeddings[0];
  if (first.length === 0) {
    throw new EmbeddingResponseError('Embedding call returned a zero-dimension vector.');
  }
  const out = new Float32Array(first.length);
  for (let i = 0; i < first.length; i++) {
    const value = first[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EmbeddingResponseError(`Embedding response contains a non-finite value at index ${i}.`);
    }
    out[i] = value;
  }
  return out;
}

export async function generateEmbedding(
  text: string,
  options?: EmbeddingRequestOptions,
): Promise<Float32Array> {
  const baseUrl = options?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = options?.model || DEFAULT_EMBEDDING_MODEL;
  const doFetch = options?.fetchImpl ?? globalThis.fetch;

  const res = await doFetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    throw new EmbeddingResponseError(`Ollama embedding call failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as EmbeddingResponseShape;
  return validateEmbeddingResponse(json.embeddings);
}

/**
 * Canonical embedding call returning the vector plus the document schema
 * version. All production consumers use this entry point; tests inject a
 * mocked fetch implementation and never contact a live model.
 */
export async function fetchEmbedding(
  text: string,
  options?: { model?: string; provider?: string; baseUrl?: string; fetch?: typeof fetch },
): Promise<{ vector: Float32Array; schemaVersion: number; model: string; provider: string }> {
  const model = options?.model || DEFAULT_EMBEDDING_MODEL;
  const provider = options?.provider || DEFAULT_EMBEDDING_PROVIDER;
  const vector = await generateEmbedding(text, {
    model,
    baseUrl: options?.baseUrl,
    fetchImpl: options?.fetch,
  });
  return { vector, schemaVersion: EMBEDDING_DOCUMENT_SCHEMA_VERSION, model, provider };
}

// ─── Versioned canonical embedding documents ──────────────────────────────────

export interface EmbeddingDocumentInput {
  sku: string;
  text: string;
  sourceHash: string;
  configHash: string | null;
  decisionHash: string | null;
  model: string;
  provider: string;
  namespace: EmbeddingNamespace;
  runId?: string | null;
}

export interface EmbeddingDocument {
  version: number;
  schemaVersion: number;
  id: string;
  sku: string;
  text: string;
  sourceHash: string;
  configHash: string | null;
  decisionHash: string | null;
  model: string;
  provider: string;
  namespace: EmbeddingNamespace;
  runId: string | null;
  documentHash: string;
}

/** Canonical text used for both the embedding request and the document hash. */
export function canonicalEmbeddingText(input: {
  sku: string;
  name: string;
  brand?: string;
  textParts?: string[];
}): string {
  const name = input.name || input.sku;
  const brand = input.brand ?? '';
  const parts = (input.textParts ?? []).slice(0, 5);
  return `${name} | ${brand} | ${parts.join(' ')}`.trim();
}

/**
 * Stable identity for a document: version + schema + namespace + sku + model.
 * Two documents for the same product/model/namespace always share an id.
 */
export function computeEmbeddingDocumentId(input: EmbeddingDocumentInput): string {
  const payload = {
    version: EMBEDDING_DOCUMENT_VERSION,
    schemaVersion: EMBEDDING_DOCUMENT_SCHEMA_VERSION,
    namespace: input.namespace,
    sku: input.sku,
    model: input.model,
  };
  return sha256Hex(JSON.stringify(payload));
}

/**
 * Content hash of a document's stable fields. Timestamps and the document id
 * itself are excluded so identical semantic inputs hash identically.
 */
export function computeEmbeddingDocumentHash(input: EmbeddingDocumentInput): string {
  const payload = {
    version: EMBEDDING_DOCUMENT_VERSION,
    schemaVersion: EMBEDDING_DOCUMENT_SCHEMA_VERSION,
    namespace: input.namespace,
    sku: input.sku,
    text: input.text,
    sourceHash: input.sourceHash,
    configHash: input.configHash,
    decisionHash: input.decisionHash,
    model: input.model,
    provider: input.provider,
    runId: input.runId ?? null,
  };
  return sha256Hex(JSON.stringify(payload));
}

export function buildEmbeddingDocument(input: EmbeddingDocumentInput): EmbeddingDocument {
  return {
    version: EMBEDDING_DOCUMENT_VERSION,
    schemaVersion: EMBEDDING_DOCUMENT_SCHEMA_VERSION,
    id: computeEmbeddingDocumentId(input),
    sku: input.sku,
    text: input.text,
    sourceHash: input.sourceHash,
    configHash: input.configHash,
    decisionHash: input.decisionHash,
    model: input.model,
    provider: input.provider,
    namespace: input.namespace,
    runId: input.runId ?? null,
    documentHash: computeEmbeddingDocumentHash(input),
  };
}
