/**
 * Immutable Prediction Bundles
 *
 * A prediction bundle captures the complete predictions for a frozen Gold
 * split and is persisted in full BEFORE evaluation. The evaluator only reads
 * the persisted bundle plus the frozen Gold examples — it never queries
 * current runs or decisions, so evaluations are repeatable and replayable.
 *
 * Fail-closed rules:
 * - Missing predictions for any gold example → error.
 * - Duplicate example ids inside a bundle → error.
 * - bundleHash mismatch against the canonical predictions → error.
 */

import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';
import { pageNameFromPageValue } from '../shared/proposal-display';
import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import type { BenchmarkPredictionEntry, BenchmarkPredictionBundle } from '../shared/schemas/classification';

export interface GoldExampleForPrediction {
  id: string;
  productSku: string;
}

export function computePredictionBundleHash(predictions: BenchmarkPredictionEntry[]): string {
  const sorted = [...predictions].sort((a, b) => (a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : 0));
  return sha256Hex(JSON.stringify(sorted));
}

/**
 * Extract the exact reviewed-run predictions for one SKU: the live (non-
 * superseded) accepted decisions of the most recent completed run, using the
 * effective revised values/targets. Stale proposals are excluded.
 */
export function extractPredictionsForSku(
  workspaceId: string,
  sku: string,
  claimTargets: string[] = [],
): BenchmarkPredictionEntry | null {
  const run = classRunRepo.getRecentRun(workspaceId, sku);
  if (!run) return null;

  const proposals = classRunRepo.getProposalsByRun(run.id);
  if (proposals.length === 0) return null;

  const decisions = classRunRepo.getLiveDecisionsByRun(run.id);

  let productType: string | null = null;
  const pageAssignments: string[] = [];
  const fieldAssignments: Array<{ targetId: string; value: string | null }> = [];
  let abstained = false;
  let confidence: number | null = null;

  for (const proposal of proposals) {
    // Exclude stale/config-drift/source-drift records at extraction time.
    if (proposal.isStale) continue;
    if (proposal.proposalType === 'reviewable_abstention') {
      abstained = true;
      continue;
    }

    const decision = decisions.find(d => d.proposalId === proposal.id);
    if (!decision || decision.decision !== 'accepted') continue;

    const val = effectiveValue(decision, proposal);
    const effectiveTarget = decision.hasRevisedTargetId && decision.revisedTargetId !== undefined
      ? decision.revisedTargetId
      : proposal.targetId;

    if (proposal.proposalType === 'primary_product_type') {
      productType = val;
      confidence = proposal.confidence;
    } else if (proposal.proposalType === 'category_page') {
      // Page labels use the display name from the effective value — never the
      // stable Page ID (issue #17 D1).
      const pageName = pageNameFromPageValue(
        decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
        effectiveTarget,
      );
      if (pageName) pageAssignments.push(pageName);
    } else if (proposal.proposalType === 'field_assignment' && effectiveTarget) {
      fieldAssignments.push({ targetId: effectiveTarget, value: val });
    }
  }

  if (!productType && pageAssignments.length === 0 && fieldAssignments.length === 0 && !abstained) {
    return null;
  }

  return {
    exampleId: '', // filled by the builder against the gold example id
    productSku: sku,
    productType,
    pageAssignments: [...new Set(pageAssignments)],
    fieldAssignments,
    abstained,
    confidence,
    claimTargets,
  };
}

function effectiveValue(decision: { hasRevisedValue?: boolean; revisedValue?: unknown }, proposal: { proposedValue?: unknown }): string | null {
  if (decision.hasRevisedValue && decision.revisedValue !== undefined) {
    return typeof decision.revisedValue === 'string'
      ? decision.revisedValue
      : decision.revisedValue === null
        ? null
        : JSON.stringify(decision.revisedValue);
  }
  const pv = proposal.proposedValue;
  if (pv === null || pv === undefined) return null;
  return typeof pv === 'string' ? pv : JSON.stringify(pv);
}

export function validatePredictionBundle(
  predictions: BenchmarkPredictionEntry[],
  goldExamples: GoldExampleForPrediction[],
  bundleHash: string,
): void {
  const expected = new Map(goldExamples.map(e => [e.id, e.productSku]));

  if (predictions.length !== goldExamples.length) {
    throw new Error(
      `Prediction bundle incomplete: ${predictions.length} predictions for ${goldExamples.length} gold examples.`,
    );
  }

  const seen = new Set<string>();
  for (const prediction of predictions) {
    if (!expected.has(prediction.exampleId)) {
      throw new Error(`Prediction bundle references unknown example id "${prediction.exampleId}".`);
    }
    if (prediction.productSku !== expected.get(prediction.exampleId)) {
      throw new Error(
        `Prediction bundle SKU mismatch for example "${prediction.exampleId}": got "${prediction.productSku}", expected "${expected.get(prediction.exampleId)}".`,
      );
    }
    if (seen.has(prediction.exampleId)) {
      throw new Error(`Prediction bundle contains duplicate example id "${prediction.exampleId}".`);
    }
    seen.add(prediction.exampleId);
  }

  const computed = computePredictionBundleHash(predictions);
  if (computed !== bundleHash) {
    throw new Error(`Prediction bundle digest mismatch: expected ${bundleHash}, computed ${computed}.`);
  }
}

export interface BuildPredictionBundleOptions {
  runLabel: string;
  splitGroup: 'test' | 'holdout';
  /** Target ids whose attributes are claim-sensitive (from the active config). */
  claimTargets?: string[];
}

/**
 * Build a prediction bundle from the exact reviewed runs and persist it BEFORE
 * evaluation. Fails closed on any gold example without a prediction or on any
 * digest inconsistency.
 */
export function buildPredictionBundle(
  workspaceId: string,
  datasetId: string,
  options: BuildPredictionBundleOptions,
): BenchmarkPredictionBundle {
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId);
  if (!dataset) throw new Error('Dataset not found or not owned by this workspace.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Predictions require a frozen dataset; dataset is ${dataset.status}.`);
  }

  const goldExamples = benchmarkRepo.getExamples(datasetId, options.splitGroup);
  if (goldExamples.length === 0) {
    throw new Error(`No gold examples in split "${options.splitGroup}".`);
  }

  const claimTargets = options.claimTargets ?? [];
  const predictions: BenchmarkPredictionEntry[] = goldExamples.map(example => {
    const entry = extractPredictionsForSku(workspaceId, example.product_sku, claimTargets);
    if (!entry) {
      throw new Error(
        `No reviewed-run prediction available for gold example "${example.id}" (SKU ${example.product_sku}).`,
      );
    }
    return { ...entry, exampleId: example.id };
  });

  const bundleHash = computePredictionBundleHash(predictions);

  const bundle: BenchmarkPredictionBundle = {
    id: randomUUID(),
    datasetId,
    workspaceId,
    runLabel: options.runLabel,
    splitGroup: options.splitGroup,
    predictions,
    bundleHash,
    createdAt: new Date().toISOString(),
  };

  // Fail closed BEFORE persisting: the persisted bundle must be complete and
  // self-consistent, otherwise no evaluation can ever be run against it.
  validatePredictionBundle(
    predictions,
    goldExamples.map(e => ({ id: e.id, productSku: e.product_sku })),
    bundleHash,
  );

  benchmarkRepo.createPredictionBundle(
    datasetId,
    workspaceId,
    options.runLabel,
    options.splitGroup,
    JSON.stringify(predictions),
    bundleHash,
    bundle.id,
  );

  return bundle;
}

export function loadPredictionBundle(
  workspaceId: string,
  datasetId: string,
  bundleId: string | undefined,
  splitGroup: 'test' | 'holdout',
): { bundleId: string; predictions: BenchmarkPredictionEntry[]; bundleHash: string } {
  const row = bundleId
    ? benchmarkRepo.getPredictionBundle(bundleId)
    : benchmarkRepo.getLatestPredictionBundle(datasetId, splitGroup);
  if (!row) {
    throw new Error('No prediction bundle found; build one before evaluating.');
  }
  if (row.workspace_id !== workspaceId) {
    throw new Error('Prediction bundle belongs to a different workspace.');
  }
  if (row.dataset_id !== datasetId) {
    throw new Error('Prediction bundle belongs to a different dataset.');
  }
  if (row.split_group !== splitGroup) {
    throw new Error(`Prediction bundle split "${row.split_group}" does not match requested "${splitGroup}".`);
  }
  const predictions = JSON.parse(row.predictions_json) as BenchmarkPredictionEntry[];
  // Re-verify the persisted digest against the exact bytes.
  if (computePredictionBundleHash(predictions) !== row.bundle_hash) {
    throw new Error('Persisted prediction bundle digest mismatch.');
  }
  return { bundleId: row.id, predictions, bundleHash: row.bundle_hash };
}
