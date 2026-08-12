import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductLineItemSnapshot } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  getLlmConfigForTask: vi.fn(),
  callLlmForTaskWithProvenance: vi.fn(),
}));

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  getLlmConfigForTask: mocks.getLlmConfigForTask,
  // Route through the test handle so tests can inspect the transport options
  // (e.g. the B3 protectedOperation pin); the default implementation wraps the
  // string content in the enriched result shape the coordinator consumes.
  callLlmForTaskWithProvenance: (...args: unknown[]) => mocks.callLlmForTaskWithProvenance(...args),
}));
vi.mock('../../db/repositories/page-repo', () => ({ listPages: vi.fn(() => []) }));
// The coordinator records terminal preflight rows; mock the repo so the
// bun:sqlite-backed module never loads in the Vitest graph.
vi.mock('../../db/repositories/classification-model-call-repo', () => ({
  recordTerminalPreflight: vi.fn(),
}));

import {
  clearCohortPageCoordinationCache,
  coordinateCohortPagesOnce,
  type CohortPageCoordinationParams,
} from '../../classification/cohort-page-coordinator';
import { llmAssignCategoryPages } from '../../classification/page-assignment-llm';
import { getLlmConfigForTask } from '../../onboarding/llm-client';
import { pageModelAuthorityFromConfig } from '../../onboarding/cohort-page-hash';

const pages = [
  { id: 'cat-wet', name: 'Cat Food Wet', parentName: 'Cat Food Shop All' },
  { id: 'cat-shop', name: 'Cat Food Shop All', parentName: null },
  { id: 'dog-food', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
  { id: 'brand-acme', name: 'Brand - Acme', parentName: null },
  { id: 'cat-treats', name: 'Cat Treats', parentName: null },
];

function product(sku: string, species: string[] = ['Cat']): ProductLineItemSnapshot {
  return {
    sku,
    name: `Acme Pate ${sku}`,
    webTitle: `Acme Pate ${sku}`,
    brand: 'Acme',
    description: 'Wet food in a cup.',
    species,
    flavor: sku,
    lifeStage: null,
    productForm: 'Pate',
    healthConcern: [],
  };
}

function params(products = [product('SKU1'), product('SKU2')]): CohortPageCoordinationParams {
  return { groupId: 'group-acme-pate', products, pages, selectionMode: 'multiple', maxPages: 5 };
}

function validResponse(products: ProductLineItemSnapshot[]): string {
  return JSON.stringify(Object.fromEntries(products.map(item => [item.sku, [
    { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
  ]])));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCohortPageCoordinationCache();
  mocks.getLlmConfigForTask.mockReturnValue({ provider: 'openai', model: 'test-model' });
  mocks.callLlmForTaskWithProvenance.mockImplementation(
    async (task: string, prompt: string, system: string) => {
      const content = await mocks.callLlmForTask(task, prompt, system);
      return content == null
        ? null
        : { content, callId: 'cohort-call-1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } };
    },
  );
});

describe('cohort page coordinator', () => {
  it('shares one LLM call across concurrent and sequential calls', async () => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(validResponse(input.products));
    const [first, second] = await Promise.all([
      coordinateCohortPagesOnce(input),
      coordinateCohortPagesOnce(input),
    ]);
    const third = await coordinateCohortPagesOnce(input);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('includes every member of a 16-variant group in one call and result', async () => {
    const products = Array.from({ length: 16 }, (_, index) => product(`SKU${index + 1}`));
    const input = params(products);
    mocks.callLlmForTask.mockResolvedValue(validResponse(products));
    const result = await coordinateCohortPagesOnce(input);
    expect(result.size).toBe(16);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
    const prompt = mocks.callLlmForTask.mock.calls[0][1] as string;
    for (const item of products) expect(prompt).toContain(`SKU ${item.sku}`);
  });

  it('normalizes exact brand and removes Shop All beside a specific page', async () => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(JSON.stringify({
      SKU1: [
        { pageId: 'cat-shop', pageName: 'Cat Food Shop All', confidence: 0.5 },
        { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
      ],
      SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
    }));
    const result = await coordinateCohortPagesOnce(input);
    expect(result.get('SKU1')).toEqual({ status: 'assigned', pages: [
      { pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 },
      { pageId: 'brand-acme', pageName: 'Brand - Acme', confidence: 0.95, isBrandShortcut: true },
    ], modelCallIds: ['cohort-call-1'] });
  });

  it('applies species safety per SKU and retains different valid page sets', async () => {
    const input = params([product('CAT', ['Cat']), product('DOG', ['Dog'])]);
    mocks.callLlmForTask.mockResolvedValue(JSON.stringify({
      CAT: [
        { pageId: 'dog-food', pageName: 'Dog Food Dry', confidence: 0.7 },
        { pageId: 'cat-treats', pageName: 'Cat Treats', confidence: 0.8 },
      ],
      DOG: [{ pageId: 'dog-food', pageName: 'Dog Food Dry', confidence: 0.85 }],
    }));
    const result = await coordinateCohortPagesOnce(input);
    const cat = result.get('CAT');
    const dog = result.get('DOG');
    expect(cat?.status).toBe('assigned');
    expect(dog?.status).toBe('assigned');
    if (cat?.status === 'assigned' && dog?.status === 'assigned') {
      expect(cat.pages.map(page => page.pageId)).toEqual(['cat-treats', 'brand-acme']);
      expect(dog.pages.map(page => page.pageId)).toEqual(['dog-food', 'brand-acme']);
      expect(cat.pages).not.toEqual(dog.pages);
    }
  });

  it.each([
    ['missing SKU', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['unknown ID', JSON.stringify({ SKU1: [{ pageId: 'missing', pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['ID/name mismatch', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Dog Food Dry', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['missing pageId', JSON.stringify({ SKU1: [{ pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['empty assignment', JSON.stringify({ SKU1: [], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] })],
    ['invalid JSON', '{not json'],
    ['wrapper object', JSON.stringify({ assignments: { SKU1: [], SKU2: [] } })],
    ['unknown SKU', JSON.stringify({ SKU1: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }], SKU2: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }], OTHER: [] })],
    ['duplicate SKU key', '{"SKU1":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}],"SKU1":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}],"SKU2":[{"pageId":"cat-wet","pageName":"Cat Food Wet","confidence":0.8}]}'],
  ])('abstains every member for %s', async (_label, response) => {
    const input = params();
    mocks.callLlmForTask.mockResolvedValue(response);
    const result = await coordinateCohortPagesOnce(input);
    expect([...result.values()].every(value => value.status === 'abstained')).toBe(true);
  });

  it('invalidates the stable fingerprint when a product or page changes', async () => {
    const first = params();
    mocks.callLlmForTask.mockResolvedValue(validResponse(first.products));
    await coordinateCohortPagesOnce(first);
    const changedProduct = params([{ ...first.products[0], description: 'Changed evidence' }, first.products[1]]);
    await coordinateCohortPagesOnce(changedProduct);
    const changedPage = { ...changedProduct, pages: [...pages, { id: 'new-page', name: 'New Page', parentName: null }] };
    await coordinateCohortPagesOnce(changedPage);
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(3);
  });
});

describe('PR7 review R1 (B3) — parent singleton transport resolves the P-hash model authority', () => {
  /** Divergent routes: `cohort_page_assignment` → provider A (ollama),
   *  `page_assignment` → provider B (openai). */
  function mockDivergentRoutes(): void {
    mocks.getLlmConfigForTask.mockImplementation((task: string, options: Record<string, unknown>) => {
      const operation = options?.protectedOperation;
      if (operation === 'cohort_page_assignment') return { provider: 'ollama', model: 'qwen2.5vl:latest' };
      if (operation === 'page_assignment') return { provider: 'openai', model: 'gpt-4o-mini' };
      return { provider: 'openai', model: 'test-model' };
    });
  }

  function singletonParams() {
    return {
      productName: 'Acme Pate Chicken',
      productDescription: 'Wet food in a cup.',
      ocrSummary: {
        species: ['Cat'], flavor: 'Chicken', lifeStage: null, productForm: 'Pate',
        healthConcern: [], productName: null, brand: 'Acme',
      },
      productType: 'Dry Dog Food',
      pages,
      selectionMode: 'multiple' as const,
      maxPages: 5,
    };
  }

  it('with divergent routes, the parent singleton transport uses the cohort_page_assignment route (provider A) and the P-hash authority equals A', async () => {
    mockDivergentRoutes();
    mocks.callLlmForTask.mockResolvedValue(
      JSON.stringify({ pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] }),
    );

    const result = await llmAssignCategoryPages(
      singletonParams(),
      { protectedOperation: 'cohort_page_assignment' },
    );
    expect(result).not.toBeNull();
    // The audited transport was invoked with the PINNED operation — the route
    // that resolves to provider A (the same route the P-hash claims).
    const transportOptions = mocks.callLlmForTaskWithProvenance.mock.calls[0][3] as Record<string, unknown>;
    expect(transportOptions.protectedOperation).toBe('cohort_page_assignment');
    // The P-hash model authority resolves to the SAME route → provider A.
    expect(pageModelAuthorityFromConfig('/tmp/ws', { providerLocalities: { ollama: 'local' } } as never, 'snap'))
      .toEqual({ provider: 'ollama', model: 'qwen2.5vl:latest' });
    // The legacy 'page_assignment' route resolves to provider B — the
    // divergence is real, and the parent singleton no longer takes it.
    mocks.getLlmConfigForTask.mockClear();
    expect(getLlmConfigForTask('category_page_assignment', {
      allowFallback: true,
      protectedOperation: 'page_assignment',
    })).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('legacy callers omit the options → the transport keeps the legacy page_assignment route (byte-identical)', async () => {
    mockDivergentRoutes();
    mocks.callLlmForTask.mockResolvedValue(
      JSON.stringify({ pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] }),
    );
    const result = await llmAssignCategoryPages(singletonParams());
    expect(result).not.toBeNull();
    const transportOptions = mocks.callLlmForTaskWithProvenance.mock.calls[0][3] as Record<string, unknown>;
    expect(transportOptions.protectedOperation).toBe('page_assignment');
  });
});
