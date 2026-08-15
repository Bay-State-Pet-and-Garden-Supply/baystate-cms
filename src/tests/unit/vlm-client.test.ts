/**
 * VLM client timeout handling (bun:test — `vlm-client.ts` imports
 * `bun:sqlite` transitively, so vitest cannot collect this suite; it runs
 * under `bun test` via `test:db`).
 *
 * Timeout normalization is exercised with direct `globalThis.fetch`
 * stubbing (bun:test has no `vi.stubGlobal`).
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { callVlm, getVlmConfig } from '../../onboarding/vlm-client';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertProviderConnection,
  saveAiRoutingDefaults,
} from '../../db/repositories/provider-connection-repo';

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

describe('VLM client — AI Compute route inheritance (getVlmConfig)', () => {
  beforeAll(() => {
    initDb(':memory:');
    runMigrations();
  });

  afterAll(() => {
    closeDb();
  });

  it('resolves an INHERITED visionOcr route to the usable catalog default', () => {
    upsertProviderConnection({
      id: 'desktop-lmstudio',
      label: 'Desktop LM Studio',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.50',
      approvedPort: 1234,
      enabled: true,
    });
    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'desktop-lmstudio', modelId: 'gemma-4-26b-a4b-qat' },
      catalogFallback: null,
      textDataSharing: 'trusted_lan_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });
    // NO visionOcr route → the route inherits the catalog default.
    const cfg = getVlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.baseUrl).toBe('http://192.168.1.50:1234/v1');
    expect(cfg?.model).toBe('gemma-4-26b-a4b-qat');
    expect(cfg?.transport).toBe('openai-compatible');
    expect(cfg?.enabled).toBe(true);
  });

  it('falls back to the legacy ollama_vlm setting when the inherited AI Compute primary is unusable', () => {
    // Inherited catalog default is a DISABLED connection → not usable → the
    // legacy api_keys.ollama_vlm route is consulted.
    upsertProviderConnection({
      id: 'desktop-lmstudio',
      label: 'Desktop LM Studio',
      transport: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:1234/v1',
      trustZone: 'trusted_lan',
      approvedHost: '192.168.1.50',
      approvedPort: 1234,
      enabled: false,
    });
    upsertApiKey('ollama_vlm', 'enabled', 'http://localhost:11434', 'qwen2.5vl:latest');

    const cfg = getVlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.transport).toBe('ollama-native');
    expect(cfg?.baseUrl).toBe('http://localhost:11434');
    expect(cfg?.model).toBe('qwen2.5vl:latest');
  });
});
