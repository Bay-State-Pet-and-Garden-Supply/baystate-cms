/**
 * story: e02s01 — read-only specialist policy display F.I.R.S.T tests
 */
import { describe, it, expect } from 'vitest';
import { toPolicySnapshotDisplay } from '../../client/agent-lab/specialist-workspace-policy';

describe('toPolicySnapshotDisplay', () => {
  it('parses policy JSON read-only', () => {
    const display = toPolicySnapshotDisplay(JSON.stringify({
      configId: 'abc123hash',
      allowedTools: ['read'],
      researchTools: ['search_products'],
      allowedSourceDomains: ['example.com'],
      modelRoute: { provider: 'openai', model: 'gpt-4', thinkingLevel: 'medium' },
      maxToolCalls: 50,
      maxCostUsd: 1.5,
      deadlineMs: 120000,
    }));
    expect(display?.configId).toBe('abc123hash');
    expect(display?.researchTools).toEqual(['search_products']);
    expect(display?.modelRoute?.provider).toBe('openai');
    expect(display?.isReadOnly).toBe(true);
  });

  it('returns null for invalid JSON', () => {
    expect(toPolicySnapshotDisplay('not json')).toBeNull();
  });

  it('handles missing modelRoute', () => {
    expect(toPolicySnapshotDisplay(JSON.stringify({ configId: 'x' }))?.modelRoute).toBeNull();
  });
});
