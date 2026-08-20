// @vitest-environment jsdom
// story: e05s01 — gating and applicability rendering
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import { ReviewClassificationPanel } from '../../client/components/onboarding/review/ReviewClassificationPanel';

async function renderWithCuration(curation: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const detail = { item: { curationData: curation } } as any;
  await act(async () => {
    root.render(<ReviewClassificationPanel detail={detail} onDecision={vi.fn()} busyDecisionId={null} />);
  });
  return {
    container,
    text: () => container.textContent ?? '',
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ReviewClassificationPanel e05s01 gating // story: e05s01', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows Needs reviewed Product Type when gating needsReviewedType', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: true, needsVerifiedPages: false, verifiedPageCount: 3, reason: 'No reviewed Primary Product Type. Page assignment requires an accepted Product Type', verifiedPageIdSet: [], snapshotHash: 'abc' },
      attributeApplicability: [],
      speciesGuardDropped: [],
    });
    expect(r.text()).toContain('Needs reviewed Product Type');
    r.unmount();
  });

  it('shows No verified Catalog Pages when gating needsVerifiedPages', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: true, verifiedPageCount: 0, reason: 'No verified store pages available. Page assignment requires a verified ShopSite Pages import.', verifiedPageIdSet: [], snapshotHash: null },
      attributeApplicability: [],
      speciesGuardDropped: [],
    });
    expect(r.text()).toContain('No verified Catalog Pages');
    r.unmount();
  });

  it('renders attribute applicability with unknown → type not reviewed', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: false, verifiedPageCount: 2, reason: null, verifiedPageIdSet: [], snapshotHash: null },
      attributeApplicability: [
        { attributeId: 'flavor', state: 'unknown', reason: 'No reviewed Primary Product Type; type-gated attribute is blocked until the type is accepted.' },
        { attributeId: 'size', state: 'not_applicable', reason: 'Attribute is not in the accepted Product Type profile (dog-food-dry).' },
      ],
      speciesGuardDropped: [],
    });
    const text = r.text();
    expect(text).toContain('Attribute applicability');
    expect(text).toContain('Flavor');
    expect(text).toContain('unknown');
    expect(text).toContain('Size');
    expect(text).toContain('not_applicable');
    r.unmount();
  });

  it('renders species-guard dropped list', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: ['Dog Food Dry'],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: false, verifiedPageCount: 2, reason: null, verifiedPageIdSet: ['p1'], snapshotHash: 'abc12345' },
      attributeApplicability: [],
      speciesGuardDropped: [{ pageName: 'Cat Food Wet', species: 'dog', reason: 'species_incompatible', matchedTerm: 'cat' }],
    });
    expect(r.text()).toContain('Filtered by species guard');
    expect(r.text()).toContain('Cat Food Wet');
    expect(r.text()).toContain('species_incompatible');
    r.unmount();
  });
});
