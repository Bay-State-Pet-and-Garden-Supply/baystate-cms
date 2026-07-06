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
vi.mock('../../db/repositories/profile-generation-repo', () => ({
  insertProfileGeneration: vi.fn(),
  updateProfileGenerationStatus: vi.fn(),
}));
vi.mock('../../onboarding/llm-client', () => ({
  getLlmConfig: vi.fn(),
  callLlm: vi.fn(),
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

function stubHtml(html: string): void {
  globalThis.fetch = vi.fn(async () => new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as any;
}

/**
 * Realistic Woof Pupsicle HTML: a bare `window.productJSON` without
 * featured_image (which is what the old parser grabbed), plus a richer
 * `mntn_product_data` object that has per-variant featured_image.src
 * for the Lavender / Forest Green / Tie Dye / Party Pink colorways.
 */
const WOOF_STYLE_HTML = `<!doctype html>
<html>
  <head>
    <meta property="og:title" content="Pupsicle">
    <meta property="og:description" content="Long-lasting quiet in a beautifully designed dog toy.">
    <meta property="og:image" content="https://mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Green_8937b47b-001a-4d70-a863-54a75992ad7d.png?v=1762200338">
    <script>
      // The old, sparse window.productJSON — no featured_image on variants.
      window.productJSON = {
        "id": 7336435548356,
        "title": "Pupsicle",
        "handle": "pupsicle",
        "options": ["Color","Size"],
        "variants": [
          { "id": 42864285024452, "title": "Lavender / Small",   "option1": "Lavender",     "option2": "Small",   "price": 1999 },
          { "id": 42864284991684, "title": "Lavender / Large",   "option1": "Lavender",     "option2": "Large",   "price": 1999 },
          { "id": 42864285057220, "title": "Lavender / X-Large", "option1": "Lavender",     "option2": "X-Large", "price": 2499 },
          { "id": 42090560979140, "title": "Forest Green / Small",  "option1": "Forest Green", "option2": "Small",   "price": 1999 },
          { "id": 42090560946372, "title": "Forest Green / Large",  "option1": "Forest Green", "option2": "Large",   "price": 1999 },
          { "id": 42244536893636, "title": "Forest Green / X-Large","option1": "Forest Green", "option2": "X-Large", "price": 2499 }
        ]
      };
    </script>
    <script>
      // The richer mntn_product_data that the new parser should prefer.
      let mntn_product_data = {
        "id": 7336435548356,
        "title": "Pupsicle",
        "handle": "pupsicle",
        "vendor": "Woof",
        "variants": [
          { "id": 42864285024452, "title": "Lavender / Small",   "option1": "Lavender",     "option2": "Small",   "sku": "PS-LAV",  "price": 1999, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Lavender.png?v=1731705583" } },
          { "id": 42864284991684, "title": "Lavender / Large",   "option1": "Lavender",     "option2": "Large",   "sku": "PL-LAV",  "price": 1999, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Lavender.png?v=1731705583" } },
          { "id": 42864285057220, "title": "Lavender / X-Large", "option1": "Lavender",     "option2": "X-Large", "sku": "PXL-LAV", "price": 2499, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Lavender.png?v=1731705583" } },
          { "id": 42090560979140, "title": "Forest Green / Small", "option1": "Forest Green", "option2": "Small",   "sku": "PS-GRN",  "price": 1999, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Green_8937b47b-001a-4d70-a863-54a75992ad7d.png?v=1762200338" } },
          { "id": 42090560946372, "title": "Forest Green / Large", "option1": "Forest Green", "option2": "Large",   "sku": "PL-GRN",  "price": 1999, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Green_8937b47b-001a-4d70-a863-54a75992ad7d.png?v=1762200338" } },
          { "id": 42244536893636, "title": "Forest Green / X-Large","option1": "Forest Green", "option2": "X-Large", "sku": "PXL-GRN", "price": 2499, "featured_image": { "src": "//mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Green_8937b47b-001a-4d70-a863-54a75992ad7d.png?v=1762200338" } }
        ]
      };
    </script>
  </head>
  <body></body>
</html>`;

describe('Woof variant image inference', () => {

  it('falls back to og:image when variant inference is deprecated in extraction (expected "WOOF PUPSICLE LAVENDER SM")', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE LAVENDER SM', brandHint: 'WOOF' },
    );
    // Variant inference was deprecated in extraction (see commit 4e99767).
    // The primary image falls back to the og:image (Green) instead of the
    // Lavender variant's featured_image.
    expect(result.data.primaryImage).toContain('Green_8937b47b');
    expect(result.data.primaryImage).toContain('width=1200');
    // Title is NOT enriched with variant options since variant inference is inert.
    expect(result.data.title).toBe('Pupsicle');
  });

  it('falls back to og:image when variant inference is deprecated in extraction (expected "WOOF PUPSICLE LAVENDER LG")', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE LAVENDER LG', brandHint: 'WOOF' },
    );
    // Variant inference was deprecated in extraction (see commit 4e99767).
    // The primary image falls back to the og:image (Green).
    expect(result.data.primaryImage).toContain('Green_8937b47b');
    expect(result.data.primaryImage).toContain('width=1200');
  });

  it('selects the Forest Green variant for expected "WOOF PUPSICLE FOREST GREEN SMALL"', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE FOREST GREEN SMALL', brandHint: 'WOOF' },
    );
    expect(result.data.primaryImage).toContain('Green_8937b47b');
    expect(result.data.primaryImage).toContain('width=1200');
  });

  it('does not infer a variant for an ambiguous expected name and falls back to JSON-LD image', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE', brandHint: 'WOOF' },
    );
    // No variant tokens to break ties, so primary should be the og:image / JSON-LD default.
    expect(result.data.primaryImage).toContain('Green_8937b47b');
    // Title is NOT enriched with variant options because no variant was inferred.
    expect(result.data.title).toBe('Pupsicle');
  });

  it('ignores both mntn_product_data and window.productJSON since variant inference is deprecated in extraction', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE LAVENDER SM', brandHint: 'WOOF' },
    );
    // Both mntn_product_data and window.productJSON are ignored in extraction.
    // The primary image falls back to the og:image (Green) instead of any
    // variant-specific image. Variant resolution will happen in the
    // Discovery phase instead (see issue #1).
    expect(result.data.primaryImage).toContain('Green_8937b47b');
  });

  it('falls back to og:image when XL size alias would have been mapped to X-Large variant', async () => {
    stubHtml(WOOF_STYLE_HTML);
    const result = await extractViaHttpDetailed(
      'https://mywoof.com/products/pupsicle',
      null,
      { name: 'WOOF PUPSICLE LAVENDER XL', brandHint: 'WOOF' },
    );
    // Variant inference was deprecated in extraction (see commit 4e99767).
    // The primary image falls back to the og:image (Green).
    expect(result.data.primaryImage).toContain('Green_8937b47b');
    expect(result.data.primaryImage).toContain('width=1200');
  });
});
