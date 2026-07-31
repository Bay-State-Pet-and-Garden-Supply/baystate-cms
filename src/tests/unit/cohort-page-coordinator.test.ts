import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductLineItemSnapshot } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  getLlmConfigForTask: vi.fn(),
}));

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  getLlmConfigForTask: mocks.getLlmConfigForTask,
}));
vi.mock('../../db/repositories/page-repo', () => ({ listPages: vi.fn(() => []) }));

import {
  clearCohortPageCoordinationCache,
  coordinateCohortPagesOnce,
  type CohortPageCoordinationParams,
} from '../../classification/cohort-page-coordinator';

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
    ] });
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
