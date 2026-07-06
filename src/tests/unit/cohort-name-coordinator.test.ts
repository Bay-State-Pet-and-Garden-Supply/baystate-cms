import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import { callLlmForTask, getLlmConfigForTask } from '../../onboarding/llm-client';
import { coordinateCohortItems } from '../../onboarding/cohort-name-coordinator';

vi.mock('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: vi.fn(() => ({
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  })),
  callLlmForTask: vi.fn(async (_task: string, _prompt: string) =>
    JSON.stringify({
      '860012493760': 'Woof Pupsicle Lavender (Small)',
      '860012493746': 'Woof Pupsicle Lavender (Large)',
      '860012493753': 'Woof Pupsicle Lavender (X-Large)',
    }),
  ),
}));

const makeItem = (overrides: Record<string, any> = {}): any => ({
  id: 'test-id',
  batchId: 'test-batch',
  upc: '000000000000',
  name: 'Test Product',
  stage: 'curation',
  stageStatus: 'pending',
  status: 'imported',
  price: null,
  quantity: null,
  brandHint: 'TestBrand',
  departmentHint: null,
  sourceUrl: null,
  expectedName: null,
  errorMessage: null,
  retryCount: 0,
  isDuplicate: false,
  existingSku: null,
  extractionData: { title: 'Test', packagingOcrData: null, packagingTitle: null },
  curationData: null,
  coordinatedTitle: null,
  rowNumber: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('Cohort Name Coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coordinates a group of 3 variants with ONE LLM call', async () => {
    const items = [
      makeItem({ upc: '860012493760', name: 'WOOF PUPSICLE LAVENDER SM' }),
      makeItem({ upc: '860012493746', name: 'WOOF PUPSICLE LAVENDER LG' }),
      makeItem({ upc: '860012493753', name: 'WOOF PUPSICLE LAVENDER XL' }),
    ] as OnboardingItem[];
    const result = await coordinateCohortItems(items);
    expect(getLlmConfigForTask).toHaveBeenCalled();
    expect(result.size).toBe(3);
    expect(result.get('860012493760')).toBe('Woof Pupsicle Lavender (Small)');
  });

  it('skips singletons (no LLM call)', async () => {
    const items = [makeItem()] as OnboardingItem[];
    const result = await coordinateCohortItems(items);
    expect(callLlmForTask).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('handles mixed batch with group + singleton', async () => {
    const items = [
      makeItem({ upc: '860012493760', name: 'WOOF PUPSICLE LAVENDER SM' }),
      makeItem({ upc: '860012493753', name: 'WOOF PUPSICLE LAVENDER XL' }),
      makeItem({ upc: '999999999999', name: 'UNRELATED PRODUCT' }),
    ] as OnboardingItem[];
    const result = await coordinateCohortItems(items);
    expect(getLlmConfigForTask).toHaveBeenCalled();
    expect(result.size).toBe(2);
  });

  it('returns empty map on LLM failure without throwing', async () => {
    (callLlmForTask as any).mockResolvedValueOnce('invalid json');
    const items = [
      makeItem({ upc: '860012493760', name: 'WOOF PUPSICLE LAVENDER SM' }),
      makeItem({ upc: '860012493753', name: 'WOOF PUPSICLE LAVENDER XL' }),
    ] as OnboardingItem[];
    const result = await coordinateCohortItems(items);
    expect(result.size).toBe(0);
  });

  it('returns empty map when LLM not configured', async () => {
    (getLlmConfigForTask as any).mockReturnValueOnce(null);
    const items = [
      makeItem({ upc: '860012493760', name: 'WOOF PUPSICLE LAVENDER SM' }),
      makeItem({ upc: '860012493753', name: 'WOOF PUPSICLE LAVENDER XL' }),
    ] as OnboardingItem[];
    const result = await coordinateCohortItems(items);
    expect(callLlmForTask).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('parses markdown-wrapped JSON correctly', async () => {
    (callLlmForTask as any).mockResolvedValueOnce(
      '```json\n{"860012493760": "Woof Pupsicle Lavender (Small)"}\n```',
    );
    const items = [
      makeItem({ upc: '860012493760', name: 'WOOF PUPSICLE LAVENDER SM' }),
      makeItem({ upc: '860012493761', name: 'WOOF PUPSICLE LAVENDER LG' }),
    ];
    const result = await coordinateCohortItems(items);
    expect(result.get('860012493760')).toBe('Woof Pupsicle Lavender (Small)');
  });
});
