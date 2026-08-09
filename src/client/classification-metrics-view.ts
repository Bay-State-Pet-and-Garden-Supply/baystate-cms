/**
 * Pure display derivation for the classification quality report (issue #17 F).
 *
 * No DOM, no React — just deterministic formatting of a QualityReport into
 * summary strings, warnings, and per-version-group display rows. The weekly
 * report modal and (optionally) a settings panel consume this helper so the
 * same formatting logic is tested once without a DOM harness.
 */
import type {
  QualityReport,
  QualityVersionGroup,
} from '../shared/schemas/classification-metrics';

function fmtPercent(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNumber(value: number | null, digits = 2): string {
  if (value === null) return 'n/a';
  return value.toFixed(digits);
}

function fmtMs(value: number | null): string {
  if (value === null) return 'n/a';
  return `${Math.round(value)} ms`;
}

export interface QualitySummaryRow {
  label: string;
  value: string;
  denominator: string;
}

export interface QualityGroupRow {
  groupLabel: string;
  configSnapshotHash: string;
  modelPlanDigest: string;
  ruleVersionsDigest: string;
  sourceKind: string;
  proposalTypes: string;
  modelRoutes: string;
  precision: string;
  coverage: string;
  correctionRate: string;
  abstentionRate: string;
  ece: string;
  supportingCoverage: string;
  contradictionRate: string;
  runLatencyMedian: string;
  callLatencyMedian: string;
  totalKnownCost: string;
}

export interface QualityDisplay {
  summaryRows: QualitySummaryRow[];
  warnings: string[];
  groupRows: QualityGroupRow[];
  hasGroups: boolean;
}

function shortHash(hash: string | null): string {
  if (!hash) return 'legacy';
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

/** Derive display rows from a validated QualityReport. Pure and deterministic. */
export function deriveQualityDisplay(report: QualityReport | null): QualityDisplay {
  if (!report) {
    return {
      summaryRows: [
        { label: 'Precision', value: 'n/a', denominator: 'no report' },
        { label: 'Coverage', value: 'n/a', denominator: 'no report' },
      ],
      warnings: ['No quality report available.'],
      groupRows: [],
      hasGroups: false,
    };
  }

  const s = report.sampleCounts;
  const summaryRows: QualitySummaryRow[] = [
    { label: 'Runs (window)', value: String(s.runs), denominator: `eligible ${s.eligibleRuns}` },
    { label: 'Proposals', value: String(s.proposals), denominator: `decisions ${s.liveDecisions}` },
    { label: 'Model calls', value: String(s.modelCalls), denominator: 'terminal only for cost' },
  ];

  // Aggregate across version groups for the top-line summary (each metric is
  // summed/null-safe; the version groups themselves carry the per-version truth).
  let acceptedUnchanged = 0;
  let acceptedCorrected = 0;
  let rejected = 0;
  let eligibleRuns = 0;
  let decisionEligibleRuns = 0;
  let anyGroupCoverageNonNull = false;
  let correctedAccepted = 0;
  let accepted = 0;
  let abstentions = 0;
  let proposals = 0;
  for (const g of report.groups) {
    acceptedUnchanged += g.reviewAgreement.acceptedUnchanged;
    acceptedCorrected += g.reviewAgreement.acceptedCorrected;
    rejected += g.reviewAgreement.rejected;
    eligibleRuns += g.coverage.eligibleRuns;
    decisionEligibleRuns += g.coverage.decisionEligibleRuns;
    if (g.coverage.value !== null) anyGroupCoverageNonNull = true;
    correctedAccepted += g.corrections.correctedAccepted;
    accepted += g.corrections.accepted;
    abstentions += g.abstention.reviewableAbstentions;
    proposals += g.abstention.proposals;
  }
  const precisionDen = acceptedUnchanged + acceptedCorrected + rejected;
  summaryRows.push({
    label: 'Review precision',
    value: precisionDen > 0 ? fmtPercent(acceptedUnchanged / precisionDen) : 'n/a',
    denominator: `uncorrected ${acceptedUnchanged} / total decided ${precisionDen}`,
  });
  summaryRows.push({
    label: 'Coverage',
    // Never a misleading zero: when eligible runs exist but no group has a
    // non-null coverage value (no decision-eligible proposals anywhere), the
    // metric is honestly 'n/a' — mirroring the group-level null semantics.
    value:
      eligibleRuns > 0 && (decisionEligibleRuns > 0 || anyGroupCoverageNonNull)
        ? fmtPercent(decisionEligibleRuns / eligibleRuns)
        : 'n/a',
    denominator: `decision-eligible ${decisionEligibleRuns} / eligible ${eligibleRuns}`,
  });
  summaryRows.push({
    label: 'Correction rate',
    value: accepted > 0 ? fmtPercent(correctedAccepted / accepted) : 'n/a',
    denominator: `corrected ${correctedAccepted} / accepted ${accepted}`,
  });
  summaryRows.push({
    label: 'Abstention rate',
    value: proposals > 0 ? fmtPercent(abstentions / proposals) : 'n/a',
    denominator: `abstentions ${abstentions} / proposals ${proposals}`,
  });

  const groupRows: QualityGroupRow[] = report.groups.map((g: QualityVersionGroup) => ({
    groupLabel: `v:${shortHash(g.configSnapshotHash)} p:${shortHash(g.modelPlanDigest)} r:${shortHash(g.ruleVersionsDigest)}`,
    configSnapshotHash: g.configSnapshotHash ?? 'legacy',
    modelPlanDigest: g.modelPlanDigest ?? 'n/a',
    ruleVersionsDigest: g.ruleVersionsDigest ?? 'n/a',
    sourceKind: g.sourceKind ?? 'unknown',
    proposalTypes: Object.entries(g.proposalTypes)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(', '),
    modelRoutes: g.modelRoutes.map(r => `${r.provider}/${r.model}×${r.count}`).join(', ') || 'none',
    precision: fmtPercent(g.reviewAgreement.precision),
    coverage: fmtPercent(g.coverage.value),
    correctionRate: fmtPercent(g.corrections.rate),
    abstentionRate: fmtPercent(g.abstention.rate),
    ece: fmtNumber(g.calibration.ece),
    supportingCoverage: fmtPercent(g.grounding.supportingCitationCoverage),
    contradictionRate: fmtPercent(g.grounding.contradictionRate),
    runLatencyMedian: fmtMs(g.latency.runMedianMs),
    callLatencyMedian: fmtMs(g.latency.modelCallMedianMs),
    totalKnownCost: g.cost.totalKnownUsd === null ? 'n/a' : `$${fmtNumber(g.cost.totalKnownUsd)}`,
  }));

  const warnings = [...report.warnings];
  for (const g of report.groups) {
    for (const w of g.warnings) warnings.push(`${shortHash(g.configSnapshotHash)}: ${w}`);
  }

  return { summaryRows, warnings: [...new Set(warnings)], groupRows, hasGroups: groupRows.length > 0 };
}

/** One-line formatted window label for UI headers. */
export function formatQualityWindow(report: QualityReport | null): string {
  if (!report) return 'no window';
  return `${report.window.start.slice(0, 10)} → ${report.window.end.slice(0, 10)} (UTC)`;
}
