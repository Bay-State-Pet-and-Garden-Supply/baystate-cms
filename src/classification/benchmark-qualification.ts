/**
 * Conservative Benchmark Qualification
 *
 * Qualification receipts encode the approved gate. A receipt is NEVER a
 * permission to enable a feature: feature-policy still requires the receipt
 * digest plus an explicit activation audit. Nothing here auto-enables or
 * auto-accepts anything.
 *
 * Approved gate (docs/plans/classification-system-implementation-plan.md):
 * - holdout ≥ 200;
 * - support ≥ 20 per evaluated class;
 * - coverage ≥ 0.80;
 * - zero cross-species, claim-safety, and controlled-value violations;
 * - lower 95% confidence bound for the predeclared paired primary-metric delta
 *   above zero;
 * - task-specific non-regression floors.
 */

import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';
import type { EvalMetrics } from '../shared/schemas/classification';

export interface QualificationGateOptions {
  requiredHoldout?: number;
  requiredClassSupport?: number;
  requiredCoverage?: number;
  /** Predeclared paired primary metric (e.g. productType.top1Accuracy). */
  primaryMetric?: string;
  /** Task-specific non-regression floors, e.g. top1Accuracy ≥ 0.5. */
  nonRegressionFloors?: Array<{ metric: string; floor: number; actual: number }>;
}

export interface QualificationResult {
  qualified: boolean;
  reasons: string[];
  gate: {
    holdoutSize: number;
    coverage: number;
    minClassSupport: number;
    violations: { crossSpecies: number; claimSafety: number; controlledValue: number };
    deltaLower95: number;
    primaryMetric: string;
    nonRegressionFloorsMet: boolean;
  };
}

export function evaluateQualificationGate(
  metrics: EvalMetrics,
  holdoutSize: number,
  options: QualificationGateOptions = {},
): QualificationResult {
  const requiredHoldout = options.requiredHoldout ?? 200;
  const requiredClassSupport = options.requiredClassSupport ?? 20;
  const requiredCoverage = options.requiredCoverage ?? 0.8;
  const primaryMetric = options.primaryMetric ?? 'productType.top1Accuracy';

  const reasons: string[] = [];

  if (holdoutSize < requiredHoldout) {
    reasons.push(`insufficient_sample: holdout ${holdoutSize} < ${requiredHoldout}`);
  }

  const coverage = metrics.productType.coverage;
  if (coverage < requiredCoverage) {
    reasons.push(`coverage ${coverage.toFixed(3)} < ${requiredCoverage}`);
  }

  const perClassSupport = metrics.productType.perClassSupport;
  const supportValues = Object.values(perClassSupport);
  const minClassSupport = supportValues.length > 0 ? Math.min(...supportValues) : 0;
  if (supportValues.length === 0 || minClassSupport < requiredClassSupport) {
    reasons.push(
      `insufficient_class_support: min support ${minClassSupport} < ${requiredClassSupport} over ${supportValues.length} class(es)`,
    );
  }

  const violations = {
    crossSpecies: metrics.safety.crossSpeciesCount,
    claimSafety: metrics.safety.claimSafetyViolations,
    controlledValue: metrics.safety.controlledValueViolations,
  };
  if (violations.crossSpecies + violations.claimSafety + violations.controlledValue > 0) {
    reasons.push(
      `safety_violations: ${JSON.stringify(violations)}`,
    );
  }

  const deltaLower95 = metrics.pairedDelta.deltaLower95;
  if (metrics.pairedDelta.primaryMetric !== primaryMetric) {
    reasons.push(
      `paired_metric_mismatch: evaluated "${metrics.pairedDelta.primaryMetric}", predeclared "${primaryMetric}"`,
    );
  } else if (deltaLower95 <= 0) {
    reasons.push(`paired_delta_not_significant: lower 95% CI ${deltaLower95.toFixed(4)} <= 0`);
  }

  let nonRegressionFloorsMet = true;
  for (const floor of options.nonRegressionFloors ?? []) {
    if (floor.actual < floor.floor) {
      nonRegressionFloorsMet = false;
      reasons.push(`non_regression_floor: ${floor.metric} ${floor.actual.toFixed(3)} < ${floor.floor}`);
    }
  }

  const qualified = reasons.length === 0;

  return {
    qualified,
    reasons,
    gate: {
      holdoutSize,
      coverage,
      minClassSupport,
      violations,
      deltaLower95,
      primaryMetric,
      nonRegressionFloorsMet,
    },
  };
}

export interface BuildQualificationReceiptOptions {
  datasetId: string;
  datasetHash: string;
  predictionBundleId: string;
  bundleHash: string;
  holdoutSize: number;
  metrics: EvalMetrics;
  qualification: QualificationResult;
  generatedBy?: string | null;
}

/**
 * Build the content-addressed qualification receipt payload. The digest binds
 * the dataset hash, bundle hash, holdout size, metrics-derived gate values, and
 * the qualification outcome so a receipt cannot be replayed against a different
 * dataset/bundle.
 */
export function buildQualificationReceiptPayload(options: BuildQualificationReceiptOptions): Record<string, unknown> {
  const { qualification, metrics } = options;
  return {
    datasetId: options.datasetId,
    datasetHash: options.datasetHash,
    predictionBundleId: options.predictionBundleId,
    bundleHash: options.bundleHash,
    holdoutSize: options.holdoutSize,
    gate: qualification.gate,
    qualified: qualification.qualified,
    reasons: qualification.reasons,
    calibrationEce: metrics.calibration.ece,
  };
}

export function buildQualificationReceiptDigest(payload: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(payload));
}

export function createQualificationReceiptId(): string {
  return randomUUID();
}
