/**
 * ReviewPagesPanel — pages promoted into the main field stack (post-critique).
 * Contract: chips render from curation.suggestedPages; removal calls
 * onUpdatePages WITHOUT a correction; adding a VERIFIED page (active import)
 * passes the correctedCategoryPage provenance record (adjudication #10);
 * adding an unverified page does not.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReviewPagesPanel } from '../../client/components/onboarding/review/ReviewPagesPanel';

vi.mock('../../../api', () => ({
  listPages: vi.fn(async () => ({ pages: [{ name: 'Dog Food' }, { name: 'Cat Toys' }, { name: 'Bird Cages' }] })),
  listVerifiedPageOptionSummaries: vi.fn(async () => ({
    pages: [{ id: 'page-1', name: 'Dog Food' }],
    activeImportHash: 'import-hash-1',
  })),
}));

function makeDetail(suggestedPages: string[]) {
  return {
    item: { curationData: { suggestedPages } },
  } as never;
}

async function renderPanel(props: { detail: never; onUpdatePages?: (...args: unknown[]) => Promise<void> }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ReviewPagesPanel {...props} />);
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

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReviewPagesPanel // pages promoted to main fields', () => {
  it('renders the Required badge and assigned page chips', async () => {
    const p = await renderPanel({ detail: makeDetail(['Dog Food']) });
    expect(p.text()).toContain('Required');
    expect(p.text()).toContain('Dog Food');
    p.unmount();
  });

  it('empty state says no pages assigned yet', async () => {
    const p = await renderPanel({ detail: makeDetail([]) });
    expect(p.text()).toContain('No category pages assigned yet.');
    p.unmount();
  });
});
