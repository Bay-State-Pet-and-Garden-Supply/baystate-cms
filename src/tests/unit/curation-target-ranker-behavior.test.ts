import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  callLlmForTaskWithProvenance: vi.fn(),
  getLlmConfigForTask: vi.fn(() => ({
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test',
  })),
}));

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  callLlmForTaskWithProvenance: mocks.callLlmForTaskWithProvenance,
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
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce({ content: '{"values":[],"confidence":0}', callId: 'c1', provider: 'openai', model: 'test-model', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
  });

  it('retries once after invalid JSON and accepts repaired JSON', async () => {
    mocks.callLlmForTaskWithProvenance
      .mockResolvedValueOnce({ content: 'not valid json', callId: 'c1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } })
      .mockResolvedValueOnce({ content: '{"values":["Chicken"],"confidence":0.8}', callId: 'c2', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } });

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.8,
      modelCallIds: ['c2'],
    });
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(2);
  });

  it('does not retry a valid non-empty response', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Salmon"],"confidence":0.7}', callId: 'c3', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Salmon'],
      confidence: 0.7,
      modelCallIds: ['c3'],
    });
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
  });
});
