import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireLocalSlot,
  releaseLocalSlot,
  getLocalConcurrencyStats,
  getLocalRuntimeStatus,
  getMaxLocalConcurrency,
  _resetLocalCoordinatorState,
} from '../../ai/local-runtime-coordinator';

describe('Local Runtime Coordinator (PR 2)', () => {
  const originalEnv = process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;

  beforeEach(() => {
    _resetLocalCoordinatorState();
    delete process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;
  });

  afterEach(() => {
    _resetLocalCoordinatorState();
    if (originalEnv !== undefined) {
      process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = originalEnv;
    } else {
      delete process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;
    }
  });

  test('default max concurrency is 1', () => {
    expect(getMaxLocalConcurrency()).toBe(1);
  });

  test('respects process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY override', () => {
    process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = '3';
    expect(getMaxLocalConcurrency()).toBe(3);
  });

  test('ignores non-numeric or non-positive env values and falls back to 1', () => {
    process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = 'invalid';
    expect(getMaxLocalConcurrency()).toBe(1);

    process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = '0';
    expect(getMaxLocalConcurrency()).toBe(1);

    process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = '-2';
    expect(getMaxLocalConcurrency()).toBe(1);
  });

  test('cloud providers bypass the local semaphore without queuing', async () => {
    await acquireLocalSlot('deepseek');
    await acquireLocalSlot('openai');
    const stats = getLocalConcurrencyStats();
    expect(stats.activeRequests).toBe(0);
    expect(stats.queuedRequests).toBe(0);
    releaseLocalSlot('deepseek');
    releaseLocalSlot('openai');
  });

  test('ollama requests acquire and serialize under maxConcurrency = 1', async () => {
    let secondAcquired = false;

    await acquireLocalSlot('ollama');
    expect(getLocalConcurrencyStats().activeRequests).toBe(1);
    expect(getLocalConcurrencyStats().queuedRequests).toBe(0);

    const secondPromise = acquireLocalSlot('ollama').then(() => {
      secondAcquired = true;
    });

    expect(secondAcquired).toBe(false);
    expect(getLocalConcurrencyStats().queuedRequests).toBe(1);

    releaseLocalSlot('ollama');
    await secondPromise;

    expect(secondAcquired).toBe(true);
    expect(getLocalConcurrencyStats().activeRequests).toBe(1);
    expect(getLocalConcurrencyStats().queuedRequests).toBe(0);

    releaseLocalSlot('ollama');
    expect(getLocalConcurrencyStats().activeRequests).toBe(0);
  });

  test('allows parallel local execution when maxConcurrency > 1', async () => {
    process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = '2';

    await acquireLocalSlot('ollama');
    await acquireLocalSlot('ollama');

    expect(getLocalConcurrencyStats().activeRequests).toBe(2);
    expect(getLocalConcurrencyStats().queuedRequests).toBe(0);

    releaseLocalSlot('ollama');
    releaseLocalSlot('ollama');
    expect(getLocalConcurrencyStats().activeRequests).toBe(0);
  });

  test('getLocalRuntimeStatus queries Ollama /api/ps and returns running models', async () => {
    const mockFetch = (async (url: string) => {
      if (url.includes('/api/ps')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'gemma4:12b-mlx', size: 8589934592, digest: 'abc123digest' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const status = await getLocalRuntimeStatus('http://localhost:11434');
      expect(status.connected).toBe(true);
      expect(status.runningModels.length).toBe(1);
      expect(status.runningModels[0].name).toBe('gemma4:12b-mlx');
      expect(status.maxConcurrency).toBe(1);
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  });

  test('getLocalRuntimeStatus returns connected: false on fetch failure', async () => {
    const mockFetch = (async () => {
      throw new Error('Connection refused');
    }) as unknown as typeof fetch;

    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const status = await getLocalRuntimeStatus('http://localhost:11434');
      expect(status.connected).toBe(false);
      expect(status.runningModels).toEqual([]);
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  });
});
