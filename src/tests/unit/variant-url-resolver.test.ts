import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scoreShopifyVariant,
  resolveVariantsFromHtml,
  resolveVariantsForCandidates,
} from '../../onboarding/variant-url-resolver';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';

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

const SHOPIFY_HTML_VARIANTS = `
<!doctype html>
<html>
  <head>
    <script>
      window.productJSON = {
        "id": 12345,
        "title": "HonestChew Antler",
        "options": ["Color", "Size"],
        "variants": [
          { "id": 451635, "title": "Lavender / Small", "option1": "Lavender", "option2": "Small", "sku": "HC-LAV-SM", "barcode": "111111111111", "price": 1999, "available": true },
          { "id": 451636, "title": "Lavender / Large", "option1": "Lavender", "option2": "Large", "sku": "HC-LAV-LG", "barcode": "222222222222", "price": 2499, "available": true },
          { "id": 451637, "title": "Green / Small", "option1": "Green", "option2": "Small", "sku": "HC-GRN-SM", "barcode": "333333333333", "price": 1999, "available": true }
        ]
      };
    </script>
  </head>
  <body></body>
</html>
`;

describe('Shopify variant url resolver scoring', () => {
  it('assigns high score for barcode/UPC exact match', () => {
    const v = {
      id: '451635',
      title: 'Lavender / Small',
      option1: 'Lavender',
      option2: 'Small',
      sku: 'HC-LAV-SM',
      barcode: '111111111111',
      price: 19.99,
    };
    const context = {
      upc: '111111111111',
      rawName: 'HonestChew Antler Dog Toy',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
    };
    const hints = new Set<string>();
    const varNameTokens = new Set<string>();

    const { score, matchedSignals } = scoreShopifyVariant(v, context, hints, varNameTokens);
    expect(score).toBeGreaterThanOrEqual(1000);
    expect(matchedSignals).toContain('barcode-exact');
  });

  it('matches expected name tokens and exact option values', () => {
    const v = {
      id: '451635',
      title: 'Lavender / Small',
      option1: 'Lavender',
      option2: 'Small',
      sku: 'HC-LAV-SM',
      barcode: null,
      price: 19.99,
    };
    const context = {
      upc: '',
      rawName: 'HonestChew Antler Lavender Small',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      price: 19.99,
    };
    const hints = new Set(['lavender', 'small']);
    const varNameTokens = new Set(['lavender', 'small']);

    const { score, matchedSignals } = scoreShopifyVariant(v, context, hints, varNameTokens);
    // score should include option exact (60 * 2) + name/hint matches
    expect(score).toBeGreaterThan(120);
    expect(matchedSignals).toContain('option-exact:lavender');
    expect(matchedSignals).toContain('option-exact:small');
    expect(matchedSignals).toContain('price-exact');
  });
});

describe('resolveVariantsFromHtml', () => {
  it('resolves exactly to the matching variant when barcode matches', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '222222222222',
        rawName: 'HonestChew Antler',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.variant.id).toBe('451636');
      expect(result.variant.title).toBe('Lavender / Large');
      expect(result.variant.url).toBe('https://honestchew.com/products/antler?variant=451636');
    }
  });

  it('resolves using option names when barcode is missing', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '',
        rawName: 'HonestChew Antler Green Small',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.variant.id).toBe('451637');
      expect(result.variant.title).toBe('Green / Small');
    }
  });

  it('marks as ambiguous if multiple variants are close match', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '',
        rawName: 'HonestChew Antler Lavender',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.variants.length).toBe(3); // Lavender Small and Lavender Large are both matches
    }
  });
});

describe('resolveVariantsForCandidates integration', () => {
  it('replaces base candidate with resolved variant url', async () => {
    stubHtmlFetch(SHOPIFY_HTML_VARIANTS);

    const candidates: InsertSourceData[] = [
      {
        url: 'https://honestchew.com/products/antler',
        title: 'HonestChew Antler',
        domain: 'honestchew.com',
        confidence: 0.9,
        sourceMethod: 'serper_name',
      },
    ];

    const result = await resolveVariantsForCandidates({
      candidates,
      upc: '',
      rawName: 'HonestChew Antler Green Small',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
    });

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://honestchew.com/products/antler?variant=451637');
    expect(result[0].title).toBe('HonestChew Antler - Green / Small');
    expect(result[0].sourceMethod).toBe('shopify_variant');
    expect(result[0].metadataJson).toBeDefined();

    const meta = JSON.parse(result[0].metadataJson!);
    expect(meta.variantResolution.status).toBe('resolved');
    expect(meta.variantResolution.variantId).toBe('451637');
  });

  it('duplicates candidates when variant resolution is ambiguous', async () => {
    stubHtmlFetch(SHOPIFY_HTML_VARIANTS);

    const candidates: InsertSourceData[] = [
      {
        url: 'https://honestchew.com/products/antler',
        title: 'HonestChew Antler',
        domain: 'honestchew.com',
        confidence: 0.9,
        sourceMethod: 'serper_name',
      },
    ];

    const result = await resolveVariantsForCandidates({
      candidates,
      upc: '',
      rawName: 'HonestChew Antler Lavender',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
    });

    // It should expand into all Shopify variants as candidates
    expect(result.length).toBe(3);
    expect(result[0].url).toContain('?variant=');
    expect(result[0].sourceMethod).toBe('shopify_variant');

    const meta = JSON.parse(result[0].metadataJson!);
    expect(meta.variantResolution.status).toBe('ambiguous');
    expect(meta.variantResolution.baseUrl).toBe('https://honestchew.com/products/antler');
  });
});
