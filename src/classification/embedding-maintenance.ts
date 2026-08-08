/**
 * Embedding Maintenance Service
 *
 * Desired-set maintenance: computes the set of products that SHOULD have an
 * embedding (accepted decisions on completed runs bound to a config snapshot)
 * and reconciles the current index against it:
 *   - no-op:     row exists and source/config/model fingerprint are unchanged;
 *   - upsert:    row missing or its source hash / config binding changed;
 *   - stale:     row exists but the product is no longer in the desired set;
 *   - tombstone: stale rows older than the grace period;
 *   - delete:    tombstoned rows (and wrong-model rows that are being replaced).
 *
 * One in-process maintenance lock per workspace; bounded resumable batches;
 * corrupt vectors and wrong-model fingerprints are handled explicitly.
 *
 * Evaluation-namespace maintenance is permitted only with an explicit request
 * AND a feature policy that allows evaluation scope. Production-namespace
 * maintenance requires the production feature to be enabled (which the
 * approved Bay State configuration keeps disabled — fail closed).
 */

import { getDb } from '../db/connection';
import * as embeddingRepo from '../db/repositories/embedding-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import { fetchEmbedding } from './embedding-client';
import {
  InMemoryRetrievalIndex,
  VectorValidationError,
  assertFiniteVector,
  embeddingDocumentId,
  type VectorEntry,
  type EmbeddingNamespace,
} from './retrieval-index';
import { evaluateFeaturePolicy, type FeaturePolicyOptions } from './feature-policy';
import type { ModelPolicyConfigV2, MlFeatureId } from '../shared/schemas/classification';
import { sha256Hex, canonicalJsonStringify } from '../shared/stable-id';

export const EMBEDDING_MODEL = 'nomic-embed-text';
export const EMBEDDING_PROVIDER = 'ollama';
export const DEFAULT_BATCH_SIZE = 50;
const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class EmbeddingMaintenanceLockedError extends Error {
  constructor(workspaceId: string) {
    super(`Embedding maintenance is already running for workspace ${workspaceId}.`);
    this.name = 'EmbeddingMaintenanceLockedError';
  }
}

export class EmbeddingPolicyDeniedError extends Error {
  readonly code = 'embedding_policy_denied';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'EmbeddingPolicyDeniedError';
    this.reason = reason;
  }
}

/** One product's desired embedding document (before vector generation). */
export interface DesiredEmbedding {
  workspaceId: string;
  sku: string;
  model: string;
  provider: string;
  namespace: EmbeddingNamespace;
  text: string;
  sourceHash: string;
  configHash: string | null;
  decisionRunId: string | null;
}

export interface MaintenancePlan {
  noops: string[];
  upserts: string[];
  stale: string[];
  tombstones: string[];
  deletions: string[];
}

export interface MaintenanceReport {
  namespace: EmbeddingNamespace;
  lockAcquired: boolean;
  plan: MaintenancePlan;
  appliedUpserts: number;
  appliedTombstones: number;
  appliedDeletes: number;
  processedCount: number;
  batch: number;
  hasMore: boolean;
  errors: string[];
}

interface MaintenanceOptions {
  namespace?: EmbeddingNamespace;
  model?: string;
  provider?: string;
  batchSize?: number;
  cursor?: string;
  now?: string;
  /** Deterministic embedding function (mocked in tests; no live calls). */
  embed?: (text: string) => Promise<Float32Array>;
  /** Explicit evaluation request token; required for evaluation namespace. */
  evaluationRequestToken?: string;
  modelPolicy?: ModelPolicyConfigV2 | null;
  featurePolicyOptions?: FeaturePolicyOptions;
}
export type { MaintenanceOptions };

export type { ModelPolicyConfigV2, FeaturePolicyOptions };

// One in-process lock per workspace so maintenance cannot run concurrently.
const maintenanceLocks = new Set<string>();

/**
 * Build the desired embedding set from accepted decisions on completed runs
 * that are bound to a config snapshot (so source/config provenance is known).
 */
export function computeDesiredEmbeddings(workspaceId: string, namespace: EmbeddingNamespace): DesiredEmbedding[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT DISTINCT r.product_sku, r.config_snapshot_id, r.config_snapshot_hash
       FROM classification_runs r
       JOIN classification_proposals p ON p.run_id = r.id
       JOIN classification_proposal_decisions d ON d.proposal_id = p.id
       WHERE r.workspace_id = ?
         AND r.status IN ('completed', 'completed_with_abstentions')
         AND d.superseded_at IS NULL
         AND d.decision = 'accepted'`,
    )
    .all(workspaceId) as Array<{ product_sku: string; config_snapshot_id: string | null; config_snapshot_hash: string | null }>;

  const desired: DesiredEmbedding[] = [];
  for (const row of rows) {
    const run = classRunRepo.getRecentRun(workspaceId, row.product_sku);
    const decisionRunId = run?.id ?? null;
    const text = buildDesiredEmbeddingText(workspaceId, row.product_sku);
    if (!text) continue;
    const model = EMBEDDING_MODEL;
    const provider = EMBEDDING_PROVIDER;
    desired.push({
      workspaceId,
      sku: row.product_sku,
      model,
      provider,
      namespace,
      text,
      sourceHash: sha256Hex(canonicalJsonStringify({ text })),
      configHash: row.config_snapshot_hash ?? null,
      decisionRunId,
    });
  }
  return desired.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Canonical embedding text from the most recent evidence for a product. */
export function buildDesiredEmbeddingText(workspaceId: string, sku: string): string {
  const run = classRunRepo.getRecentRun(workspaceId, sku);
  if (!run) return '';
  const evidence = classRunRepo.getEvidenceByRun(run.id);
  let name = sku;
  const textParts: string[] = [];
  for (const ev of evidence) {
    if (ev.sourceField === 'product_name' && ev.snippet) name = ev.snippet;
    if (ev.snippet) textParts.push(ev.snippet);
  }
  return `${name} | ${textParts.slice(0, 5).join(' ')}`;
}

/** Load current index entries (validated; corrupt vectors are surfaced). */
export function loadCurrentIndex(
  workspaceId: string,
  namespace: EmbeddingNamespace,
  model: string,
  provider: string,
  now: string,
): { entries: Map<string, VectorEntry>; errors: string[] } {
  const entries = new Map<string, VectorEntry>();
  const errors: string[] = [];
  // Load ALL rows in the namespace (any model) so wrong-model rows are
  // visible to the planner and are never silently reused or left behind.
  const rows = embeddingRepo.listNamespaceRows(workspaceId, namespace);
  for (const row of rows) {
    const id = embeddingDocumentId(row.workspace_id, row.product_sku, namespace, row.embedding_model);
    let vector: Float32Array;
    let corrupt: string | null = null;
    try {
      vector = embeddingRepo.deserializeEmbedding(row.embedding_blob);
      assertFiniteVector(vector, `stored embedding ${row.product_sku}`);
    } catch (err) {
      corrupt = err instanceof Error ? err.message : String(err);
      vector = new Float32Array(0);
    }
    const failureStatus = corrupt ? 'corrupt_vector' : null;
    if (corrupt) {
      embeddingRepo.markEmbeddingFailure(row.id, 'corrupt_vector', now);
      errors.push(`SKU ${row.product_sku}: corrupt_vector: ${corrupt}`);
    }
    entries.set(id, {
      id,
      workspaceId: row.workspace_id,
      sku: row.product_sku,
      namespace: (row.namespace ?? 'production') as EmbeddingNamespace,
      model: row.embedding_model,
      provider: row.provider ?? 'ollama',
      dimension: row.embedding_dim,
      schemaVersion: row.schema_version ?? 1,
      vector,
      text: row.embedding_text,
      sourceHash: row.source_hash,
      configHash: row.source_config_hash ?? row.config_hash ?? null,
      decisionRunId: row.decision_run_id ?? row.run_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      failureStatus,
    });
  }
  return { entries, errors };
}

/**
 * Diff the desired set against the current index into a maintenance plan.
 * Wrong-model rows (fingerprint mismatch against the target model/provider)
 * are treated as stale and deleted before the desired upsert, so they are
 * never silently reused.
 */
export function planEmbeddingMaintenance(
  current: Map<string, VectorEntry>,
  desired: DesiredEmbedding[],
  now: string,
  target?: { model: string; provider: string },
): MaintenancePlan {
  const plan: MaintenancePlan = { noops: [], upserts: [], stale: [], tombstones: [], deletions: [] };
  const targetModel = target?.model ?? EMBEDDING_MODEL;
  const targetProvider = target?.provider ?? EMBEDDING_PROVIDER;
  const desiredIds = new Set<string>();

  for (const d of desired) {
    const id = embeddingDocumentId(d.workspaceId, d.sku, d.namespace, d.model);
    desiredIds.add(id);
    const existing = current.get(id);
    if (!existing) {
      plan.upserts.push(d.sku);
      continue;
    }
    if (existing.failureStatus === 'corrupt_vector') {
      plan.upserts.push(d.sku);
      continue;
    }
    const fingerprintMatches = existing.model === d.model && existing.provider === d.provider;
    const contentMatches = existing.sourceHash === d.sourceHash && existing.configHash === d.configHash;
    if (fingerprintMatches && contentMatches) {
      plan.noops.push(d.sku);
    } else {
      plan.upserts.push(d.sku);
    }
  }

  for (const [id, entry] of current) {
    if (desiredIds.has(id)) continue;
    const isWrongModel = entry.model !== targetModel || entry.provider !== targetProvider;
    const ageMs = now.length > 0 ? Math.max(0, Date.parse(now) - Date.parse(entry.updatedAt)) : 0;
    if (isWrongModel || ageMs >= TOMBSTONE_GRACE_MS) {
      plan.deletions.push(entry.sku);
    } else {
      plan.tombstones.push(entry.sku);
      plan.stale.push(entry.sku);
    }
  }

  return plan;
}

/**
 * Apply a maintenance plan in bounded batches. Returns a report plus the
 * cursor (last processed SKU) so callers can resume on the next invocation.
 */
export async function applyMaintenancePlan(
  workspaceId: string,
  namespace: EmbeddingNamespace,
  plan: MaintenancePlan,
  desired: DesiredEmbedding[],
  current: Map<string, VectorEntry>,
  options: Required<Pick<MaintenanceOptions, 'embed'>> & { batchSize?: number; cursor?: string; now?: string },
): Promise<{ report: MaintenanceReport; cursor: string | null }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const now = options.now ?? new Date().toISOString();
  const errors: string[] = [];

  // Deletes first (wrong-model/stale cleanup never blocks desired upserts).
  let appliedDeletes = 0;
  let appliedTombstones = 0;
  if (!options.cursor) {
    const namespaceRows = embeddingRepo.listNamespaceRows(workspaceId, namespace);
    for (const sku of plan.tombstones) {
      for (const row of namespaceRows.filter(r => r.product_sku === sku)) {
        // Persisted tombstone marker; a later run past the grace period
        // moves the row into deletions.
        embeddingRepo.markEmbeddingFailure(row.id, 'stale_tombstoned', now);
        appliedTombstones++;
      }
    }
    for (const sku of plan.deletions) {
      for (const row of namespaceRows.filter(r => r.product_sku === sku)) {
        embeddingRepo.removeEmbedding(row.id);
        appliedDeletes++;
      }
    }
  }

  // Upserts (bounded, resumable by cursor over the sorted desired set).
  const upsertDesired = plan.upserts.map(sku => desired.find(d => d.sku === sku)).filter((d): d is DesiredEmbedding => Boolean(d));
  let appliedUpserts = 0;
  let processedCount = 0;
  let hasMore = false;
  let cursor: string | null = null;
  const startIndex = options.cursor ? upsertDesired.findIndex(d => d.sku >= (options.cursor as string)) : 0;
  const begin = startIndex < 0 ? 0 : startIndex;

  for (let i = begin; i < upsertDesired.length; i++) {
    if (processedCount >= batchSize) {
      hasMore = i < upsertDesired.length;
      cursor = upsertDesired[i].sku;
      break;
    }
    const d = upsertDesired[i];
    processedCount++;
    try {
      const response = await options.embed(d.text);
      assertFiniteVector(response, `embedding for ${d.sku}`);
      const vector = response as Float32Array;
      embeddingRepo.upsertEmbeddingV2({
        workspaceId,
        productSku: d.sku,
        model: d.model,
        provider: d.provider,
        text: d.text,
        embedding: vector,
        dimension: vector.length,
        sourceHash: d.sourceHash,
        namespace,
        schemaVersion: 1,
        sourceConfigHash: d.configHash,
        decisionRunId: d.decisionRunId,
        updatedAt: now,
      });
      appliedUpserts++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`SKU ${d.sku}: ${msg}`);
    }
  }
  if (!hasMore) cursor = null;

  return {
    report: {
      namespace,
      lockAcquired: true,
      plan,
      appliedUpserts,
      appliedTombstones,
      appliedDeletes,
      processedCount,
      batch: Math.max(1, Math.ceil(begin / batchSize) + 1),
      hasMore,
      errors,
    },
    cursor,
  };
}

/**
 * Run embedding maintenance for a namespace. Evaluation namespace requires an
 * explicit request token AND an evaluation-allowed feature policy. Production
 * namespace requires the production feature to be enabled (fail closed).
 */
export async function runEmbeddingMaintenance(
  workspaceId: string,
  options: MaintenanceOptions = {},
): Promise<MaintenanceReport> {
  const namespace = options.namespace ?? 'production';
  const model = options.model ?? EMBEDDING_MODEL;
  const provider = options.provider ?? EMBEDDING_PROVIDER;
  const now = options.now ?? new Date().toISOString();

  if (maintenanceLocks.has(workspaceId)) {
    throw new EmbeddingMaintenanceLockedError(workspaceId);
  }
  maintenanceLocks.add(workspaceId);
  try {
    // Policy gate: evaluation namespace needs an explicit request + policy;
    // production namespace needs the production feature enabled.
    const feature: MlFeatureId = 'productionEmbeddings';
    const policy: ModelPolicyConfigV2 | null = options.modelPolicy ?? null;
    const request = {
      feature,
      scope: namespace,
      evaluationRequestToken: options.evaluationRequestToken,
    } as const;
    const decision = policy
      ? evaluateFeaturePolicy(policy, request, options.featurePolicyOptions)
      : null;
    if (namespace === 'evaluation') {
      if (!options.evaluationRequestToken) {
        throw new EmbeddingPolicyDeniedError(
          'Embedding evaluation-namespace maintenance requires an explicit evaluationRequestToken.',
        );
      }
      if (!policy || !decision) {
        throw new EmbeddingPolicyDeniedError(
          'Embedding evaluation-namespace maintenance requires a model policy with an evaluation-scope decision.',
        );
      }
      if (decision.state !== 'evaluation_only' && decision.state !== 'enabled') {
        throw new EmbeddingPolicyDeniedError(`Embedding evaluation-namespace maintenance denied by feature policy: ${decision.reason}`);
      }
    } else {
      if (policy && decision && decision.state !== 'enabled') {
        throw new EmbeddingPolicyDeniedError(`Production embedding maintenance denied by feature policy: ${decision?.reason ?? 'feature disabled'}`);
      }
      // No model policy available (unconfigured workspace): fail closed.
      if (!policy || !decision) {
        throw new EmbeddingPolicyDeniedError('Production embedding maintenance requires a model policy; none configured.');
      }
    }

    const desired = computeDesiredEmbeddings(workspaceId, namespace);
    const { entries, errors: loadErrors } = loadCurrentIndex(workspaceId, namespace, model, provider, now);
    const plan = planEmbeddingMaintenance(entries, desired, now, { model, provider });

    const embed = options.embed ?? (async (text: string) => {
      const response = await fetchEmbedding(text, { model, provider });
      return response.vector;
    });

    const { report, cursor } = await applyMaintenancePlan(workspaceId, namespace, plan, desired, entries, {
      embed,
      batchSize: options.batchSize,
      cursor: options.cursor,
      now,
    });
    report.errors.unshift(...loadErrors);
    if (cursor) report.hasMore = true;
    return report;
  } finally {
    maintenanceLocks.delete(workspaceId);
  }
}

export { InMemoryRetrievalIndex, VectorValidationError };
