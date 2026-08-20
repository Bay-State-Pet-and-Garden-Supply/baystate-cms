/**
 * v1 (single-agent) vs v2 (specialist) shadow comparison (e03s01 Task 2).
 * Runs both on identical frozen-dataset seeds, never mutates state,
 * durable reviewer adjudication where ground truth non-deterministic.
 * Pure + minimal DB shadow tables (shadow_*), <240 lines.
 * story: e03s01
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import { getExamples, getDatasetForWorkspace } from '../../db/repositories/benchmark-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { aggregatePiComparisons, type PiComparison } from './metrics';
import { PiGoldLabelsSchema } from './gold';

export interface ShadowPairResult {
  sku: string;
  v1Outcome: string;
  v2Outcome: string;
  adjudication: 'deterministic' | 'needs_reviewer';
  comparison: PiComparison | null;
}

export interface ShadowComparisonReport {
  datasetId: string;
  datasetHash: string;
  evaluated: number;
  deltas: {
    quality: number | null;
    provenance: number | null;
    cost: number | null;
    latency: number | null;
    humanCorrection: number | null;
  };
  adjudicationNotes: string[];
  pairs: ShadowPairResult[];
}

function isDeterministicGold(goldJson: string): boolean {
  try {
    const gold = PiGoldLabelsSchema.parse(JSON.parse(goldJson));
    return !gold.misleadingSources.length && gold.expectedEvidence.length > 0;
  } catch { return false; }
}

function avg(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export function runShadowComparison(opts: {
  datasetId: string;
  v1Comparisons: PiComparison[];
  v2Comparisons: PiComparison[];
}): ShadowComparisonReport {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');
  const dataset = getDatasetForWorkspace(opts.datasetId, ws.id);
  if (!dataset) throw new Error(`Dataset ${opts.datasetId} not found`);
  const hash = dataset.dataset_hash ?? '';
  const examples = getExamples(opts.datasetId, 'test');
  const pairs: ShadowPairResult[] = [];
  const notes: string[] = [];
  const skuMap = new Map(examples.map((e) => [e.product_sku, e.gold_labels_json]));

  for (let i = 0; i < Math.min(opts.v1Comparisons.length, opts.v2Comparisons.length); i++) {
    const v1 = opts.v1Comparisons[i];
    const v2 = opts.v2Comparisons[i];
    const sku = examples[i]?.product_sku ?? `sku-${i}`;
    const goldJson = skuMap.get(sku) ?? '{}';
    const deterministic = isDeterministicGold(goldJson);
    const adjudication = deterministic ? 'deterministic' : 'needs_reviewer';
    if (!deterministic) notes.push(`sku ${sku}: ground truth non-deterministic, durable reviewer adjudication required`);
    pairs.push({ sku, v1Outcome: v1.outcome, v2Outcome: v2.outcome, adjudication, comparison: v2 });
    // Shadow never mutates — write only to shadow tables (additive).
    try {
      const db = getDb();
      db.run(
        `INSERT INTO shadow_comparisons (id, dataset_id, dataset_hash, sku, v1_outcome, v2_outcome, adjudication, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), opts.datasetId, hash, sku, v1.outcome, v2.outcome, adjudication, new Date().toISOString()],
      );
    } catch {
      // Table may not exist in older DB — shadow is best-effort, never fails the report.
    }
  }

  const v1Agg = opts.v1Comparisons.length ? aggregatePiComparisons(opts.v1Comparisons) : null;
  const v2Agg = opts.v2Comparisons.length ? aggregatePiComparisons(opts.v2Comparisons) : null;
  const deltas = {
    quality:
      v1Agg && v2Agg && v1Agg.rates['fields.recall'] != null && v2Agg.rates['fields.recall'] != null
        ? (v2Agg.rates['fields.recall'] as number) - (v1Agg.rates['fields.recall'] as number)
        : null,
    provenance:
      v1Agg && v2Agg && v1Agg.rates['evidenceCoverage.coverage'] != null && v2Agg.rates['evidenceCoverage.coverage'] != null
        ? (v2Agg.rates['evidenceCoverage.coverage'] as number) - (v1Agg.rates['evidenceCoverage.coverage'] as number)
        : null,
    cost:
      v1Agg && v2Agg && v1Agg.ops.totalCostUsd != null && v2Agg.ops.totalCostUsd != null
        ? (v2Agg.ops.totalCostUsd as number) - (v1Agg.ops.totalCostUsd as number)
        : null,
    latency:
      v1Agg && v2Agg && v1Agg.ops.avgDurationMs != null && v2Agg.ops.avgDurationMs != null
        ? (v2Agg.ops.avgDurationMs as number) - (v1Agg.ops.avgDurationMs as number)
        : null,
    humanCorrection: avg(pairs.map((p) => (p.adjudication === 'needs_reviewer' ? 1 : 0))),
  };

  return { datasetId: opts.datasetId, datasetHash: hash, evaluated: pairs.length, deltas, adjudicationNotes: notes, pairs };
}
