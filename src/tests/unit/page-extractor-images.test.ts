import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

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

function stubHtml(html: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })));
}

describe('page extractor image scoping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not treat global recommendation srcsets as product additional images', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="Pupsicle">
          <meta property="og:description" content="The Pupsicle is a dog treat dispensing puzzle toy.">
          <meta property="og:image" content="https://mywoof.com/cdn/shop/files/Woof_Single-Pupsicle_Thumbnail_600x600_Green.png?v=1762200338">
          <script>window.productJSON = {"id":1,"title":"Pupsicle","variants":[]};</script>
        </head>
        <body>
          <section class="recommended-products">
            <div class="product-card-os__media-wrapper">
              <img
                srcset="//mywoof.com/cdn/shop/files/Woof_Camp-2026_Pupsicle_Thumbnail_600x600_Tie-Dye.png?v=1782090772&amp;width=165 165w, //mywoof.com/cdn/shop/files/Woof_Camp-2026_Pupsicle_Thumbnail_600x600_Tie-Dye.png?v=1782090772&amp;width=352 352w"
                alt="Recommended product">
            </div>
          </section>
        </body>
      </html>`);

    const result = await extractViaHttpDetailed('https://mywoof.com/products/pupsicle', null);

    expect(result.data.primaryImage).toContain('Woof_Single-Pupsicle_Thumbnail_600x600_Green.png');
    expect(result.data.primaryImage).toContain('width=1200');
    expect(result.data.additionalImages).toEqual([]);
    expect(result.raw.images).toEqual([]);
  });

  it('still reads srcset images when they are scoped to a product gallery', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Gallery Product"></head>
        <body>
          <div class="product-gallery">
            <img
              srcset="//mywoof.com/cdn/shop/files/Actual_Product_600x600.png?v=1&amp;width=165 165w, //mywoof.com/cdn/shop/files/Actual_Product_600x600.png?v=1&amp;width=533 533w"
              alt="Actual product">
          </div>
        </body>
      </html>`);

    const result = await extractViaHttpDetailed('https://mywoof.com/products/gallery-product', null);

    expect(result.raw.images.length).toBeGreaterThan(0);
    expect(result.data.primaryImage).toContain('Actual_Product_600x600.png');
    expect(result.data.primaryImage).toContain('width=1200');
  });

  it('applies extractor profile image selectors to srcset and relative image URLs', async () => {
    stubHtml(`<!doctype html>
      <html>
        <body>
          <h1 class="custom-title">Profile Product</h1>
          <div class="custom-media">
            <picture>
              <source srcset="/images/profile-product-small.jpg 400w, /images/profile-product-large.jpg 800w">
              <img src="/images/profile-product-fallback.jpg" alt="Profile product">
            </picture>
          </div>
        </body>
      </html>`);

    const profile: ExtractorProfile = {
      id: 'profile-1',
      domain: 'example.com',
      titleSelector: '.custom-title',
      titleOptionalSelectors: [],
      priceSelector: null,
      descriptionSelector: null,
      brandSelector: null,
      imagesSelector: '.custom-media picture',
      sitemapProductUrlPattern: null,
      shopifyJSONPath: false,
      customSelectors: {},
      variantSelectionStrategy: null,
      customSelectorMetadata: {},
      runtime: 'rendered',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await extractViaHttpDetailed('https://example.com/products/profile-product', profile);

    expect(result.data.title).toBe('Profile Product');
    expect(result.data.primaryImage).toBe('https://example.com/images/profile-product-small.jpg');
    expect(result.data.fieldProvenance.primaryImage).toBe('custom-selector');
  });
});
