import { describe, it, expect } from 'vitest';
import {
  computeQualityReport,
  type QualityMetricsInput,
} from '../../classification/production-metrics';
import { QualityReportSchema } from '../../shared/schemas/classification-metrics';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PLAN_A = 'plan-a'.padEnd(64, '0');
const PLAN_B = 'plan-b'.padEnd(64, '0');
const RULES_A = 'rules-a'.padEnd(64, '0');
const RULES_B = 'rules-b'.padEnd(64, '0');

function baseInput(overrides: Partial<QualityMetricsInput> = {}): QualityMetricsInput {
  return {
    workspaceId: 'ws1',
    start: '2026-08-01T00:00:00.000Z',
    end: '2026-08-08T00:00:00.000Z',
    sourceWatermark: '2026-08-08T00:00:00.000Z',
    generatedAt: '2026-08-08T00:00:01.000Z',
    runs: [],
    proposals: [],
    decisions: [],
    modelCalls: [],
    snapshots: [],
    ...overrides,
  };
}

function snap(hash: string, opts: { plan?: string; rules?: string; enabled?: boolean; schema?: 1 | 2 } = {}) {
  return {
    configSnapshotHash: hash,
    schemaVersion: opts.schema ?? 2,
    modelPlanDigest: opts.plan ?? PLAN_A,
    ruleVersionsDigest: opts.rules ?? RULES_A,
    enabledTargets: opts.enabled ?? true,
  };
}

function run(id: string, opts: { hash?: string; kind?: string; status?: string; start?: string; end?: string } = {}) {
  return {
    id,
    sourceKind: opts.kind ?? 'catalog_product',
    sourceProductHash: 'sp-' + id,
    productSku: 'SKU-' + id,
    configSnapshotHash: opts.hash ?? HASH_A,
    status: opts.status ?? 'completed',
    startedAt: opts.start ?? '2026-08-02T00:00:00.000Z',
    completedAt: opts.end ?? '2026-08-02T00:01:00.000Z',
  };
}

function proposal(id: string, opts: { runId?: string; type?: string; confidence?: number | null } = {}) {
  return {
    id,
    runId: opts.runId ?? 'r1',
    proposalType: opts.type ?? 'primary_product_type',
    targetId: null,
    confidence: opts.confidence ?? 0.9,
    status: 'pending',
    isStale: false,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    configSnapshotHash: HASH_A,
    sourceKind: 'catalog_product',
  };
}

function decision(proposalId: string, opts: { decision?: 'accepted' | 'rejected' | 'deferred'; revised?: boolean; citations?: string[] } = {}) {
  return {
    proposalId,
    decision: opts.decision ?? 'accepted',
    hasRevisedValue: opts.revised ?? false,
    hasRevisedTargetId: false,
    evidenceIds: opts.citations ?? [],
  };
}

function call(runId: string, opts: { provider?: string; model?: string; status?: string; durationMs?: number | null; tokens?: boolean; cost?: number | null } = {}) {
  return {
    runId,
    provider: opts.provider ?? 'ollama',
    model: opts.model ?? 'qwen',
    status: opts.status ?? 'success',
    durationMs: opts.durationMs ?? 120,
    promptTokens: opts.tokens === false ? null : 100,
    completionTokens: opts.tokens === false ? null : 40,
    estimatedCostUsd: opts.cost === undefined ? 0 : opts.cost,
    costBasis: opts.cost === undefined ? 'local_zero' : opts.cost === null ? 'unknown' : 'reviewed',
  };
}

function reportValid(input: QualityMetricsInput) {
  const report = computeQualityReport(input);
  const parsed = QualityReportSchema.safeParse(report);
  expect(parsed.success).toBe(true);
  return parsed.data ?? report;
}

describe('computeQualityReport (issue #17 F)', () => {
  it('is deterministic for a fixed input', () => {
    const input = baseInput({
      runs: [run('r1'), run('r2', { hash: HASH_B })],
      proposals: [proposal('p1'), proposal('p2', { runId: 'r2' })],
      decisions: [decision('p1'), decision('p2', { decision: 'rejected' })],
      modelCalls: [call('r1'), call('r2')],
      snapshots: [snap(HASH_A), snap(HASH_B, { plan: PLAN_B, rules: RULES_B })],
    });
    const a = computeQualityReport(input);
    const b = computeQualityReport(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
  });

  it('computes exact reviewAgreementPrecision (unchanged/corrected/rejected, deferred excluded)', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [
        proposal('p-unchanged', { confidence: 0.9 }),
        proposal('p-corrected', { confidence: 0.8 }),
        proposal('p-rejected', { confidence: 0.7 }),
        proposal('p-deferred', { confidence: 0.6 }),
      ],
      decisions: [
        decision('p-unchanged'),
        decision('p-corrected', { revised: true }),
        decision('p-rejected', { decision: 'rejected' }),
        decision('p-deferred', { decision: 'deferred' }),
      ],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    expect(g.reviewAgreement.acceptedUnchanged).toBe(1);
    expect(g.reviewAgreement.acceptedCorrected).toBe(1);
    expect(g.reviewAgreement.rejected).toBe(1);
    expect(g.reviewAgreement.deferred).toBe(1);
    // precision = 1 / (1 + 1 + 1)
    expect(g.reviewAgreement.precision).toBeCloseTo(1 / 3, 5);
    expect(g.reviewAgreement.warnings.some(w => /deferred/.test(w))).toBe(true);
  });

  it('returns null precision (never a misleading zero) when no decided proposals exist', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p-pending')],
      decisions: [],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    expect(report.groups[0].reviewAgreement.precision).toBeNull();
    expect(report.groups[0].reviewAgreement.warnings.length).toBeGreaterThan(0);
  });

  it('computes coverage over eligible runs only and excludes legacy/unresolvable denominators with warnings', () => {
    const input = baseInput({
      runs: [
        run('r1'), // v2, enabled
        run('r2', { hash: HASH_B, status: 'failed' }), // failed → not eligible
        run('r3', { hash: 'legacy-hash' }), // unresolvable snapshot → excluded + warned
        run('r4', { hash: 'v1-hash' }), // schema-v1 → excluded + warned
      ],
      proposals: [proposal('p1', { runId: 'r1' })],
      decisions: [decision('p1')],
      snapshots: [
        snap(HASH_A),
        { configSnapshotHash: 'v1-hash', schemaVersion: 1, modelPlanDigest: null, ruleVersionsDigest: null, enabledTargets: false },
      ],
    });
    const report = reportValid(input);
    expect(report.sampleCounts.runs).toBe(4);
    expect(report.groups[0].coverage.eligibleRuns).toBe(1);
    expect(report.groups[0].coverage.decisionEligibleRuns).toBe(1);
    expect(report.groups[0].coverage.value).toBe(1);
    // Legacy warnings present (unresolvable + v1 + failed run is silently not eligible).
    expect(report.warnings.some(w => /unresolvable config snapshot/.test(w))).toBe(true);
    expect(report.warnings.some(w => /legacy schema-v1/.test(w))).toBe(true);
  });

  it('returns null coverage (no misleading zero) when eligible runs exist but none is decision-eligible', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p-pending')],
      decisions: [], // no live decisions
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    expect(report.groups[0].coverage.value).toBeNull();
    expect(report.groups[0].coverage.eligibleRuns).toBe(1);
    expect(report.groups[0].coverage.decisionEligibleRuns).toBe(0);
  });

  it('computes correction rate and revisions per 100 adjudicated proposals', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [
        proposal('p1'), // accepted corrected
        proposal('p2'), // accepted unchanged
        proposal('p3'), // rejected
        proposal('p4'), // deferred
      ],
      decisions: [
        decision('p1', { revised: true }),
        decision('p2'),
        decision('p3', { decision: 'rejected' }),
        decision('p4', { decision: 'deferred' }),
      ],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    expect(g.corrections.accepted).toBe(2);
    expect(g.corrections.correctedAccepted).toBe(1);
    expect(g.corrections.rate).toBeCloseTo(0.5, 5);
    expect(g.corrections.adjudicatedProposals).toBe(4); // deferred counts as adjudicated
    expect(g.corrections.revisionsPer100).toBeCloseTo(25, 5); // 1/4 * 100
  });

  it('computes ECE over original confidence vs reviewer-agreement labels, with min-sample warnings', () => {
    // 10 accepted at 0.95 (bin 9), 10 rejected at 0.55 (bin 5): ECE =
    // (10/20)|1 - 0.95| + (10/20)|0 - 0.55| = 0.025 + 0.275 = 0.30
    const proposals = [] as ReturnType<typeof proposal>[];
    const decisions = [] as ReturnType<typeof decision>[];
    for (let i = 0; i < 10; i++) {
      proposals.push(proposal(`acc-${i}`, { confidence: 0.95 }));
      decisions.push(decision(`acc-${i}`));
    }
    for (let i = 0; i < 10; i++) {
      proposals.push(proposal(`rej-${i}`, { confidence: 0.55 }));
      decisions.push(decision(`rej-${i}`, { decision: 'rejected' }));
    }
    const input = baseInput({ runs: [run('r1')], proposals, decisions, snapshots: [snap(HASH_A)] });
    const report = reportValid(input);
    const cal = report.groups[0].calibration;
    expect(cal.sampleCount).toBe(20);
    expect(cal.ece).toBeCloseTo(0.3, 3);
    expect(cal.bins.some(b => b.bin === 9 && b.accuracy === 1 && b.avgConfidence === 0.95)).toBe(true);
    // 20 is exactly the minimum sample; bins have 10 each ≥ 5 → no min-bin warning.
    expect(cal.warnings.some(w => /minimum/.test(w))).toBe(false);
  });

  it('warns on low ECE sample and returns null when no labeled examples exist', () => {
    const lowInput = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p1', { confidence: 0.9 }), proposal('p2', { confidence: 0.8 })],
      decisions: [decision('p1'), decision('p2', { decision: 'rejected' })],
      snapshots: [snap(HASH_A)],
    });
    const lowReport = reportValid(lowInput);
    expect(lowReport.groups[0].calibration.sampleCount).toBe(2);
    expect(lowReport.groups[0].calibration.warnings.some(w => /below the 20-example minimum/.test(w))).toBe(true);

    const emptyInput = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p1', { confidence: 0.9 }), proposal('p2', { confidence: 0.8 })],
      decisions: [decision('p1', { decision: 'deferred' }), decision('p2', { decision: 'deferred' })],
      snapshots: [snap(HASH_A)],
    });
    const emptyReport = reportValid(emptyInput);
    expect(emptyReport.groups[0].calibration.ece).toBeNull();
    expect(emptyReport.groups[0].calibration.sampleCount).toBe(0);
  });

  it('computes latency percentiles and honest cost metrics', () => {
    const input = baseInput({
      runs: [
        run('r1', { start: '2026-08-02T00:00:00.000Z', end: '2026-08-02T00:00:10.000Z' }), // 10000 ms
        run('r2', { start: '2026-08-02T00:00:00.000Z', end: '2026-08-02T00:00:20.000Z' }), // 20000 ms
        run('r3', { start: '2026-08-02T00:00:00.000Z', end: '2026-08-02T00:00:40.000Z' }), // 40000 ms
      ],
      proposals: [],
      decisions: [],
      modelCalls: [
        call('r1', { durationMs: 100, tokens: true, cost: 0 }),
        call('r1', { durationMs: 300, tokens: false, cost: null }), // unknown cost + no tokens
        call('r2', { durationMs: 200, tokens: true, cost: 0 }),
      ],
      snapshots: [snap(HASH_A), snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    expect(g.latency.runSampleCount).toBe(3);
    expect(g.latency.runMedianMs).toBe(20000);
    expect(g.latency.runP95Ms).toBeCloseTo(38000, 0); // 20000 + 0.95*(40000-20000)
    expect(g.latency.modelCallSampleCount).toBe(3);
    expect(g.latency.modelCallMedianMs).toBe(200);
    expect(g.cost.totalCalls).toBe(3);
    expect(g.cost.knownCostCalls).toBe(2);
    expect(g.cost.totalKnownUsd).toBe(0);
    expect(g.cost.knownCostFraction).toBeCloseTo(2 / 3, 5);
    expect(g.cost.tokenCoverageFraction).toBeCloseTo(2 / 3, 5);
    expect(g.cost.warnings.some(w => /unknown cost/.test(w))).toBe(true);
    expect(g.cost.warnings.some(w => /token counts/.test(w))).toBe(true);
  });

  it('never emits a guessed zero cost when only unknown costs exist', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [],
      decisions: [],
      modelCalls: [call('r1', { cost: null })],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    // Totals stay null (no known cost), but the coverage fraction is an honest
    // 0 (0 known-cost calls out of 1 call).
    expect(g.cost.totalKnownUsd).toBeNull();
    expect(g.cost.meanKnownUsd).toBeNull();
    expect(g.cost.knownCostCalls).toBe(0);
    expect(g.cost.totalCalls).toBe(1);
    expect(g.cost.knownCostFraction).toBe(0);
  });

  it('computes grounding (supporting coverage, contradiction rate, correction citations)', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [
        { ...proposal('p1'), supportingEvidenceIds: ['e1'] },
        { ...proposal('p2'), contradictingEvidenceIds: ['e2'] },
        { ...proposal('p3', { type: 'reviewable_abstention' }) }, // excluded from grounding denominator
        { ...proposal('p4') }, // no evidence
      ],
      decisions: [
        decision('p1', { revised: true, citations: ['e1'] }),
        decision('p2'),
        decision('p4', { revised: true }), // accepted correction WITHOUT citation
      ],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    expect(g.grounding.nonAbstentionProposals).toBe(3);
    expect(g.grounding.proposalsWithSupporting).toBe(1);
    expect(g.grounding.supportingCitationCoverage).toBeCloseTo(1 / 3, 5);
    expect(g.grounding.proposalsWithContradicting).toBe(1);
    expect(g.grounding.contradictionRate).toBeCloseTo(1 / 3, 5);
    expect(g.grounding.acceptedCorrections).toBe(2);
    expect(g.grounding.correctionsWithCitations).toBe(1);
    expect(g.grounding.correctionCitationCoverage).toBeCloseTo(0.5, 5);
  });

  it('keeps version groups separate when config/plan/rule/source identities differ', () => {
    const input = baseInput({
      runs: [
        run('r1', { hash: HASH_A, kind: 'catalog_product' }),
        run('r2', { hash: HASH_B, kind: 'onboarding' }),
      ],
      proposals: [proposal('p1'), proposal('p2', { runId: 'r2' })],
      decisions: [decision('p1'), decision('p2', { decision: 'rejected' })],
      modelCalls: [call('r1'), call('r2', { provider: 'deepseek', model: 'deepseek-v4' })],
      snapshots: [snap(HASH_A), snap(HASH_B, { plan: PLAN_B, rules: RULES_B })],
    });
    const report = reportValid(input);
    expect(report.groups).toHaveLength(2);
    const gA = report.groups.find(g => g.configSnapshotHash === HASH_A)!;
    const gB = report.groups.find(g => g.configSnapshotHash === HASH_B)!;
    expect(gA.modelPlanDigest).toBe(PLAN_A);
    expect(gB.modelPlanDigest).toBe(PLAN_B);
    expect(gA.sourceKind).toBe('catalog_product');
    expect(gB.sourceKind).toBe('onboarding');
    expect(gA.modelRoutes).toEqual([{ provider: 'ollama', model: 'qwen', count: 1 }]);
    expect(gB.modelRoutes).toEqual([{ provider: 'deepseek', model: 'deepseek-v4', count: 1 }]);
    // Model/plan identities never combine: p1 metrics only in gA, p2 only in gB.
    expect(gA.reviewAgreement.acceptedUnchanged).toBe(1);
    expect(gB.reviewAgreement.rejected).toBe(1);
  });

  it('computes abstention rate and resolved abstentions', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [
        proposal('a1', { type: 'reviewable_abstention' }),
        proposal('a2', { type: 'reviewable_abstention' }),
        proposal('p1'),
        proposal('p2'),
      ],
      decisions: [decision('a1', { decision: 'accepted' }), decision('p1')],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const g = report.groups[0];
    expect(g.abstention.reviewableAbstentions).toBe(2);
    expect(g.abstention.proposals).toBe(4);
    expect(g.abstention.rate).toBeCloseTo(0.5, 5);
    expect(g.abstention.resolvedAbstentions).toBe(1);
  });

  it('excludes orphan proposals and calls from unlisted runs with warnings', () => {
    const input = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p1'), proposal('p-orphan', { runId: 'ghost-run' })],
      decisions: [decision('p1')],
      modelCalls: [call('r1'), call('ghost-run')],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    expect(report.warnings.some(w => /unlisted run ghost-run/.test(w))).toBe(true);
    expect(report.groups[0].abstention.proposals).toBe(1);
  });

  it('uses original confidence, never revised confidence, in calibration', () => {
    // A corrected proposal: original confidence 0.9; revised value present.
    const input = baseInput({
      runs: [run('r1')],
      proposals: [proposal('p1', { confidence: 0.9 })],
      decisions: [decision('p1', { revised: true })],
      snapshots: [snap(HASH_A)],
    });
    const report = reportValid(input);
    const cal = report.groups[0].calibration;
    const bin9 = cal.bins.find(b => b.bin === 9);
    expect(bin9?.avgConfidence).toBeCloseTo(0.9, 5);
  });
});
