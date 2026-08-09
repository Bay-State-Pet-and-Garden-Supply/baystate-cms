import { describe, it, expect } from 'vitest';
import {
  deriveQualityDisplay,
  formatQualityWindow,
} from '../../client/classification-metrics-view';
import { computeQualityReport } from '../../classification/production-metrics';
import type { QualityReport } from '../../shared/schemas/classification-metrics';

const HASH = 'a'.repeat(64);

function sampleReport(): QualityReport {
  return computeQualityReport({
    workspaceId: 'ws1',
    start: '2026-08-01T00:00:00.000Z',
    end: '2026-08-08T00:00:00.000Z',
    sourceWatermark: '2026-08-08T00:00:00.000Z',
    generatedAt: '2026-08-08T00:00:01.000Z',
    runs: [
      {
        id: 'r1', sourceKind: 'catalog_product', sourceProductHash: 'p', productSku: 'SKU-1',
        configSnapshotHash: HASH, status: 'completed',
        startedAt: '2026-08-02T00:00:00.000Z', completedAt: '2026-08-02T00:01:00.000Z',
      },
    ],
    proposals: [
      {
        id: 'p1', runId: 'r1', proposalType: 'primary_product_type', targetId: null,
        confidence: 0.9, status: 'pending', isStale: false,
        supportingEvidenceIds: ['e1'], contradictingEvidenceIds: [],
        configSnapshotHash: HASH, sourceKind: 'catalog_product',
      },
      {
        id: 'p2', runId: 'r1', proposalType: 'field_assignment', targetId: 'flavor',
        confidence: 0.7, status: 'pending', isStale: false,
        supportingEvidenceIds: [], contradictingEvidenceIds: ['e2'],
        configSnapshotHash: HASH, sourceKind: 'catalog_product',
      },
    ],
    decisions: [
      { proposalId: 'p1', decision: 'accepted', hasRevisedValue: false, hasRevisedTargetId: false, evidenceIds: [] },
      { proposalId: 'p2', decision: 'rejected', hasRevisedValue: false, hasRevisedTargetId: false, evidenceIds: [] },
    ],
    modelCalls: [
      { runId: 'r1', provider: 'ollama', model: 'qwen2.5vl', status: 'success', durationMs: 150, promptTokens: 100, completionTokens: 40, estimatedCostUsd: 0, costBasis: 'local_zero' },
    ],
    snapshots: [{ configSnapshotHash: HASH, schemaVersion: 2, modelPlanDigest: 'plan', ruleVersionsDigest: 'rules', enabledTargets: true }],
  });
}

describe('deriveQualityDisplay (issue #17 F)', () => {
  it('returns a safe empty display for a null report', () => {
    const d = deriveQualityDisplay(null);
    expect(d.hasGroups).toBe(false);
    expect(d.groupRows).toEqual([]);
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.summaryRows.some(r => r.value === 'n/a')).toBe(true);
  });

  it('derives summary rows with honest n/a and denominators', () => {
    const d = deriveQualityDisplay(sampleReport());
    expect(d.summaryRows.length).toBeGreaterThan(0);
    const runsRow = d.summaryRows.find(r => r.label === 'Runs (window)');
    expect(runsRow?.value).toBe('1');
    const precisionRow = d.summaryRows.find(r => r.label === 'Review precision');
    expect(precisionRow?.value).toBe('50.0%');
    expect(precisionRow?.denominator).toContain('uncorrected 1');
  });

  it('derives version group rows without combining identities', () => {
    const d = deriveQualityDisplay(sampleReport());
    expect(d.hasGroups).toBe(true);
    expect(d.groupRows).toHaveLength(1);
    const g = d.groupRows[0];
    expect(g.configSnapshotHash).toBe(HASH);
    expect(g.modelPlanDigest).toBe('plan');
    expect(g.ruleVersionsDigest).toBe('rules');
    expect(g.sourceKind).toBe('catalog_product');
    expect(g.precision).toBe('50.0%');
    expect(g.coverage).toBe('100.0%');
    expect(g.modelRoutes).toContain('ollama/qwen2.5vl×1');
    expect(g.totalKnownCost).toBe('$0.00');
  });

  it('aggregates warnings from the report and groups', () => {
    const report = sampleReport();
    report.warnings = ['global warning'];
    report.groups[0].warnings = ['group warning'];
    const d = deriveQualityDisplay(report);
    expect(d.warnings.some(w => w === 'global warning')).toBe(true);
    expect(d.warnings.some(w => w.endsWith('group warning'))).toBe(true);
  });

  it('formats the window label from the report', () => {
    expect(formatQualityWindow(sampleReport())).toBe('2026-08-01 → 2026-08-08 (UTC)');
    expect(formatQualityWindow(null)).toBe('no window');
  });
});
