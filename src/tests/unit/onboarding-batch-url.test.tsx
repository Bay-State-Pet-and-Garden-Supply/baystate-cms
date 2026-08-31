// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../client/onboarding-api', () => ({
  getBatches: vi.fn(),
  getBatch: vi.fn(),
  deleteBatch: vi.fn(),
  uploadSpreadsheet: vi.fn(),
  createBatch: vi.fn(),
  resolveBrandDomains: vi.fn(),
  getBrandSites: vi.fn(),
  getOnboardingCapabilities: vi.fn(),
}));

vi.mock('../../client/onboarding-work-api', () => ({
  getBatchWorkState: vi.fn(),
  subscribeBatchEvents: vi.fn(() => () => {}),
  getItemWorkState: vi.fn(),
  getNeedsAttentionItems: vi.fn(),
  getProcessingItems: vi.fn(),
  getWaitingOnFamilyItems: vi.fn(),
  getReadyForReviewItems: vi.fn(),
  getApprovedItems: vi.fn(),
}));

import { Onboarding } from '../../client/components/Onboarding';
import {
  getBatches,
  getBatch,
  getBrandSites,
  getOnboardingCapabilities,
} from '../../client/onboarding-api';
import { getBatchWorkState } from '../../client/onboarding-work-api';

describe('Onboarding Batch URL Persistence', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();

    vi.mocked(getOnboardingCapabilities).mockResolvedValue({
      sourcing: { engineEnabled: true },
      vlmOcr: { available: true },
      brightData: { available: true },
      braveSearch: { available: true },
    } as any);

    vi.mocked(getBrandSites).mockResolvedValue({
      brandSites: [],
      catalogBrands: [],
    });

    vi.mocked(getBatches).mockResolvedValue({
      batches: [
        {
          id: 'batch-1',
          name: 'Batch Alpha',
          fileName: 'alpha.csv',
          createdAt: '2026-08-30T12:00:00.000Z',
          status: 'active',
          totalItems: 10,
          completedItems: 5,
          failedItems: 0,
          skippedItems: 0,
          executionState: 'running',
          columnMapping: { upc: 'UPC', name: 'Name', nameMergeWith: null, price: null, quantity: null, brand: null, department: null, sourceUrl: null },
          workspaceId: 'ws-test',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
        {
          id: 'batch-2',
          name: 'Batch Beta',
          fileName: 'beta.csv',
          createdAt: '2026-08-30T13:00:00.000Z',
          status: 'active',
          totalItems: 20,
          completedItems: 10,
          failedItems: 0,
          skippedItems: 0,
          executionState: 'running',
          columnMapping: { upc: 'UPC', name: 'Name', nameMergeWith: null, price: null, quantity: null, brand: null, department: null, sourceUrl: null },
          workspaceId: 'ws-test',
          updatedAt: '2026-08-30T12:00:00.000Z',
        },
      ],
      workStateCounts: {},
    });

    vi.mocked(getBatch).mockImplementation(async (id: string): Promise<any> => {
      if (id === 'batch-1') {
        return {
          batch: {
            id: 'batch-1',
            name: 'Batch Alpha',
            fileName: 'alpha.csv',
            createdAt: '2026-08-30T12:00:00.000Z',
            status: 'active',
            totalItems: 10,
            completedItems: 5,
            failedItems: 0,
            skippedItems: 0,
            executionState: 'running',
            columnMapping: { upc: 'UPC', name: 'Name', nameMergeWith: null, price: null, quantity: null, brand: null, department: null, sourceUrl: null },
          workspaceId: 'ws-test',
          updatedAt: '2026-08-30T12:00:00.000Z',
          },
        };
      }
      if (id === 'batch-2') {
        return {
          batch: {
            id: 'batch-2',
            name: 'Batch Beta',
            fileName: 'beta.csv',
            createdAt: '2026-08-30T13:00:00.000Z',
            status: 'active',
            totalItems: 20,
            completedItems: 10,
            failedItems: 0,
            skippedItems: 0,
            executionState: 'running',
            columnMapping: { upc: 'UPC', name: 'Name', nameMergeWith: null, price: null, quantity: null, brand: null, department: null, sourceUrl: null },
          workspaceId: 'ws-test',
          updatedAt: '2026-08-30T12:00:00.000Z',
          },
        };
      }
      throw new Error('Batch not found');
    });

    vi.mocked(getBatchWorkState).mockResolvedValue({
      batchId: 'batch-1',
      counts: {
        needs_attention: 1,
        processing: 2,
        waiting_on_family: 0,
        ready_for_review: 3,
        approved: 4,
        ready_to_export: 0,
        completed: 0,
        skipped: 0,
      },
      items: [],
      total: 10,
    });
  });

  afterEach(() => {
    document.body.removeChild(container);
    window.history.replaceState(null, '', '/');
  });

  it('renders batch list by default when no batch param is present in URL', async () => {
    window.history.replaceState(null, '', '/?view=onboarding');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(getBatches).toHaveBeenCalled();
    expect(container.textContent).toContain('Product Onboarding');
    expect(container.textContent).toContain('Batch Alpha');
    expect(container.textContent).toContain('Batch Beta');
  });

  it('automatically loads and renders the batch when batch param is present on mount (refresh scenario)', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=batch-1');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(getBatch).toHaveBeenCalledWith('batch-1');
    expect(container.textContent).toContain('Batch Alpha');
    expect(container.querySelector('button[aria-label="Back to batches"]')).not.toBeNull();
  });

  it('updates URL when a batch is clicked from the list', async () => {
    window.history.replaceState(null, '', '/?view=onboarding');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);

    // Click on the first row (Batch Alpha)
    await act(async () => {
      (rows[0] as HTMLTableRowElement).click();
    });

    expect(getBatch).toHaveBeenCalledWith('batch-1');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('batch')).toBe('batch-1');
    expect(params.get('view')).toBe('onboarding');
  });

  it('clears batch param from URL when Back to Batches is clicked', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=batch-1');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(container.textContent).toContain('Batch Alpha');
    const backBtn = container.querySelector('button[aria-label="Back to batches"]') as HTMLButtonElement;
    expect(backBtn).not.toBeNull();

    await act(async () => {
      backBtn.click();
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('batch')).toBeNull();
    expect(container.textContent).toContain('Product Onboarding');
  });

  it('handles popstate browser back/forward navigation between batches and list', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=batch-1');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(container.textContent).toContain('Batch Alpha');

    // Simulate browser Back button to ?view=onboarding (no batch)
    await act(async () => {
      window.history.replaceState(null, '', '/?view=onboarding');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.textContent).toContain('Product Onboarding');

    // Simulate browser Forward button to ?view=onboarding&batch=batch-2
    await act(async () => {
      window.history.replaceState(null, '', '/?view=onboarding&batch=batch-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(getBatch).toHaveBeenCalledWith('batch-2');
    expect(container.textContent).toContain('Batch Beta');
  });

  it('gracefully handles non-existent batch ID in URL by clearing batch param and showing error', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=non-existent-batch');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(getBatch).toHaveBeenCalledWith('non-existent-batch');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('batch')).toBeNull();
    expect(container.textContent).toContain('Batch not found');
  });

  it('initializes and preserves the active workspace tab from URL tab parameter on refresh', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=batch-1&tab=review');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    expect(container.textContent).toContain('Batch Alpha');
    const reviewTab = container.querySelector('#bws-tab-review') as HTMLButtonElement;
    expect(reviewTab).not.toBeNull();
    expect(reviewTab.getAttribute('aria-selected')).toBe('true');
  });

  it('updates tab query parameter when switching tabs in BatchWorkspace', async () => {
    window.history.replaceState(null, '', '/?view=onboarding&batch=batch-1');

    const root = createRoot(container);
    await act(async () => {
      root.render(<Onboarding />);
    });

    const processingTab = container.querySelector('#bws-tab-processing') as HTMLButtonElement;
    expect(processingTab).not.toBeNull();

    await act(async () => {
      processingTab.click();
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('processing');
    expect(params.get('batch')).toBe('batch-1');
  });
});
