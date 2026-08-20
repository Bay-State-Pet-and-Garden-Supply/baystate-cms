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
  /** Stable UUID for this pair; links to shadow_comparisons + shadow_adjudications. */
  id: string;
  sku: string;
  v1Outcome: string;
  v2Outcome: string;
  adjudication: 'deterministic' | 'needs_reviewer';
  comparison: PiComparison | null;
}

/** A comparison paired with the frozen-seed SKU it was produced for. */
export interface SkuComparison {
  sku: string;
  comparison: PiComparison;
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
  humanCorrectionRates: { v1Rate: number; v2Rate: number };
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

function ensureAdjudicationsTable(): void {
  getDb().run(
    `CREATE TABLE IF NOT EXISTS shadow_adjudications (
      id TEXT PRIMARY KEY,
      shadow_comparison_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      decision TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
}

function skuNeedsHumanCorrection(outcome: string): boolean {
  // A version's result needs human correction when it did not produce a clean
  // submitted outcome (i.e. it abstained, failed, or hit a wrong-variant path).
  return outcome !== 'submitted';
}

export function runShadowComparison(opts: {
  datasetId: string;
  v1Comparisons: SkuComparison[];
  v2Comparisons: SkuComparison[];
}): ShadowComparisonReport {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');
  const dataset = getDatasetForWorkspace(opts.datasetId, ws.id);
  if (!dataset) throw new Error(`Dataset ${opts.datasetId} not found`);
  const hash = dataset.dataset_hash ?? '';
  const examples = getExamples(opts.datasetId, 'test');
  const skuMap = new Map(examples.map((e) => [e.product_sku, e.gold_labels_json]));

  // Pair strictly by frozen-seed SKU, never by array index. A SKU present in
  // the examples but missing from either version is skipped (no index fallback).
  const v1BySku = new Map(opts.v1Comparisons.map((c) => [c.sku, c.comparison]));
  const v2BySku = new Map(opts.v2Comparisons.map((c) => [c.sku, c.comparison]));

  const pairs: ShadowPairResult[] = [];
  const notes: string[] = [];
  for (const example of examples) {
    const sku = example.product_sku;
    const v1 = v1BySku.get(sku);
    const v2 = v2BySku.get(sku);
    if (!v1 || !v2) {
      notes.push(`sku ${sku}: missing v1 or v2 comparison on identical seed, skipped`);
      continue;
    }
    const goldJson = skuMap.get(sku) ?? '{}';
    const deterministic = isDeterministicGold(goldJson);
    const adjudication = deterministic ? 'deterministic' : 'needs_reviewer';
    if (!deterministic) notes.push(`sku ${sku}: ground truth non-deterministic, durable reviewer adjudication required`);
    // Stable UUID links the pair to shadow_comparisons and shadow_adjudications.
    const id = randomUUID();
    pairs.push({ id, sku, v1Outcome: v1.outcome, v2Outcome: v2.outcome, adjudication, comparison: v2 });
    // Shadow never mutates — write only to shadow tables (additive).
    try {
      const db = getDb();
      db.run(
        `INSERT INTO shadow_comparisons (id, dataset_id, dataset_hash, sku, v1_outcome, v2_outcome, adjudication, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, opts.datasetId, hash, sku, v1.outcome, v2.outcome, adjudication, new Date().toISOString()],
      );
    } catch (error) {
      console.warn(`shadow: failed to persist comparison for sku ${sku}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const v1Agg = opts.v1Comparisons.length ? aggregatePiComparisons(opts.v1Comparisons.map((c) => c.comparison)) : null;
  const v2Agg = opts.v2Comparisons.length ? aggregatePiComparisons(opts.v2Comparisons.map((c) => c.comparison)) : null;
  const v1Needs = pairs.filter((p) => skuNeedsHumanCorrection(p.v1Outcome)).length;
  const v2Needs = pairs.filter((p) => skuNeedsHumanCorrection(p.v2Outcome)).length;
  const v1Rate = pairs.length ? v1Needs / pairs.length : 0;
  const v2Rate = pairs.length ? v2Needs / pairs.length : 0;
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
    humanCorrection: pairs.length ? v2Rate - v1Rate : null,
  };

  return {
    datasetId: opts.datasetId,
    datasetHash: hash,
    evaluated: pairs.length,
    deltas,
    humanCorrectionRates: { v1Rate, v2Rate },
    adjudicationNotes: notes,
    pairs,
  };
}

/**
 * Durable reviewer adjudication for a non-deterministic shadow pair.
 * Additive write to shadow_adjudications; never fails the report.
 * story: e03s01
 */
export function resolveShadowAdjudication(
  shadowComparisonId: string,
  sku: string,
  decision: 'confirmed' | 'rejected' | 'escalated',
  reviewer: string,
): void {
  try {
    ensureAdjudicationsTable();
    getDb().run(
      `INSERT INTO shadow_adjudications (id, shadow_comparison_id, sku, decision, reviewer, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), shadowComparisonId, sku, decision, reviewer, new Date().toISOString()],
    );
  } catch (error) {
    console.warn(`shadow: failed to persist adjudication for sku ${sku}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
