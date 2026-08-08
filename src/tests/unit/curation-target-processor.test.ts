/**
 * Integration tests for `processPageTarget()` in `curation-target-processor.ts`.
 *
 * Verifies that the LLM-first path is used (not keyword matching) and that
 * proposals are correctly shaped.
 *
 * Mocks `page-assignment-llm` at the module level to avoid loading
 * bun:sqlite transitive dependencies through `page-repo`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks — mock the entire page-assignment-llm module so its
//    transitive dependencies (page-repo → bun:sqlite) never load ─────

vi.mock('../../classification/page-assignment-llm', () => ({
  buildPageHierarchy: vi.fn(),
  extractProductContext: vi.fn(),
  llmAssignCategoryPages: vi.fn(),
}));

vi.mock('../../classification/runtime-snapshot', () => ({ buildModelCallContext: vi.fn(() => null) }));
vi.mock('../../classification/config-loader', () => ({
  loadClassificationConfig: vi.fn(() => ({
    curationTargets: [
      {
        id: 'page-assignment',
        kind: 'page',
        label: 'Store Category Pages',
        enabled: true,
        selectionMode: 'multiple',
        
      },
    ],
    productTypes: [],
    attributes: [],
  })),
}));

vi.mock('../../classification/curation-target-resolver', () => ({
  resolveEnabledTargets: vi.fn(),
}));

vi.mock('../../classification/curation-target-ranker', () => ({
  llmRankOptions: vi.fn(),
}));

vi.mock('../../classification/cohort-page-coordinator', () => ({
  coordinateCohortPagesOnce: vi.fn(),
}));

// Import after mocks
import { processPageTarget } from '../../classification/curation-target-processor';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
} from '../../classification/page-assignment-llm';
import type { StageInput, StageContext } from '../../classification/types';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const makeContext = (overrides: Partial<StageContext> = {}): StageContext => ({
  workspacePath: '/tmp/test-workspace',
  workspaceId: 'test-workspace',
  runId: 'run-test',
  configSnapshotRef: {
    id: 'snap-1',
    hash: 'snap-1',
    sourceCommit: null,
    createdAt: new Date().toISOString(),
  },
  ...overrides,
});

const makeInput = (overrides: Partial<StageInput> = {}): StageInput => ({
  sku: 'test-sku',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('processPageTarget (LLM-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty proposals when no options are available', async () => {
    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [],
      },
      input,
      context,
    );

    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('No options available');
    expect(llmAssignCategoryPages).not.toHaveBeenCalled();
  });

  it('calls LLM (not keyword matcher) when page options exist and returns proposals', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
      { id: 'dog-food-wet', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test Product',
      productDescription: 'A test product.',
      ocrSummary: {
        species: ['Dog'],
        flavor: null,
        lifeStage: null,
        productForm: null,
        healthConcern: [],
        productName: null,
        brand: null,
      },
      productType: 'Dry Dog Food',
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue({
      pages: [
        { pageId: 'dog-food-dry', pageName: 'Dog Food Dry', confidence: 0.85 },
        { pageId: 'dog-food-wet', pageName: 'Dog Food Wet', confidence: 0.65 },
      ],
    });

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [
          { value: 'dog-food-dry', label: 'Dog Food Dry' },
          { value: 'dog-food-wet', label: 'Dog Food Wet' },
        ],
      },
      input,
      context,
    );

    expect(llmAssignCategoryPages).toHaveBeenCalledTimes(1);
    expect(buildPageHierarchy).toHaveBeenCalledTimes(1);
    expect(extractProductContext).toHaveBeenCalledTimes(1);
    expect(llmAssignCategoryPages).toHaveBeenCalledWith(
      expect.objectContaining({
        productName: 'Test Product',
        productType: 'Dry Dog Food',
      }),
    );

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0].proposalType).toBe('category_page');
    // Stable Page ID is the identity; the display name lives in the value.
    expect(result.proposals[0].targetId).toBe('dog-food-dry');
    expect(result.proposals[0].proposedValue).toHaveProperty('pageId');
    expect(result.proposals[0].proposedValue).toHaveProperty('pageName');
  });

  it('returns empty proposals when LLM returns null', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: null },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test',
      productDescription: '',
      ocrSummary: {
        species: [], flavor: null, lifeStage: null, productForm: null,
        healthConcern: [], productName: null, brand: null,
      },
      productType: null,
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue(null);

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [{ value: 'dog-food-dry', label: 'Dog Food Dry' }],
      },
      input,
      context,
    );

    expect(result.proposals).toEqual([]);
    expect(result.message).toContain('No page assignment from LLM');
  });

  it('proposals include pageId and pageName in proposedValue', async () => {
    vi.mocked(buildPageHierarchy).mockReturnValue([
      { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: null },
    ]);
    vi.mocked(extractProductContext).mockReturnValue({
      productName: 'Test',
      productDescription: '',
      ocrSummary: {
        species: [], flavor: null, lifeStage: null, productForm: null,
        healthConcern: [], productName: null, brand: null,
      },
      productType: null,
    });
    vi.mocked(llmAssignCategoryPages).mockResolvedValue({
      pages: [{ pageId: 'dog-food-dry', pageName: 'Dog Food Dry', confidence: 0.8 }],
    });

    const context = makeContext();
    const input = makeInput();

    const result = await processPageTarget(
      {
        config: {
          id: 'page-assignment',
          kind: 'page',
          label: 'Store Category Pages',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
        options: [{ value: 'dog-food-dry', label: 'Dog Food Dry' }],
      },
      input,
      context,
    );

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal.proposalType).toBe('category_page');
    expect(proposal.targetId).toBe('dog-food-dry');
    expect(proposal.proposedValue).toHaveProperty('pageId', 'dog-food-dry');
    expect(proposal.proposedValue).toHaveProperty('pageName', 'Dog Food Dry');
    expect(proposal.confidence).toBeGreaterThanOrEqual(0);
  });
});
