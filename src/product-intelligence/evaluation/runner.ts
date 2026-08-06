/**
 * PI-9 evaluation runner: compare completed Product Intelligence runs
 * against the versioned golden dataset (benchmark tables reused from the
 * classification benchmark subsystem).
 *
 * Shadow-mode semantics: evaluation reads ONLY persisted runs and never
 * mutates onboarding or catalog state. Held-out products are never evaluated
 * by default (splitGroup defaults to 'test').
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import {
  createDataset,
  freezeDataset,
  getDatasetForWorkspace,
  getExamples,
  insertExample,
  listDatasets,
  markFamilyReviewComplete,
} from '../../db/repositories/benchmark-repo';
import { getPiResult, listPiRuns } from '../../db/repositories/product-intelligence-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { splitForFamily } from '../../classification/benchmark-exporter';
import { PI_GOLDEN_DATASET_NAME, buildPiGoldenProducts } from './fixture-dataset';
import { PiGoldLabelsSchema, type PiGoldLabels, type PiProductInput } from './gold';
import {
  aggregatePiComparisons,
  classifyRunOutcome,
  comparePredictionToGold,
  extractPredictionFromResult,
  type PiAggregateReport,
  type PiComparison,
} from './metrics';

export interface RunEvaluationOptions {
  datasetId: string;
  /** Defaults to 'test' — held-out products are excluded from evaluation. */
  splitGroup?: 'train' | 'test' | 'holdout';
  /** Restrict evaluation to specific runs (matched by product sku = gtin). */
  runIds?: string[];
}

export interface RunEvaluationResult {
  evaluated: number;
  skipped: Array<{ sku: string; reason: string }>;
  report: PiAggregateReport | null;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function runPiEvaluation(opts: RunEvaluationOptions): RunEvaluationResult {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');

  const dataset = getDatasetForWorkspace(opts.datasetId, ws.id);
  if (!dataset) throw new Error(`Dataset ${opts.datasetId} not found`);
  if (dataset.status !== 'frozen') {
    throw new Error(`Dataset ${opts.datasetId} is not frozen (status '${dataset.status}')`);
  }
  const datasetHash = dataset.dataset_hash ?? '';

  const examples = getExamples(opts.datasetId, opts.splitGroup ?? 'test');
  const runs = listPiRuns({ workspaceId: ws.id, status: 'completed' });

  const comparisons: PiComparison[] = [];
  const skipped: Array<{ sku: string; reason: string }> = [];
  const db = getDb();
  const now = new Date().toISOString();

  for (const example of examples) {
    const sku = example.product_sku;

    let gold: PiGoldLabels;
    try {
      const parsed = PiGoldLabelsSchema.safeParse(JSON.parse(example.gold_labels_json));
      if (!parsed.success) {
        skipped.push({ sku, reason: 'invalid_gold' });
        continue;
      }
      gold = parsed.data;
    } catch {
      skipped.push({ sku, reason: 'invalid_gold' });
      continue;
    }

    // Match runs by input GTIN (normalized digits).
    const candidateRuns = runs.filter((r) => {
      try {
        const input = JSON.parse(r.inputJson) as { gtin?: unknown };
        return typeof input.gtin === 'string' && digitsOf(input.gtin) === digitsOf(sku);
      } catch {
        return false;
      }
    });
    const restricted = opts.runIds ? candidateRuns.filter((r) => opts.runIds!.includes(r.id)) : candidateRuns;
    if (restricted.length === 0) {
      skipped.push({ sku, reason: 'no_run' });
      continue;
    }
    const run = restricted.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

    const result = getPiResult(run.id);
    const prediction = extractPredictionFromResult(result?.resultJson ?? null);
    const outcome = classifyRunOutcome(run.status, run.errorCode, result?.disposition ?? null, prediction?.identityStatus ?? null);
    const comparison = comparePredictionToGold(prediction, gold, outcome);
    comparison.ops = {
      durationMs: run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : null,
      costUsd: run.actualCost,
      toolCalls: 0,
      deniedToolCalls: 0,
    };

    db.run(
      `INSERT INTO pi_evaluation_runs (
        id, dataset_id, dataset_hash, product_sku, split_group, run_id,
        gold_labels_json, prediction_json, comparison_json, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), opts.datasetId, datasetHash, sku, example.split_group, run.id,
        JSON.stringify(gold), JSON.stringify(prediction), JSON.stringify(comparison), outcome, now,
      ],
    );

    comparisons.push(comparison);
  }

  return {
    evaluated: comparisons.length,
    skipped,
    report: comparisons.length > 0 ? aggregatePiComparisons(comparisons) : null,
  };
}

/**
 * Seed the built-in versioned golden dataset from the fixture products
 * (PI_GOLDEN_DATASET_NAME). Idempotent per workspace: refuses to duplicate
 * an existing dataset with the same name.
 */
export function seedPiGoldenDataset(): { datasetId: string; datasetHash: string; total: number } {
  const ws = findWorkspace();
  if (!ws) throw new Error('No active workspace');
  const existing = listDatasets(ws.id);
  const dup = existing.find((d) => d.name === PI_GOLDEN_DATASET_NAME);
  if (dup) throw new Error(`Fixture dataset '${PI_GOLDEN_DATASET_NAME}' already exists`);

  const products = buildPiGoldenProducts();
  const dataset = createDataset(ws.id, PI_GOLDEN_DATASET_NAME, 'random', 42);
  for (const product of products) {
    const input: PiProductInput = product.input;
    insertExample(
      dataset.id,
      input.gtin,
      input.gtin,
      splitForFamily(input.gtin, 42, 20),
      JSON.stringify(input),
      JSON.stringify(product.gold),
    );
  }
  markFamilyReviewComplete(dataset.id, 'system');
  const frozen = freezeDataset(dataset.id, 'system');
  return { datasetId: dataset.id, datasetHash: frozen.dataset_hash ?? '', total: products.length };
}
