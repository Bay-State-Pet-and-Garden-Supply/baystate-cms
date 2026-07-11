import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/repositories/api-key-repo', () => ({
  getApiKey: vi.fn(),
}));

import { callVlm } from '../../onboarding/vlm-client';

const config = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-vlm',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VLM client timeout handling', () => {
  it.each(['AbortError', 'TimeoutError'])('normalizes %s with the original cause', async name => {
    const cause = Object.assign(new Error('aborted by timeout signal'), { name });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    try {
      await callVlm('read this label', 'base64-image', config);
      throw new Error('expected callVlm to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('VLM request timed out after 120s');
      expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });

  it('rethrows non-timeout failures unchanged', async () => {
    const failure = new Error('connection refused');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));

    await expect(callVlm('read this label', 'base64-image', config)).rejects.toBe(failure);
  });
});
