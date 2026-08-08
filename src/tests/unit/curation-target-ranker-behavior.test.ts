import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  getLlmConfigForTask: vi.fn(() => ({
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test',
  })),
}));

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  getLlmConfigForTask: mocks.getLlmConfigForTask,
  defaultProtectedOperationForTask: () => 'product_type_ranking',
}));

import { llmRankOptions } from '../../classification/curation-target-ranker';

const baseParams = {
  targetLabel: 'Flavor',
  options: [
    { value: 'chicken', label: 'Chicken' },
    { value: 'salmon', label: 'Salmon' },
  ],
  selectionMode: 'single' as const,
  evidenceText: 'Official packaging says chicken recipe for adult dogs.',
  // Protected ranking requires a frozen policy context (issue #17 pass 1c).
  modelPolicy: {} as unknown as import('../../classification/model-policy-gateway').ModelPolicyView,
};

describe('curation target ranker response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abstains without any LLM call when no modelPolicy is supplied (pass 1c)', async () => {
    const { targetLabel, options, selectionMode, evidenceText } = baseParams;
    await expect(
      llmRankOptions({ targetLabel, options, selectionMode, evidenceText }),
    ).resolves.toBeNull();
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
    expect(mocks.getLlmConfigForTask).not.toHaveBeenCalled();
  });

  it('does not retry a valid empty abstention', async () => {
    mocks.callLlmForTask.mockResolvedValueOnce('{"values":[],"confidence":0}');

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
  });

  it('retries once after invalid JSON and accepts repaired JSON', async () => {
    mocks.callLlmForTask
      .mockResolvedValueOnce('not valid json')
      .mockResolvedValueOnce('{"values":["Chicken"],"confidence":0.8}');

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.8,
    });
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(2);
  });

  it('does not retry a valid non-empty response', async () => {
    mocks.callLlmForTask.mockResolvedValueOnce(
      '{"values":["Salmon"],"confidence":0.7}',
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Salmon'],
      confidence: 0.7,
    });
    expect(mocks.callLlmForTask).toHaveBeenCalledTimes(1);
  });
});
