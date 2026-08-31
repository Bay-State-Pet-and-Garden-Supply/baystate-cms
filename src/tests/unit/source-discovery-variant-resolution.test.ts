import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveVariantsForCandidates, MAX_VARIANT_PARENT_FETCHES } from '../../onboarding/variant-url-resolver';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';
import { productUrlIdentityKey } from '../../onboarding/product-url-identity';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';

let originalFetch: typeof fetch;

function stubHtmlFetch(html: string): void {
  globalThis.fetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
}

const SHOPIFY_HTML = `
<html><head><script>window.productJSON = {"id":1,"title":"BetterBone","options":["Size"],"variants":[{"id":4123456001,"title":"SM","option1":"Small","sku":"BB-SM","barcode":"810001234501","price":1299,"available":true},{"id":4123456002,"title":"LG","option1":"Large","sku":"BB-LG","barcode":"810001234502","price":1499,"available":true},{"id":4123456003,"title":"MINI","option1":"Mini","sku":"BB-MINI","barcode":"810001234503","price":1199,"available":true}]};</script></head><body></body></html>
`;

describe('M3 variant-aware Discovery — bounded resolver', () => {
  beforeEach(() => { originalFetch = globalThis.fetch; overrideVariantFlags({ mode: 'active' }); });
  afterEach(() => { globalThis.fetch = originalFetch; resetVariantFlagsOverride(); vi.restoreAllMocks(); });

  it('enforces hard cap 3 after deterministic sort', async () => {
    expect(MAX_VARIANT_PARENT_FETCHES).toBe(3);
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    globalThis.fetch = fetchSpy;
    const candidates: InsertSourceData[] = Array.from({ length: 6 }, (_, i) => ({
      url: `https://betterbone.com/products/item-${i}`,
      title: null, domain: 'betterbone.com', confidence: 0.9 - i * 0.01, sourceMethod: 'sitemap_name' as const,
    }));
    await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone Hard Beef SM', expectedName: 'BetterBone Hard Beef SM', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('retains already deep-linked candidates without parent re-fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://betterbone.com/products/the-betterbone-beef?variant=4123456001', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
      { url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.8, sourceMethod: 'sitemap_name' as const },
    ];
    const { candidates: out } = await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone Hard Beef SM', expectedName: 'BetterBone Hard Beef SM', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    // deep-linked should be preserved verbatim
    expect(out.some(c => c.url.includes('variant=4123456001'))).toBe(true);
  });

  it('only official-domain candidates are eligible for fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://evil.com/products/fake', title: null, domain: 'evil.com', confidence: 0.99, sourceMethod: 'sitemap_name' as const },
      { url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.5, sourceMethod: 'sitemap_name' as const },
    ];
    await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone', expectedName: 'BetterBone', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    const fetchedUrls = fetchSpy.mock.calls.map((c: any) => String(c[0]));
    expect(fetchedUrls.every((u: string) => u.includes('betterbone.com'))).toBe(true);
  });

  it('three BetterBone siblings resolve to three distinct deep links', async () => {
    stubHtmlFetch(SHOPIFY_HTML);
    const base: InsertSourceData = { url: 'https://betterbone.com/products/the-betterbone-beef', title: 'BetterBone', domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const };
    const upcs = ['810001234501', '810001234502', '810001234503'];
    const outs: string[] = [];
    const resolutions: any[] = [];
    for (const upc of upcs) {
      const { candidates: res, resolution } = await resolveVariantsForCandidates({ candidates: [base], upc, rawName: 'BetterBone Hard Beef', expectedName: 'BetterBone Hard Beef', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: globalThis.fetch as any });
      outs.push(res[0].url);
      resolutions.push(resolution);
    }
    const distinct = new Set(outs.map(u => { try { return productUrlIdentityKey(u); } catch { return u; } }));
    expect(distinct.size).toBe(3);
    expect(outs.every(u => u.includes('?variant='))).toBe(true);
    // resolution distinct per sibling
    expect(resolutions[0].selectedKey).not.toBe(resolutions[1].selectedKey);
    expect(resolutions[1].selectedKey).not.toBe(resolutions[2].selectedKey);
  });

  it('mode off is byte-compatible — no fetch, original candidates returned', async () => {
    overrideVariantFlags({ mode: 'off' });
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [{ url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    const { candidates: out, resolution } = await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone', expectedName: 'BetterBone', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out[0].url).toBe(candidates[0].url);
    expect(resolution.status).toBe('off');
  });

  it('observe records diagnostics without mutating URLs', async () => {
    overrideVariantFlags({ mode: 'observe' });
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [{ url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    const { candidates: out, resolution } = await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone SM', expectedName: 'BetterBone SM', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    expect(out[0].url).toBe(candidates[0].url);
    expect(resolution.status).toBe('observe');
    if (out[0].metadataJson) {
      const meta = JSON.parse(out[0].metadataJson);
      expect(meta.variantResolutionObserve).toBeDefined();
    }
  });

  it('spoofed domain field does not make evil URL fetch-eligible', async () => {
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [
      // URL is evil.com but domain field spoofed to betterbone.com
      { url: 'https://evil.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.99, sourceMethod: 'sitemap_name' as const },
    ];
    await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone SM', expectedName: 'BetterBone SM', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when injected fetch is missing but mode needs fetch', async () => {
    const candidates: InsertSourceData[] = [{ url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    await expect(resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone', expectedName: 'BetterBone', brandHint: 'BetterBone', brandDomains: ['betterbone.com'] } as any)).rejects.toThrow(/fetchFn is required/);
  });

  it('rejects Content-Length >5MB before buffering', async () => {
    const fetchSpy = vi.fn(async () => new Response('x'.repeat(10), { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) } })) as any;
    const candidates: InsertSourceData[] = [{ url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    const { candidates: out, resolution } = await resolveVariantsForCandidates({ candidates, upc: '810001234501', rawName: 'BetterBone SM', expectedName: 'BetterBone SM', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    // Should degrade to original candidate, not expand variants, because body rejected pre-buffer
    expect(out.length).toBe(1);
    expect(out[0].url).toBe('https://betterbone.com/products/the-betterbone-beef');
    expect(resolution.status).toBe('no_variants');
  });

  it('preserves case-sensitive sku distinctness', () => {
    const a = productUrlIdentityKey('https://example.com/products/a?sku=ABC');
    const b = productUrlIdentityKey('https://example.com/products/a?sku=abc');
    expect(a).not.toBe(b);
  });

  it('fixture-backed BetterBone resolves from real product JSON', async () => {
    const fs = await import('node:fs');
    const json = fs.readFileSync('src/tests/fixtures/variants/betterbone-shopify-product.json', 'utf-8');
    const payload = JSON.parse(json);
    // Build HTML that embeds the JSON as shopify would — via script window.productJSON
    const html = `<html><head><script>window.productJSON=${JSON.stringify(payload)};</script></head><body></body></html>`;
    const fetchSpy = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [{ url: 'https://betterbone.com/products/the-betterbone-beef', title: null, domain: 'betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    const { candidates: out, resolution } = await resolveVariantsForCandidates({ candidates, upc: '810001234502', rawName: 'BetterBone Hard Beef Large', expectedName: 'BetterBone Hard Beef Large', brandHint: 'BetterBone', brandDomains: ['betterbone.com'], fetchFn: fetchSpy });
    expect(out[0].url).toContain('variant=4123456002');
    expect(resolution.status).toBe('resolved');
    expect(resolution.selectedKey).toBeTruthy();
  });
});
