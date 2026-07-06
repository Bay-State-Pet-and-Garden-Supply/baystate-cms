import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractVariantsFromJsonLd,
  extractVariantsFromShopify,
  extractVariantsFromWooCommerce,
  diffRegisterVsExpected,
  matchVariant,
  resolveVariantUrl,
} from '../../onboarding/variant-resolver';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubHtmlFetch(html: string, status = 200): void {
  globalThis.fetch = vi.fn(async () => new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as any;
}

const SHOPIFY_HTML = `
<!doctype html>
<html>
  <head>
    <script>
      window.productJSON = {
        "id": 12345,
        "title": "HonestChew Antler",
        "options": ["Size"],
        "variants": [
          { "id": 451635, "title": "Small", "option1": "Small", "sku": "HC-SM", "available": true },
          { "id": 451636, "title": "Large", "option1": "Large", "sku": "HC-LG", "available": true }
        ]
      };
    </script>
  </head>
  <body></body>
</html>
`;

const WOO_HTML = `
<!doctype html>
<html>
  <body>
    <form class="variations_form" data-product_variations='[
      { "variation_id": 998, "attributes": { "attribute_pa_color": "lavender" }, "sku": "PE-LAV", "is_in_stock": true },
      { "variation_id": 999, "attributes": { "attribute_pa_color": "green" }, "sku": "PE-GRN", "is_in_stock": false }
    ]'>
    </form>
  </body>
</html>
`;

const JSONLD_HTML = `
<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@type": "ProductGroup",
        "name": "Butcher Pate Wet Food",
        "hasVariant": [
          {
            "@type": "Product",
            "name": "Butcher Pate Wet Food - Chicken 10.5oz",
            "sku": "BP-CHKN-10.5",
            "url": "https://brand.com/pate?variant=chkn10.5",
            "offers": { "availability": "InStock" }
          },
          {
            "@type": "Product",
            "name": "Butcher Pate Wet Food - Turkey 10.5oz",
            "sku": "BP-TURK-10.5",
            "url": "https://brand.com/pate?variant=turk10.5",
            "offers": { "availability": "InStock" }
          }
        ]
      }
    </script>
  </head>
</html>
`;

describe('variant-resolver strategy detection', () => {
  it('extracts Shopify variants correctly', () => {
    const variants = extractVariantsFromShopify(SHOPIFY_HTML);
    expect(variants.length).toBe(2);
    expect(variants[0].platformId).toBe('451635');
    expect(variants[0].title).toBe('Small');
    expect(variants[0].options).toEqual(['Small']);
    expect(variants[0].sku).toBe('HC-SM');
  });

  it('extracts WooCommerce variations correctly', () => {
    const variants = extractVariantsFromWooCommerce(WOO_HTML);
    expect(variants.length).toBe(2);
    expect(variants[0].platformId).toBe('998');
    expect(variants[0].title).toBe('lavender');
    expect(variants[0].options).toEqual(['lavender']);
    expect(variants[0].sku).toBe('PE-LAV');
    expect(variants[0].url).toBe('?variation_id=998');
  });

  it('extracts Schema.org JSON-LD variants correctly', () => {
    const variants = extractVariantsFromJsonLd(JSONLD_HTML);
    expect(variants.length).toBe(2);
    expect(variants[0].title).toBe('Butcher Pate Wet Food - Chicken 10.5oz');
    expect(variants[0].sku).toBe('BP-CHKN-10.5');
    expect(variants[0].url).toBe('https://brand.com/pate?variant=chkn10.5');
    expect(variants[0].options).toEqual(['Chicken', '10.5oz']);
  });
});

describe('variant-resolver matching hints and diffing', () => {
  it('diffs names correctly to extract variant hints', () => {
    const hints = diffRegisterVsExpected(
      'WOOF HONESTCHEW ANTLER SM',
      'Woof HonestChew Antler',
      'WOOF'
    );
    expect(Array.from(hints)).toEqual(['sm']);
  });

  it('handles accent normalization and decimal sizes correctly', () => {
    const hints = diffRegisterVsExpected(
      'HONEST KITCHEN BUTCHER block PATE CHKN 10.5OZ',
      'Honest Kitchen Butcher Block Pâté Chicken',
      'HONEST KITCHEN'
    );
    expect(hints.has('10.5oz')).toBe(true);
    expect(hints.has('chkn')).toBe(true);
    // Block / Pâté mismatch is resolved since Pâté normalizes to pate, and block is in both names.
    expect(hints.has('block')).toBe(false);
    expect(hints.has('pate')).toBe(false);
  });
});

describe('variant-resolver match core', () => {
  const candidates = [
    { platformId: '1', title: 'Small', options: ['Small'], sku: 'HC-SM', available: true, url: null },
    { platformId: '2', title: 'Large', options: ['Large'], sku: 'HC-LG', available: true, url: null }
  ];

  it('matches SM token to Small variant option', () => {
    const match = matchVariant(
      candidates,
      'WOOF HONESTCHEW ANTLER SM',
      'Woof HonestChew Antler',
      'WOOF'
    );
    expect(match.matched?.platformId).toBe('1');
    expect(match.ambiguous).toBe(false);
  });

  it('matches Large token to Large variant option', () => {
    const match = matchVariant(
      candidates,
      'WOOF HONESTCHEW ANTLER LARGE',
      'Woof HonestChew Antler',
      'WOOF'
    );
    expect(match.matched?.platformId).toBe('2');
    expect(match.ambiguous).toBe(false);
  });

  it('declares ambiguity when multiple variants match equally', () => {
    const match = matchVariant(
      candidates,
      'WOOF HONESTCHEW ANTLER HC',
      'Woof HonestChew Antler',
      'WOOF'
    );
    expect(match.ambiguous).toBe(true);
  });

  it('returns no match and not ambiguous when no hints match', () => {
    const match = matchVariant(
      candidates,
      'WOOF HONESTCHEW ANTLER',
      'Woof HonestChew Antler',
      'WOOF'
    );
    expect(match.matched).toBeNull();
    expect(match.ambiguous).toBe(false);
  });
});

describe('resolveVariantUrl integration', () => {
  it('resolves Shopify variant URL successfully', async () => {
    stubHtmlFetch(SHOPIFY_HTML);
    const result = await resolveVariantUrl(
      'https://mywoof.com/products/honestchew',
      'WOOF HONESTCHEW ANTLER SM',
      'Woof HonestChew Antler',
      'WOOF'
    );

    expect(result.resolvedUrl).toBe('https://mywoof.com/products/honestchew?variant=451635');
    expect(result.variantId).toBe('451635');
    expect(result.variantTitle).toBe('Small');
    expect(result.method).toBe('shopify');
  });

  it('resolves WooCommerce variant URL successfully', async () => {
    stubHtmlFetch(WOO_HTML);
    const result = await resolveVariantUrl(
      'https://earthanimal.com/products/honestchew',
      'EARTH ANIMAL HONESTCHEW LAV',
      'Earth Animal HonestChew',
      'EARTH ANIMAL'
    );

    expect(result.resolvedUrl).toBe('https://earthanimal.com/products/honestchew?variation_id=998');
    expect(result.variantId).toBe('998');
    expect(result.method).toBe('woocommerce');
  });

  it('resolves JSON-LD hasVariant URL successfully', async () => {
    stubHtmlFetch(JSONLD_HTML);
    const result = await resolveVariantUrl(
      'https://brand.com/pate',
      'HONEST KITCHEN BUTCHER block PATE CHKN 10.5OZ',
      'Honest Kitchen Butcher Block Pâté Chicken',
      'HONEST KITCHEN'
    );

    expect(result.resolvedUrl).toBe('https://brand.com/pate?variant=chkn10.5');
    expect(result.variantId).toBe('BP-CHKN-10.5');
    expect(result.method).toBe('jsonld');
  });

  it('returns base URL unchanged when ambiguity is hit', async () => {
    stubHtmlFetch(SHOPIFY_HTML);
    const result = await resolveVariantUrl(
      'https://mywoof.com/products/honestchew',
      'WOOF HONESTCHEW ANTLER HC',
      'Woof HonestChew Antler',
      'WOOF'
    );

    expect(result.resolvedUrl).toBe('https://mywoof.com/products/honestchew');
    expect(result.variantId).toBeNull();
    expect(result.ambiguous).toBe(true);
  });
});
