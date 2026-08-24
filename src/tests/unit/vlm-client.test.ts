/**
 * VLM client timeout handling (bun:test — `vlm-client.ts` imports
 * `bun:sqlite` transitively, so vitest cannot collect this suite; it runs
 * under `bun test` via `test:db`).
 *
 * Timeout normalization is exercised with direct `globalThis.fetch`
 * stubbing (bun:test has no `vi.stubGlobal`).
 */

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { callVlm, getVlmConfig, parseOcrTimeoutMs, DEFAULT_OCR_TIMEOUT_MS, sniffImageMimeType } from '../../onboarding/vlm-client';
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

// ─── image MIME sniffing (FIX-10) ─────────────────────────────────────────────

describe('sniffImageMimeType (magic-header detection)', () => {
  it('detects JPEG, PNG, GIF, and WebP headers from decoded base64 bytes', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1100)]).toString('base64');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.alloc(1100)]).toString('base64');
    const gif = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), Buffer.alloc(1100)]).toString('base64');
    const webp = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(1100)]).toString('base64');
    expect(sniffImageMimeType(jpeg)).toBe('image/jpeg');
    expect(sniffImageMimeType(png)).toBe('image/png');
    expect(sniffImageMimeType(gif)).toBe('image/gif');
    expect(sniffImageMimeType(webp)).toBe('image/webp');
  });

  it('defaults undecodable/unknown payloads to image/jpeg', () => {
    // Not real base64 image data — historical hardcoded value applies.
    expect(sniffImageMimeType('base64-image')).toBe('image/jpeg');
    expect(sniffImageMimeType('')).toBe('image/jpeg');
    const text = Buffer.from('plain text payload', 'utf8').toString('base64');
    expect(sniffImageMimeType(text)).toBe('image/jpeg');
  });
});

// ─── P3-T2 sampling options serialization ────────────────────────────────────

describe('callVlm sampling options (VlmConfig.options)', () => {
  function stubFetch(capture: { url?: string; body?: string }): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      capture.url = typeof input === 'string' ? input : input.toString();
      capture.body = String(init?.body ?? '');
      return new Response(JSON.stringify({ message: { content: 'ok' }, choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    delete process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS;
  });

  it('serializes temperature/frequency_penalty into the ollama-native body.options', async () => {
    const capture: { url?: string; body?: string } = {};
    globalThis.fetch = stubFetch(capture);
    await callVlm('p', 'b64', {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'm1',
      enabled: true,
      transport: 'ollama-native',
      options: { temperature: 0, frequencyPenalty: 0.3 },
    });
    const body = JSON.parse(capture.body!);
    expect(body.options).toEqual({ temperature: 0, frequency_penalty: 0.3 });
    expect(capture.url).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('serializes sampling as top-level fields into the openai-compatible body', async () => {
    const capture: { url?: string; body?: string } = {};
    globalThis.fetch = stubFetch(capture);
    await callVlm('p', 'b64', {
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'm2',
      enabled: true,
      transport: 'openai-compatible',
      options: { temperature: 0.2, frequencyPenalty: 0.5 },
    });
    const body = JSON.parse(capture.body!);
    expect(body.temperature).toBe(0.2);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.options).toBeUndefined();
    expect(capture.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('keeps bodies BYTE-IDENTICAL to pre-P3-T2 snapshots when options are absent', async () => {
    const ollamaCapture: { body?: string } = {};
    globalThis.fetch = stubFetch(ollamaCapture);
    await callVlm('read this label', 'base64-image', {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-vlm',
      enabled: true,
      transport: 'ollama-native',
    });
    expect(ollamaCapture.body).toBe(JSON.stringify({
      model: 'test-vlm',
      messages: [
        { role: 'user', content: 'read this label', images: ['base64-image'] },
      ],
      stream: false,
    }));

    const openAiCapture: { body?: string } = {};
    globalThis.fetch = stubFetch(openAiCapture);
    await callVlm('read this label', 'base64-image', {
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test-vlm',
      enabled: true,
      transport: 'openai-compatible',
    });
    expect(openAiCapture.body).toBe(JSON.stringify({
      model: 'test-vlm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read this label' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,base64-image' } },
          ],
        },
      ],
      stream: false,
    }));
  });
});

// ─── per-attempt timeout knob (post-review fixup 4) ─────────────────────────────

describe('parseOcrTimeoutMs (BAYSTATE_CMS_OCR_TIMEOUT_MS)', () => {
  const ORIGINAL = process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS;
    else process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS = ORIGINAL;
  });

  it('defaults to 120000 when the env var is absent', () => {
    delete process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS;
    expect(parseOcrTimeoutMs()).toBe(120_000);
    expect(DEFAULT_OCR_TIMEOUT_MS).toBe(120_000);
  });

  it('parses a positive integer override', () => {
    expect(parseOcrTimeoutMs('45000')).toBe(45_000);
    process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS = '30000';
    expect(parseOcrTimeoutMs()).toBe(30_000);
  });

  it('falls back to the default for unparseable values', () => {
    expect(parseOcrTimeoutMs('not-a-number')).toBe(120_000);
    expect(parseOcrTimeoutMs('12abc')).toBe(120_000); // non-integer junk rejected
    expect(parseOcrTimeoutMs('')).toBe(120_000);
  });

  it('falls back to the default for zero and negative values', () => {
    expect(parseOcrTimeoutMs('0')).toBe(120_000);
    expect(parseOcrTimeoutMs('-5000')).toBe(120_000);
    process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS = '-1';
    expect(parseOcrTimeoutMs()).toBe(120_000);
  });
});
