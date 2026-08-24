/**
 * ADR-0031: extraction-ladder wiring tests.
 *
 * Covers both production entry points:
 *  - the Bun-server fast HTTP path (`extractViaHttpDetailed`), and
 *  - the extraction-worker profile seam (`doStaticExtract`) — the path live
 *    official-page onboarding actually takes when an approved profile exists.
 *
 * Contract under test: additive-only enrichment (profile values always win),
 * deterministic identity classification, failure isolation, and zero extra
 * network traffic by default (dead Shopify productJSON path stays dead).
 *
 * Runs under `bun test` (registered in package.json test:db) alongside the
 * other page-extractor DB suites.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── Module mocks (must precede imports of consumers) ─────────────────────
let runnerCalls: Array<Record<string, unknown>> = [];
mock.module('../../onboarding/profile-runner-client', () => ({
  runProfileExtraction: (options: Record<string, unknown>) => {
    runnerCalls.push(options);
    return { ok: false as const, error: 'mocked-worker-down', warnings: [] };
  },
}));
mock.module('../../db/repositories/extractor-profile-repo', () => ({
  findProfileByDomain: (domain: string) =>
    domain === 'forwarding.example'
      ? { id: 7, domain, titleSelector: '.pdp-title', updatedAt: null }
      : null,
}));
mock.module('../../db/repositories/brand-site-repo', () => ({
  findBrandSites: () => [],
}));
mock.module('../../db/repositories/domain-status-repo', () => ({
  recordDomainStatus: () => {},
}));

import { extractViaHttpDetailed, extractProductData } from '../../onboarding/page-extractor';
import { applyLadderEnrichment } from '../../onboarding/extraction-ladder/enrich';
import { doStaticExtract } from '../../extraction-worker/routes/extract';
import { ExtractionDataSchema, type ExtractionData } from '../../shared/schemas/onboarding';

const originalFetch = globalThis.fetch;

function stubHtml(html: string): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as any;
  return { calls };
}

beforeEach(() => {
  runnerCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('extraction ladder wiring — HTTP fast path (ADR-0031)', () => {
  test('never overwrites values produced by earlier layers — REAL profile wins over ladder', async () => {
    // Profile selector yields "Selector Title"; a Next.js payload offers
    // "Next Title". The custom-selector value must win and keep its
    // custom-selector provenance.
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="OG Title">
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","sku":"SKU-1","variants":[{"id":1}]}}}}</script>
        </head>
        <body><h1 class="pdp-title">Selector Title</h1></body>
      </html>`);
    const profile = {
      id: 1,
      domain: 'example.com',
      titleSelector: '.pdp-title',
      priceSelector: null,
      descriptionSelector: null,
      brandSelector: null,
      imagesSelector: null,
      titleOptionalSelectors: [],
      customSelectors: {},
    };
    const result = await extractViaHttpDetailed('https://example.com/products/widget', profile as any);
    expect(result.data.title).toBe('Selector Title');
    expect(result.data.fieldProvenance.title).toBe('custom-selector');
    expect(result.data.identityStatus).toBe('probable_match'); // SKU present via ladder signals
    expect(result.data.identityReasons?.join(' ')).toContain('SKU present');
  });

  test('fills an empty title from an embedded Next.js product payload', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next-Only Title","vendor":"Acme","variants":[{"id":1},{"id":2}]}}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.title).toBe('Next-Only Title');
    expect(result.data.fieldProvenance.title).toBe('ladder-nextjs');
    expect(result.data.brand).toBe('Acme');
    expect(result.data.fieldProvenance.brand).toBe('ladder-nextjs');
    // Two variants reported by the platform = parent product page signal.
    expect(result.data.identityStatus).toBe('parent_product_only');
  });

  test('fills brand from structured JSON-LD, including nested WebPage.mainEntity graphs', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","mainEntity":{"@type":"Product","name":"Nested Widget","brand":{"@type":"Brand","name":"Nested Brand"}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/nested-widget', null);
    expect(result.data.title).toBe('Nested Widget');
    expect(result.data.brand).toBe('Nested Brand');
    expect(result.data.fieldProvenance.brand).toBe('ladder-json-ld');
  });

  test('appends Nuxt gallery images to additionalImages without touching primaryImage', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:image" content="https://example.com/og.png">
        </head>
        <body>
          <script>window.__NUXT__={"product":{"title":"Nuxt Widget","images":["/img/a.png","https://example.com/og.png"],"variants":[]}};</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.primaryImage).toContain('/og.png');
    expect(result.data.additionalImages).toEqual(['https://example.com/img/a.png']);
    expect(result.data.fieldProvenance.additionalImages).toBe('ladder-nuxt');
  });

  test('fills price/description from an embedded WooCommerce Store API payload', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head><script src="/wp-content/plugins/woocommerce/assets/js/frontend/woocommerce.min.js"></script></head>
        <body>
          <script type="application/json">{"id":9,"name":"Woo Widget","sku":"WOO-1","prices":{"price":"1299"},"description":"Long woo description","images":["https://example.com/woo.png"]}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/product/widget', null);
    expect(result.data.title).toBe('Woo Widget');
    expect(result.data.price).toBe('1299');
    expect(result.data.description).toBe('Long woo description');
    expect(result.data.fieldProvenance.title).toBe('ladder-woocommerce');
  });

  test('attaches exact_match identity when the requested GTIN is affirmatively proven single-variant', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Exact Widget","gtin":"0012345678905","variants":[{"id":"only-one"}]}}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed(
      'https://example.com/products/exact-widget',
      null,
      { name: 'Exact Widget', gtin: '0012345678905' },
    );
    expect(result.data.identityStatus).toBe('exact_match');
    expect(result.data.identityReasons?.length).toBeGreaterThan(0);
  });

  test('degrades gracefully when embedded payloads are malformed (internal parser guards)', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Resilient Title"></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{definitely-not-json</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/broken', null);
    expect(result.data.title).toBe('Resilient Title'); // base layers unaffected
    expect(result.data.identityStatus).toBeTruthy();   // classification still attached
  });

  test('never throws when the target object rejects mutation (frozen ExtractionData)', async () => {
    const frozen = Object.freeze(ExtractionDataSchema.parse({})) as ExtractionData;
    const outcome = await applyLadderEnrichment({
      html: '<html><head><meta property="og:title" content="Frozen Probe"></head><body></body></html>',
      url: 'https://example.com/products/frozen',
      data: frozen,
      expected: { name: 'Unrelated Product Name' },
    });
    // Resolves normally; outcome is authoritative even though mutation was dropped.
    expect(typeof outcome.identityStatus).toBe('string');
    expect(outcome.layersUsed.length).toBeGreaterThan(0);
    expect(frozen.title).toBeNull(); // unchanged — mutation was guarded away
  });

  test('makes zero extra network requests on Shopify pages by default (dead productJSON path stays dead)', async () => {
    const { calls } = stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Shop Thing"></head>
        <body><div class="cdn/shop/marker"></div><script>Shopify.theme = {"name":"dawn"};</script></body>
      </html>`);
    const result = await extractViaHttpDetailed('https://shop.example.com/products/thing', null);
    expect(calls.length).toBe(1); // only the original HTML fetch
    expect(result.data.title).toBe('Shop Thing');
  });

  test('does not duplicate og:image into additionalImages', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="T">
          <meta property="og:image" content="https://example.com/primary.png">
        </head>
        <body></body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/t', null);
    expect(result.data.primaryImage).toBe('https://example.com/primary.png');
    expect(result.data.additionalImages).toEqual([]);
  });
});

describe('extraction ladder wiring — production profile/worker seam (ADR-0031)', () => {
  test('doStaticExtract enriches with embedded signals and classifies identity from expected.upc', async () => {
    // Production shape: approved profile executes its selectors; the ladder
    // enriches from embedded platform state using the SAME fetched HTML and
    // classifies identity against the forwarded UPC. Profile value wins.
    let served = false;
    const fetchFn = (async () => {
      served = true;
      return new Response(`<!doctype html>
        <html>
          <head></head>
          <body>
            <h1 class="pdp-title">Selector Title</h1>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","gtin":"0012345678905","variants":[{"id":"only-one"}]}}}}</script>
          </body>
        </html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }) as any;

    const request = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://brand.example.com/products/exact-widget',
      expected: { name: 'Exact Widget', brandHint: null, price: null, upc: '0012345678905', spreadsheetHints: {} },
      profile: {
        runtime: 'static' as const,
        selectors: { titleSelector: '.pdp-title' },
        titleOptionalSelectors: [],
        customSelectors: {},
        imageRules: {},
        variantSelectionStrategy: null,
        allowedSourceDomains: [],
      },
    };
    const result = await doStaticExtract(request as any, {
      fetchFn,
      // SSRF floor performs DNS resolution on the destination — resolve it
      // deterministically for the test (no real network).
      lookupFn: (async () => [{ address: '93.184.216.34' }]) as any,
    });
    expect(served).toBe(true);                       // single fetch — no refetch
    expect(result.data.title).toBe('Selector Title'); // profile-primary preserved
    expect(result.data.fieldProvenance.title).toBe('profile-selector');
    // UPC was consumed by the enrichment → real exact_match classification.
    expect(result.data.identityStatus).toBe('exact_match');
    expect(result.data.identityReasons?.length).toBeGreaterThan(0);
  });

  test('extractProductData forwards expected.gtin as upc to the profile runner', async () => {
    stubHtml('<html></html>'); // unused by the mocked runner
    await expect(
      extractProductData('https://forwarding.example/products/widget', {
        name: 'Forwarded Widget',
        gtin: '0012345678905',
      }),
    ).rejects.toThrow('mocked-worker-down');
    expect(runnerCalls.length).toBe(1);
    const expectedArg = (runnerCalls[0] as { expected?: { upc?: string } }).expected;
    expect(expectedArg?.upc).toBe('0012345678905');
  });
});
