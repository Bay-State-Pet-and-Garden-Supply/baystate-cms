import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageContext, StageInput } from '../../classification/types';

const mocks = vi.hoisted(() => ({
  coordinate: vi.fn(),
  perItem: vi.fn(),
}));

vi.mock('../../classification/config-loader', () => ({ loadClassificationConfig: vi.fn() }));
vi.mock('../../classification/curation-target-resolver', () => ({ resolveEnabledTargets: vi.fn() }));
vi.mock('../../classification/detail-enrichment', () => ({ enrichProductDetails: vi.fn(() => []) }));
vi.mock('../../classification/curation-target-ranker', () => ({ llmRankOptions: vi.fn() }));
vi.mock('../../classification/cohort-page-coordinator', () => ({
  coordinateCohortPagesOnce: mocks.coordinate,
}));
vi.mock('../../classification/page-assignment-llm', () => ({
  buildPageHierarchy: vi.fn((options: Array<{ value: string; label: string }>) =>
    options.map(option => ({ id: option.value, name: option.label, parentName: null }))),
  extractProductContext: vi.fn(() => ({
    productName: 'Acme Cat Pate',
    productDescription: 'Wet cat food',
    ocrSummary: { species: ['Cat'], flavor: null, lifeStage: null, productForm: 'Pate', healthConcern: [], productName: null, brand: 'Acme' },
    productType: null,
  })),
  llmAssignCategoryPages: mocks.perItem,
}));

vi.mock('../../classification/runtime-snapshot', () => ({ buildModelCallContext: vi.fn(() => null) }));
import { processPageTarget } from '../../classification/curation-target-processor';

const products = [
  { sku: 'SKU1', name: 'Acme Cat Pate Chicken', webTitle: null, brand: 'Acme', description: '', species: ['Cat'], flavor: 'Chicken', lifeStage: null, productForm: 'Pate', healthConcern: [] },
  { sku: 'SKU2', name: 'Acme Cat Pate Salmon', webTitle: null, brand: 'Acme', description: '', species: ['Cat'], flavor: 'Salmon', lifeStage: null, productForm: 'Pate', healthConcern: [] },
];

const context: StageContext = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-SKU1',
  configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
  productLineContext: {
    groupId: 'group-acme-pate', groupLabel: 'Acme Pate', siblingNames: products.map(p => p.name),
    siblingWebTitles: [], siblingOcrTitles: [], siblingSkus: products.map(p => p.sku),
  },
  productLineItems: products,
};

const input: StageInput = {
  sku: 'SKU1', onboardingItemId: 'item-1', evidence: [], acceptedProposals: [], allProposals: [],
};

const target = {
  config: { id: 'pages', kind: 'page', label: 'Pages', enabled: true, selectionMode: 'multiple' },
  options: [{ value: 'cat-wet', label: 'Cat Food Wet' }],
};

describe('grouped page target processing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses only the current SKU result and never invokes per-item LLM', async () => {
    mocks.coordinate.mockResolvedValue(new Map([
      ['SKU1', { status: 'assigned', pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }] }],
      ['SKU2', { status: 'assigned', pages: [{ pageId: 'other', pageName: 'Other', confidence: 0.7 }] }],
    ]));
    const result = await processPageTarget(target as any, input, context);
    expect(mocks.coordinate).toHaveBeenCalledTimes(1);
    expect(mocks.perItem).not.toHaveBeenCalled();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].productSku).toBe('SKU1');
    expect(result.proposals[0].targetId).toBe('cat-wet');
  });

  it('returns zero proposals on cohort abstention without per-item fallback', async () => {
    mocks.coordinate.mockResolvedValue(new Map([
      ['SKU1', { status: 'abstained', reason: 'invalid group response' }],
      ['SKU2', { status: 'abstained', reason: 'invalid group response' }],
    ]));
    const result = await processPageTarget(target as any, input, context);
    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('Cohort page coordination abstained');
    expect(mocks.perItem).not.toHaveBeenCalled();
  });
});
