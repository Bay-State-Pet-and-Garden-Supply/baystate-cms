/**
 * PR10 C3 lightweight render assertions for the Review drawer's semantic
 * findings banner (issue #30, DECISION-B).
 *
 * Reuses the repo's existing vitest harness (no new framework): the drawer is
 * a pure component (React + types only), so `renderToStaticMarkup` needs no
 * jsdom and no API mocks. The PipelineBoard card badge is NOT render-tested
 * here (the board imports the full pipeline module graph); its data contract —
 * the committed `curationData.semanticValidation.status === 'blocked'` written
 * by `processCohort` for active blocked members — is covered end-to-end by
 * `pr10-acceptance.test.ts` (bun:test, DB-backed). Visual badge rendering is
 * covered by the manual-verification scope documented in the C3 commit.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewDrawerShell } from '../../client/components/pipeline-drawer/ReviewDrawerShell';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

function reviewItem(overrides: Partial<OnboardingItem> = {}): OnboardingItem {
  return {
    id: 'item-1',
    batchId: 'batch-1',
    upc: '100000000001',
    name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
    price: null,
    quantity: null,
    brandHint: 'Woof',
    departmentHint: null,
    sourceUrl: 'https://brand.example.com/100000000001',
    status: 'curated',
    stage: 'review',
    stageStatus: 'completed',
    errorMessage: null,
    retryCount: 0,
    rowNumber: 1,
    expectedName: null,
    sourcingDecision: null,
    extractionData: null,
    curationData: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as OnboardingItem;
}

const noop = () => {};

function renderShell(props: {
  semanticValidation?: { status: 'passed' | 'blocked'; findings: Array<{ code: string; message: string; memberSku: string | null }> } | null;
  consistencyWarnings?: Array<{ groupId: string; field: string; message: string }>;
}): string {
  const { semanticValidation = null, consistencyWarnings = [] } = props;
  return renderToStaticMarkup(
    <ReviewDrawerShell
      reviewItem={reviewItem()}
      hasPrev={false}
      hasNext={false}
      reviewTransitioning={false}
      onPrevItem={noop}
      onNextItem={noop}
      onClose={noop}
      consistencyWarnings={consistencyWarnings}
      semanticValidation={semanticValidation}
      saveStatus="idle"
      saveError={null}
      leftColumnContent={null}
      rightColumnContent={null}
    />,
  );
}

describe('ReviewDrawerShell PR10 semantic findings banner (issue #30, DECISION-B)', () => {
  it('blocked semanticValidation renders the red banner with every finding [code] + message + member SKU', () => {
    const html = renderShell({
      semanticValidation: {
        status: 'blocked',
        findings: [
          { code: 'family_brand', message: 'Member brand "blue-buffalo" conflicts with the canonical cohort Brand "woof".', memberSku: '100000000002' },
          { code: 'coordinated_page', message: 'Assigned page set does not match the durable parent output.', memberSku: null },
        ],
      },
    });
    expect(html).toContain('⛔ Not review-ready — cohort semantic validation blocked');
    expect(html).toContain('[family_brand]');
    expect(html).toContain('canonical cohort Brand');
    expect(html).toContain('SKU 100000000002');
    expect(html).toContain('[coordinated_page]');
    // The active surface replaces the legacy warnings box.
    expect(html).not.toContain('Sibling consistency warning');
  });

  it('passed semanticValidation renders no banner and no legacy warnings box', () => {
    const html = renderShell({
      semanticValidation: { status: 'passed', findings: [] },
      consistencyWarnings: [{ groupId: 'g', field: 'category_page', message: 'legacy warning' }],
    });
    expect(html).not.toContain('⛔ Not review-ready');
    expect(html).not.toContain('Sibling consistency warning');
  });

  it('null semanticValidation keeps the legacy warnings box byte-identical (legacy/shadow mode)', () => {
    const html = renderShell({
      semanticValidation: null,
      consistencyWarnings: [{ groupId: 'g', field: 'category_page', message: 'Siblings in group differ.' }],
    });
    expect(html).toContain('Sibling consistency warning');
    expect(html).toContain('category_page:');
    expect(html).toContain('Siblings in group differ.');
    expect(html).not.toContain('⛔ Not review-ready');
  });
});
