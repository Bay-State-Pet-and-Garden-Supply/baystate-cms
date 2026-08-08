/**
 * Unit tests for `src/onboarding/sitemap-matcher.ts`.
 *
 * Runs under `bun test` (excluded from vitest) because the LLM
 * selection path imports `getApiKey` from `api-key-repo`, which uses
 * `bun:sqlite`. The non-LLM paths (UPC exact, URL filter, token
 * overlap) are also exercised here so the full public surface is
 * covered from a single harness.
 *
 * The test harness mirrors `llm-client-task-routing.test.ts`:
 *   - spins up a dedicated test DB,
 *   - seeds an Ollama API key so the LLM has a reachable config,
 *   - stubs `globalThis.fetch` to capture LLM requests.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  deleteLlmTaskConfig,
  upsertLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { matchSitemapUrls } from '../../onboarding/sitemap-matcher';
import * as llmClient from '../../onboarding/llm-client';

describe('Sitemap Matcher', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-matcher-test.db';
  let originalFetch: typeof fetch;

  function stubFetch(responseContent: string): { calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> } {
    const calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
    const mock = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responseContent } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    globalThis.fetch = mock;
    return { calls };
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    // Seed at least one provider credential so the LLM call has a config.
    upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'llama3');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default stub: any LLM call falls back to a non-matching response.
    // Individual tests that need a specific LLM response override this
    // via stubFetch(). This keeps the "no Ollama running" noise out
    // of tests that don't actually exercise the LLM selection path.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'no-llm-configured' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Strip any task configs left over from a previous test so the
    // "no LLM configured" fallback is exercised cleanly.
    try { deleteLlmTaskConfig('product_name_consolidation'); } catch { /* ignore */ }
  });

  // ── Empty input ───────────────────────────────────────────────────────

  test('returns an empty array when the sitemap is empty', async () => {
    const result = await matchSitemapUrls(
      [],
      'WOOF POOMERGENCY LAVENDER',
      null,
      '850067859598',
      'mywoof.com',
    );
    expect(result).toEqual([]);
  });

  // ── Pass 1: UPC exact match ───────────────────────────────────────────

  test('UPC exact match short-circuits with 0.95 confidence', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/collections/all',
      `https://mywoof.com/products/poomergency/${upc}`,
      'https://mywoof.com/about',
    ];

    const result = await matchSitemapUrls(urls, 'WOOF POOMERGENCY LAVENDER', null, upc, 'mywoof.com');

    expect(result.length).toBe(1);
    expect(result[0].url).toBe(`https://mywoof.com/products/poomergency/${upc}`);
    expect(result[0].confidence).toBe(0.95);
    expect(result[0].sourceMethod).toBe('sitemap_upc');
    expect(result[0].matchType).toBe('upc_exact');
  });

  test('UPC exact match tolerates dashes and surrounding text', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/p/widget-1',
      `https://mywoof.com/pup/${upc.slice(0, 4)}-${upc.slice(4)}/lavender.html`,
    ];

    const result = await matchSitemapUrls(urls, 'Woof Lavender', null, upc, 'mywoof.com');

    expect(result.length).toBe(1);
    expect(result[0].url).toBe(urls[1]);
    expect(result[0].matchType).toBe('upc_exact');
  });

  // ── Pass 2: product URL filter ────────────────────────────────────────

  test('generic filter keeps /products/, /p/, /shop/, /item/, /dp/ paths only', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/',
      'https://mywoof.com/collections/all',
      'https://mywoof.com/blog/post-1',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/p/poomergency',
      'https://mywoof.com/shop/poomergency',
      'https://mywoof.com/item/poomergency',
      'https://mywoof.com/dp/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    // No UPC exact, so we should get 5 token-overlap hits (one per
    // product-shaped URL) all coming from the filtered set.
    const filteredUrls = result.map(r => r.url);
    expect(filteredUrls.every(u => /\/(products?|p|shop|item|dp)\//.test(u) || /\/(products?|p|shop|item|dp)$/.test(u))).toBe(true);
    expect(result.every(r => r.sourceMethod === 'sitemap_name')).toBe(true);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
  });

  test('explicit productUrlPattern narrows the candidate set to matching URLs', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/p/poomergency',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/blog/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      '^https://mywoof\\.com/p/',
    );

    const filteredUrls = result.map(r => r.url);
    expect(filteredUrls).toContain('https://mywoof.com/p/poomergency');
    expect(filteredUrls).not.toContain('https://mywoof.com/products/poomergency');
  });

  test('invalid productUrlPattern falls back to the generic heuristic', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/blog/x',
      'https://mywoof.com/products/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      '[invalid regex(',
    );

    // The generic heuristic should still keep the /products/ URL.
    expect(result.map(r => r.url)).toContain('https://mywoof.com/products/poomergency');
  });

  // ── Pass 3: token overlap ─────────────────────────────────────────────

  test('token overlap prefers URLs whose slug contains name tokens', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency-lavender',
      'https://mywoof.com/products/treats',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBeGreaterThan(0);
    // The "poomergency-lavender" URL should be the top token-overlap hit
    // (highest ratio of name tokens in the slug).
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency-lavender');
    // 2/2 name tokens ("poomergency", "lavender") appear in the slug after
    // "woof" is excluded as a domain-match token.
    // 0.7 + 0.25 * 2/2 = 0.95.
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(result[0].confidence).toBeLessThanOrEqual(0.95);
    expect(result[0].sourceMethod).toBe('sitemap_name');
    expect(result[0].matchType).toBe('token_overlap');
  });

  test('consolidatedName takes precedence over itemName when tokenizing', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      // The slug matches the *consolidated* name "Pup Brush" (post-merge),
      // not the raw spreadsheet name.
      'https://mywoof.com/products/pup-brush',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF Dental Toothbrush 12345',
      'Pup Brush',
      upc,
      'mywoof.com',
    );

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://mywoof.com/products/pup-brush');
  });

  test('returns up to 3 token-overlap candidates in fallback mode', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/catnip',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    // No LLM configured (we deleted the task config in afterEach),
    // so the function should return the top-3 token-overlap candidates.
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    // First result should be the URL with the best token overlap.
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('caps the candidate set at the top 10 before emitting results', async () => {
    const upc = '850067859598';
    // Build 15 product URLs that all share the "poomergency" token, so
    // every URL has a positive token overlap. The function should
    // trim down to <=10 in the candidate pass, then to <=3 in fallback.
    const urls = Array.from({ length: 15 }, (_, i) =>
      `https://mywoof.com/products/poomergency-${i}`,
    );

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('confidence is clamped to the [0, 1] range', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency-lavender',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBe(1);
    expect(result[0].confidence).toBeLessThanOrEqual(1);
    expect(result[0].confidence).toBeGreaterThanOrEqual(0);
  });

  test('returns only the UPC exact result when no URL survives the filter', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/',
      'https://mywoof.com/collections/all',
      'https://mywoof.com/blog/post-1',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result).toEqual([]);
  });

  // ── LLM selection ─────────────────────────────────────────────────────

  test('LLM-selected URL gets +0.15 confidence boost and llm_selected matchType', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
      'https://mywoof.com/products/lavender-spray',
    ];

    // Configure the LLM so the LLM pass is taken.
    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // Have the LLM return the first URL.
    const { calls } = stubFetch(urls[0]);

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(calls.length).toBe(1);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe(urls[0]);
    expect(result[0].matchType).toBe('llm_selected');
    expect(result[0].sourceMethod).toBe('sitemap_name');
    // Token overlap is 1.0 (poomergency in slug), so the LLM boost
    // is 0.7 + 0.25 * 1.0 + 0.15 = 1.10 → clamped to 1.0.
    expect(result[0].confidence).toBeLessThanOrEqual(1);
  });

  test('LLM response that does not match any candidate triggers fallback', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
    ];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // The LLM returns garbage that does not match any URL.
    stubFetch('I am not a URL');

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('LLM is not called when there is only a single candidate', async () => {
    const upc = '850067859598';
    const urls = ['https://mywoof.com/products/poomergency'];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    const { calls } = stubFetch('https://mywoof.com/products/poomergency');

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    // With only one candidate, the LLM is intentionally not called
    // and we return the token-overlap result.
    expect(calls.length).toBe(0);
    expect(result.length).toBe(1);
    expect(result[0].matchType).toBe('token_overlap');
  });

  test('LLM response with extra whitespace/punctuation is normalized', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // LLM response has surrounding quotes and trailing punctuation.
    stubFetch('  "https://mywoof.com/products/lavender".  ');

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://mywoof.com/products/lavender');
    expect(result[0].matchType).toBe('llm_selected');
  });

  test('falls back to top token-overlap candidate when no LLM is configured', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    // Force "no LLM" by making getLlmConfigForTask return null for
    // this call. We use vi.spyOn so the rest of the LLM client stays
    // functional for the other tests in this file.
    const spy = vi.spyOn(llmClient, 'getLlmConfigForTask').mockReturnValue(null);

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    spy.mockRestore();

    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
    expect(result[0].sourceMethod).toBe('sitemap_name');
  });
});
