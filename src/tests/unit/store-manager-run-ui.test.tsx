// @vitest-environment jsdom
/**
 * Operations console Issue 7 — run/diff UI + pure derivation (jsdom).
 * Components render read-only previews; approvals are parent callbacks —
 * nothing executes client-side.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ActionDiffReview } from '../../client/components/store-manager/ActionDiffReview';
import { VerificationDiff } from '../../client/components/store-manager/VerificationDiff';
import { RunComparison } from '../../client/components/store-manager/RunComparison';
import {
  diffRenderRows,
  diffNetworkSummary,
  diffAffectedSkuText,
  terminalStatusLabel,
  entrypointLabel,
  modelCallSummary,
  comparisonWarning,
  replayWarning,
} from '../../client/store-manager-history-logic';

async function renderAsync(component: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        container.remove();
      });
    },
  };
}

function byText(container: HTMLElement, text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

const sampleDiff = {
  schemaVersion: 1 as const,
  toolName: 'stage_stored_proposal_in_change_set',
  toolVersion: 1,
  riskClass: 'catalog_mutation' as const,
  workspaceId: 'ws',
  scopeHash: null,
  affectedSkuCount: 37,
  affectedSkus: ['SKU-1', 'SKU-2'],
  affectedSkusTruncated: false,
  beforeAfter: [
    { field: 'ProductField24', before: 'Old', after: 'New', affectedCount: 37 },
    { field: 'ProductField24', before: 'Other', after: 'New', affectedCount: 12 },
  ],
  filesTouched: [{ path: 'products/SKU-1.json', note: 'draft row' }],
  changeSet: { currentState: 'reviewing', expectedState: 'draft' },
  networkActivity: { kind: 'none' } as const,
  evidenceRefs: ['proposal:p1'],
  stateHashes: {},
  generatedAt: new Date().toISOString(),
  diffHash: 'a'.repeat(64),
};

describe('Store Manager run/diff UI (Issue 7)', () => {
  it('ActionDiffReview renders the PR-like before/after review before approval', async () => {
    const { container, unmount } = await renderAsync(
      <ActionDiffReview
        diff={sampleDiff}
        onApprove={() => undefined}
        onDeny={() => undefined}
      />,
    );
    try {
      expect(byText(container, 'Catalog / Change Set mutation')).toBe(true);
      expect(byText(container, '37 SKUs affected')).toBe(true);
      expect(byText(container, 'ProductField24')).toBe(true);
      expect(byText(container, 'Old')).toBe(true);
      expect(byText(container, 'New')).toBe(true);
      expect(byText(container, 'Approve exact diff')).toBe(true);
      expect(byText(container, 'Deny')).toBe(true);
    } finally {
      await unmount();
    }
  });

  it('ActionDiffReview shows "Unknown" network explicitly and no absolute paths', async () => {
    const { container, unmount } = await renderAsync(
      <ActionDiffReview
        diff={{ ...sampleDiff, networkActivity: { kind: 'unknown', note: 'adapter did not estimate' } }}
        reviewMode={false}
      />,
    );
    try {
      expect(byText(container, 'Unknown')).toBe(true);
      expect(container.textContent?.includes('/Users')).toBe(false);
    } finally {
      await unmount();
    }
  });

  it('VerificationDiff renders per-SKU authoritative statuses, never a bare success claim', async () => {
    const { container, unmount } = await renderAsync(
      <VerificationDiff
        verification={{
          verifiedSkuCount: 2,
          perSku: [
            { sku: 'SKU-1', status: 'verified' },
            { sku: 'SKU-2', status: 'error', note: 'missing' },
          ],
          perSkuTruncated: false,
          verificationHash: 'b'.repeat(64),
          generatedAt: new Date().toISOString(),
          toolName: 'stage_stored_proposal_in_change_set',
        }}
      />,
    );
    try {
      expect(byText(container, '2 SKUs verified')).toBe(true);
      expect(byText(container, 'SKU-1')).toBe(true);
      expect(byText(container, 'error')).toBe(true);
    } finally {
      await unmount();
    }
  });

  it('RunComparison renders run A/B inputs', async () => {
    const { container, unmount } = await renderAsync(
      <RunComparison
        open
        onClose={() => undefined}
        preselectedRunId="run-a"
      />,
    );
    try {
      expect(container.querySelector('[aria-label="Run A id"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Run B id"]')).toBeTruthy();
    } finally {
      await unmount();
    }
  });

  it('pure derivation: labels, diffs, warnings stay bounded and honest', () => {
    expect(terminalStatusLabel('deadline_exceeded')).toBe('Deadline exceeded');
    expect(terminalStatusLabel(null)).toBe('In progress');
    expect(entrypointLabel('replay')).toBe('Replay');
    expect(diffRenderRows(sampleDiff).length).toBe(2);
    expect(diffNetworkSummary(sampleDiff)).toContain('None');
    expect(diffAffectedSkuText(sampleDiff)).toBe('37 SKUs affected');
    expect(comparisonWarning({ comparable: false, runIdA: 'a', runIdB: 'b', kind: null, delta: null, reason: 'Kinds differ.' })).toContain('Kinds differ');
    expect(replayWarning({ run: { lineage: { replayOfRunId: 'x' } }, artifacts: [], events: [], modelCall: null } as never)).toContain('CURRENT');
    expect(replayWarning({ run: { lineage: {} }, artifacts: [], events: [], modelCall: null } as never)).toBeNull();
    expect(
      modelCallSummary({
        run: { replayOfRunId: null },
        artifacts: [],
        events: [],
        modelCall: { provider: 'p', model: 'm', locality: 'local', promptTokens: 10, completionTokens: 5, estimatedApiCostUsd: 0.001 },
      } as never),
    ).toContain('10 / 5');
  });
});
