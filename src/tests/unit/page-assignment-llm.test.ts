/**
 * Unit tests for `src/classification/page-assignment-llm.ts`.
 *
 * Runs under vitest. Mocks the LLM client and page repo so no
 * real API calls or database connections are made.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/schemas/classification';

// Helper: cast a mock-spy value to its Mock type so TS sees .mockResolvedValue etc.
function asMock(fn: any): Mock {
  return fn as unknown as Mock;
}

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: vi.fn(),
}));

vi.mock('../../db/repositories/page-repo', () => ({
  listPages: vi.fn(),
}));

// Import after mocks are set up
import { callLlmForTask } from '../../onboarding/llm-client';
import { listPages } from '../../db/repositories/page-repo';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
  type PageAssignmentParams,
} from '../../classification/page-assignment-llm';

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeEvidence = (overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence => ({
  id: 'ev-' + Math.random().toString(36).slice(2, 8),
  runId: 'run-1',
  stageName: 'evidence_extraction',
  productSku: 'test-sku',
  attributeId: null,
  source: 'spreadsheet',
  reliability: 'medium',
  sourceUrl: null,
  sourceField: 'name',
  snippet: null,
  value: 'Test Product',
  metadata: null,
  capturedAt: new Date().toISOString(),
  ...overrides,
});

const makeProposal = (overrides: Partial<ClassificationProposal> = {}): ClassificationProposal => ({
  id: 'prop-' + Math.random().toString(36).slice(2, 8),
  runId: 'run-1',
  productSku: 'test-sku',
  proposalType: 'primary_product_type',
  targetId: null,
  proposedValue: null,
  confidence: 0.8,
  evidenceIds: [],
  status: 'pending',
  isBulkAcceptable: false,
  isStale: false,
  stalenessReason: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

// ─── buildPageHierarchy ──────────────────────────────────────────────────────

describe('buildPageHierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves parent names from page_index', () => {
    const mockPages = [
      { id: 'parent-1', name: 'Dog Food Shop All', fileName: null, parentId: null, pageHash: 'a', lastSyncedAt: null, createdAt: '', updatedAt: '' },
      { id: 'child-1', name: 'Dog Food Dry', fileName: null, parentId: 'parent-1', pageHash: 'b', lastSyncedAt: null, createdAt: '', updatedAt: '' },
      { id: 'child-2', name: 'Dog Food Wet', fileName: null, parentId: 'parent-1', pageHash: 'c', lastSyncedAt: null, createdAt: '', updatedAt: '' },
    ];
    asMock(listPages).mockReturnValue(mockPages);

    const options = [
      { value: 'parent-1', label: 'Dog Food Shop All' },
      { value: 'child-1', label: 'Dog Food Dry' },
      { value: 'child-2', label: 'Dog Food Wet' },
    ];

    const result = buildPageHierarchy(options);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 'parent-1', name: 'Dog Food Shop All', parentName: null });
    expect(result[1]).toEqual({ id: 'child-1', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' });
    expect(result[2]).toEqual({ id: 'child-2', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' });
  });

  it('returns null parentName for top-level pages', () => {
    asMock(listPages).mockReturnValue([
      { id: 'p1', name: 'Dog Toys', fileName: null, parentId: null, pageHash: 'a', lastSyncedAt: null, createdAt: '', updatedAt: '' },
      { id: 'p2', name: 'Dog Beds', fileName: null, parentId: null, pageHash: 'b', lastSyncedAt: null, createdAt: '', updatedAt: '' },
    ]);

    const result = buildPageHierarchy([
      { value: 'p1', label: 'Dog Toys' },
      { value: 'p2', label: 'Dog Beds' },
    ]);

    expect(result.every(p => p.parentName === null)).toBe(true);
  });
});

// ─── extractProductContext ───────────────────────────────────────────────────

describe('extractProductContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts product name from spreadsheet expected_name', () => {
    const evidence = [
      makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'RAW PRODUCT NAME' }),
      makeEvidence({ source: 'spreadsheet', sourceField: 'expected_name', value: 'Cleaned Product Name' }),
      makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
    ];

    const result = extractProductContext(evidence, []);
    expect(result.productName).toBe('Cleaned Product Name');
  });

  it('falls through preference chain: expected_name → web title → OCR name → spreadsheet name', () => {
    // Only spreadsheet name available
    let result = extractProductContext(
      [makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Only Name' })],
      [],
    );
    expect(result.productName).toBe('Only Name');

    // OCR name available (no expected_name or web title)
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
      ],
      [],
    );
    expect(result.productName).toBe('OCR Name');

    // Web title available
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
        makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
      ],
      [],
    );
    expect(result.productName).toBe('Web Title');

    // expected_name beats everything
    result = extractProductContext(
      [
        makeEvidence({ source: 'spreadsheet', sourceField: 'name', value: 'Spreadsheet Name' }),
        makeEvidence({ source: 'spreadsheet', sourceField: 'expected_name', value: 'Expected Name' }),
        makeEvidence({ source: 'visual_product_evidence', sourceField: 'name', value: 'OCR Name' }),
        makeEvidence({ source: 'official_product_page', sourceField: 'title', value: 'Web Title' }),
      ],
      [],
    );
    expect(result.productName).toBe('Expected Name');
  });

  it('extracts species, flavor, lifeStage, productForm from visual_product_evidence', () => {
    const evidence = [
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'species', value: 'dogs' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'flavor', value: 'Smoked Salmon' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'lifeStage', value: 'Adult' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'productForm', value: 'Dry Kibble' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'healthConcern', value: 'Joint Health' }),
      makeEvidence({ source: 'visual_product_evidence', sourceField: 'healthConcern', value: 'Digestion' }),
    ];

    const result = extractProductContext(evidence, []);

    expect(result.ocrSummary.species).toEqual(['Dog', 'dogs']);
    expect(result.ocrSummary.flavor).toBe('Smoked Salmon');
    expect(result.ocrSummary.lifeStage).toBe('Adult');
    expect(result.ocrSummary.productForm).toBe('Dry Kibble');
    expect(result.ocrSummary.healthConcern).toEqual(['Joint Health', 'Digestion']);
  });

  it('extracts productType from primary_product_type proposals', () => {
    const proposals = [
      makeProposal({ proposalType: 'primary_product_type', targetId: 'Dry Dog Food' }),
    ];

    const result = extractProductContext([], proposals);
    expect(result.productType).toBe('Dry Dog Food');
  });

  it('returns null productType when no primary_product_type proposal exists', () => {
    const result = extractProductContext([], []);
    expect(result.productType).toBeNull();
  });
});

// ─── llmAssignCategoryPages ──────────────────────────────────────────────────

describe('llmAssignCategoryPages', () => {
  const mockPages = [
    { id: 'dog-food-dry', name: 'Dog Food Dry', parentName: 'Dog Food Shop All' },
    { id: 'dog-food-wet', name: 'Dog Food Wet', parentName: 'Dog Food Shop All' },
    { id: 'dog-treats', name: 'Dog Treats Shop All', parentName: null },
    { id: 'dog-toys', name: 'Dog Toys', parentName: null },
    { id: 'cat-food', name: 'Cat Food Shop All', parentName: null },
  ];

  const defaultParams: PageAssignmentParams = {
    productName: 'Honest Kitchen Beef Recipe',
    productDescription: 'A premium grain-free dog food.',
    ocrSummary: {
      species: ['Dog'],
      flavor: 'Beef',
      lifeStage: 'Adult',
      productForm: 'Dry Kibble',
      healthConcern: ['Joint Health'],
      productName: 'Honest Kitchen Beef',
      brand: 'The Honest Kitchen',
    },
    productType: 'Dry Dog Food',
    pages: mockPages,
    selectionMode: 'multiple',
    maxPages: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when pages list is empty', async () => {
    const result = await llmAssignCategoryPages({ ...defaultParams, pages: [] });
    expect(result).toBeNull();
    expect(callLlmForTask).not.toHaveBeenCalled();
  });

  it('returns null when LLM returns null (no config/fallback)', async () => {
    asMock(callLlmForTask).mockResolvedValue(null);

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns unparseable response', async () => {
    asMock(callLlmForTask).mockResolvedValue('not valid json at all');

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('returns validated pages when LLM returns valid JSON with pages array', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.85 },
          { pageName: 'Dog Food Wet', confidence: 0.65 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    expect(result!.pages[0]).toEqual({
      pageId: 'dog-food-dry',
      pageName: 'Dog Food Dry',
      confidence: 0.85,
    });
    expect(result!.pages[1]).toEqual({
      pageId: 'dog-food-wet',
      pageName: 'Dog Food Wet',
      confidence: 0.65,
    });
  });

  it('rejects page names not in the provided list', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.85 },
          { pageName: 'Non Existent Page', confidence: 0.7 },
          { pageName: 'Dog Treats Shop All', confidence: 0.6 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    expect(result!.pages.map(p => p.pageName)).toEqual(['Dog Food Dry', 'Dog Treats Shop All']);
  });

  it('returns null when no returned pages match the provided list', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Completely Made Up Page', confidence: 0.9 },
          { pageName: 'Another Fake Page', confidence: 0.8 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).toBeNull();
  });

  it('handles {values: [...]} response shape from LLM', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ values: ['Dog Food Dry', 'Dog Treats Shop All'], confidence: 0.8 }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
    // With the values shape, confidence is pulled from the outer confidence
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
    expect(result!.pages[1].pageName).toBe('Dog Treats Shop All');
  });

  it('strips markdown code fences from LLM response', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      '```json\n{"pages":[{"pageName":"Dog Food Dry","confidence":0.8}]}\n```',
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(1);
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
  });

  it('matches page names case-insensitively', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({ pages: [{ pageName: 'dog food dry', confidence: 0.8 }] }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages[0].pageName).toBe('Dog Food Dry');
    expect(result!.pages[0].pageId).toBe('dog-food-dry');
  });

  it('caps confidence between 0.35 and 0.95', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.99 }, // should cap at 0.95
          { pageName: 'Dog Food Wet', confidence: 0.1 }, // should floor at 0.35
        ],
      }),
    );

    const result = await llmAssignCategoryPages(defaultParams);
    expect(result).not.toBeNull();
    expect(result!.pages[0].confidence).toBe(0.95);
    expect(result!.pages[1].confidence).toBe(0.35);
  });

  it('limits results to maxPages', async () => {
    asMock(callLlmForTask).mockResolvedValue(
      JSON.stringify({
        pages: [
          { pageName: 'Dog Food Dry', confidence: 0.9 },
          { pageName: 'Dog Food Wet', confidence: 0.8 },
          { pageName: 'Dog Treats Shop All', confidence: 0.7 },
          { pageName: 'Dog Toys', confidence: 0.6 },
        ],
      }),
    );

    const result = await llmAssignCategoryPages({ ...defaultParams, maxPages: 2 });
    expect(result).not.toBeNull();
    expect(result!.pages).toHaveLength(2);
  });
});
