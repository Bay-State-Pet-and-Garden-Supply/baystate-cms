// @vitest-environment jsdom
/**
 * Epic #46 review round — ReviewClassificationPanel clarity contract.
 *
 * The operator reported the Classification section was confusing: raw JSON
 * blobs, abstentions with meaningless Accept/Reject buttons, duplicated
 * attribute rows, and unlabeled confidence. These tests pin the new
 * presentation rules:
 * - abstentions are informational (never accept/reject affordances),
 * - values are humanized (product type label, no JSON),
 * - identical pending proposals merge into one row,
 * - confidence renders as a qualitative chip + percent.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import { ReviewClassificationPanel } from '../../client/components/onboarding/review/ReviewClassificationPanel';

function proposal(partial: Partial<ClassificationProposal>): ClassificationProposal {
  return {
    id: 'p-' + Math.random().toString(36).slice(2, 8),
    runId: 'run-1',
    productSku: 'SKU',
    proposalType: 'field_assignment',
    targetId: 'brand',
    proposedValue: 'LITTLE GIANT',
    confidence: 0.85,
    evidenceIds: [],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

const detail: any = {
  item: {
    curationData: {
      classificationProposals: [],
    },
  },
};

async function renderWith(proposals: ClassificationProposal[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  detail.item.curationData = { classificationProposals: proposals, suggestedPages: [] };
  await act(async () => {
    root.render(
      <ReviewClassificationPanel detail={detail} onDecision={vi.fn()} busyDecisionId={null} />,
    );
  });
  return {
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? ''),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ReviewClassificationPanel clarity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders abstentions as informational notes with NO accept/reject buttons', async () => {
    const abstention = proposal({
      proposalType: 'reviewable_abstention',
      targetId: 'primary-product-type',
      proposedValue: { reason: 'No title signals available from evidence.' },
      confidence: 0,
    });
    const r = await renderWith([abstention]);
    const text = r.text();
    expect(text).toContain('Nothing to propose');
    expect(text).toContain('No title signals available from evidence.');
    expect(r.buttons()).toEqual([]);
    r.unmount();
  });

  it('humanizes the primary product type value — raw JSON never appears', async () => {
    const ppt = proposal({
      proposalType: 'primary_product_type',
      targetId: 'poultry-feed',
      proposedValue: { productTypeId: 'poultry-feed', matchedWords: [] },
      confidence: 0.35,
    });
    const r = await renderWith([ppt]);
    const text = r.text();
    expect(text).toContain('Poultry Feed');
    expect(text).toContain('35%');
    expect(text).toContain('Low');
    expect(text).toContain('Model pick');
    expect(text).not.toContain('"productTypeId"');
    expect(text).not.toContain('{');
    expect(r.buttons()).toEqual(['Accept', 'Reject']);
    r.unmount();
  });

  it('renders matched words as chips for keyword-grounded picks', async () => {
    const ppt = proposal({
      proposalType: 'primary_product_type',
      targetId: 'dog-food-dry',
      proposedValue: { productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] },
      confidence: 0.8,
    });
    const r = await renderWith([ppt]);
    const text = r.text();
    expect(text).toContain('Dog Food Dry');
    expect(text).toContain('Keyword match');
    expect(text).toContain('dog');
    expect(text).toContain('kibble');
    expect(text).toContain('80%');
    r.unmount();
  });

  it('merges identical pending proposals into a single row', async () => {
    const a = proposal({
      proposalType: 'field_assignment',
      targetId: 'brand',
      proposedValue: 'LITTLE GIANT BEEHIVE FRAME FEEDER Feeds your bees',
      confidence: 0.85,
    });
    const b = proposal({
      proposalType: 'field_assignment',
      targetId: 'product-type',
      proposedValue: 'LITTLE GIANT BEEHIVE FRAME FEEDER Feeds your bees',
      confidence: 0.85,
    });
    const r = await renderWith([a, b]);
    const text = r.text();
    expect(text).toContain('Decisions needed (1)');
    expect(text).toContain('1 duplicate merged');
    expect(text).toContain('Brand & Product Type');
    expect(r.buttons()).toEqual(['Accept', 'Reject']);
    r.unmount();
  });

  it('keeps distinct pending proposals as separate decisions', async () => {
    const a = proposal({ targetId: 'brand', proposedValue: 'LITTLE GIANT', confidence: 0.85 });
    const b = proposal({ targetId: 'product-type', proposedValue: 'Poultry Feed', confidence: 0.85 });
    const r = await renderWith([a, b]);
    const text = r.text();
    expect(text).toContain('Decisions needed (2)');
    expect(r.buttons()).toEqual(['Accept', 'Reject', 'Accept', 'Reject']);
    r.unmount();
  });
});
