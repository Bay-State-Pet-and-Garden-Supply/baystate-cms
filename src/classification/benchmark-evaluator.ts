/**
 * Benchmark Evaluator
 *
 * The evaluator is PURE over a frozen Gold dataset plus a persisted prediction
 * bundle. It never queries current runs or decisions, so evaluations are
 * repeatable and replayable. All run/decision access happens at bundle build
 * time (benchmark-prediction.ts); evaluation reads only frozen examples and
 * the immutable bundle.
 */

import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import { loadPredictionBundle } from './benchmark-prediction';
import {
  buildQualificationReceiptDigest,
  buildQualificationReceiptPayload,
  createQualificationReceiptId,
  evaluateQualificationGate,
  type QualificationGateOptions,
  type QualificationResult,
} from './benchmark-qualification';
import type {
  BenchmarkGoldLabels,
  BenchmarkPredictionEntry,
  EvalMetrics,
} from '../shared/schemas/classification';

// ─── Pure metric core ──────────────────────────────────────────────────────────

export interface GoldExampleForEvaluation {
  id: string;
  productSku: string;
  goldLabels: BenchmarkGoldLabels;
  /** Lowercased concatenated evidence text (for species heuristics). */
  evidenceText: string;
}

export interface ControlledValues {
  /** targetId -> allowed values (empty = free-form). */
  [targetId: string]: string[];
}

export interface ComputeMetricsOptions {
  /** Controlled vocabulary per field target; violations counted against it. */
  controlledValues?: ControlledValues;
  /** Deterministic seed digest for the paired bootstrap (e.g. bundleHash). */
  pairedSeedDigest?: string;
  /** Baseline predictions for the paired delta (default: abstention baseline). */
  baselinePredictions?: BenchmarkPredictionEntry[];
  primaryMetric?: string;
  /** Number of holdout examples in the dataset (gate input). */
  holdoutSize?: number;
  bootstrapRuns?: number;
}

function defaultMetrics(): EvalMetrics {
  return {
    productType: {
      top1Accuracy: 0,
      macroF1: 0,
      confusionPairs: [],
      support: 0,
      coverage: 0,
      perClassSupport: {},
    },
    pages: {
      precisionAtK: 0,
      recallAtK: 0,
      exactSetAccuracy: 0,
      blocked: false,
      blockedReason: null,
    },
    fields: {
      targetAccuracy: {},
      targetSupport: {},
    },
    safety: {
      crossSpeciesCount: 0,
      crossSpeciesExamples: [],
      claimSafetyViolations: 0,
      controlledValueViolations: 0,
    },
    abstention: {
      abstainedPercent: 0,
      accuracyOfNonAbstained: 0,
    },
    operations: {
      correctionsPerHundred: 0,
    },
    calibration: {
      ece: 0,
      bins: [],
    },
    pairedDelta: {
      primaryMetric: 'productType.top1Accuracy',
      deltaMean: 0,
      deltaLower95: 0,
      deltaUpper95: 0,
      bootstrapRuns: 0,
    },
  };
}

function predictionForExample(predictions: BenchmarkPredictionEntry[], exampleId: string): BenchmarkPredictionEntry | undefined {
  return predictions.find(p => p.exampleId === exampleId);
}

function speciesOfType(productType: string | null): { dog: boolean; cat: boolean } {
  const text = (productType ?? '').toLowerCase();
  return {
    dog: /\bdog\b|\bcanine\b|\bpuppy\b/.test(text),
    cat: /\bcat\b|\bfeline\b|\bkitten\b/.test(text),
  };
}

/** Deterministic PRNG (mulberry32) seeded from a hex digest. */
export function seededRandom(seedDigest: string): () => number {
  const seed = parseInt(seedDigest.replace(/[^0-9a-f]/gi, '').slice(0, 8) || '0', 16) >>> 0;
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PerExamplePrimaryMetric {
  exampleId: string;
  candidate: number; // 1 = correct / 0 = incorrect (abstained excluded)
  baseline: number;
}

/** Per-example paired values for the primary metric (product type accuracy). */
export function computePerExamplePrimaryMetric(
  gold: GoldExampleForEvaluation[],
  candidate: BenchmarkPredictionEntry[],
  baseline: BenchmarkPredictionEntry[] | null,
): PerExamplePrimaryMetric[] {
  const result: PerExamplePrimaryMetric[] = [];
  for (const example of gold) {
    if (!example.goldLabels.productType) continue;
    const cand = predictionForExample(candidate, example.id);
    if (!cand || cand.abstained || cand.productType === null) continue;
    const base = baseline ? predictionForExample(baseline, example.id) : null;
    if (baseline && (!base || base.abstained)) continue;
    const candCorrect = cand.productType === example.goldLabels.productType ? 1 : 0;
    const baseCorrect = baseline ? (base!.productType === example.goldLabels.productType ? 1 : 0) : 0;
    result.push({ exampleId: example.id, candidate: candCorrect, baseline: baseCorrect });
  }
  return result;
}

/**
 * Deterministic 95% paired bootstrap interval. Seeded from the candidate
 * bundle digest (plus an optional extra digest) so identical inputs produce
 * identical intervals.
 */
export function computePairedBootstrap(
  pairs: PerExamplePrimaryMetric[],
  seedDigest: string,
  bootstrapRuns = 2000,
): { deltaMean: number; deltaLower95: number; deltaUpper95: number; bootstrapRuns: number } {
  if (pairs.length === 0) {
    return { deltaMean: 0, deltaLower95: 0, deltaUpper95: 0, bootstrapRuns: 0 };
  }
  const random = seededRandom(seedDigest);
  const deltas: number[] = [];
  for (let run = 0; run < bootstrapRuns; run++) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) {
      const idx = Math.floor(random() * pairs.length);
      sum += pairs[idx].candidate - pairs[idx].baseline;
    }
    deltas.push(sum / pairs.length);
  }
  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(deltas.length * 0.025)];
  const upper = deltas[Math.floor(deltas.length * 0.975)];
  const deltaMean = deltas.reduce((acc, d) => acc + d, 0) / deltas.length;
  return { deltaMean, deltaLower95: lower, deltaUpper95: upper, bootstrapRuns };
}

function computeEce(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): { ece: number; bins: EvalMetrics['calibration']['bins'] } {
  const binCount = 10;
  const bins = Array.from({ length: binCount }, () => ({ count: 0, correct: 0, confSum: 0 }));
  for (const example of gold) {
    if (!example.goldLabels.productType) continue;
    const pred = predictionForExample(predictions, example.id);
    if (!pred || pred.abstained || pred.productType === null || pred.confidence === null || pred.confidence === undefined) continue;
    const bin = Math.min(binCount - 1, Math.floor(pred.confidence * binCount));
    bins[bin].count++;
    if (pred.productType === example.goldLabels.productType) bins[bin].correct++;
    bins[bin].confSum += pred.confidence;
  }
  const total = bins.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return { ece: 0, bins: [] };
  let ece = 0;
  const outBins = bins
    .filter(b => b.count > 0)
    .map(b => {
      const accuracy = b.correct / b.count;
      const avgConfidence = b.confSum / b.count;
      ece += (b.count / total) * Math.abs(accuracy - avgConfidence);
      return { bin: bins.indexOf(b), count: b.count, accuracy, avgConfidence };
    });
  return { ece, bins: outBins };
}

/**
 * Pure metrics computation. No database, no runs, no decisions.
 */
export function computeMetrics(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  options: ComputeMetricsOptions = {},
): EvalMetrics {
  const metrics = defaultMetrics();
  const controlledValues = options.controlledValues ?? {};
  const primaryMetric = options.primaryMetric ?? 'productType.top1Accuracy';
  const bootstrapRuns = options.bootstrapRuns ?? 2000;

  // ── Product Type ───────────────────────────────────────────────────────────
  let eligible = 0;
  let evaluated = 0;
  let correct = 0;
  const classStats: Record<string, { gold: number; correct: number; predicted: number }> = {};
  const confusionMap: Record<string, number> = {};
  let abstained = 0;

  for (const example of gold) {
    const goldType = example.goldLabels.productType;
    const pred = predictionForExample(predictions, example.id);

    if (pred?.abstained || pred?.productType === null || pred?.productType === undefined) {
      if (goldType) {
        eligible++;
        abstained++;
      }
      continue;
    }
    if (!goldType) continue;

    eligible++;
    evaluated++;
    classStats[goldType] = classStats[goldType] ?? { gold: 0, correct: 0, predicted: 0 };
    classStats[goldType].gold++;
    if (pred.productType === goldType) {
      correct++;
      classStats[goldType].correct++;
    }
    if (pred.productType) {
      classStats[pred.productType] = classStats[pred.productType] ?? { gold: 0, correct: 0, predicted: 0 };
      classStats[pred.productType].predicted++;
      if (pred.productType !== goldType) {
        const pairKey = `${goldType} -> ${pred.productType}`;
        confusionMap[pairKey] = (confusionMap[pairKey] ?? 0) + 1;
      }
    }
  }

  metrics.productType.support = evaluated;
  metrics.productType.coverage = eligible > 0 ? evaluated / eligible : 0;
  metrics.productType.top1Accuracy = evaluated > 0 ? correct / evaluated : 0;
  // INTENTIONAL (M9 review note): per-class support is reported conservatively
  // as min(gold, predicted) rather than the standard gold-class count. This
  // UNDER-reports support for under-predicted classes, which makes the
  // qualification gate reject those classes more aggressively — a fail-closed
  // bias, never a license to pass. Standard "support = gold count" consumers
  // should use the classStats breakdown when a non-conservative reading is
  // required.
  metrics.productType.perClassSupport = Object.fromEntries(
    Object.entries(classStats).map(([cls, s]) => [cls, Math.min(s.gold, s.correct + (s.predicted - Math.min(s.gold, s.correct)))]),
  );

  // Macro F1 from class-level precision/recall.
  let macroF1Sum = 0;
  let classCount = 0;
  for (const stats of Object.values(classStats)) {
    const precision = stats.predicted > 0 ? stats.correct / stats.predicted : 0;
    const recall = stats.gold > 0 ? stats.correct / stats.gold : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    macroF1Sum += f1;
    classCount++;
  }
  metrics.productType.macroF1 = classCount > 0 ? macroF1Sum / classCount : 0;
  metrics.productType.confusionPairs = Object.entries(confusionMap).map(([key, count]) => {
    const [g, p] = key.split(' -> ');
    return [g, p, count] as [string, string, number];
  });

  // ── Abstention ─────────────────────────────────────────────────────────────
  metrics.abstention.abstainedPercent = gold.length > 0 ? (abstained / gold.length) * 100 : 0;
  const nonAbstained = evaluated;
  metrics.abstention.accuracyOfNonAbstained = nonAbstained > 0 ? correct / nonAbstained : 0;

  // ── Pages ──────────────────────────────────────────────────────────────────
  const goldPagesExist = gold.some(example => example.goldLabels.pageAssignments.length > 0);
  let pagePrecisionSum = 0;
  let pageRecallSum = 0;
  let exactMatches = 0;
  let pageEvaluated = 0;

  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const goldPages = new Set(example.goldLabels.pageAssignments.map(p => p.pageName));
    const predPages = new Set((pred?.pageAssignments ?? []).filter((v): v is string => Boolean(v)));
    if (goldPages.size === 0 && predPages.size === 0) continue;
    pageEvaluated++;
    let hits = 0;
    for (const page of predPages) if (goldPages.has(page)) hits++;
    pagePrecisionSum += predPages.size > 0 ? hits / predPages.size : 0;
    pageRecallSum += goldPages.size > 0 ? hits / goldPages.size : 0;
    if (goldPages.size === predPages.size && [...goldPages].every(p => predPages.has(p))) exactMatches++;
  }

  metrics.pages.precisionAtK = pageEvaluated > 0 ? pagePrecisionSum / pageEvaluated : 0;
  metrics.pages.recallAtK = pageEvaluated > 0 ? pageRecallSum / pageEvaluated : 0;
  metrics.pages.exactSetAccuracy = pageEvaluated > 0 ? exactMatches / pageEvaluated : 0;
  metrics.pages.blocked = goldPagesExist;
  metrics.pages.blockedReason = goldPagesExist ? 'blocked_missing_verified_page_gold' : null;

  // ── Fields ─────────────────────────────────────────────────────────────────
  const fieldStats: Record<string, { support: number; correct: number }> = {};
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const predFields = new Map((pred?.fieldAssignments ?? []).map(f => [f.targetId, f.value]));
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      fieldStats[goldField.targetId] = fieldStats[goldField.targetId] ?? { support: 0, correct: 0 };
      fieldStats[goldField.targetId].support++;
      const predicted = predFields.get(goldField.targetId);
      if (predicted === goldField.value) fieldStats[goldField.targetId].correct++;
    }
  }
  metrics.fields.targetSupport = Object.fromEntries(Object.entries(fieldStats).map(([t, s]) => [t, s.support]));
  metrics.fields.targetAccuracy = Object.fromEntries(
    Object.entries(fieldStats).map(([t, s]) => [t, s.support > 0 ? s.correct / s.support : 0]),
  );

  // ── Operations: corrections per hundred ────────────────────────────────────
  let totalCorrections = 0;
  let totalFieldProposals = 0;
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const predFields = new Map((pred?.fieldAssignments ?? []).map(f => [f.targetId, f.value]));
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      totalFieldProposals++;
      const predicted = predFields.get(goldField.targetId);
      if (predicted !== null && predicted !== undefined && predicted !== goldField.value) {
        totalCorrections++;
      }
    }
  }
  metrics.operations.correctionsPerHundred = totalFieldProposals > 0 ? (totalCorrections / totalFieldProposals) * 100 : 0;

  // ── Safety ─────────────────────────────────────────────────────────────────
  const crossSpeciesExamples: string[] = [];
  for (const example of gold) {
    const goldSpecies = speciesOfType(example.goldLabels.productType);
    const pred = predictionForExample(predictions, example.id);
    for (const page of pred?.pageAssignments ?? []) {
      const lower = page.toLowerCase();
      if (goldSpecies.dog && /\bcat\b/.test(lower) && !/\bdog\b/.test(lower)) {
        metrics.safety.crossSpeciesCount++;
        crossSpeciesExamples.push(`${example.productSku}: Dog product on page '${page}'`);
      } else if (goldSpecies.cat && /\bdog\b/.test(lower) && !/\bcat\b/.test(lower)) {
        metrics.safety.crossSpeciesCount++;
        crossSpeciesExamples.push(`${example.productSku}: Cat product on page '${page}'`);
      }
    }

    // Claim-safety: asserting a value for a claim-sensitive target without
    // linked evidence in the bundle is a violation.
    for (const claimTarget of pred?.claimTargets ?? []) {
      const asserted = (pred?.fieldAssignments ?? []).some(f => f.targetId === claimTarget && f.value !== null && f.value !== undefined);
      if (asserted) metrics.safety.claimSafetyViolations++;
    }

    // Controlled-value: a predicted value outside the declared vocabulary.
    for (const field of pred?.fieldAssignments ?? []) {
      const allowed = controlledValues[field.targetId];
      if (field.value !== null && field.value !== undefined && allowed && allowed.length > 0 && !allowed.includes(field.value)) {
        metrics.safety.controlledValueViolations++;
      }
    }
  }
  metrics.safety.crossSpeciesExamples = crossSpeciesExamples;

  // ── Calibration (ECE over non-abstained product-type predictions) ─────────
  metrics.calibration = computeEce(gold, predictions);

  // ── Paired delta (candidate vs baseline; default abstention baseline) ─────
  const pairs = computePerExamplePrimaryMetric(gold, predictions, options.baselinePredictions ?? null);
  const seedDigest = options.pairedSeedDigest ?? '0000000000000000000000000000000000000000000000000000000000000000';
  const bootstrap = computePairedBootstrap(pairs, seedDigest, bootstrapRuns);
  metrics.pairedDelta = {
    primaryMetric,
    deltaMean: bootstrap.deltaMean,
    deltaLower95: bootstrap.deltaLower95,
    deltaUpper95: bootstrap.deltaUpper95,
    bootstrapRuns: bootstrap.bootstrapRuns,
  };

  return metrics;
}

// ─── DB-backed wrapper ─────────────────────────────────────────────────────────

export interface EvaluateBenchmarkOptions {
  runLabel: string;
  splitGroup?: 'test' | 'holdout';
  predictionBundleId?: string;
  baselineBundleId?: string;
  qualification?: QualificationGateOptions;
  controlledValues?: ControlledValues;
  bootstrapRuns?: number;
}

export interface EvaluateBenchmarkResult {
  evalRunId: string;
  metrics: EvalMetrics;
  qualification: QualificationResult;
  holdoutSize: number;
  predictionBundleId: string;
  bundleHash: string;
  receiptDigest: string;
  receiptId: string;
}

export async function evaluateBenchmark(
  datasetId: string,
  options: EvaluateBenchmarkOptions,
  workspaceId?: string,
): Promise<EvaluateBenchmarkResult> {
  const splitGroup = options.splitGroup ?? 'test';

  // Workspace-scoped lookup (M9 review note): a direct caller cannot evaluate
  // a foreign workspace's frozen dataset. The routes pre-check ownership too.
  const dataset = workspaceId
    ? benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId)
    : benchmarkRepo.getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Evaluation requires a frozen dataset; dataset is ${dataset.status}.`);
  }
  const effectiveWorkspaceId = dataset.workspace_id;

  // Frozen gold + persisted bundle only — no current-run access.
  const goldExamples = benchmarkRepo.getExamples(datasetId, splitGroup);
  const gold: GoldExampleForEvaluation[] = goldExamples.map(example => {
    const goldLabels = JSON.parse(example.gold_labels_json) as BenchmarkGoldLabels;
    let evidenceText = '';
    try {
      const snapshot = JSON.parse(example.input_snapshot_json || '{}') as { evidence?: Array<{ snippet?: string }> };
      evidenceText = (snapshot.evidence ?? []).map(e => e.snippet ?? '').join(' ').toLowerCase();
    } catch { /* evidence text is best-effort for heuristics only */ }
    return {
      id: example.id,
      productSku: example.product_sku,
      goldLabels,
      evidenceText,
    };
  });

  const { bundleId, predictions, bundleHash } = loadPredictionBundle(effectiveWorkspaceId, datasetId, options.predictionBundleId, splitGroup);

  let baselinePredictions: BenchmarkPredictionEntry[] | undefined;
  if (options.baselineBundleId) {
    baselinePredictions = loadPredictionBundle(effectiveWorkspaceId, datasetId, options.baselineBundleId, splitGroup).predictions;
  }

  const metrics = computeMetrics(gold, predictions, {
    controlledValues: options.controlledValues,
    pairedSeedDigest: bundleHash + (options.baselineBundleId ?? ''),
    baselinePredictions,
    primaryMetric: 'productType.top1Accuracy',
    bootstrapRuns: options.bootstrapRuns ?? 2000,
  });

  const holdoutSize = benchmarkRepo.getExamples(datasetId, 'holdout').length;
  const qualification = evaluateQualificationGate(metrics, holdoutSize, options.qualification);

  // Persist the content-addressed receipt.
  const datasetHash = dataset.dataset_hash ?? '';
  const payload = buildQualificationReceiptPayload({
    datasetId,
    datasetHash,
    predictionBundleId: bundleId,
    bundleHash,
    holdoutSize,
    metrics,
    qualification,
  });
  const receiptDigest = buildQualificationReceiptDigest(payload);
  const receiptId = createQualificationReceiptId();
  benchmarkRepo.insertQualificationReceipt({
    datasetId,
    datasetHash,
    predictionBundleId: bundleId,
    bundleHash,
    holdoutSize,
    coverage: metrics.productType.coverage,
    minClassSupport: Object.values(metrics.productType.perClassSupport).length > 0
      ? Math.min(...Object.values(metrics.productType.perClassSupport))
      : 0,
    violations: {
      crossSpecies: metrics.safety.crossSpeciesCount,
      claimSafety: metrics.safety.claimSafetyViolations,
      controlledValue: metrics.safety.controlledValueViolations,
    },
    primaryMetric: metrics.pairedDelta.primaryMetric,
    deltaLower95: metrics.pairedDelta.deltaLower95,
    nonRegressionFloorsMet: qualification.gate.nonRegressionFloorsMet,
    qualified: qualification.qualified,
    reasons: qualification.reasons,
    digest: receiptDigest,
    generatedBy: null,
  });

  const evalRunId = benchmarkRepo.insertEvalRun(
    datasetId,
    options.runLabel,
    null,
    JSON.stringify(metrics),
    bundleId,
  );

  return {
    evalRunId,
    metrics,
    qualification,
    holdoutSize,
    predictionBundleId: bundleId,
    bundleHash,
    receiptDigest,
    receiptId,
  };
}
