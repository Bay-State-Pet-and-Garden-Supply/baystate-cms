/**
 * P3-T2 repetition-tail mitigation — pure `detectRepetitionTail` unit cases
 * plus the success-with-retry metadata note.
 *
 * bun:test: src/onboarding/packaging-ocr.ts transitively imports bun:sqlite
 * repositories (same reason packaging-ocr-attempt.test.ts is bun-backed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { runPackagingOcrAttempt, detectRepetitionTail } from '../../onboarding/packaging-ocr';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { resetCircuitBreakers } from '../../onboarding/vlm-circuit-breaker';

let tmpDir: string;

/** Local >1KiB image so no remote image fetch is attempted. */
function seedLocalImage(): string {
  const imgPath = path.join(tmpDir, 'img.bin');
  fs.writeFileSync(imgPath, Buffer.alloc(2048, 0x64));
  return imgPath;
}

describe('detectRepetitionTail', () => {
  it('does not trigger on clean JSON/text', () => {
    expect(detectRepetitionTail(JSON.stringify({ productName: 'Acme Dog Food', brand: 'Acme' }))).toBe(false);
    const prose = 'The package shows a dog food bag with feeding instructions and storage notes printed clearly.';
    expect(detectRepetitionTail(prose)).toBe(false);
    expect(detectRepetitionTail('')).toBe(false);
  });

  it('triggers when an n-gram repeats ≥3 consecutive times near the tail', () => {
    const base = 'The package shows dog treats and ';
    const tail = 'and and and and and and and and and and and end of label text here';
    expect(detectRepetitionTail(base + tail)).toBe(true);
    const trigram = Array.from({ length: 6 }, () => 'dog treats bag').join(' ');
    expect(detectRepetitionTail(`Long enough prefix sentence to pass the minimum length guard. ${trigram}`)).toBe(true);
  });

  it('does not trigger on short texts even with repeated words', () => {
    expect(detectRepetitionTail('very very very')).toBe(false);
    expect(detectRepetitionTail('{"productName":"x"}')).toBe(false);
  });

  it('does not trigger on legit repeated printed lines (few single-token repeats)', () => {
    // Three consecutive identical words are a plausible legitimate label
    // echo; the single-token rule requires ≥6 consecutive repeats.
    const legitEcho =
      'The package shows a dog food bag with feeding instructions and storage notes printed clearly. ' +
      'Flavor: chicken chicken chicken.';
    expect(detectRepetitionTail(legitEcho)).toBe(false);
    expect(detectRepetitionTail('boom boom boom with plenty of other label copy to pass the minimum length guard here')).toBe(false);
  });

  it('only inspects roughly the last 200 characters', () => {
    const repetitivePrefix = Array.from({ length: 40 }, () => 'repeat').join(' ');
    const cleanTail =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa ' +
      'quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven';
    // Repetition far outside the tail window must NOT fire.
    expect(detectRepetitionTail(repetitivePrefix + ' ' + cleanTail)).toBe(false);
  });
});

// ─── success-with-retry metadata note ────────────────────────────────────────

const LEGACY_BASE = 'http://localhost:11434';
const LEGACY_MODEL = 'qwen2.5vl:latest';

function contentTransport(responder: (call: number, body: Record<string, unknown>) => string) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(JSON.stringify({ message: { content: responder(calls.length, body) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  return { fn, calls };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-repetition-'));
  initDb(':memory:');
  runMigrations();
  upsertApiKey('ollama_vlm', 'enabled', LEGACY_BASE, LEGACY_MODEL);
  resetCircuitBreakers();
});

afterEach(() => {
  closeDb();
  resetCircuitBreakers();
  resetOcrStageFlagsOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeParams(modelFetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const imgPath = seedLocalImage();
  return {
    imageUrl: 'https://example.com/img.jpg',
    imageLocalPath: path.basename(imgPath),
    workspacePath: tmpDir,
    sku: 'SKU-REPETITION',
    modelFetchFn,
  } as Parameters<typeof runPackagingOcrAttempt>[0];
}

describe('repetition-tail retry inside runPackagingOcrAttempt', () => {
  it('records the retried_repetition parser note and penalty options on the retry call', async () => {
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    const repetitive = ('The package shows dog treats dog treats dog treats dog treats dog treats dog treats ' +
      'dog treats dog treats dog treats dog treats dog treats').trim();
    const transport = contentTransport(call =>
      call === 1 ? repetitive : '{"productName":"Clean Retry Result"}',
    );
    const result = await runPackagingOcrAttempt(makeParams(transport.fn));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Clean Retry Result');
      expect(result.data.metadata?.parser).toBe('packaging-ocr.ts (retried_repetition)');
      expect(result.attempts).toBe(2);
    }
    // Greedy default on BOTH attempts; the retry adds the frequency penalty.
    expect(transport.calls[0]!.body.options).toEqual({ temperature: 0 });
    expect(transport.calls[1]!.body.options).toEqual({ temperature: 0, frequency_penalty: 0.3 });
  });

  it('leaves the plain parser note when no repetition was detected', async () => {
    const transport = contentTransport(() => '{"productName":"No Retry Needed"}');
    const result = await runPackagingOcrAttempt(makeParams(transport.fn));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metadata?.parser).toBe('packaging-ocr.ts');
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls).toHaveLength(1);
  });

  // Post-review fixup 3: the ORIGINAL response must survive a failed
  // penalized retry (throw OR unparseable garbage) instead of failing an
  // item whose first response was parseable.
  const REPETITIVE_GOOD_FIRST =
    '{"productName":"Original Response","brand":"Acme"} and and and and and and and and and';

  it('falls back to the original response when the penalized retry throws', async () => {
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    const transport = contentTransport(call => {
      if (call === 1) return REPETITIVE_GOOD_FIRST;
      throw new Error('connection reset by peer');
    });
    const result = await runPackagingOcrAttempt(makeParams(transport.fn));
    expect(transport.calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Original Response');
      // Data came from the ORIGINAL response, not the retry.
      expect(result.data.metadata?.parser).toBe('packaging-ocr.ts');
      expect(result.attempts).toBe(2);
    }
  });

  it('falls back to the original response when the penalized retry returns unparseable garbage', async () => {
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    const transport = contentTransport(call =>
      call === 1 ? REPETITIVE_GOOD_FIRST : 'total garbage prose without any json payload at all',
    );
    const result = await runPackagingOcrAttempt(makeParams(transport.fn));
    expect(transport.calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Original Response');
      expect(result.data.metadata?.parser).toBe('packaging-ocr.ts');
    }
  });
});
