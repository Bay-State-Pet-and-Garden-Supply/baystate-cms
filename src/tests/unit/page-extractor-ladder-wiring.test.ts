/**
 * ADR-0031: extraction-ladder wiring tests.
 *
 * Verifies that `extractViaHttpDetailed` enriches its merged result from the
 * deterministic extraction-ladder signals (embedded structured data +
 * platform payloads) ADDITIVELY:
 *  - profile/custom values always win (ladder never overwrites),
 *  - empty fields may be filled from ladder layers,
 *  - identityStatus/identityReasons are attached,
 *  - ladder failures never fail extraction,
 *  - no extra network traffic occurs by default (dead Shopify productJSON
 *    path stays dead; the maintained `.js` layer is opt-in only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/repositories/extractor-profile-repo', () => ({
  findProfileByDomain: vi.fn(),
}));
vi.mock('../../db/repositories/brand-site-repo', () => ({
  findBrandSites: vi.fn(() => []),
}));
vi.mock('../../db/repositories/domain-status-repo', () => ({
  recordDomainStatus: vi.fn(),
}));

import { extractViaHttpDetailed } from '../../onboarding/page-extractor';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubHtml(html: string): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as any;
  return { calls };
}

describe('extraction ladder wiring (ADR-0031)', () => {
  it('never overwrites values produced by earlier layers (profile-primary precedence)', async () => {
    // og:title provides "OG Title"; a Next.js payload offers "Next Title" —
    // merged layers already filled title, so the ladder must NOT replace it.
    const { calls } = stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="OG Title">
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","sku":"SKU-1","variants":[{"id":1}]}}}}</script>
        </head>
        <body></body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.title).toBe('OG Title');
    expect(result.data.fieldProvenance.title).not.toBe('ladder-nextjs');
    expect(calls.length).toBe(1); // single fetch — no ladder refetch
    // No GTIN, no SKU, and no expected name to align against — the honest
    // classification for an unidentified request is insufficient_evidence.
    expect(result.data.identityStatus).toBe('insufficient_evidence');
  });

  it('fills an empty title from an embedded Next.js product payload', async () => {
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

  it('appends Nuxt gallery images to additionalImages without touching primaryImage', async () => {
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

  it('fills price/description from an embedded WooCommerce Store API payload', async () => {
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

  it('attaches exact_match identity when the requested GTIN is affirmatively proven single-variant', async () => {
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

  it('isolates ladder failures: malformed payloads degrade to no enrichment without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
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
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('makes zero extra network requests on Shopify pages by default (dead productJSON path stays dead)', async () => {
    const { calls } = stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Shop Thing"></head>
        <body><div class="cdn/shop/marker"></div><script>Shopify.theme = {"name":"dawn"};</script></body>
      </html>`);
    const result = await extractViaHttpDetailed('https://shop.example.com/products/thing', null);
    expect(calls.length).toBe(1); // only the original HTML fetch
    expect(result.data.title).toBe('Shop Thing');
  });

  it('does not duplicate og:image into additionalImages', async () => {
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
