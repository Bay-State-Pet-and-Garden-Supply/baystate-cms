// story: e02s02 — VerifierVerdictPanel unit tests (vitest, no DB)
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { VerifierVerdictPanel } from '../../client/components/agent-lab/VerifierVerdictPanel';
import type { PiRunProjection } from '../../client/product-intelligence-api';

function projectionWithReport(report: unknown): PiRunProjection {
  return {
    run: { id: 'run-1', status: 'completed' } as any,
    result: { resultJson: JSON.stringify(report) } as any,
    events: [],
  } as unknown as PiRunProjection;
}

describe('VerifierVerdictPanel', () => {
  it('renders VERIFIED with high confidence as not blocked', () => {
    const html = renderToString(React.createElement(VerifierVerdictPanel, {
      projection: projectionWithReport({
        verdict: 'pass',
        identityStatus: 'verified',
        identityScore: 0.92,
        productDataDecision: 'verified',
        checks: [{ field: 'title', details: 'matches GTIN', passed: true }],
      }),
    }));
    expect(html).toContain('Identity:');
    expect(html).toContain('verified');
    expect(html).not.toContain('blocks verification');
    expect(html).toContain('title');
  });

  it('blocks when low confidence score', () => {
    const html = renderToString(React.createElement(VerifierVerdictPanel, {
      projection: projectionWithReport({
        verdict: 'pass',
        identityStatus: 'verified',
        identityScore: 0.5,
        productDataDecision: 'unknown',
        checks: [],
      }),
    }));
    expect(html).toContain('blocked');
    expect(html).toContain('Low-confidence');
  });

  it('renders retryRequest when present', () => {
    const html = renderToString(React.createElement(VerifierVerdictPanel, {
      projection: projectionWithReport({
        verdict: 'needs_review',
        identityStatus: 'unknown',
        identityScore: 0.3,
        retryRequest: { targetSpecialist: 'retry_discovery', reason: 'GTIN mismatch', suggestedAction: 're-run discovery' },
        checks: [],
      }),
    }));
    expect(html).toContain('Retry requested');
    expect(html).toContain('retry_discovery');
    expect(html).toContain('GTIN mismatch');
  });

  it('returns null when result missing', () => {
    const html = renderToString(React.createElement(VerifierVerdictPanel, {
      projection: { run: { id: 'run-2' } as any, result: null, events: [] } as unknown as PiRunProjection,
    }));
    expect(html).toBe('');
  });
});
