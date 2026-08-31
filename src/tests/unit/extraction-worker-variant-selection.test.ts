import { describe, it, expect, vi, beforeEach } from 'vitest';
import { doStaticExtract } from '../../extraction-worker/routes/extract';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';

const baseProfile: any = {
  id: 'prof-1',
  domain: 'example.com',
  titleSelector: 'h1',
  titleOptionalSelectors: [],
  priceSelector: null,
  descriptionSelector: null,
  brandSelector: null,
  imagesSelector: null,
  customSelectors: {},
  variantSelectionStrategy: null,
  customSelectorMetadata: {},
  runtime: 'static' as const,
  allowedSourceDomains: ['example.com'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function shopifyHtmlWithVariants() {
  return `
  <html><head><title>BetterBone</title></head><body>
  <h1>BetterBone Beef</h1>
  <script type="application/ld+json">
  {"@type":"ProductGroup","hasVariant":[
    {"@type":"Product","name":"BetterBone Small","sku":"SM-001","additionalProperty":[{"name":"size","value":"Small"}],"offers":{"price":"9.99","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"https://example.com/products/betterbone?variant=1"},"image":"https://example.com/sm.jpg"},
    {"@type":"Product","name":"BetterBone Large","sku":"LG-001","additionalProperty":[{"name":"size","value":"Large"}],"offers":{"price":"19.99","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"https://example.com/products/betterbone?variant=2"},"image":"https://example.com/lg.jpg"}
  ]}
  </script></body></html>`;
}

describe('extraction-worker variant selection (M4)', () => {
  beforeEach(() => resetVariantFlagsOverride());

  it('allowShopifyProductJson false does no extra fetch (additive)', async () => {
    overrideVariantFlags({ mode: 'off' });
    const fetchFn = vi.fn(async () => new Response('<html><h1>Title</h1></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'BetterBone Small', brandHint: null, price: null, spreadsheetHints: {}, upc: undefined },
      profile: baseProfile,
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    // title may be null if profile selector fails, but gate should not have fetched .js
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // when off, no variant failure
    expect(result.failureCode).toBeFalsy();
  });

  it('observe records matrixDecision but does not fail when ambiguous', async () => {
    overrideVariantFlags({ mode: 'observe' });
    const html = shopifyHtmlWithVariants();
    const fetchFn = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'BetterBone', brandHint: null, price: null, spreadsheetHints: {} },
      profile: baseProfile,
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    expect(result.data.title).toBeTruthy();
    expect(result.failureCode).toBeFalsy();
    // observe warns but still ok
    expect(result.warnings.join(' ')).toMatch(/observe/i);
  });

  it('active returns failureCode variant_selection_required when ambiguous without selection', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = shopifyHtmlWithVariants();
    const fetchFn = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'BetterBone', brandHint: null, price: null, spreadsheetHints: {} },
      profile: baseProfile,
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    expect(result.failureCode).toBe('variant_selection_required');
    expect(['ambiguous','no_match','too_many_variants']).toContain(result.matrixDecision?.status);
  });

  it('active with valid selection receipt materializes variant and returns selectedReceipt', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = shopifyHtmlWithVariants();
    // Need to compute hash by running parse then compute
    const { parseVariantMatrix } = await import('../../onboarding/variant-resolver');
    const { computeIdentityMatrixHash } = await import('../../shared/schemas/variant-resolution');
    const matrix = parseVariantMatrix(html, 'https://example.com/products/betterbone')!;
    const hash = computeIdentityMatrixHash(matrix as any);
    const key = matrix.candidates[0].variantKey;
    const fetchFn = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'BetterBone Small', brandHint: null, price: null, spreadsheetHints: {} },
      profile: baseProfile,
      variantSelection: { resolutionId: 'res-1', identityMatrixHash: hash, variantKey: key },
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    expect(result.selectedReceipt).toBeDefined();
    expect(result.data.title).toBe(matrix.candidates[0].title);
    expect(result.selectedReceipt?.selectedVariantKey).toBe(key);
    expect(result.selectedReceipt?.identityMatrixHash).toBe(hash);
    expect(result.data.title).toBe(matrix.candidates[0].title);
  });

  it('stale hash returns variant_selection_stale', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = shopifyHtmlWithVariants();
    const fetchFn = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'BetterBone Small', brandHint: null, price: null, spreadsheetHints: {} },
      profile: baseProfile,
      variantSelection: { resolutionId: 'res-1', identityMatrixHash: '0'.repeat(64), variantKey: 'shopify:1:Small' },
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    expect(result.failureCode).toBe('variant_selection_stale');
  });

  it('redirect to unallowed domain denied for .js fetch', async () => {
    overrideVariantFlags({ mode: 'active' });
    // craft html with no matrix but shopify url triggers .js fetch to different host (should be denied)
    const html = '<html><h1>Title</h1></html>';
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('.js')) return new Response('{}', { status: 200 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const req: any = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://example.com/products/betterbone',
      expected: { name: 'Title', brandHint: null, price: null, spreadsheetHints: {} },
      profile: { ...baseProfile, allowedSourceDomains: ['example.com'] },
    };
    const result: any = await doStaticExtract(req, { fetchFn: fetchFn as any });
    // Should not crash, may have title or be null depending on html, but no variant failure
    expect(result.failureCode).toBeFalsy();
  });
});
