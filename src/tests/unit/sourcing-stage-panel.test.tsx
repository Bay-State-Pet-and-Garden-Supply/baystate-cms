/**
 * SourcingStagePanel render assertions for the sourcing safety patch AND the
 * ADR 0014 enabled-mode drawer.
 *
 * Pure-component test via `renderToStaticMarkup` (no jsdom, no API mocks),
 * following the existing `pr10-drawer-render.test.tsx` pattern. Proves the
 * disabled-engine panel surfaces only the audited Continue-to-Discovery
 * action and read-only historical evidence — never the unsupported
 * "automatic sourcing decision" copy, "Re-run Sourcing", distributor-bundle
 * selection, or checkboxes — and that the enabled-mode panel surfaces
 * generation disclosure, durable conflict resolution, display-only images,
 * and the guarded Continue/Retry actions.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourcingStagePanel } from '../../client/components/pipeline-drawer/SourcingStagePanel';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { DistributorEvidenceAttemptView } from '../../shared/schemas/onboarding';
import type { OnboardingEvidenceConflict } from '../../shared/schemas/distributor';

function reviewItem(overrides: Partial<OnboardingItem> = {}): OnboardingItem {
  return {
    id: 'item-1',
    batchId: 'batch-1',
    upc: '012345678901',
    name: 'Test Product',
    price: null,
    quantity: null,
    brandHint: null,
    departmentHint: null,
    sourceUrl: null,
    sourceType: 'official_page',
    acceptedEvidenceAttemptIds: [],
    acceptedEvidenceAttemptId: null,
    sourcingDecision: null,
    stage: 'sourcing',
    stageStatus: 'pending',
    isHeld: false,
    heldReason: null,
    status: 'imported',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    extractionData: null,
    curationData: null,
    rowNumber: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function viewAttempt(overrides: Partial<DistributorEvidenceAttemptView> = {}): DistributorEvidenceAttemptView {
  return {
    id: 'attempt-1',
    providerId: 'unfi',
    lookupUpc: '012345678901',
    outcome: 'found',
    confidence: 0.9,
    evidenceUrl: null,
    productName: null,
    brand: null,
    description: null,
    imageUrls: [],
    warnings: [],
    errorMessage: null,
    createdAt: new Date().toISOString(),
    isAccepted: false,
    identity: null,
    ...overrides,
  };
}

function hardOpenConflict(overrides: Partial<OnboardingEvidenceConflict> = {}): OnboardingEvidenceConflict {
  return {
    id: 'cnf-1',
    itemId: 'item-1',
    field: 'weight',
    severity: 'hard',
    status: 'open',
    sourcingGenerationId: 'gen-1',
    resolutionType: null,
    resolvedValue: null,
    resolvedBy: null,
    resolvedAt: null,
    candidates: [
      { id: 'cand-1', conflictId: 'cnf-1', evidenceAttemptId: 'attempt-1', valueJson: '"10 lbs"', createdAt: new Date().toISOString() },
      { id: 'cand-2', conflictId: 'cnf-1', evidenceAttemptId: 'attempt-2', valueJson: '"20 lbs"', createdAt: new Date().toISOString() },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SourcingStagePanel (engine disabled)', () => {
  it('renders the engine-unavailable note and the Continue action', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={false}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('sourcing engine is not enabled');
    expect(html).toContain('Continue to Official Site Discovery');
  });

  it('never renders unsupported automatic/re-run/bundle controls when disabled', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={false}
        evidenceAttempts={[
          viewAttempt({
            id: 'attempt-1',
            providerId: 'unfi',
            lookupUpc: '012345678901',
            outcome: 'found',
            productName: 'Distributor Title',
          }),
        ]}
        onContinueToDiscovery={async () => {}}
      />,
    );
    // Prohibited copy/actions absent:
    expect(html).not.toContain('automatic sourcing decision');
    expect(html).not.toContain('Re-run Sourcing');
    expect(html).not.toContain('Use Selected Bundle & Continue');
    expect(html).not.toContain('type="checkbox"');
    // Historical evidence remains inspectable:
    expect(html).toContain('Distributor Evidence Attempts (1)');
    expect(html).toContain('Distributor Title');
  });

  it('renders the read-only badge while disabled', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={false}
        evidenceAttempts={[
          viewAttempt({ id: 'attempt-1', providerId: 'orgill', outcome: 'not_stocked' }),
        ]}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('read-only');
  });

  it('keeps bundle-to-Curation absent even when the engine is enabled (prohibited routing)', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).not.toContain('Use Selected Bundle & Continue');
    expect(html).not.toContain('type="checkbox"');
  });
});

describe('SourcingStagePanel (engine enabled)', () => {
  it('renders durable hard conflicts with resolution actions and disables Continue', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        evidenceAttempts={[
          viewAttempt({ id: 'attempt-1', providerId: 'phillips', productName: 'Bag A' }),
          viewAttempt({ id: 'attempt-2', providerId: 'unfi', productName: 'Bag B' }),
        ]}
        conflicts={[hardOpenConflict()]}
        onContinueToDiscovery={async () => {}}
        onResolveConflict={async () => {}}
        onRetry={async () => {}}
      />,
    );
    expect(html).toContain('Identity Conflicts — Resolve to Continue');
    expect(html).toContain('Use candidate');
    expect(html).toContain('Custom value');
    expect(html).toContain('Dismiss');
    expect(html).toContain('phillips:');
    // Open hard conflict blocks the Continue action:
    expect(html).toContain('disabled=""');
    expect(html).toContain('Resolve all hard conflicts or retry before continuing.');
  });

  it('renders soft conflicts as informational — no resolution actions, never blocks Continue', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        sourcingEntryPolicyVersion={1}
        conflicts={[
          hardOpenConflict({
            id: 'cnf-soft-sku',
            field: 'distributorSku',
            severity: 'soft',
            candidates: [
              { id: 'cand-s1', conflictId: 'cnf-soft-sku', evidenceAttemptId: 'attempt-1', valueJson: '"055428"', createdAt: new Date().toISOString() },
              { id: 'cand-s2', conflictId: 'cnf-soft-sku', evidenceAttemptId: 'attempt-2', valueJson: '"38155012"', createdAt: new Date().toISOString() },
            ],
          }),
        ]}
        onContinueToDiscovery={async () => {}}
        onResolveConflict={async () => {}}
      />,
    );
    // Informational presentation only — no candidate/custom/dismiss actions.
    expect(html).toContain('Distributor Discrepancies (informational)');
    expect(html).toContain('Informational discrepancy');
    expect(html).not.toContain('Use candidate');
    expect(html).not.toContain('Custom value');
    expect(html).not.toContain('Dismiss');
    // A soft-only conflict never blocks Continue.
    expect(html).not.toContain('disabled=""');
  });

  it('renders hard conflicts with resolution actions while soft conflicts stay informational', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        sourcingEntryPolicyVersion={1}
        conflicts={[
          hardOpenConflict(),
          hardOpenConflict({
            id: 'cnf-soft-sku',
            field: 'distributorSku',
            severity: 'soft',
          }),
        ]}
        onContinueToDiscovery={async () => {}}
        onResolveConflict={async () => {}}
      />,
    );
    expect(html).toContain('Identity Conflicts — Resolve to Continue');
    expect(html).toContain('Use candidate');
    expect(html).toContain('Custom value');
    expect(html).toContain('Dismiss');
    expect(html).toContain('Informational discrepancy');
    expect(html).toContain('disabled=""');
  });

  it('marks distributor image URLs as display-only — never catalog-approved', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        evidenceAttempts={[
          viewAttempt({ imageUrls: ['https://cdn.example.com/front.jpg'] }),
        ]}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('display only — not approved for catalog use');
    expect(html).toContain('https://cdn.example.com/front.jpg');
  });

  it('surfaces source_error details', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        evidenceAttempts={[
          viewAttempt({ outcome: 'source_error', errorMessage: 'provider returned HTTP 500' }),
        ]}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('Error:');
    expect(html).toContain('provider returned HTTP 500');
  });

  it('keeps Continue enabled with no open hard conflicts', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        conflicts={[
          hardOpenConflict({ severity: 'soft' }),
          hardOpenConflict({ id: 'cnf-2', status: 'resolved', resolutionType: 'dismissed', resolvedValue: null }),
        ]}
        onContinueToDiscovery={async () => {}}
        onRetry={async () => {}}
      />,
    );
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Resolve all hard conflicts or retry before continuing.');
  });

  it('keeps Continue disabled while the item is in needs_input', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('disabled=""');
  });

  it('discloses the current generation and superseded history', () => {
    const now = new Date().toISOString();
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        generations={[
          { id: 'gen-2', status: 'running', supersedesId: 'gen-1', reason: null, startedAt: now, completedAt: null },
          { id: 'gen-1', status: 'superseded', supersedesId: null, reason: 'operator_retry', startedAt: now, completedAt: now },
        ]}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('Evidence Generation');
    expect(html).toContain('gen-2');
    expect(html).toContain('running');
    expect(html).toContain('Superseded history (1)');
  });

  it('renders the Retry action only when enabled', () => {
    const on = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        onContinueToDiscovery={async () => {}}
        onRetry={async () => {}}
      />,
    );
    const off = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={false}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(on).toContain('Re-run Sourcing');
    expect(off).not.toContain('Re-run Sourcing');
  });

  it('OFF mode ignores durable conflicts entirely: no resolution UI, Continue enabled', () => {
    const item = reviewItem({ stageStatus: 'needs_input', errorMessage: 'Identity conflict detected' });
    const durableConflicts = [
      {
        id: 'cnf-1',
        itemId: 'item-1',
        field: 'weight',
        severity: 'hard' as const,
        status: 'open' as const,
        sourcingGenerationId: 'gen-1',
        resolutionType: null,
        resolvedValue: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: '2026-08-13T00:00:00.000Z',
        candidates: [{ id: 'cand-1', conflictId: 'cnf-1', evidenceAttemptId: 'att-1', valueJson: '"10 lbs"', createdAt: '2026-08-13T00:00:00.000Z' }],
      },
    ];
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={item}
        sourcingEngineEnabled={false}
        evidenceAttempts={[]}
        conflicts={durableConflicts}
        onContinueToDiscovery={async () => {}}
      />,
    );
    // No durable resolution UI in OFF mode...
    expect(html).not.toContain('Use candidate');
    expect(html).not.toContain('Custom value');
    expect(html).not.toContain('Dismiss');
    // ...and Continue stays available regardless of conflicts/needs_input.
    const continueButton = html.match(/Continue to Official Site Discovery/);
    expect(continueButton).not.toBeNull();
    expect(html).not.toContain('disabled=""');
  });

  it('ON mode disables Continue while an open hard conflict exists', () => {
    const item = reviewItem({ stageStatus: 'needs_input' });
    const durableConflicts = [
      {
        id: 'cnf-1',
        itemId: 'item-1',
        field: 'weight',
        severity: 'hard' as const,
        status: 'open' as const,
        sourcingGenerationId: 'gen-1',
        resolutionType: null,
        resolvedValue: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: '2026-08-13T00:00:00.000Z',
        candidates: [{ id: 'cand-1', conflictId: 'cnf-1', evidenceAttemptId: 'att-1', valueJson: '"10 lbs"', createdAt: '2026-08-13T00:00:00.000Z' }],
      },
    ];
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={item}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        evidenceAttempts={[]}
        conflicts={durableConflicts}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('Use candidate');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Resolve all hard conflicts or retry before continuing.');
  });
});

describe('SourcingStagePanel (Amendment A modes)', () => {
  const qualifiedView = {
    qualified: true,
    reasonCodes: [],
    acceptedEvidenceAttemptIds: ['a1'],
    providerIds: ['phillips'],
    evidenceHash: 'ab'.repeat(32),
    sourcingGenerationId: 'gen-1',
  };

  it('manual mode at needs_input renders the qualification view with both actions', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="manual"
        sourcingEntryPolicyVersion={1}
        sourcingQualificationView={qualifiedView}
        onContinueToDiscovery={async () => {}}
        onUseDistributorRecord={async () => {}}
      />,
    );
    expect(html).toContain('Distributor Record Qualification');
    expect(html).toContain('qualified distributor record');
    expect(html).toContain('Use distributor record');
    expect(html).toContain('Continue to Official Site Discovery');
    // Manual mode does not render automatic-mode conflict resolution.
    expect(html).not.toContain('Use candidate');
  });

  it('manual mode with a NOT-qualified view shows reason codes and only Continue', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="manual"
        sourcingEntryPolicyVersion={1}
        sourcingQualificationView={{
          qualified: false,
          reasonCodes: ['missing_name', 'open_hard_conflict'],
          acceptedEvidenceAttemptIds: [],
          providerIds: [],
          evidenceHash: null,
          sourcingGenerationId: 'gen-1',
        }}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('not qualified');
    expect(html).toContain('Distributor record has no usable product name.');
    expect(html).toContain('Distributor feeds disagree on identity-critical fields.');
    expect(html).not.toContain('Use distributor record');
    expect(html).toContain('Continue to Official Site Discovery');
  });

  it('manual mode keeps Continue enabled at needs_input without open conflicts', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="manual"
        sourcingEntryPolicyVersion={1}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).not.toContain('disabled=""');
  });

  it('manual mode with an open hard conflict still requires resolution', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="manual"
        sourcingEntryPolicyVersion={1}
        conflicts={[hardOpenConflict()]}
        onContinueToDiscovery={async () => {}}
        onResolveConflict={async () => {}}
      />,
    );
    expect(html).toContain('Use candidate');
    expect(html).toContain('disabled=""');
  });

  it('legacy v0 items show Continue only — no retry, no use-distributor-record, no qualification UI', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        sourcingEntryPolicyVersion={0}
        sourcingQualificationView={qualifiedView}
        onContinueToDiscovery={async () => {}}
        onRetry={async () => {}}
        onUseDistributorRecord={async () => {}}
      />,
    );
    expect(html).not.toContain('Re-run Sourcing');
    expect(html).not.toContain('Use distributor record');
    expect(html).not.toContain('Distributor Record Qualification');
    expect(html).toContain('Continue to Official Site Discovery');
    // Legacy v0 rows keep Continue available even when the engine is ON.
    expect(html).not.toContain('disabled=""');
  });

  it('observe mode shows the observation banner, no retry, and never blocks Continue', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode="observe"
        evidenceAttempts={[viewAttempt({ outcome: 'found' })]}
        onContinueToDiscovery={async () => {}}
        onRetry={async () => {}}
      />,
    );
    expect(html).toContain('Observation mode');
    expect(html).toContain('observing');
    expect(html).not.toContain('Re-run Sourcing');
    expect(html).not.toContain('Use distributor record');
    expect(html).not.toContain('disabled=""');
  });

  it('engine enabled WITHOUT a valid mode fails closed (legacy/disabled UI, never automatic)', () => {
    // Invalid/missing mode must NOT be treated as automatic (MC review fix):
    // no automatic conflict resolution, no retry, no Use-distributor-record,
    // no qualification view; Continue stays available.
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem({ stageStatus: 'needs_input' })}
        sourcingEngineEnabled={true}
        sourcingMode={null}
        sourcingEntryPolicyVersion={1}
        conflicts={[hardOpenConflict()]}
        sourcingQualificationView={qualifiedView}
        onContinueToDiscovery={async () => {}}
        onRetry={async () => {}}
        onUseDistributorRecord={async () => {}}
      />,
    );
    expect(html).not.toContain('Re-run Sourcing');
    expect(html).not.toContain('Use distributor record');
    expect(html).not.toContain('Distributor Record Qualification');
    expect(html).not.toContain('Resolve');
    // Fail closed to the legacy surface: Continue is available and enabled.
    expect(html).toContain('Continue to Official Site Discovery');
    expect(html).not.toContain('disabled=""');
  });

  it('automatic mode surfaces the distributor-to-extraction copy, not official-page-only copy', () => {
    const html = renderToStaticMarkup(
      <SourcingStagePanel
        reviewItem={reviewItem()}
        sourcingEngineEnabled={true}
        sourcingMode="automatic"
        sourcingEntryPolicyVersion={1}
        onContinueToDiscovery={async () => {}}
      />,
    );
    expect(html).toContain('advances the item to extraction directly from the distributor record');
    expect(html).not.toContain('so items continue to official-site Discovery.');
  });
});
