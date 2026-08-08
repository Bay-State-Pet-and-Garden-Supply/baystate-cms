/**
 * PI-11 deterministic extraction ladder (issue #29), layers 1-4: direct
 * HTTP retrieval, embedded structured data (JSON-LD/OG/meta/canonical),
 * platform adapters (Shopify product JSON, WooCommerce Store API payloads,
 * Next.js app state, Nuxt hydration state), and the profile-selector seam.
 *
 * Pure HTTP with injected fetch — no browser, no LLM, no DB.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectPlatform,
  parseStructuredSignals,
  parseNextJsData,
  parseNuxtData,
  shopifyProductUrl,
  gtinFromAny,
  fetchPageHtml,
} from '../../product-intelligence/extraction/platforms';
import { runExtractionLadder, exactGtinMatch, createLadderExtractionContract } from '../../product-intelligence/extraction/ladder';
import { runBrowserInteraction, evidenceFromBrowserSnapshot, type BrowserSnapshotFn } from '../../product-intelligence/extraction/browser';
import { ManagedFallbackRegistry, StubManagedProvider } from '../../product-intelligence/extraction/managed-fallback';
import { LlmExtractionAdapter, isLlmAvailable, narrowLlmPrompt, NARROW_LLM_SYSTEM_PROMPT } from '../../product-intelligence/extraction/llm';
import type { FetchedPage } from '../../product-intelligence/extraction/platforms';
import type { PageExtractionContract } from '../../product-intelligence/tools/contract';

const JSON_LD_HTML = `
<html><head>
<title>Stella &amp; Chewy's Chicken Broth 16oz</title>
<meta property="og:title" content="Stella &amp; Chewy's Chicken Broth 16oz" />
<meta property="og:image" content="https://img.example.com/broth.jpg" />
<link rel="canonical" href="https://example.com/p/stella-broth-16oz" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Stella & Chewy's Chicken Broth 16oz","sku":"SC-BROTH-16","brand":{"name":"Stella & Chewy's"},"gtin":"085000079585","image":["https://img.example.com/broth.jpg","https://img.example.com/broth-2.jpg"],"offers":{"price":"6.99","availability":"https://schema.org/InStock"}}
</script>
</head><body><h1>Chicken Broth</h1></body></html>`;

const SHOPIFY_HTML = `
<html><head>
<title>Pet Treats — Example Pet</title>
<script src="/cdn/shop/t/1/main.js"></script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>
</head><body></body></html>`;

const SHOPIFY_PRODUCT_JSON = {
  id: 123,
  title: 'Chicken Broth 16oz',
  vendor: 'Example Pet Co',
  product_type: 'Food',
  handle: 'chicken-broth-16oz',
  variants: [
    { id: 111, title: '16 oz', sku: 'EB-16', available: true, price: '6.99', option1: '16 oz' },
    { id: 222, title: '32 oz', sku: 'EB-32', available: true, price: '11.99', option1: '32 oz' },
  ],
  images: [{ src: 'https://cdn.example.com/broth.jpg', variant_ids: [] }],
  options: [{ name: 'Size', values: ['16 oz', '32 oz'] }],
};

const WOOCOMMERCE_HTML = `
<html><head>
<title>Fish Flakes</title>
<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css" />
<script type="application/json">{"id":42,"name":"Fish Flakes 2oz","sku":"FF-2","prices":{"price":"3.49"},"images":[{"src":"https://img.example.com/flakes.jpg"}],"attributes":[{"name":"Size","terms":[{"name":"2 oz","slug":"2-oz"}]}]}</script>
</head><body></body></html>`;

const NEXTJS_HTML = `
<html><head><title>Dog Biscuits</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Dog Biscuits Bacon 12ct","sku":"DB-12","gtin":"012345678905","brand":"Bark Co","images":["https://img.example.com/biscuits.jpg"],"variants":[{"id":1,"title":"12 ct","sku":"DB-12"}]}}}}</script>
</head><body></body></html>`;

const NUXT_HTML = `
<html><head><title>Catnip Toy</title></head>
<body><script>window.__NUXT__={"data":[{"product":{"title":"Catnip Toy Mouse","sku":"CT-1","gtin":"098765432109","brand":"Paws Inc","images":["https://img.example.com/mouse.jpg"],"variants":[{"id":1,"title":"Mouse","sku":"CT-1"}]}}]}</script></body></html>`;

function fetched(html: string, finalUrl = 'https://example.com/p/1'): FetchedPage {
  return { html, finalUrl, status: 200, contentHash: `hash-${html.length}` };
}

describe('platform detection', () => {
  it('detects each platform family from page markup', () => {
    expect(detectPlatform(SHOPIFY_HTML, 'https://shop.example.com/products/x')).toBe('shopify');
    expect(detectPlatform(WOOCOMMERCE_HTML, 'https://wc.example.com/p/x')).toBe('woocommerce');
    expect(detectPlatform(NEXTJS_HTML, 'https://next.example.com/p/x')).toBe('nextjs');
    expect(detectPlatform(NUXT_HTML, 'https://nuxt.example.com/p/x')).toBe('nuxt');
    expect(detectPlatform('<html><body>plain</body></html>', 'https://x.example.com')).toBe('generic');
  });
});

describe('structured signal parsing', () => {
  it('extracts JSON-LD products with gtin, sku, brand, and images', () => {
    const signals = parseStructuredSignals(JSON_LD_HTML);
    expect(signals.jsonLdProducts).toHaveLength(1);
    const product = signals.jsonLdProducts[0];
    expect(product.name).toContain('Chicken Broth');
    expect(product.sku).toBe('SC-BROTH-16');
    expect(product.gtin).toBe('085000079585');
    expect(product.brand).toBe("Stella & Chewy's");
    expect(product.images).toHaveLength(2);
    expect(signals.ogImage).toBe('https://img.example.com/broth.jpg');
    expect(signals.canonicalUrl).toBe('https://example.com/p/stella-broth-16oz');
  });
});

describe('platform payload parsers', () => {
  it('maps a /products/<handle> URL to the Shopify .js endpoint', () => {
    expect(shopifyProductUrl('https://shop.example.com/products/chicken-broth-16oz')).toBe(
      'https://shop.example.com/products/chicken-broth-16oz.js',
    );
    expect(shopifyProductUrl('https://shop.example.com/collections/all')).toBeNull();
  });

  it('parses Next.js __NEXT_DATA__ product state', () => {
    const data = parseNextJsData(NEXTJS_HTML);
    expect(data.product).not.toBeNull();
    expect(data.product?.title).toBe('Dog Biscuits Bacon 12ct');
    expect(gtinFromAny(data.product!)).toBe('012345678905');
  });

  it('parses Nuxt hydration state', () => {
    const data = parseNuxtData(NUXT_HTML);
    expect(data.product?.title).toBe('Catnip Toy Mouse');
    expect(gtinFromAny(data.product!)).toBe('098765432109');
  });

  it('normalizes gtin candidates from arbitrary payloads', () => {
    expect(gtinFromAny({ gtin: '085000079585' })).toBe('085000079585');
    expect(gtinFromAny({ upc: '0 85000 07958 5' })).toBe('085000079585');
    expect(gtinFromAny({ mpn: 'XYZ' })).toBeNull();
    expect(gtinFromAny({ sku: 'short' })).toBeNull();
  });
});

describe('extraction ladder', () => {
  it('extracts a JSON-LD page with exact GTIN identity (structured corroboration alone is not exact_match — probable_match)', async () => {
    const fetchPage = vi.fn(async () => fetched(JSON_LD_HTML, 'https://example.com/p/stella-broth-16oz'));
    const fetchShopify = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://example.com/p/stella-broth-16oz',
      { gtin: '085000079585', name: "Stella & Chewy's Chicken Broth 16oz" },
      new AbortController().signal,
      5000,
      { fetchPage, fetchShopify },
    );
    // P0-5 round 3: a JSON-LD single-offer claim is CORROBORATION only —
    // without a platform payload or rendered browser affirmatively seeing the
    // variant set, the identity settles below exact_match.
    expect(result.identityStatus).toBe('probable_match');
    expect(result.identityReasons.join(' ')).toContain('variant status unproven');
    expect(result.gtins.map((g) => g.value)).toContain('085000079585');
    expect(result.productName).toContain('Chicken Broth');
    expect(result.sku).toBe('SC-BROTH-16');
    expect(result.brand).toBe("Stella & Chewy's");
    // P0-5 round 2: the platform layer always runs before settling, so the
    // fetch-modes now include the platform probe even for non-platform pages.
    expect(result.fetchModes).toEqual(expect.arrayContaining(['http', 'structured_data']));
    expect(layersUsed).toContain('platform_none');
    expect(result.deterministicOnly).toBe(true);
    expect(layersUsed).toContain('http');
    expect(fetchShopify).not.toHaveBeenCalled();
  });

  it('escalates to the Shopify platform API when structured evidence is thin and records the parent-page signal', async () => {
    const fetchPage = vi.fn(async () => fetched(SHOPIFY_HTML, 'https://shop.example.com/products/chicken-broth-16oz'));
    const fetchShopify = vi.fn(async () => SHOPIFY_PRODUCT_JSON as never);
    const { result, layersUsed } = await runExtractionLadder(
      'https://shop.example.com/products/chicken-broth-16oz',
      { gtin: '085000079585', name: 'Chicken Broth 16oz' },
      new AbortController().signal,
      5000,
      { fetchPage, fetchShopify },
    );
    expect(layersUsed).toContain('shopify');
    expect(fetchShopify).toHaveBeenCalledTimes(1);
    expect(result.productName).toBe('Chicken Broth 16oz');
    expect(result.brand).toBe('Example Pet Co');
    // Two variants -> parent page, never an exact match without the GTIN.
    expect(result.identityStatus).toBe('parent_product_only');
    expect(result.images[0].url).toBe('https://cdn.example.com/broth.jpg');
    expect(result.variant?.sku).toBe('EB-16');
  });

  it('extracts from an embedded WooCommerce Store API payload', async () => {
    const { result, layersUsed } = await runExtractionLadder(
      'https://wc.example.com/product/fish-flakes',
      { name: 'Fish Flakes 2oz' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(WOOCOMMERCE_HTML, 'https://wc.example.com/product/fish-flakes') },
    );
    expect(layersUsed).toContain('woocommerce');
    expect(result.productName).toBe('Fish Flakes 2oz');
    expect(result.sku).toBe('FF-2');
    expect(result.fields.some((f) => f.field === 'attribute_size')).toBe(true);
    expect(result.identityStatus).toBe('probable_match');
  });

  it('extracts from Next.js application state with a GTIN-driven exact match', async () => {
    const { result, layersUsed } = await runExtractionLadder(
      'https://next.example.com/p/dog-biscuits',
      { gtin: '012345678905', name: 'Dog Biscuits Bacon 12ct' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(NEXTJS_HTML, 'https://next.example.com/p/dog-biscuits') },
    );
    expect(layersUsed).toContain('nextjs');
    expect(result.identityStatus).toBe('exact_match');
    expect(result.sku).toBe('DB-12');
    expect(result.variant?.sku).toBe('DB-12');
  });

  it('extracts from Nuxt hydration state', async () => {
    const { result } = await runExtractionLadder(
      'https://nuxt.example.com/p/catnip-mouse',
      { gtin: '098765432109', name: 'Catnip Toy Mouse' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(NUXT_HTML, 'https://nuxt.example.com/p/catnip-mouse') },
    );
    expect(result.identityStatus).toBe('exact_match');
    expect(result.productName).toBe('Catnip Toy Mouse');
    expect(result.brand).toBe('Paws Inc');
  });

  it('runs the registered profile layer and merges its evidence', async () => {
    const profile = {
      name: 'test-profile',
      matches: (url: string) => url.includes('profiled.example'),
      extract: async () => ({
        fields: [
          { field: 'product_name', value: 'Profiled Product 8oz', method: 'selectors', sourcePath: 'h1.title' },
          { field: 'sku', value: 'PP-8', method: 'selectors', sourcePath: '.sku' },
        ],
        images: [{ url: 'https://img.example.com/profiled.jpg', sourcePath: 'img.main' }],
      }),
    };
    const { result, layersUsed } = await runExtractionLadder(
      'https://profiled.example.com/p/x',
      { gtin: '999999999999' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>minimal</body></html>', 'https://profiled.example.com/p/x'),
        profiles: [profile],
      },
    );
    expect(layersUsed).toContain('profile_selector');
    expect(result.fields.some((f) => f.method === 'profile_selector' && f.field === 'product_name')).toBe(true);
    expect(result.images[0].url).toBe('https://img.example.com/profiled.jpg');
    expect(result.identityStatus).toBe('probable_match');
  });

  it('returns insufficient_evidence for an empty page and records the retrieval failure', async () => {
    const { result, layersUsed } = await runExtractionLadder(
      'https://empty.example.com/p/x',
      { gtin: '085000079585' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched('<html><body>no data</body></html>', 'https://empty.example.com/p/x') },
    );
    expect(result.identityStatus).toBe('insufficient_evidence');
    expect(result.fields).toHaveLength(0);
    expect(result.deterministicOnly).toBe(true);
    expect(layersUsed).toContain('platform_none');
  });

  it('surfaces conflicting GTIN evidence durably', async () => {
    const conflictingHtml = `
<html><head><title>T</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"A","gtin":"111111111111","offers":{"price":"1"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"B","gtin":"222222222222","offers":{"price":"2"}}</script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://conflict.example.com/p/x',
      { gtin: '111111111111' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(conflictingHtml, 'https://conflict.example.com/p/x') },
    );
    expect(result.conflicts.some((c) => c.field === 'gtin')).toBe(true);
    // P0-5 round 3: exact GTIN is represented but structured corroboration
    // alone cannot settle exact identity.
    expect(result.identityStatus).toBe('probable_match');
  });

  it('fails retrieval into a durable conflict rather than throwing', async () => {
    const { result, layersUsed } = await runExtractionLadder(
      'https://down.example.com/p/x',
      { gtin: '085000079585' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => {
          throw new Error('HTTP 503 for https://down.example.com/p/x');
        },
      },
    );
    expect(result.identityStatus).toBe('insufficient_evidence');
    expect(result.conflicts.some((c) => c.field === '_retrieval')).toBe(true);
    expect(layersUsed).toEqual(['http']);
  });

  it('never marks a multi-variant page exact when the default variant is another size (P0-5 adversarial)', async () => {
    const shopifyHtml = `<html><head><title>Wormeze Feline</title>
<script src="/cdn/shop/t/1/main.js"></script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://shop.example.com/products/wormeze-feline',
      { gtin: '745801105447', name: 'Wormeze Feline 4oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched(shopifyHtml, 'https://shop.example.com/products/wormeze-feline'),
        fetchShopify: async () =>
          ({
            id: 7,
            title: 'Wormeze Feline Anthelmintic',
            vendor: 'Durvet',
            product_type: 'Pet',
            handle: 'wormeze-feline',
            // The product payload carries the requested CHILD GTIN (the page
            // represents the whole family), while the default variant is
            // another size — the review P0-5 danger case.
            gtin: '745801105447',
            variants: [
              { id: 701, title: '8 oz', sku: 'W-8', available: true },
              { id: 702, title: '16 oz', sku: 'W-16', available: true },
            ],
            images: [],
          }) as never,
      },
    );
    expect(result.gtins.map((g) => g.value)).toContain('745801105447');
    // Exact GTIN is represented, but the selected/default variant is another
    // size and there is no positive single-variant or child-linkage proof.
    expect(result.identityStatus).toBe('parent_product_only');
  });

  it('exact-matches a page the platform API affirms is single-variant (P0-5 positive proof)', async () => {
    const singleHtml = `<html><head><title>Single Variant</title>
<script src="/cdn/shop/t/1/main.js"></script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://shop.example.com/products/single',
      { gtin: '555566667777', name: 'Single Variant 8oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched(singleHtml, 'https://shop.example.com/products/single'),
        fetchShopify: async () =>
          ({
            id: 8,
            title: 'Single Variant 8oz',
            vendor: 'Vendor Co',
            handle: 'single',
            gtin: '555566667777',
            // Platform API affirmatively reports exactly one variant.
            variants: [{ id: 1, title: '8 oz', sku: 'SV-8', available: true }],
            images: [],
          }) as never,
      },
    );
    expect(result.identityStatus).toBe('exact_match');
  });

  it('does not exact-match when a group page declares the GTIN but no positive proof exists (P0-5)', async () => {
    // A leaf Product node carries the exact GTIN, but the SAME page also
    // carries ProductGroup/hasVariant markers — so single-variant proof is
    // invalidated and the ladder must fall through instead of settling.
    const groupHtml = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Wormeze Feline 4oz","sku":"W-4","gtin":"745801105447"}</script>
<script type="application/ld+json">{"@type":"ProductGroup","name":"Wormeze Feline (all sizes)","hasVariant":[{"@type":"Product","name":"Wormeze Feline 8oz"}]}</script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://group.example.com/p/wormeze',
      { gtin: '745801105447', name: 'Wormeze Feline 4oz' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(groupHtml, 'https://group.example.com/p/wormeze') },
    );
    expect(result.gtins.map((g) => g.value)).toContain('745801105447');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match');
    expect(result.identityReasons.join(' ')).toContain('variant status unproven');
  });

  it('exact-matches via positive selected-variant linkage after a bounded interaction (P0-5)', async () => {
    const snapshot: BrowserSnapshotFn = async (request) => ({
      url: 'https://browser.example.com/p/size-pick',
      finalUrl: 'https://browser.example.com/p/size-pick',
      // A Product node with a variants list — NOT single-variant proof, so
      // only the interaction's variant_match signal can settle the identity.
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Size Pick 16oz',
          sku: 'SP-16',
          gtin: '121212121212',
          variants: [
            { id: 1, title: '8 oz' },
            { id: 2, title: '16 oz' },
          ],
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: request.interaction
        ? { performed: true, finalUrl: 'https://browser.example.com/p/size-pick?size=16oz', selectedOptions: ['16 oz'] }
        : null,
      pageStructureSignals: ['interaction:variant-selector'],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://browser.example.com/p/size-pick',
      { gtin: '121212121212', name: 'Size Pick 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://browser.example.com/p/size-pick'),
        browser: { snapshot },
        interaction: { type: 'select_option', selector: '#size', optionLabel: '16 oz', settleMs: 500 },
      },
    );
    expect(layersUsed).toContain('interaction');
    expect(result.identityStatus).toBe('exact_match');
    expect(result.identityReasons.join(' ')).toContain('selected-variant linkage');
  });
});

describe('ladder contract adapter + helpers', () => {
  it('exactGtinMatch compares digit-normalized values', () => {
    expect(exactGtinMatch('0 85000 07958 5', [{ value: '085000079585' }])).toBe(true);
    expect(exactGtinMatch('111111111111', [{ value: '222222222222' }])).toBe(false);
    expect(exactGtinMatch(undefined, [{ value: '085000079585' }])).toBe(false);
  });

  it('createLadderExtractionContract satisfies the PageExtractionContract seam', async () => {
    const contract: PageExtractionContract = createLadderExtractionContract({
      fetchPage: async () => fetched(JSON_LD_HTML, 'https://example.com/p/stella-broth-16oz'),
    });
    expect(contract.name).toBe('extraction_ladder');
    expect(contract.version).toBe('1.0.0');
    const result = await contract.extract({
      url: 'https://example.com/p/stella-broth-16oz',
      expected: { gtin: '085000079585' },
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    expect(result.identityStatus).toBe('probable_match'); // structured corroboration only (P0-5 round 3)
    expect(result.fields.every((f) => f.method.length > 0)).toBe(true);
  });

  it('fetchPageHtml records the final URL, status, and content hash', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>fixture</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const page = await fetchPageHtml('https://fixture.example.com/p/x', new AbortController().signal, 5000);
      expect(page.status).toBe(200);
      expect(page.finalUrl).toBe('https://fixture.example.com/p/x');
      expect(page.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('recurses into WebPage.mainEntity JSON-LD wrappers', async () => {
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","mainEntity":{"@type":"Product","name":"Wrapped Product 4oz","sku":"WP-4","gtin":"123456789012","offers":{"price":"1"}}}</script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://wrapped.example.com/p/x',
      { gtin: '123456789012' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(html, 'https://wrapped.example.com/p/x') },
    );
    expect(result.identityStatus).toBe('probable_match'); // structured corroboration only (P0-5 round 3)
    expect(result.productName).toBe('Wrapped Product 4oz');
  });

  it('accepts ld+json script types with charset suffixes', async () => {
    const html = `<html><head>
<script type="application/ld+json; charset=utf-8">{"@type":"Product","name":"Charset Product","sku":"CS-1","gtin":"222222222222","offers":{"price":"1"}}</script>
</head><body></body></html>`;
    const { result } = await runExtractionLadder(
      'https://charset.example.com/p/x',
      { gtin: '222222222222' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(html, 'https://charset.example.com/p/x') },
    );
    expect(result.identityStatus).toBe('probable_match'); // structured corroboration only (P0-5 round 3)
  });

  it('falls back from a failed Shopify .js fetch to embedded Next.js state (Hydrogen)', async () => {
    const hydrogenHtml = `<html><head><title>Hydrogen Store</title>
<script src="https://cdn.shopify.com/s/files/1/0000/main.js"></script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Hydrogen Product 6oz","sku":"H-6","gtin":"333333333333","variants":[{"id":1,"title":"6 oz","sku":"H-6"}]}}}}</script>
</head><body></body></html>`;
    const fetchShopify = vi.fn(async () => {
      throw new Error('HTTP 404 for .js endpoint');
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://hydrogen.example.com/products/h-6',
      { gtin: '333333333333' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(hydrogenHtml, 'https://hydrogen.example.com/products/h-6'), fetchShopify },
    );
    expect(layersUsed).toContain('shopify_failed');
    expect(layersUsed).toContain('nextjs');
    expect(result.identityStatus).toBe('exact_match');
  });

  it('does not early-exit on an exact GTIN alone when fields are thin', async () => {
    const thinHtml = `<html><head>
<script type="application/ld+json">{"@type":"Product","gtin":"444444444444"}</script>
</head><body></body></html>`;
    const { result, layersUsed } = await runExtractionLadder(
      'https://thin.example.com/p/x',
      { gtin: '444444444444' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(thinHtml, 'https://thin.example.com/p/x') },
    );
    // GTIN matched but only one field -> no early exit; platform layer ran.
    // P0-5 round 2: a bare Product JSON-LD with no offer declaration is not
    // affirmative single-variant proof, so the identity cannot be exact.
    expect(layersUsed).toContain('platform_api');
    expect(result.identityStatus).not.toBe('exact_match');
  });

  it('parses Nuxt 3 __NUXT_DATA__ devalue payloads', async () => {
    const html = `<html><head><title>T</title></head><body>
<script id="__NUXT_DATA__" type="application/json">["ShallowRef:1",{"product":{"title":"Nuxt3 Product 8oz","sku":"N3-8","gtin":"555555555555","variants":[{"id":1,"title":"8 oz","sku":"N3-8"}]},"$sconfig":{}}]</script>
</body></html>`;
    const data = parseNuxtData(html);
    expect(data.product?.title).toBe('Nuxt3 Product 8oz');
    expect(gtinFromAny(data.product!)).toBe('555555555555');
    const { result } = await runExtractionLadder(
      'https://nuxt3.example.com/p/x',
      { gtin: '555555555555' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(html, 'https://nuxt3.example.com/p/x') },
    );
    expect(result.identityStatus).toBe('exact_match');
  });

  it('rejects loose 6-digit pseudo-GTINs as identity evidence', () => {
    expect(gtinFromAny({ gtin: '123456' })).toBeNull();
    expect(gtinFromAny({ gtin: '12345678' })).toBe('12345678');
  });
  it('escalates to the rendered browser layer with network capture', async () => {
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://browser.example.com/p/x',
      finalUrl: 'https://browser.example.com/p/x',
      jsonLd: [{ '@type': 'Product', name: 'Browser Product 12oz', sku: 'BP-12', brand: 'Browser Co', gtin: '666666666666', offers: { price: '1' } }],
      embeddedProductData: [],
      imageCandidates: ['https://img.example.com/browser.jpg'],
      networkResponses: [
        {
          url: 'https://browser.example.com/api/products/12',
          status: 200,
          responseContentType: 'application/json',
          // Round-4 P1-2: an explicit variants array with exactly one entry
          // is the AFFIRMATIVE browser variant-set evidence that proves
          // single-variant — rendered leaf JSON-LD alone no longer does.
          jsonBody: { product: { title: 'Browser Product 12oz', sku: 'BP-12', brand: 'Browser Co', gtin: '666666666666', variants: [{ id: 1, title: '12 oz' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: ['interaction:variant-selector'],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://browser.example.com/p/x',
      { gtin: '666666666666' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://browser.example.com/p/x'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(layersUsed).toContain('browser_parsed');
    expect(result.identityStatus).toBe('exact_match');
    expect(result.fields.some((f) => f.method === 'network_response')).toBe(true);
    expect(result.images.some((i) => i.url === 'https://img.example.com/browser.jpg')).toBe(true);
  });

  it('round-4: rendered leaf JSON-LD alone is NOT browser proof (corroboration only)', async () => {
    // Unknown storefront: leaf Product JSON-LD after rendering, no payload
    // declaring the variant set, no DOM selector data. The passive extractor
    // cannot affirm a single sellable variant — identity must NOT settle.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://unknown.example.com/p/y',
      finalUrl: 'https://unknown.example.com/p/y',
      jsonLd: [{ '@type': 'Product', name: 'Mystery Treat 16oz', sku: 'MY-16', gtin: '333333333333', offers: { price: '4.99' } }],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://unknown.example.com/p/y',
      { gtin: '333333333333', name: 'Mystery Treat 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://unknown.example.com/p/y'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match'); // structured corroboration only
    expect(result.identityReasons.join(' ')).toMatch(/variant status unproven|not exact|single-variant/i);
  });

  it('round-4: DOM size selector with 2+ options contradicts the leaf claim (parent_product_only)', async () => {
    // The reviewer's scenario: JS-rendered size selector hides multiple
    // variants from the passive extractor. A DOM selector with >= 2 options
    // is AFFIRMATIVE contradiction even when only leaf JSON-LD was parsed.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://unknown.example.com/p/z',
      finalUrl: 'https://unknown.example.com/p/z',
      jsonLd: [{ '@type': 'Product', name: 'Size Select 16oz', sku: 'SS-16', gtin: '444444444444', offers: { price: '5.99' } }],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: null,
      pageStructureSignals: ['interaction:variant-selector'],
      domVariantSelectors: [{ kind: 'select', optionCount: 3 }],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://unknown.example.com/p/z',
      { gtin: '444444444444', name: 'Size Select 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://unknown.example.com/p/z'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).toBe('parent_product_only');
  });

  it('round-4: network payload declaring exactly one variant is affirmative browser proof', async () => {
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://api.example.com/p/one',
      finalUrl: 'https://api.example.com/p/one',
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          // The current-product API response rides the canonical page URL
          // (round-7: with an expected GTIN the lone-payload fallback is
          // disabled, so the canonical-URL linkage is the page-context marker).
          url: 'https://api.example.com/p/one',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { product: { title: 'Single Variant 8oz', sku: 'SV-8', brand: 'Single Co', gtin: '555555555555', variants: [{ id: 1, title: '8 oz' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://api.example.com/p/one',
      { gtin: '555555555555' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://api.example.com/p/one'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).toBe('exact_match');
    expect(result.identityReasons.join(' ')).toMatch(/exact GTIN/);
  });

  it('round-4: browser interaction linkage matching the expected variant settles exact', async () => {
    // Leaf JSON-LD (corroboration only) PLUS a bounded select_option whose
    // selected option overlaps the expected variant name: positive selected-
    // child linkage — the browser interaction proves which child is selected.
    const snapshot: BrowserSnapshotFn = async (request) => ({
      url: 'https://link.example.com/p/s',
      finalUrl: 'https://link.example.com/p/s',
      jsonLd: [{ '@type': 'Product', name: 'Link Pick 16oz', sku: 'LP-16', gtin: '666666666661', offers: { price: '2.99' } }],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: request.interaction
        ? { performed: true, finalUrl: 'https://link.example.com/p/s?size=16oz', selectedOptions: ['16 oz'] }
        : null,
      pageStructureSignals: ['interaction:variant-selector'],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://link.example.com/p/s',
      { gtin: '666666666661', name: 'Link Pick 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://link.example.com/p/s'),
        browser: { snapshot },
        interaction: { type: 'select_option', selector: '#size', optionLabel: '16 oz', settleMs: 500 },
      },
    );
    expect(layersUsed).toContain('interaction');
    expect(result.identityStatus).toBe('exact_match');
    expect(result.identityReasons.join(' ')).toMatch(/selected-variant linkage/);
  });

  it('runs a bounded interaction and records the resulting variant state', async () => {
    const snapshot: BrowserSnapshotFn = async (request) => ({
      url: request.url,
      finalUrl: 'https://browser.example.com/p/x?size=12oz',
      jsonLd: [{ '@type': 'Product', name: 'Selectable Product', sku: 'SP-1', gtin: '777777777777' }],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: request.interaction
        ? { performed: true, finalUrl: 'https://browser.example.com/p/x?size=12oz', selectedOptions: ['12 oz'] }
        : null,
      pageStructureSignals: [],
      warnings: [],
    });
    const out: {
      fields: Array<{ field: string; value: string; method: string; sourcePath?: string }>;
      images: Array<{ url: string; sourcePath?: string }>;
      gtins: Array<{ value: string; method: string }>;
      sku: string | null;
      brand: string | null;
      productName: string | null;
      size: string | null;
      variant: { name?: string; id?: string; sku?: string } | null;
      variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    } = { fields: [], images: [], gtins: [], sku: null, brand: null, productName: null, size: null, variant: null, variantSignals: [] };
    const result = await runBrowserInteraction(snapshot, 'https://browser.example.com/p/x', {
      type: 'select_option',
      selector: '#size',
      optionLabel: '12 oz',
      settleMs: 500,
    }, out, { name: 'Selectable Product 12oz' });
    expect(result.selectedOptions).toEqual(['12 oz']);
    expect(out.variantSignals.some((s) => s.kind === 'variant_match')).toBe(true);
    expect(out.fields.some((f) => f.field === 'variant_selection')).toBe(true);
    expect(result.finalUrl).toContain('size=12oz');
  });

  it('round-5 P0-3: an unrelated recommended payload declaring one variant cannot prove this GTIN single-variant (contamination)', async () => {
    // Payload A (the main product) carries the exact GTIN and NO variants
    // field. Payload B (an unrelated recommended product) declares exactly
    // one variant. The shared-flag accumulator would have let B's single
    // bit settle exact_match — entity scoping must reject it.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://contam.example.com/p/main',
      finalUrl: 'https://contam.example.com/p/main',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Main Product 16oz',
          sku: 'MP-16',
          gtin: '123123123123',
          size: '16 oz',
          offers: { price: '9.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://contam.example.com/api/recommended',
          status: 200,
          responseContentType: 'application/json',
          // Related product — different entity, no GTIN, declares ONE variant.
          jsonBody: { product: { title: 'Recommended Snack', sku: 'RC-1', variants: [{ id: 1, title: '1 pack' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://contam.example.com/p/main',
      { gtin: '123123123123', name: 'Main Product 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://contam.example.com/p/main'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.gtins.map((g) => g.value)).toContain('123123123123');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match');
    expect(result.identityReasons.join(' ')).toMatch(/unproven|not exact|single-variant/i);
  });

  it('round-5 P0-3: an unrelated multi-variant payload does not contradict by itself (no parent_page from unlinked payloads)', async () => {
    // Payload A carries the exact GTIN without a variants field; payload B
    // (unrelated) declares THREE variants. Before round 5, B pushed a
    // parent_page contradiction signal. Now unlinked payloads neither prove
    // nor contradict — the identity stays 'unproven', not 'parent page'.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://multi.example.com/p/main',
      finalUrl: 'https://multi.example.com/p/main',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Main Product 16oz',
          sku: 'MP-16',
          gtin: '321321321321',
          size: '16 oz',
          offers: { price: '9.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://multi.example.com/api/related',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { product: { title: 'Related Item', sku: 'RL-3', variants: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://multi.example.com/p/main',
      { gtin: '321321321321', name: 'Main Product 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://multi.example.com/p/main'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match');
    const reasons = result.identityReasons.join(' ');
    expect(reasons).toMatch(/unproven|not exact|single-variant/i);
    expect(reasons).not.toMatch(/parent/i);
    expect(reasons).not.toMatch(/multiple variants/i);
  });

  it('round-5 P0-3: entity-scoped variant-set signal — linked proves, unlinked never (unit)', () => {
    const makeOut = () => ({
      fields: [] as Array<{ field: string; value: string; method: string; sourcePath?: string }>,
      images: [] as Array<{ url: string; sourcePath?: string }>,
      gtins: [] as Array<{ value: string; method: string }>,
      sku: null as string | null,
      brand: null as string | null,
      productName: null as string | null,
      size: null as string | null,
      variant: null as { name?: string; id?: string; sku?: string } | null,
      variantSignals: [] as Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>,
      variantSetEvidence: { single: false, multiple: false },
      variantSetContributions: [],
    });
    const snapshotOf = (jsonLd: Array<Record<string, unknown>>, network: Array<{ url: string; jsonBody: unknown }>) => ({
      url: 'https://u.example.com/p/x',
      finalUrl: 'https://u.example.com/p/x',
      jsonLd,
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: network.map((n) => ({ url: n.url, status: 200, responseContentType: 'application/json', jsonBody: n.jsonBody })),
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });

    // (a) expected GTIN + linked single-variant payload -> 'single'. The
    //     payload rides the canonical page URL (page-context marker) and
    //     carries the expected GTIN (round-7: with an expected GTIN the lone
    //     payload fallback is disabled, so the canonical-URL linkage is what
    //     makes it primary).
    const outA = makeOut();
    const evA = evidenceFromBrowserSnapshot(
      snapshotOf([], [{ url: 'https://u.example.com/p/x', jsonBody: { product: { title: 'T', gtin: '999999999999', variants: [{ id: 1 }] } } }]),
      outA,
      { gtin: '999999999999' },
    );
    expect(evA.variantSetEvidence).toBe('single');

    // (b) expected GTIN + UNLINKED single-variant payload -> 'none'.
    const outB = makeOut();
    const evB = evidenceFromBrowserSnapshot(
      snapshotOf([], [{ url: 'https://u.example.com/api/2', jsonBody: { product: { title: 'Other', gtin: '888888888888', variants: [{ id: 1 }] } } }]),
      outB,
      { gtin: '999999999999' },
    );
    expect(evB.variantSetEvidence).toBe('none');
    expect(outB.variantSignals.some((s) => s.kind === 'parent_page')).toBe(false);

    // (c) expected GTIN + unlinked MULTI-variant payload -> 'none', and it
    //     contributes NO parent_page contradiction either.
    const outC = makeOut();
    const evC = evidenceFromBrowserSnapshot(
      snapshotOf([], [{ url: 'https://u.example.com/api/3', jsonBody: { product: { title: 'Other', variants: [{ id: 1 }, { id: 2 }] } } }]),
      outC,
      { gtin: '999999999999' },
    );
    expect(evC.variantSetEvidence).toBe('none');
    expect(outC.variantSignals.some((s) => s.kind === 'parent_page')).toBe(false);

    // (d) no expected GTIN + single payload -> page-primary fallback: 'single'.
    const outD = makeOut();
    const evD = evidenceFromBrowserSnapshot(
      snapshotOf([{ '@type': 'Product', name: 'Solo', sku: 'SO-1', variants: [{ id: 1, title: '8 oz' }] }], []),
      outD,
      {},
    );
    expect(evD.variantSetEvidence).toBe('single');

    // (e) no expected GTIN + two unidentifiable payloads -> conservative 'none'.
    const outE = makeOut();
    const evE = evidenceFromBrowserSnapshot(
      snapshotOf([{ '@type': 'Product', name: 'One', sku: 'O-1', variants: [{ id: 1 }] }], [{ url: 'https://u.example.com/api/4', jsonBody: { product: { title: 'Two', sku: 'T-2', variants: [{ id: 1 }] } } }]),
      outE,
      {},
    );
    expect(evE.variantSetEvidence).toBe('none');

    // (f) linked multi-variant payload IS a contradiction (parent_page).
    //     The payload rides the canonical page URL so it is the current
    //     product (round-7), not a same-GTIN cross-sell.
    const outF = makeOut();
    const evF = evidenceFromBrowserSnapshot(
      snapshotOf([], [{ url: 'https://u.example.com/p/x', jsonBody: { product: { title: 'T', gtin: '999999999999', variants: [{ id: 1 }, { id: 2 }] } } }]),
      outF,
      { gtin: '999999999999' },
    );
    expect(evF.variantSetEvidence).toBe('multiple');
    expect(outF.variantSignals.some((s) => s.kind === 'parent_page')).toBe(true);
  });

  it('round-6 P0-3: a recommendation carrying the REQUESTED GTIN cannot prove the page product single-variant (page-primary linkage)', async () => {
    // The reviewer's round-6 regression: the page's primary product X has a
    // DIFFERENT GTIN (no variants declared); the recommendation/cross-sell
    // payload Y carries the REQUESTED GTIN and declares exactly one variant.
    // Round-5's GTIN-equality linkage would settle exact — round-6 requires
    // page-primary/current-entity linkage, and Y is not the page's product.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://rec.example.com/p/main',
      finalUrl: 'https://rec.example.com/p/main',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Primary Product 16oz',
          sku: 'PP-16',
          gtin: '777777777777',
          size: '16 oz',
          offers: { price: '12.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://rec.example.com/api/cross-sell',
          status: 200,
          responseContentType: 'application/json',
          // Cross-sell for the REQUESTED UPC (different sku) — one variant.
          jsonBody: { product: { title: 'Requested UPC Item', sku: 'CS-9', gtin: '888888888888', variants: [{ id: 1, title: '1 ct' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://rec.example.com/p/main',
      { gtin: '888888888888', name: 'Requested UPC Item' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://rec.example.com/p/main'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.gtins.map((g) => g.value)).toContain('888888888888');
    // GTIN equality alone is identity evidence, not page-context evidence.
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match');
    expect(result.identityReasons.join(' ')).toMatch(/unproven|not exact|single-variant/i);
  });

  it('round-6 P0-3: canonical mainEntity marks the primary — a GTIN-bearing recommendation still cannot prove single-variant', async () => {
    // Strong-marker variant of the reviewer regression: the page declares its
    // canonical product via a WebPage mainEntity. The recommendation payload
    // carries the REQUESTED GTIN with one variant, but it is NOT the page's
    // primary entity — identity equality must not override page context.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://me.example.com/p/main',
      finalUrl: 'https://me.example.com/p/main',
      jsonLd: [
        {
          '@type': 'ProductPage',
          '@id': 'https://me.example.com/p/main',
          mainEntity: {
            '@type': 'Product',
            name: 'Primary Product 16oz',
            sku: 'MP-16',
            gtin: '777777777777',
            size: '16 oz',
            offers: { price: '12.99' },
          },
        },
        {
          '@type': 'Product',
          name: 'Primary Product 16oz',
          sku: 'MP-16',
          gtin: '777777777777',
          size: '16 oz',
          offers: { price: '12.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://me.example.com/api/recommended',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { product: { title: 'Requested UPC Item', sku: 'RC-2', gtin: '888888888888', variants: [{ id: 1, title: '1 ct' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result } = await runExtractionLadder(
      'https://me.example.com/p/main',
      { gtin: '888888888888', name: 'Requested UPC Item' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://me.example.com/p/main'),
        browser: { snapshot },
      },
    );
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityReasons.join(' ')).toMatch(/unproven|not exact|single-variant/i);
  });

  it('round-6 P0-3: the current-product API response sharing the primary identity DOES prove single-variant', async () => {
    // Positive page-primary case: the leaf JSON-LD product (mainEntity) and
    // the network current-product API response share the SAME identity
    // (sku + gtin) — the API payload is the page's product, its declared
    // single variant is affirmative browser proof, and the requested GTIN is
    // on the page. Co-occurrence of identity marks the current product.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://api-pos.example.com/p/x',
      finalUrl: 'https://api-pos.example.com/p/x',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Current Product 16oz',
          sku: 'CP-16',
          gtin: '666666666666',
          size: '16 oz',
          offers: { price: '8.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://api-pos.example.com/api/products/current',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { product: { title: 'Current Product 16oz', sku: 'CP-16', gtin: '666666666666', variants: [{ id: 1, title: '16 oz' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://api-pos.example.com/p/x',
      { gtin: '666666666666', name: 'Current Product 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://api-pos.example.com/p/x'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).toBe('exact_match');
  });

  it('round-7 P0-3: GTIN co-occurrence never makes a cross-sell primary — two representations of Y sharing only the requested GTIN do not settle exact', async () => {
    // The reviewer's round-7 escape (i): the SAME cross-sell Y appears twice
    // (embedded JSON data + a /api/recommendations response), sharing ONLY
    // the requested GTIN (different skus). Round-6's co-occurrence fallback
    // counted GTINs, so Y's repeated GTIN made it a pagePrimaryId. Round-7
    // removes GTIN from the co-occurrence key entirely — Y stays non-primary
    // and cannot prove the page product single-variant.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://rec2.example.com/p/main',
      finalUrl: 'https://rec2.example.com/p/main',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Primary Product 32oz',
          sku: 'PR-32',
          gtin: '777777777777',
          size: '32 oz',
          offers: { price: '14.99' },
        },
        {
          // Embedded representation of cross-sell Y — requested GTIN, one variant.
          '@type': 'Product',
          name: 'Requested UPC Item',
          sku: 'RE-1',
          gtin: '888888888888',
          variants: [{ id: 1, title: '1 ct' }],
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://rec2.example.com/api/recommendations',
          status: 200,
          responseContentType: 'application/json',
          // API representation of the SAME cross-sell Y — different sku, same GTIN.
          jsonBody: { product: { title: 'Requested UPC Item', sku: 'RA-1', gtin: '888888888888', variants: [{ id: 1, title: '1 ct' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result } = await runExtractionLadder(
      'https://rec2.example.com/p/main',
      { gtin: '888888888888', name: 'Requested UPC Item' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://rec2.example.com/p/main'),
        browser: { snapshot },
      },
    );
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityReasons.join(' ')).toMatch(/unproven|not exact|single-variant/i);
  });

  it('round-7 P0-3: a lone cross-sell payload is NOT primary when an expected GTIN exists (no totalProductLike===1 fallback)', async () => {
    // The reviewer's round-7 escape (ii): the page's REAL product renders as
    // plain DOM/meta; the only captured structured/network payload is the
    // cross-sell Y (requested GTIN + one variant). Round-6 treated it primary
    // by definition (totalProductLike === 1). Round-7 disables that fallback
    // whenever an expected GTIN exists — Y cannot settle exact.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://lone.example.com/p/x',
      finalUrl: 'https://lone.example.com/p/x',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Requested UPC Item',
          sku: 'LX-9',
          gtin: '888888888888',
          variants: [{ id: 1, title: '1 ct' }],
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result } = await runExtractionLadder(
      'https://lone.example.com/p/x',
      { gtin: '888888888888', name: 'Requested UPC Item' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body><h1>Requested UPC Item</h1></body></html>', 'https://lone.example.com/p/x'),
        browser: { snapshot },
      },
    );
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityReasons.join(' ')).toMatch(/unproven|not exact|single-variant/i);
  });

  it('round-7 P0-3: a lone payload with a canonical page-context marker proves single-variant', async () => {
    // Positive round-7 case (iii): the lone payload IS the page's current
    // product via canonical URL/@id linkage (page-context marker) and carries
    // the requested GTIN + one variant — browser single-variant proof holds.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://canon.example.com/p/y',
      finalUrl: 'https://canon.example.com/p/y',
      jsonLd: [
        {
          '@type': 'Product',
          '@id': 'https://canon.example.com/p/y',
          name: 'Canonical Product 8oz',
          gtin: '999999999999',
          size: '8 oz',
          offers: { price: '6.99' },
          variants: [{ id: 1, title: '8 oz' }],
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://canon.example.com/p/y',
      { gtin: '999999999999', name: 'Canonical Product 8oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://canon.example.com/p/y'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).toBe('exact_match');
  });

  it('round-7 P0-3: repeated NON-GTIN sku co-occurrence marks the primary (GTIN excluded from the key)', async () => {
    // Positive round-7 case (iv): the leaf JSON-LD product and the current-
    // product API response share a non-GTIN sku (co-occurrence, GTIN removed
    // from the key) — the API payload is primary, its single variant proves
    // the requested GTIN's page is single-variant.
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://sku-pos.example.com/p/z',
      finalUrl: 'https://sku-pos.example.com/p/z',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Sku Product 12oz',
          sku: 'SK-12',
          gtin: '777777777777',
          size: '12 oz',
          offers: { price: '9.99' },
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://sku-pos.example.com/api/products/current',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { product: { title: 'Sku Product 12oz', sku: 'SK-12', gtin: '777777777777', variants: [{ id: 1, title: '12 oz' }] } },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://sku-pos.example.com/p/z',
      { gtin: '777777777777', name: 'Sku Product 12oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://sku-pos.example.com/p/z'),
        browser: { snapshot },
      },
    );
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).toBe('exact_match');
  });

  it('escalates to the managed browser fallback with a domain-scoped provider', async () => {
    const pages = new Map<string, string>([
      ['https://managed.example.com/p/x', `<html><head><script type="application/ld+json">{"@type":"Product","name":"Managed Product 4oz","sku":"MP-4","gtin":"888888888888","offers":{"price":"1"}}</script></head><body></body></html>`],
    ]);
    const registry = new ManagedFallbackRegistry(
      { providers: [{ name: 'stub_managed', pinnedVersion: '0.1.0', allowedDomains: ['managed.example.com'] }] },
      [new StubManagedProvider(pages)],
    );
    const { result, layersUsed } = await runExtractionLadder(
      'https://managed.example.com/p/x',
      { gtin: '888888888888' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>blocked</body></html>', 'https://managed.example.com/p/x'),
        managedFallback: registry,
      },
    );
    expect(layersUsed).toContain('managed_browser');
    expect(layersUsed).toContain('managed_parsed');
    // P0-5 round 3: managed-fallback HTML is corroboration only — without a
    // platform payload or browser snapshot, the identity stays below exact.
    expect(result.identityStatus).toBe('probable_match');
  });

  it('the managed registry is safety-first: empty allowedDomains never matches', async () => {
    const registry = new ManagedFallbackRegistry(
      { providers: [{ name: 'stub_managed', pinnedVersion: '0.1.0', allowedDomains: [] }] },
      [new StubManagedProvider(new Map())],
    );
    expect(registry.providerFor('https://anything.example.com/p/x')).toBeNull();
    await expect(registry.fetch('https://anything.example.com/p/x', new AbortController().signal, 5000)).rejects.toThrow(
      /No managed fallback provider enabled/,
    );
  });

  it('runs the narrow LLM layer for unresolved fields and flips deterministicOnly', async () => {
    const client = {
      async complete(prompt: string, _schema: unknown): Promise<unknown> {
        expect(prompt).toContain('size');
        expect(prompt).toContain(NARROW_LLM_SYSTEM_PROMPT.slice(0, 40));
        return { values: [{ field: 'size', value: '16 oz', sourcePath: 'meta description', directSupport: true }] };
      },
    };
    const adapter = new LlmExtractionAdapter({ client });
    process.env.BAYSTATE_CMS_PI_LLM_BASE_URL = 'http://localhost:11434';
    process.env.BAYSTATE_CMS_PI_LLM_MODEL = 'qwen2.5vl:latest';
    try {
      const { result, layersUsed } = await runExtractionLadder(
        'https://llm.example.com/p/x',
        { gtin: '999999999999' },
        new AbortController().signal,
        5000,
        {
          fetchPage: async () =>
            fetched(`<html><head><title>T</title><meta name="description" content="16 ounce bag of premium kibble" /></head><body></body></html>`, 'https://llm.example.com/p/x'),
          llm: { adapter },
        },
      );
      expect(layersUsed).toContain('llm_extraction');
      expect(layersUsed).toContain('llm_contributed');
      expect(result.fields.some((f) => f.field === 'size' && f.method === 'llm_extraction')).toBe(true);
      expect(result.deterministicOnly).toBe(false);
    } finally {
      delete process.env.BAYSTATE_CMS_PI_LLM_BASE_URL;
      delete process.env.BAYSTATE_CMS_PI_LLM_MODEL;
    }
  });

  it('the LLM adapter drops UNRESOLVED and out-of-scope values', async () => {
    const client = {
      async complete(): Promise<unknown> {
        return {
          values: [
            { field: 'size', value: 'UNRESOLVED', directSupport: true },
            { field: 'brand', value: 'Made Up Brand', directSupport: true },
            { field: 'not_requested', value: 'ignored', directSupport: true },
          ],
        };
      },
    };
    const adapter = new LlmExtractionAdapter({ client });
    const response = await adapter.extract({
      unresolvedFields: ['size', 'brand'],
      excerpts: [{ field: 'size', text: 'a' }, { field: 'brand', text: 'b' }],
      deterministicValues: {},
    });
    expect(response.values).toEqual([{ field: 'brand', value: 'Made Up Brand', directSupport: true }]);
  });

  it('narrowLlmPrompt embeds the request deterministically', () => {
    const request = { unresolvedFields: ['size'], excerpts: [{ field: 'size', text: '16 oz' }], deterministicValues: { brand: 'X' } };
    const prompt = narrowLlmPrompt(request);
    expect(prompt).toContain(NARROW_LLM_SYSTEM_PROMPT);
    expect(prompt).toContain('"size"');
    expect(prompt).toContain('"16 oz"');
  });

  it('isLlmAvailable reflects the env configuration only', () => {
    const before = isLlmAvailable();
    process.env.BAYSTATE_CMS_PI_LLM_BASE_URL = 'http://localhost:11434';
    process.env.BAYSTATE_CMS_PI_LLM_MODEL = 'qwen2.5vl:latest';
    expect(isLlmAvailable()).toBe(true);
    delete process.env.BAYSTATE_CMS_PI_LLM_MODEL;
    expect(isLlmAvailable()).toBe(false);
    delete process.env.BAYSTATE_CMS_PI_LLM_BASE_URL;
    expect(isLlmAvailable()).toBe(before);
  });
  it('network evidence requires strong product identity (cart payloads excluded)', async () => {
    // A cart line item carries title+sku — without gtin/variants/handle it
    // must NOT become product evidence (review PI-11-M2).
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://shop.example.com/products/x',
      finalUrl: 'https://shop.example.com/products/x',
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [
        {
          url: 'https://shop.example.com/cart.js',
          status: 200,
          responseContentType: 'application/json',
          jsonBody: { items: [{ title: 'Chicken Broth 16oz', sku: 'CB-16' }] },
        },
      ],
      interaction: null,
      pageStructureSignals: [],
      warnings: [],
    });
    const { result } = await runExtractionLadder(
      'https://shop.example.com/products/x',
      { gtin: '085000079585' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>js-rendered</body></html>', 'https://shop.example.com/products/x'),
        browser: { snapshot },
      },
    );
    expect(result.fields.some((f) => f.method === 'network_response')).toBe(false);
    expect(result.productName).toBeNull();
  });

  it('the LLM layer is gated on unsettled identity (no flips on exact matches)', async () => {
    process.env.BAYSTATE_CMS_PI_LLM_BASE_URL = 'http://localhost:11434';
    process.env.BAYSTATE_CMS_PI_LLM_MODEL = 'qwen2.5vl:latest';
    try {
      // A rendered-browser leaf claim affirmatively proves single-variant
      // (P0-5 round 3: raw-HTML JSON-LD alone would NOT settle), so the
      // identity is settled and layer 8 must not run.
      const complete = vi.fn(async () => ({ values: [{ field: 'brand', value: 'Fake Brand', directSupport: true }] }));
      const snapshot: BrowserSnapshotFn = async () => ({
        url: 'https://settled.example.com/p/x',
        finalUrl: 'https://settled.example.com/p/x',
        jsonLd: [{ '@type': 'Product', name: "Stella & Chewy's Chicken Broth 16oz", sku: 'SC-BROTH-16', gtin: '085000079585', offers: { price: '6.99' } }],
        // Round-4 P1-2: rendered leaf JSON-LD is corroboration only — the
        // AFFIRMATIVE single-variant evidence is this embedded payload's
        // explicit variants array with exactly one entry.
        embeddedProductData: [{ '@type': 'Product', name: "Stella & Chewy's Chicken Broth 16oz", sku: 'SC-BROTH-16', gtin: '085000079585', variants: [{ id: 1, title: '16 oz' }] }],
        imageCandidates: [],
        networkResponses: [],
        interaction: null,
        pageStructureSignals: [],
        warnings: [],
      });
    const { result, layersUsed } = await runExtractionLadder(
      'https://settled.example.com/p/x',
      { gtin: '085000079585', name: 'Stella & Chewy\'s Chicken Broth 16oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched(JSON_LD_HTML, 'https://settled.example.com/p/x'),
        browser: { snapshot },
        llm: { adapter: new LlmExtractionAdapter({ client: { complete } }) },
      },
    );
      expect(complete).not.toHaveBeenCalled();
      // The browser-affirmative proof settles after layer 5; layers 6-8 never run.
      expect(layersUsed.some((layer) => layer.startsWith('llm'))).toBe(false);
      expect(result.deterministicOnly).toBe(true);
    } finally {
      delete process.env.BAYSTATE_CMS_PI_LLM_MODEL;
      delete process.env.BAYSTATE_CMS_PI_LLM_BASE_URL;
    }
  });

  it('the LLM layer skips when there is no excerpt source', async () => {
    process.env.BAYSTATE_CMS_PI_LLM_BASE_URL = 'http://localhost:11434';
    process.env.BAYSTATE_CMS_PI_LLM_MODEL = 'qwen2.5vl:latest';
    try {
      const complete = vi.fn(async () => ({ values: [{ field: 'size', value: '16 oz', directSupport: true }] }));
    const { layersUsed } = await runExtractionLadder(
      'https://noexcerpt.example.com/p/x',
      { gtin: '085000079585' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched('<html><body>no meta at all</body></html>', 'https://noexcerpt.example.com/p/x'),
        llm: { adapter: new LlmExtractionAdapter({ client: { complete } }) },
      },
    );
      expect(complete).not.toHaveBeenCalled();
      expect(layersUsed).toContain('llm_skipped_no_excerpts');
    } finally {
      delete process.env.BAYSTATE_CMS_PI_LLM_MODEL;
      delete process.env.BAYSTATE_CMS_PI_LLM_BASE_URL;
    }
  });

  it('the managed registry enforces pinned provider versions', async () => {
    const registry = new ManagedFallbackRegistry(
      { providers: [{ name: 'stub_managed', pinnedVersion: '9.9.9', allowedDomains: ['managed.example.com'], enabled: true }] },
      [new StubManagedProvider(new Map())],
    );
    expect(registry.providerFor('https://managed.example.com/p/x')).toBeNull();
    const ok = new ManagedFallbackRegistry(
      { providers: [{ name: 'stub_managed', pinnedVersion: '0.1.0', allowedDomains: ['managed.example.com'], enabled: true }] },
      [new StubManagedProvider(new Map())],
    );
    expect(ok.providerFor('https://managed.example.com/p/x')).not.toBeNull();
  });

  it('the LLM adapter drops unsupported (directSupport:false) values', async () => {
    const complete = vi.fn(async () => ({
      values: [
        { field: 'size', value: '16 oz', directSupport: true },
        { field: 'brand', value: 'Guessed Brand', directSupport: false },
      ],
    }));
    const adapter = new LlmExtractionAdapter({ client: { complete } });
    const response = await adapter.extract({
      unresolvedFields: ['size', 'brand'],
      excerpts: [{ field: 'size', text: '16 oz bottle' }],
      deterministicValues: {},
    });
    expect(response.values).toHaveLength(1);
    expect(response.values[0].field).toBe('size');
  });

  it('does not exact-match a multi-variant storefront that renders leaf JSON-LD only (P0-5 round 2 adversarial)', async () => {
    // The storefront emits a single-offer leaf Product JSON-LD for the
    // RENDERED child, but serves multiple variants via its platform API.
    const leafOnlyHtml = `<html><head><title>Wormeze Feline 4oz</title>
<script src="/cdn/shop/t/1/main.js"></script>
<script type="application/ld+json">{"@type":"Product","name":"Wormeze Feline 4oz","gtin":"745801105447","offers":{"price":"8.99"}}</script>
</head><body></body></html>`;
    const fetchPage = vi.fn(async () => fetched(leafOnlyHtml, 'https://shop.example.com/products/wormeze-4oz'));
    const fetchShopify = vi.fn(async () => ({
      title: 'Wormeze Feline',
      vendor: 'Farnam',
      variants: [
        { id: 1, title: '2 oz', sku: 'WF-2' },
        { id: 2, title: '4 oz', sku: 'WF-4' },
      ],
    }) as never);
    const { result, layersUsed } = await runExtractionLadder(
      'https://shop.example.com/products/wormeze-4oz',
      { gtin: '745801105447', name: 'Wormeze Feline 4oz' },
      new AbortController().signal,
      5000,
      { fetchPage, fetchShopify },
    );
    // The platform layer ran and revealed >1 variants: the leaf JSON-LD
    // proof must NOT survive the contradiction.
    expect(layersUsed).toContain('shopify');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('parent_product_only');
  });

  it('emits variant_mismatch when the selected option is not the expected variant (P0-5 round 2)', async () => {
    const snapshot: BrowserSnapshotFn = async (request) => ({
      url: 'https://browser.example.com/p/size-pick',
      finalUrl: 'https://browser.example.com/p/size-pick',
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: request.interaction
        ? { performed: true, finalUrl: 'https://browser.example.com/p/size-pick?size=8oz', selectedOptions: ['8 oz'] }
        : null,
      pageStructureSignals: [],
      warnings: [],
    });
    const out: {
      fields: Array<{ field: string; value: string; method: string; sourcePath?: string }>;
      images: Array<{ url: string; sourcePath?: string }>;
      gtins: Array<{ value: string; method: string }>;
      sku: string | null;
      brand: string | null;
      productName: string | null;
      size: string | null;
      variant: { name?: string; id?: string; sku?: string } | null;
      variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    } = { fields: [], images: [], gtins: [], sku: null, brand: null, productName: null, size: null, variant: null, variantSignals: [] };
    const result = await runBrowserInteraction(snapshot, 'https://browser.example.com/p/size-pick', {
      type: 'select_option',
      selector: '#size',
      optionLabel: '8 oz',
      settleMs: 500,
    }, out, { name: 'Size Pick 16oz' });
    expect(result.selectedOptions).toEqual(['8 oz']);
    expect(out.variantSignals.some((s) => s.kind === 'variant_match')).toBe(false);
    expect(out.variantSignals.some((s) => s.kind === 'variant_mismatch')).toBe(true);
  });

  it('emits NO variant signal when no expected-variant comparison is possible (P0-5 round 2)', async () => {
    const snapshot: BrowserSnapshotFn = async (request) => ({
      url: 'https://browser.example.com/p/unknown',
      finalUrl: 'https://browser.example.com/p/unknown',
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: request.interaction
        ? { performed: true, finalUrl: 'https://browser.example.com/p/unknown', selectedOptions: ['4 oz'] }
        : null,
      pageStructureSignals: [],
      warnings: [],
    });
    const out: {
      fields: Array<{ field: string; value: string; method: string; sourcePath?: string }>;
      images: Array<{ url: string; sourcePath?: string }>;
      gtins: Array<{ value: string; method: string }>;
      sku: string | null;
      brand: string | null;
      productName: string | null;
      size: string | null;
      variant: { name?: string; id?: string; sku?: string } | null;
      variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    } = { fields: [], images: [], gtins: [], sku: null, brand: null, productName: null, size: null, variant: null, variantSignals: [] };
    // No expected variant terms -> no comparison possible -> no signal at all.
    await runBrowserInteraction(snapshot, 'https://browser.example.com/p/unknown', {
      type: 'select_option',
      selector: '#size',
      optionLabel: '4 oz',
      settleMs: 500,
    }, out);
    expect(out.variantSignals).toHaveLength(0);
    expect(out.fields.some((f) => f.field === 'variant_selection')).toBe(true);
  });

  it('does not exact-match an unknown storefront when the browser reveals multiple variants (P0-5 round 3 adversarial)', async () => {
    // Generic storefront (no platform adapter) emits a leaf single-offer
    // JSON-LD claim for the RENDERED child; the browser snapshot reveals a
    // multi-variant product. Structured corroboration must not settle the
    // identity before an available browser layer runs.
    const unknownHtml = `<html><head><title>Wormeze Feline 4oz</title>
<script type="application/ld+json">{"@type":"Product","name":"Wormeze Feline 4oz","sku":"W-4","gtin":"745801105447","offers":{"price":"8.99"}}</script>
</head><body></body></html>`;
    const snapshot: BrowserSnapshotFn = async () => ({
      url: 'https://unknown.example.com/p/wormeze-4oz',
      finalUrl: 'https://unknown.example.com/p/wormeze-4oz',
      jsonLd: [
        {
          '@type': 'Product',
          name: 'Wormeze Feline Anthelmintic',
          gtin: '745801105447',
          variants: [
            { id: 1, title: '2 oz' },
            { id: 2, title: '4 oz' },
          ],
        },
      ],
      embeddedProductData: [],
      imageCandidates: [],
      networkResponses: [],
      interaction: null,
      pageStructureSignals: ['variant-selector detected'],
      warnings: [],
    });
    const { result, layersUsed } = await runExtractionLadder(
      'https://unknown.example.com/p/wormeze-4oz',
      { gtin: '745801105447', name: 'Wormeze Feline 4oz' },
      new AbortController().signal,
      5000,
      {
        fetchPage: async () => fetched(unknownHtml, 'https://unknown.example.com/p/wormeze-4oz'),
        browser: { snapshot },
      },
    );
    // The browser layer RAN and revealed >1 variants: the structured JSON-LD
    // corroboration cannot survive the contradiction.
    expect(layersUsed).toContain('browser');
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('parent_product_only');
  });

  it('does not exact-match an unknown storefront without a browser: structured corroboration alone is insufficient (P0-5 round 3)', async () => {
    const unknownHtml = `<html><head><title>Wormeze Feline 4oz</title>
<script type="application/ld+json">{"@type":"Product","name":"Wormeze Feline 4oz","sku":"W-4","gtin":"745801105447","offers":{"price":"8.99"}}</script>
</head><body></body></html>`;
    const { result, layersUsed } = await runExtractionLadder(
      'https://unknown.example.com/p/wormeze-4oz',
      { gtin: '745801105447', name: 'Wormeze Feline 4oz' },
      new AbortController().signal,
      5000,
      { fetchPage: async () => fetched(unknownHtml, 'https://unknown.example.com/p/wormeze-4oz') },
    );
    expect(result.identityStatus).not.toBe('exact_match');
    expect(result.identityStatus).toBe('probable_match');
    expect(result.identityReasons.join(' ')).toContain('variant status unproven');
    expect(layersUsed).not.toContain('browser');
  });
});
