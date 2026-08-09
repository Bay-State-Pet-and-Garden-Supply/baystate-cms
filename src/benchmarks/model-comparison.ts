/**
 * Model Qualification & Comparison Engine.
 *
 * Evaluates candidate model runs against the cloud baseline (DeepSeek V4-Flash)
 * according to explicit qualification gates:
 * 1. JSON validity >= 99%
 * 2. Quality >= 97% of baseline
 * 3. Critical error rate <= baseline
 */

import type { ModelEvalRunResult } from './benchmark-runner';

export interface QualificationEvaluation {
  candidateModel: string;
  baselineModel: string;
  task: string;
  qualified: boolean;
  gateResults: {
    jsonValidityPass: boolean;
    accuracyPass: boolean;
    criticalErrorPass: boolean;
    latencySlaPass: boolean;
  };
  metrics: {
    candidateAccuracy: number;
    baselineAccuracy: number;
    relativeAccuracy: number;
    candidateJsonValidity: number;
    candidateCriticalErrorRate: number;
    baselineCriticalErrorRate: number;
    candidateP95LatencyMs: number;
    baselineP95LatencyMs: number;
  };
  disqualificationReasons: string[];
}

export function compareModelRuns(
  candidate: ModelEvalRunResult,
  baseline: ModelEvalRunResult,
  maxP95LatencyMs = 15000,
): QualificationEvaluation {
  const reasons: string[] = [];

  // Gate 1: JSON / Schema validity >= 99%
  const jsonValidityPass = candidate.parsedJsonValidityRate >= 0.99;
  if (!jsonValidityPass) {
    reasons.push(
      `JSON validity rate (${(candidate.parsedJsonValidityRate * 100).toFixed(1)}%) fell below 99.0% threshold.`,
    );
  }

  // Gate 2: Quality >= 97% of baseline
  const relativeAccuracy = baseline.accuracyRate > 0 ? candidate.accuracyRate / baseline.accuracyRate : 1;
  const accuracyPass = relativeAccuracy >= 0.97;
  if (!accuracyPass) {
    reasons.push(
      `Relative accuracy (${(relativeAccuracy * 100).toFixed(1)}%) fell below 97.0% of cloud baseline (${(baseline.accuracyRate * 100).toFixed(1)}%).`,
    );
  }

  // Gate 3: Critical error rate <= baseline
  const candidateCriticalErrors = candidate.failureCategories.timeout + candidate.failureCategories.transport_failure + candidate.failureCategories.policy_denied;
  const baselineCriticalErrors = baseline.failureCategories.timeout + baseline.failureCategories.transport_failure + baseline.failureCategories.policy_denied;

  const candCritRate = candidate.totalCases > 0 ? candidateCriticalErrors / candidate.totalCases : 0;
  const baseCritRate = baseline.totalCases > 0 ? baselineCriticalErrors / baseline.totalCases : 0;
  const criticalErrorPass = candCritRate <= baseCritRate;
  if (!criticalErrorPass) {
    reasons.push(
      `Critical error rate (${(candCritRate * 100).toFixed(1)}%) exceeded baseline (${(baseCritRate * 100).toFixed(1)}%).`,
    );
  }

  // Gate 4: Latency SLA threshold
  const latencySlaPass = candidate.latencyP95Ms <= maxP95LatencyMs;
  if (!latencySlaPass) {
    reasons.push(
      `p95 Latency (${candidate.latencyP95Ms}ms) exceeded maximum task SLA limit (${maxP95LatencyMs}ms).`,
    );
  }

  const qualified = jsonValidityPass && accuracyPass && criticalErrorPass && latencySlaPass;

  return {
    candidateModel: candidate.model,
    baselineModel: baseline.model,
    task: candidate.task,
    qualified,
    gateResults: {
      jsonValidityPass,
      accuracyPass,
      criticalErrorPass,
      latencySlaPass,
    },
    metrics: {
      candidateAccuracy: candidate.accuracyRate,
      baselineAccuracy: baseline.accuracyRate,
      relativeAccuracy: Number(relativeAccuracy.toFixed(4)),
      candidateJsonValidity: candidate.parsedJsonValidityRate,
      candidateCriticalErrorRate: Number(candCritRate.toFixed(4)),
      baselineCriticalErrorRate: Number(baseCritRate.toFixed(4)),
      candidateP95LatencyMs: candidate.latencyP95Ms,
      baselineP95LatencyMs: baseline.latencyP95Ms,
    },
    disqualificationReasons: reasons,
  };
}

export function formatComparisonMarkdown(evaluations: QualificationEvaluation[]): string {
  const lines: string[] = [];
  lines.push('# Model Bakeoff Evaluation & Qualification Summary\n');
  lines.push('| Candidate Model | Task | Status | Relative Quality | JSON Validity | p95 Latency |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const ev of evaluations) {
    const status = ev.qualified ? '✅ Qualified' : '❌ Disqualified';
    const relQuality = `${(ev.metrics.relativeAccuracy * 100).toFixed(1)}%`;
    const jsonVal = `${(ev.metrics.candidateJsonValidity * 100).toFixed(1)}%`;
    const latency = `${ev.metrics.candidateP95LatencyMs}ms`;
    lines.push(`| ${ev.candidateModel} | ${ev.task} | ${status} | ${relQuality} | ${jsonVal} | ${latency} |`);
  }

  return lines.join('\n');
}
