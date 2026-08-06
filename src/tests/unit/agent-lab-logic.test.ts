/**
 * Agent Lab pure logic tests (PI-7).
 */

import { describe, it, expect } from 'vitest';
import {
  validateRunLaunch,
  buildRunLaunchPayload,
  EVENT_PRESENTATION,
  toTimelineItems,
  mergeEventStream,
  isTerminalEvent,
  deriveFieldStatus,
  getProposalFields,
  computeMetrics,
  formatComparisonRow,
  computeToolFailureRates,
  conflictMatchesField,
} from '../../client/agent-lab/logic';
import type { PiLiveEvent, PiRunRow, PiEvidenceRow, PiConflictRow, PiResultRow, PiToolCallRow, PiComparisonRow, PiRunProjection } from '../../client/product-intelligence-api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: string, seq: number, payload: Record<string, unknown> = {}): PiLiveEvent {
  return {
    runId: 'run-1',
    sequence: seq,
    type,
    payload,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeRun(overrides: Partial<PiRunRow> = {}): PiRunRow {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    onboardingItemId: null,
    mode: 'shadow',
    status: 'completed',
    executor: 'pi',
    inputJson: '{}',
    policyJson: '{}',
    configSnapshotId: 'cfg-1',
    configSnapshotHash: 'hash-1',
    codeCommit: 'abc123',
    promptHash: null,
    piVersion: '1.0.0',
    extensionVersionsJson: '[]',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    cancelledAt: null,
    errorCode: null,
    errorMessage: null,
    estimatedCost: null,
    actualCost: 0.01,
    tokenUsageJson: null,
    ...overrides,
  };
}

function makeEvidenceRow(overrides: Partial<PiEvidenceRow> = {}): PiEvidenceRow {
  return {
    id: 'ev-1',
    runId: 'run-1',
    sourceId: 'src-1',
    targetField: 'title',
    valueJson: '"Test Product"',
    extractionMethod: 'meta_tags',
    sourceField: 'og:title',
    reliability: 'high',
    directSupport: 1,
    snippet: 'Test Product',
    metadataJson: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConflictRow(overrides: Partial<PiConflictRow> = {}): PiConflictRow {
  return {
    id: 'conf-1',
    runId: 'run-1',
    field: 'title',
    severity: 'medium',
    status: 'open',
    competingValuesJson: '["A","B"]',
    evidenceIdsJson: '["ev-1","ev-2"]',
    resolutionJson: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeResultRow(resultJson: string): PiResultRow {
  return {
    id: 'res-1',
    runId: 'run-1',
    schemaVersion: 1,
    disposition: 'submitted',
    resultJson,
    resultHash: 'hash',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// validateRunLaunch
// ---------------------------------------------------------------------------

describe('validateRunLaunch', () => {
  it('accepts a valid 12-digit UPC with spaces and dashes', () => {
    const result = validateRunLaunch({ gtin: '039 978-004012', registerName: 'Test Product' });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts an 8-digit GTIN', () => {
    const result = validateRunLaunch({ gtin: '12345678', registerName: 'Test' });
    expect(result.valid).toBe(true);
  });

  it('rejects letters in GTIN', () => {
    const result = validateRunLaunch({ gtin: '039978AB4012', registerName: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('digits'))).toBe(true);
  });

  it('rejects a 7-digit GTIN (too short)', () => {
    const result = validateRunLaunch({ gtin: '1234567', registerName: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('8-14'))).toBe(true);
  });

  it('rejects missing register name', () => {
    const result = validateRunLaunch({ gtin: '12345678', registerName: '  ' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('Register name'))).toBe(true);
  });

  it('rejects negative price', () => {
    const result = validateRunLaunch({ gtin: '12345678', registerName: 'Test', price: '-5' });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('Price'))).toBe(true);
  });

  it('rejects fractional quantity', () => {
    const result = validateRunLaunch({ gtin: '12345678', registerName: 'Test', quantity: 1.5 });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('Quantity'))).toBe(true);
  });

  it('accepts undefined price and quantity', () => {
    const result = validateRunLaunch({ gtin: '12345678', registerName: 'Test' });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRunLaunchPayload
// ---------------------------------------------------------------------------

describe('buildRunLaunchPayload', () => {
  it('strips spaces and dashes from GTIN', () => {
    const payload = buildRunLaunchPayload({ gtin: '039 978-004012', registerName: ' Test ' });
    expect(payload.gtin).toBe('039978004012');
    expect(payload.registerName).toBe('Test');
  });

  it('omits optional fields when blank', () => {
    const payload = buildRunLaunchPayload({ gtin: '12345678', registerName: 'Test', brandHint: '', departmentHint: '  ' });
    expect(payload.brandHint).toBeUndefined();
    expect(payload.departmentHint).toBeUndefined();
  });

  it('includes optional fields when present', () => {
    const payload = buildRunLaunchPayload({ gtin: '12345678', registerName: 'Test', brandHint: 'Acme' });
    expect(payload.brandHint).toBe('Acme');
  });
});

// ---------------------------------------------------------------------------
// EVENT_PRESENTATION
// ---------------------------------------------------------------------------

describe('EVENT_PRESENTATION', () => {
  it('covers all 14 wire event types', () => {
    const expectedTypes = [
      'run.started', 'step.started', 'step.completed',
      'tool.started', 'tool.completed', 'result.updated',
      'run.completed', 'run.failed', 'run.cancelled',
      'source.added', 'evidence.added', 'conflict.detected',
      'asset.added', 'run.needs_review',
    ];
    for (const type of expectedTypes) {
      expect(EVENT_PRESENTATION[type], `missing presentation for ${type}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// toTimelineItems
// ---------------------------------------------------------------------------

describe('toTimelineItems', () => {
  it('maps each event type to a timeline item', () => {
    const types = [
      'run.started', 'step.started', 'step.completed',
      'tool.started', 'tool.completed', 'result.updated',
      'run.completed', 'run.failed', 'run.cancelled',
      'source.added', 'evidence.added', 'conflict.detected',
      'asset.added', 'run.needs_review',
    ];
    const events = types.map((t, i) => makeEvent(t, i));
    const items = toTimelineItems(events);
    expect(items).toHaveLength(14);
    for (const item of items) {
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
  });

  it('surfaces structured payload fields (toolName, isError, code)', () => {
    const events = [
      makeEvent('tool.completed', 0, { toolName: 'search_products', isError: false }),
      makeEvent('run.failed', 1, { code: 'validation_error' }),
    ];
    const items = toTimelineItems(events);
    expect(items[0].detail).toContain('toolName: search_products');
    expect(items[1].detail).toContain('code: validation_error');
  });

  it('does NOT surface chain-of-thought fields', () => {
    const events = [
      makeEvent('tool.completed', 0, { toolName: 'search', thought: 'I should look for products...' }),
    ];
    const items = toTimelineItems(events);
    expect(items[0].detail).not.toContain('thought');
    expect(items[0].detail).not.toContain('I should look');
  });

  it('uses fallback for unknown event types', () => {
    const events = [makeEvent('unknown.type', 0)];
    const items = toTimelineItems(events);
    expect(items[0].label).toBe('Event');
    expect(items[0].icon).toBe('•');
  });
});

// ---------------------------------------------------------------------------
// mergeEventStream
// ---------------------------------------------------------------------------

describe('mergeEventStream', () => {
  it('deduplicates by runId and sequence', () => {
    const prev = [makeEvent('run.started', 0)];
    const incoming = [makeEvent('run.started', 0), makeEvent('step.started', 1)];
    const merged = mergeEventStream(prev, incoming);
    expect(merged).toHaveLength(2);
  });

  it('sorts by sequence', () => {
    const prev = [makeEvent('step.started', 1)];
    const incoming = [makeEvent('run.started', 0)];
    const merged = mergeEventStream(prev, incoming);
    expect(merged[0].sequence).toBe(0);
    expect(merged[1].sequence).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isTerminalEvent
// ---------------------------------------------------------------------------

describe('isTerminalEvent', () => {
  it('returns true for run.completed, run.failed, run.cancelled', () => {
    expect(isTerminalEvent('run.completed')).toBe(true);
    expect(isTerminalEvent('run.failed')).toBe(true);
    expect(isTerminalEvent('run.cancelled')).toBe(true);
  });

  it('returns false for non-terminal events', () => {
    expect(isTerminalEvent('tool.started')).toBe(false);
    expect(isTerminalEvent('source.added')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveFieldStatus
// ---------------------------------------------------------------------------

describe('deriveFieldStatus', () => {
  it('returns "verified" when evidence has direct support', () => {
    const evidence = [makeEvidenceRow({ targetField: 'title', directSupport: 1 })];
    const result = deriveFieldStatus('title', evidence, [], null, new Set());
    expect(result).toBe('verified');
  });

  it('returns "conflicting" when an open conflict exists', () => {
    const evidence = [makeEvidenceRow({ targetField: 'title', directSupport: 1 })];
    const conflicts = [makeConflictRow({ field: 'title', status: 'open' })];
    const result = deriveFieldStatus('title', evidence, conflicts, null, new Set());
    expect(result).toBe('conflicting');
  });

  it('returns "resolved" when in manuallyResolved set', () => {
    const result = deriveFieldStatus('title', [], [], null, new Set(['title']));
    expect(result).toBe('resolved');
  });

  it('returns "inferred" when field present in result but no direct evidence', () => {
    const resultJson = JSON.stringify({
      submission: {
        productProposal: { fields: [{ field: 'title', value: 'Inferred Title' }] },
      },
    });
    const result = makeResultRow(resultJson);
    const status = deriveFieldStatus('title', [], [], result, new Set());
    expect(status).toBe('inferred');
  });

  it('returns "missing" when no evidence, conflict, or result', () => {
    const status = deriveFieldStatus('nonexistent', [], [], null, new Set());
    expect(status).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// getProposalFields
// ---------------------------------------------------------------------------

describe('getProposalFields', () => {
  it('extracts fields from PI-1 structured submission', () => {
    const resultJson = JSON.stringify({
      submission: {
        productProposal: {
          fields: [
            { field: 'title', value: 'Stella Chicken Broth', evidenceIds: ['ev-1'] },
            { field: 'brand', value: 'Stella' },
          ],
        },
      },
    });
    const fields = getProposalFields(makeResultRow(resultJson));
    expect(fields).toHaveLength(2);
    expect(fields[0].key).toBe('title');
    expect(fields[0].value).toBe('Stella Chicken Broth');
    expect(fields[1].key).toBe('brand');
  });

  it('extracts fields from PI-4 bundle (nested under submission, the real wire shape)', () => {
    const resultJson = JSON.stringify({
      submission: {
        identity: {
          status: 'exact_match',
          brand: 'Stella',
          canonicalName: 'Stella Chicken Broth 16oz',
          netContent: { value: 16, unit: 'oz' },
          packCount: 12,
        },
        commerceFacts: [{ field: 'description', value: 'Premium broth' }],
      },
    });
    const fields = getProposalFields(makeResultRow(resultJson));
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('title');
    expect(keys).toContain('brand');
    expect(keys).toContain('size');
    expect(keys).toContain('count');
    expect(keys).toContain('description');
  });

  it('returns empty array for null result', () => {
    expect(getProposalFields(null)).toEqual([]);
  });

  it('falls back to top-level shapes when no submission envelope exists', () => {
    const resultJson = JSON.stringify({ productProposal: { fields: [{ field: 'title', value: 'Legacy' }] } });
    const fields = getProposalFields(makeResultRow(resultJson));
    expect(fields[0]).toMatchObject({ key: 'title', value: 'Legacy' });
  });

  it('matches PI-1 machine-category conflicts to proposal fields (title_conflict -> title)', () => {
    const conflict: PiConflictRow = { id: 'c1', runId: 'run-1', field: 'title_conflict', severity: 'high', status: 'open', competingValuesJson: '[]', evidenceIdsJson: '[]', resolutionJson: null, resolvedBy: null, resolvedAt: null, createdAt: '2026-01-01T00:00:00Z' };
    expect(conflictMatchesField(conflict, 'title')).toBe(true);
    expect(conflictMatchesField(conflict, 'brand')).toBe(false);
  });

  it('deriveFieldStatus reports conflicting for PI-1 category conflicts', () => {
    const conflicts: PiConflictRow[] = [{ id: 'c1', runId: 'run-1', field: 'title_conflict', severity: 'high', status: 'open', competingValuesJson: '[]', evidenceIdsJson: '[]', resolutionJson: null, resolvedBy: null, resolvedAt: null, createdAt: '2026-01-01T00:00:00Z' }];
    expect(deriveFieldStatus('title', [], conflicts, null, new Set())).toBe('conflicting');
  });

  it('handles invalid JSON gracefully', () => {
    const badRow = makeResultRow('not json');
    expect(getProposalFields(badRow)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics
// ---------------------------------------------------------------------------

describe('computeMetrics', () => {
  it('computes rates with zero runs', () => {
    const result = computeMetrics([], new Map());
    expect(result.runCount).toBe(0);
    expect(result.completionRate).toBe(0);
    expect(result.abstentionRate).toBe(0);
  });

  it('computes metrics for mixed runs', () => {
    const runs = [
      makeRun({ id: 'r1', status: 'completed', actualCost: 0.01, completedAt: '2026-01-01T00:01:00Z', startedAt: '2026-01-01T00:00:00Z' }),
      makeRun({ id: 'r2', status: 'failed', actualCost: null, completedAt: '2026-01-01T00:02:00Z', startedAt: '2026-01-01T00:00:00Z' }),
      makeRun({ id: 'r3', status: 'running', actualCost: null }),
      makeRun({ id: 'r4', status: 'cancelled', actualCost: null }),
    ];
    const projections = new Map<string, PiRunProjection>();
    projections.set('r1', {
      run: runs[0],
      steps: [],
      toolCalls: [],
      sources: [],
      evidence: [],
      conflicts: [],
      assets: [],
      result: makeResultRow('{"productProposal":{"fields":[]}}'),
      comparisons: [],
      eventCount: 0,
    });
    const result = computeMetrics(runs, projections);
    expect(result.runCount).toBe(4);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.running).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.completionRate).toBe(0.25);
    expect(result.failureRate).toBe(0.25);
    expect(result.avgCostUsd).toBe(0.01);
  });

  it('computes abstention rate from projections with abstained disposition', () => {
    const runs = [
      makeRun({ id: 'r1', status: 'completed' }),
      makeRun({ id: 'r2', status: 'completed' }),
    ];
    const projections = new Map<string, PiRunProjection>();
    projections.set('r1', {
      run: runs[0],
      steps: [],
      toolCalls: [],
      sources: [],
      evidence: [],
      conflicts: [],
      assets: [],
      result: { ...makeResultRow('{}'), disposition: 'submitted' },
      comparisons: [],
      eventCount: 0,
    });
    projections.set('r2', {
      run: runs[1],
      steps: [],
      toolCalls: [],
      sources: [],
      evidence: [],
      conflicts: [],
      assets: [],
      result: { ...makeResultRow('{}'), disposition: 'abstained' },
      comparisons: [],
      eventCount: 0,
    });
    const result = computeMetrics(runs, projections);
    expect(result.abstentionRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// formatComparisonRow
// ---------------------------------------------------------------------------

describe('formatComparisonRow', () => {
  it('formats metrics from JSON', () => {
    const row: PiComparisonRow = {
      id: 'c1',
      runId: 'r1',
      baselineType: 'legacy',
      baselineRef: 'current',
      metricsJson: JSON.stringify({
        executor: 'pi',
        outcome: 'submitted',
        durationMs: 12345,
        fieldCount: 8,
        conflictCount: 1,
        sourceCount: 3,
        imageCount: 2,
        abstained: false,
      }),
      createdAt: '2026-01-01T00:00:00Z',
    };
    const metrics = formatComparisonRow(row);
    expect(metrics).toHaveLength(8);
    const executorMetric = metrics.find((m) => m.label === 'Executor');
    expect(executorMetric?.value).toBe('pi');
    const abstainedMetric = metrics.find((m) => m.label === 'Abstained');
    expect(abstainedMetric?.value).toBe('no');
  });

  it('returns empty for invalid JSON', () => {
    const row: PiComparisonRow = {
      id: 'c1',
      runId: 'r1',
      baselineType: 'legacy',
      baselineRef: 'current',
      metricsJson: 'not json',
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(formatComparisonRow(row)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeToolFailureRates
// ---------------------------------------------------------------------------

describe('computeToolFailureRates', () => {
  it('computes rates for mixed outcomes', () => {
    const calls: PiToolCallRow[] = [
      { id: 't1', runId: 'r1', stepId: null, sequence: 0, toolName: 'search', toolVersion: null, policyOutcome: 'allowed', requestHash: null, responseHash: null, artifactRef: null, latencyMs: 100, costUsd: 0.01, startedAt: '', completedAt: '', errorJson: null },
      { id: 't2', runId: 'r1', stepId: null, sequence: 1, toolName: 'search', toolVersion: null, policyOutcome: 'denied', requestHash: null, responseHash: null, artifactRef: null, latencyMs: 0, costUsd: null, startedAt: '', completedAt: '', errorJson: null },
      { id: 't3', runId: 'r1', stepId: null, sequence: 2, toolName: 'search', toolVersion: null, policyOutcome: 'budget_exceeded', requestHash: null, responseHash: null, artifactRef: null, latencyMs: 0, costUsd: null, startedAt: '', completedAt: '', errorJson: null },
    ];
    const result = computeToolFailureRates(calls);
    expect(result.total).toBe(3);
    expect(result.denied).toBe(1);
    expect(result.budgetExceeded).toBe(1);
    expect(result.deniedRate).toBeCloseTo(2 / 3);
  });

  it('returns zeros for empty array', () => {
    const result = computeToolFailureRates([]);
    expect(result.total).toBe(0);
    expect(result.deniedRate).toBe(0);
  });
});