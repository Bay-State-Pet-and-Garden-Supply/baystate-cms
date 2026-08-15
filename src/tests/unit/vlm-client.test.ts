/**
 * VLM client timeout handling (bun:test — `vlm-client.ts` imports
 * `bun:sqlite` transitively, so vitest cannot collect this suite; it runs
 * under `bun test` via `test:db`).
 *
 * Timeout normalization is exercised with direct `globalThis.fetch`
 * stubbing (bun:test has no `vi.stubGlobal`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { callVlm } from '../../onboarding/vlm-client';

const config = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-vlm',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('VLM client timeout handling', () => {
  it.each(['AbortError', 'TimeoutError'])('normalizes %s with the original cause', async name => {
    const cause = Object.assign(new Error('aborted by timeout signal'), { name });
    globalThis.fetch = (async () => {
      throw cause;
    }) as unknown as typeof fetch;

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
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;

    await expect(callVlm('read this label', 'base64-image', config)).rejects.toBe(failure);
  });
});
