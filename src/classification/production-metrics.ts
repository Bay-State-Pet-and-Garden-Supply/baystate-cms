/**
 * Versioned production quality telemetry — pure aggregation (issue #17 F).
 *
 * This module is PURE: it takes raw, already-projected rows and returns a
 * deterministic QualityReport. No database, no runs/decisions access, no
 * mutation. All queries that produce the raw rows live in
 * classification-metrics-repo (workspace/date-bounded, read-only).
 *
 * Honesty invariants:
 * - Empty/insufficient metrics are `null` with denominators and warnings —
 *   a misleading zero is never emitted.
 * - Reviewer agreement is a REVIEW signal, never Gold/true precision.
 * - Superseded decisions are not double-counted (inputs carry only live
 *   decisions); prediction confidence is never replaced with revised
 *   confidence.
 * - Unsupported legacy denominators (unresolvable snapshots) are excluded
 *   and warned, never treated as misses.
 */
import {
  QUALITY_REPORT_SCHEMA_VERSION,
  QUALITY_METRIC_DEFINITION_VERSION,
  type QualityReport,
  type QualityVersionGroup,
  type QualitySampleCounts,
  type QualityCalibration,
  type QualityLatency,
  type QualityCost,
  type QualityReviewAgreement,
  type QualityCoverage,
  type QualityAbstention,
  type QualityCorrections,
  type QualityGrounding,
  type QualityModelRoute,
} from '../shared/schemas/classification-metrics';

// ─── Raw input shapes (produced by classification-metrics-repo) ──────────────

export interface QualityRunInput {
  id: string;
  sourceKind: string | null;
  sourceProductHash: string | null;
  productSku: string;
  configSnapshotHash: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export interface QualityProposalInput {
  id: string;
  runId: string;
  proposalType: string;
  targetId: string | null;
  confidence: number | null;
  status: string;
  isStale: boolean;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  configSnapshotHash: string | null;
  sourceKind: string | null;
}

export interface QualityLiveDecisionInput {
  proposalId: string;
  decision: 'accepted' | 'rejected' | 'deferred';
  hasRevisedValue: boolean;
  hasRevisedTargetId: boolean;
  evidenceIds: string[];
}

export interface QualityModelCallInput {
  runId: string;
  provider: string | null;
  model: string | null;
  status: string;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
  costBasis: string | null;
}

export interface QualitySnapshotDigest {
  configSnapshotHash: string;
  schemaVersion: number | null;
  modelPlanDigest: string | null;
  ruleVersionsDigest: string | null;
  /** True when the snapshot declares at least one enabled curation target. */
  enabledTargets: boolean;
}

export interface QualityMetricsInput {
  workspaceId: string;
  start: string;
  end: string;
  sourceWatermark: string | null;
  generatedAt: string;
  runs: QualityRunInput[];
  proposals: QualityProposalInput[];
  /** One latest live decision per proposal (superseded rows excluded upstream). */
  decisions: QualityLiveDecisionInput[];
  modelCalls: QualityModelCallInput[];
  /** Resolvable runtime snapshots for the run config-snapshot hashes in the window. */
  snapshots: QualitySnapshotDigest[];
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const TERMINAL_RUN_STATUSES = new Set(['completed', 'completed_with_abstentions']);
const REVIEWABLE_ABSTENTION = 'reviewable_abstention';
const CALIBRATION_BINS = 10;
/** Below this many labeled examples ECE is considered unreliable. */
const CALIBRATION_MIN_SAMPLE = 20;
/** Bins with fewer than this many examples trigger a minimum-sample warning. */
const CALIBRATION_MIN_BIN_SAMPLE = 5;

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function round3(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function safeFraction(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round3(numerator / denominator);
}

// ─── Per-metric aggregation over one group's rows ────────────────────────────

interface GroupData {
  runs: QualityRunInput[];
  proposals: QualityProposalInput[];
  decisions: Map<string, QualityLiveDecisionInput>;
  calls: QualityModelCallInput[];
  snapshot: QualitySnapshotDigest | null;
  warnings: string[];
}

function aggregateReviewAgreement(d: GroupData): QualityReviewAgreement {
  let acceptedUnchanged = 0;
  let acceptedCorrected = 0;
  let rejected = 0;
  let deferred = 0;
  for (const proposal of d.proposals) {
    const decision = d.decisions.get(proposal.id);
    if (!decision) continue;
    if (decision.decision === 'accepted') {
      if (decision.hasRevisedValue || decision.hasRevisedTargetId) acceptedCorrected += 1;
      else acceptedUnchanged += 1;
    } else if (decision.decision === 'rejected') {
      rejected += 1;
    } else {
      deferred += 1;
    }
  }
  const precision = safeFraction(acceptedUnchanged, acceptedUnchanged + acceptedCorrected + rejected);
  const warnings: string[] = [];
  if (acceptedUnchanged + acceptedCorrected + rejected === 0) {
    warnings.push('No accepted/rejected live decisions in this window for the group; precision is null.');
  }
  if (deferred > 0) {
    warnings.push(`${deferred} deferred decision(s) excluded from precision (defer is not acceptance).`);
  }
  return {
    precision,
    acceptedUnchanged,
    acceptedCorrected,
    rejected,
    deferred,
    warnings,
  };
}

function aggregateCoverage(d: GroupData): QualityCoverage {
  // Eligible = terminal runs with a resolvable snapshot that enabled a target.
  const eligibleRuns = d.runs.filter(run => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;
    const snap = d.snapshot;
    if (!snap) return false;
    // Legacy schema-v1 snapshots have no declared targets: excluded + warned
    // (never treated as misses).
    if (snap.schemaVersion !== 2) return false;
    return snap.enabledTargets;
  });
  // Decision-eligible = the run has at least one proposal with a live decision.
  const decisionEligibleRuns = eligibleRuns.filter(run => {
    const proposals = d.proposals.filter(p => p.runId === run.id);
    return proposals.some(p => d.decisions.has(p.id));
  });
  const warnings: string[] = [];
  if (eligibleRuns.length === 0) {
    warnings.push('No eligible completed runs with an enabled-target v2 snapshot; coverage is null.');
  } else if (decisionEligibleRuns.length === 0) {
    // Zero decided runs is "no data", not "0% coverage" — a misleading zero.
    warnings.push('Eligible runs exist but none has a decision-eligible proposal; coverage is null (no misleading zero).');
  }
  return {
    value:
      eligibleRuns.length === 0 || decisionEligibleRuns.length === 0
        ? null
        : safeFraction(decisionEligibleRuns.length, eligibleRuns.length),
    eligibleRuns: eligibleRuns.length,
    decisionEligibleRuns: decisionEligibleRuns.length,
    warnings,
  };
}

function aggregateAbstention(d: GroupData): QualityAbstention {
  const abstentions = d.proposals.filter(p => p.proposalType === REVIEWABLE_ABSTENTION);
  const resolvedAbstentions = abstentions.filter(p => d.decisions.has(p.id));
  const warnings: string[] = [];
  if (d.proposals.length === 0) {
    warnings.push('No proposals in the group; abstention rate is null.');
  }
  return {
    rate: safeFraction(abstentions.length, d.proposals.length),
    reviewableAbstentions: abstentions.length,
    proposals: d.proposals.length,
    resolvedAbstentions: resolvedAbstentions.length,
    warnings,
  };
}

function aggregateCorrections(d: GroupData): QualityCorrections {
  let accepted = 0;
  let correctedAccepted = 0;
  let adjudicated = 0;
  for (const proposal of d.proposals) {
    const decision = d.decisions.get(proposal.id);
    if (!decision) continue;
    adjudicated += 1;
    if (decision.decision === 'accepted') {
      accepted += 1;
      if (decision.hasRevisedValue || decision.hasRevisedTargetId) correctedAccepted += 1;
    }
  }
  const warnings: string[] = [];
  if (accepted === 0) {
    warnings.push('No live accepted decisions in the group; correction rate is null.');
  }
  return {
    rate: safeFraction(correctedAccepted, accepted),
    correctedAccepted,
    accepted,
    revisionsPer100: safeFraction(correctedAccepted * 100, adjudicated),
    adjudicatedProposals: adjudicated,
    warnings,
  };
}

function aggregateCalibration(d: GroupData): QualityCalibration {
  // Reviewer agreement labels: a proposal with a live accepted/rejected
  // decision is a labeled example; agreement = accepted (1) vs rejected (0).
  // Deferred provides no label. Confidence used is the ORIGINAL prediction
  // confidence — never revised confidence.
  const bins = Array.from({ length: CALIBRATION_BINS }, () => ({ count: 0, correct: 0, confSum: 0 }));
  let sampleCount = 0;
  for (const proposal of d.proposals) {
    if (proposal.confidence === null || proposal.confidence === undefined) continue;
    const decision = d.decisions.get(proposal.id);
    if (!decision) continue;
    if (decision.decision === 'deferred') continue;
    const binIdx = Math.min(CALIBRATION_BINS - 1, Math.floor(proposal.confidence * CALIBRATION_BINS));
    bins[binIdx].count += 1;
    if (decision.decision === 'accepted') bins[binIdx].correct += 1;
    bins[binIdx].confSum += proposal.confidence;
    sampleCount += 1;
  }
  const warnings: string[] = [];
  if (sampleCount === 0) {
    warnings.push('No reviewer-agreement labeled examples (accepted/rejected with confidence) in the group; ECE is null.');
    return { ece: null, bins: [], sampleCount, warnings };
  }
  if (sampleCount < CALIBRATION_MIN_SAMPLE) {
    warnings.push(`ECE sample count ${sampleCount} is below the ${CALIBRATION_MIN_SAMPLE}-example minimum; value is unreliable.`);
  }
  const outBins = bins
    .map((b, bin) => ({ bin, count: b.count, correct: b.correct, confSum: b.confSum }))
    .filter(b => b.count > 0)
    .map(b => {
      if (b.count < CALIBRATION_MIN_BIN_SAMPLE) {
        warnings.push(`Calibration bin ${b.bin} has ${b.count} example(s) (minimum ${CALIBRATION_MIN_BIN_SAMPLE}); under-sampled.`);
      }
      return {
        bin: b.bin,
        count: b.count,
        accuracy: round3(b.correct / b.count),
        avgConfidence: round3(b.confSum / b.count),
      };
    });
  let ece = 0;
  for (const b of outBins) {
    ece += (b.count / sampleCount) * Math.abs(b.accuracy - b.avgConfidence);
  }
  return { ece: round3(ece), bins: outBins, sampleCount, warnings };
}

function aggregateLatency(d: GroupData): QualityLatency {
  const runDurations: number[] = [];
  for (const run of d.runs) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
    if (!run.completedAt) continue;
    const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) continue;
    runDurations.push(ms);
  }
  const callDurations = d.calls
    .filter(c => c.status !== 'started' && typeof c.durationMs === 'number' && c.durationMs !== null && c.durationMs >= 0)
    .map(c => c.durationMs as number);
  runDurations.sort((a, b) => a - b);
  callDurations.sort((a, b) => a - b);
  const warnings: string[] = [];
  if (runDurations.length === 0) {
    warnings.push('No completed runs with timestamps in the group; run latency is null.');
  }
  if (callDurations.length === 0) {
    warnings.push('No terminal model calls with durations in the group; model-call latency is null.');
  }
  return {
    runMedianMs: median(runDurations),
    runP95Ms: percentile(runDurations, 0.95),
    runSampleCount: runDurations.length,
    modelCallMedianMs: median(callDurations),
    modelCallP95Ms: percentile(callDurations, 0.95),
    modelCallSampleCount: callDurations.length,
    warnings,
  };
}

function aggregateCost(d: GroupData): QualityCost {
  const knownCostCalls = d.calls.filter(c => typeof c.estimatedCostUsd === 'number' && c.estimatedCostUsd !== null);
  const tokenCalls = d.calls.filter(
    c => typeof c.promptTokens === 'number' && c.promptTokens !== null && typeof c.completionTokens === 'number' && c.completionTokens !== null,
  );
  const totalKnownUsd = knownCostCalls.reduce((acc, c) => acc + (c.estimatedCostUsd as number), 0);
  const warnings: string[] = [];
  if (d.calls.length === 0) {
    warnings.push('No model calls in the group; cost metrics are null (unknown costs are never imputed or guessed).');
  } else if (knownCostCalls.length === 0) {
    warnings.push('No calls with a known cost basis in the group; cost is null, never a guessed zero.');
  } else if (knownCostCalls.length < d.calls.length) {
    warnings.push(`${d.calls.length - knownCostCalls.length} call(s) have unknown cost and are excluded from known-cost totals.`);
  }
  if (d.calls.length > 0 && tokenCalls.length < d.calls.length) {
    warnings.push(`${d.calls.length - tokenCalls.length} call(s) lack token counts; token coverage is below 100%.`);
  }
  return {
    totalKnownUsd: totalKnownUsd > 0 || knownCostCalls.length > 0 ? round3(totalKnownUsd) : null,
    meanKnownUsd: safeFraction(totalKnownUsd, knownCostCalls.length),
    knownCostCalls: knownCostCalls.length,
    totalCalls: d.calls.length,
    knownCostFraction: safeFraction(knownCostCalls.length, d.calls.length),
    tokenCoverageFraction: safeFraction(tokenCalls.length, d.calls.length),
    warnings,
  };
}

function aggregateGrounding(d: GroupData): QualityGrounding {
  const nonAbstention = d.proposals.filter(p => p.proposalType !== REVIEWABLE_ABSTENTION);
  const withSupporting = nonAbstention.filter(p => p.supportingEvidenceIds.length > 0);
  const withContradicting = nonAbstention.filter(p => p.contradictingEvidenceIds.length > 0);
  // Accepted corrections = accepted decisions that revised value or target.
  let acceptedCorrections = 0;
  let correctionsWithCitations = 0;
  for (const proposal of d.proposals) {
    const decision = d.decisions.get(proposal.id);
    if (!decision || decision.decision !== 'accepted') continue;
    if (decision.hasRevisedValue || decision.hasRevisedTargetId) {
      acceptedCorrections += 1;
      if (decision.evidenceIds.length > 0) correctionsWithCitations += 1;
    }
  }
  const warnings: string[] = [];
  if (nonAbstention.length === 0) {
    warnings.push('No non-abstention proposals in the group; grounding coverage is null.');
  }
  if (acceptedCorrections === 0) {
    warnings.push('No accepted corrections in the group; correction-citation coverage is null.');
  }
  return {
    supportingCitationCoverage: safeFraction(withSupporting.length, nonAbstention.length),
    contradictionRate: safeFraction(withContradicting.length, nonAbstention.length),
    correctionCitationCoverage: safeFraction(correctionsWithCitations, acceptedCorrections),
    proposalsWithSupporting: withSupporting.length,
    proposalsWithContradicting: withContradicting.length,
    nonAbstentionProposals: nonAbstention.length,
    correctionsWithCitations,
    acceptedCorrections,
    warnings,
  };
}

// ─── Group assembly ───────────────────────────────────────────────────────────

function groupKey(run: QualityRunInput, snapshot: QualitySnapshotDigest | null): string {
  return [
    run.configSnapshotHash ?? '',
    snapshot?.modelPlanDigest ?? '',
    snapshot?.ruleVersionsDigest ?? '',
    run.sourceKind ?? '',
  ].join('|');
}

function makeEmptyGroup(identity: {
  configSnapshotHash: string | null;
  modelPlanDigest: string | null;
  ruleVersionsDigest: string | null;
  sourceKind: string | null;
}): QualityVersionGroup {
  return {
    ...identity,
    proposalTypes: {},
    modelRoutes: [],
    reviewAgreement: { precision: null, acceptedUnchanged: 0, acceptedCorrected: 0, rejected: 0, deferred: 0, warnings: [] },
    coverage: { value: null, eligibleRuns: 0, decisionEligibleRuns: 0, warnings: [] },
    abstention: { rate: null, reviewableAbstentions: 0, proposals: 0, resolvedAbstentions: 0, warnings: [] },
    corrections: { rate: null, correctedAccepted: 0, accepted: 0, revisionsPer100: null, adjudicatedProposals: 0, warnings: [] },
    calibration: { ece: null, bins: [], sampleCount: 0, warnings: [] },
    grounding: {
      supportingCitationCoverage: null,
      contradictionRate: null,
      correctionCitationCoverage: null,
      proposalsWithSupporting: 0,
      proposalsWithContradicting: 0,
      nonAbstentionProposals: 0,
      correctionsWithCitations: 0,
      acceptedCorrections: 0,
      warnings: [],
    },
    latency: {
      runMedianMs: null,
      runP95Ms: null,
      runSampleCount: 0,
      modelCallMedianMs: null,
      modelCallP95Ms: null,
      modelCallSampleCount: 0,
      warnings: [],
    },
    cost: {
      totalKnownUsd: null,
      meanKnownUsd: null,
      knownCostCalls: 0,
      totalCalls: 0,
      knownCostFraction: null,
      tokenCoverageFraction: null,
      warnings: [],
    },
    warnings: [],
  };
}

/**
 * Compute the versioned production quality report over the provided raw rows.
 * Deterministic for a fixed input: all grouping keys and outputs are
 * canonical/ordered, and `generatedAt` is an explicit input (never Date.now()).
 */
export function computeQualityReport(input: QualityMetricsInput): QualityReport {
  const snapshotsByHash = new Map<string, QualitySnapshotDigest>();
  for (const snap of input.snapshots) snapshotsByHash.set(snap.configSnapshotHash, snap);

  // Group runs by their version identity; proposals and calls inherit the
  // run's group (a run without a proposal still contributes latency/cost).
  const groups = new Map<string, QualityVersionGroup>();
  const runGroupKey = new Map<string, string>();
  const groupData = new Map<string, GroupData>();

  const globalWarnings: string[] = [];

  for (const run of input.runs) {
    const snapshot = run.configSnapshotHash ? snapshotsByHash.get(run.configSnapshotHash) ?? null : null;
    const key = groupKey(run, snapshot);
    runGroupKey.set(run.id, key);
    if (!groups.has(key)) {
      const identity = {
        configSnapshotHash: run.configSnapshotHash ?? null,
        modelPlanDigest: snapshot?.modelPlanDigest ?? null,
        ruleVersionsDigest: snapshot?.ruleVersionsDigest ?? null,
        sourceKind: run.sourceKind ?? null,
      };
      groups.set(key, makeEmptyGroup(identity));
      groupData.set(key, { runs: [], proposals: [], decisions: new Map(), calls: [], snapshot, warnings: [] });
    }
    const data = groupData.get(key)!;
    data.runs.push(run);
    // Unresolvable snapshot on a terminal run is a global warning (legacy
    // denominator exclusion), never a miss.
    if (TERMINAL_RUN_STATUSES.has(run.status) && run.configSnapshotHash && !snapshot) {
      globalWarnings.push(
        `Run ${run.id} (${run.productSku}) has an unresolvable config snapshot hash; excluded from coverage denominators (legacy).`,
      );
    }
    if (TERMINAL_RUN_STATUSES.has(run.status) && snapshot && snapshot.schemaVersion !== 2) {
      globalWarnings.push(
        `Run ${run.id} (${run.productSku}) uses a legacy schema-v${snapshot.schemaVersion} snapshot; target enablement is unknown and the run is excluded from coverage denominators.`,
      );
    }
  }

  for (const proposal of input.proposals) {
    const key = runGroupKey.get(proposal.runId);
    if (!key) {
      // Orphan/unlinked proposal: not attributable to any window run.
      globalWarnings.push(`Proposal ${proposal.id} references an unlisted run ${proposal.runId}; excluded from the report.`);
      continue;
    }
    const data = groupData.get(key)!;
    data.proposals.push(proposal);
    const group = groups.get(key)!;
    group.proposalTypes[proposal.proposalType] = (group.proposalTypes[proposal.proposalType] ?? 0) + 1;
  }

  for (const decision of input.decisions) {
    const proposal = input.proposals.find(p => p.id === decision.proposalId);
    if (!proposal) {
      globalWarnings.push(`Decision for unknown proposal ${decision.proposalId}; excluded.`);
      continue;
    }
    const key = runGroupKey.get(proposal.runId);
    if (!key) continue;
    groupData.get(key)!.decisions.set(decision.proposalId, decision);
  }

  for (const call of input.modelCalls) {
    const key = runGroupKey.get(call.runId);
    if (!key) {
      globalWarnings.push(`Model call for unlisted run ${call.runId}; excluded from cost/latency.`);
      continue;
    }
    const data = groupData.get(key)!;
    data.calls.push(call);
  }

  // Model routes per group: count by provider/model, sorted for determinism.
  for (const [key, data] of groupData) {
    const routeCounts = new Map<string, { provider: string; model: string; count: number }>();
    for (const call of data.calls) {
      const provider = call.provider ?? 'unknown';
      const model = call.model ?? 'unknown';
      const routeKey = `${provider}\u0000${model}`;
      const existing = routeCounts.get(routeKey);
      if (existing) existing.count += 1;
      else routeCounts.set(routeKey, { provider, model, count: 1 });
    }
    const routes: QualityModelRoute[] = [...routeCounts.values()].sort((a, b) =>
      a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider),
    );
    groups.get(key)!.modelRoutes = routes;
  }

  // Aggregate each group's metrics.
  for (const [key, data] of groupData) {
    const group = groups.get(key)!;
    group.reviewAgreement = aggregateReviewAgreement(data);
    group.coverage = aggregateCoverage(data);
    group.abstention = aggregateAbstention(data);
    group.corrections = aggregateCorrections(data);
    group.calibration = aggregateCalibration(data);
    group.latency = aggregateLatency(data);
    group.cost = aggregateCost(data);
    group.grounding = aggregateGrounding(data);
    group.warnings = [...group.reviewAgreement.warnings, ...group.coverage.warnings, ...group.abstention.warnings,
      ...group.corrections.warnings, ...group.calibration.warnings, ...group.latency.warnings, ...group.cost.warnings,
      ...group.grounding.warnings].filter((v, i, arr) => arr.indexOf(v) === i);
  }

  const sampleCounts: QualitySampleCounts = {
    runs: input.runs.length,
    completedRuns: input.runs.filter(r => TERMINAL_RUN_STATUSES.has(r.status)).length,
    eligibleRuns: [...groups.values()].reduce((acc, g) => acc + g.coverage.eligibleRuns, 0),
    proposals: input.proposals.length,
    liveDecisions: input.decisions.length,
    modelCalls: input.modelCalls.length,
  };

  return {
    schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
    metricDefinitionVersion: QUALITY_METRIC_DEFINITION_VERSION,
    workspaceId: input.workspaceId,
    window: { start: input.start, end: input.end },
    sourceWatermark: input.sourceWatermark,
    generatedAt: input.generatedAt,
    sampleCounts,
    groups: [...groups.values()].sort((a, b) => {
      const ka = `${a.configSnapshotHash ?? ''}|${a.modelPlanDigest ?? ''}|${a.ruleVersionsDigest ?? ''}|${a.sourceKind ?? ''}`;
      const kb = `${b.configSnapshotHash ?? ''}|${b.modelPlanDigest ?? ''}|${b.ruleVersionsDigest ?? ''}|${b.sourceKind ?? ''}`;
      return ka.localeCompare(kb);
    }),
    warnings: globalWarnings,
  };
}
