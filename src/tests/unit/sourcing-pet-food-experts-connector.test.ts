import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PetFoodExpertsConnector, parsePetFoodExpertsPdp, parsePetFoodExpertsSearchCandidates } from '../../onboarding/sourcing/connectors/pet-food-experts';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'pet_food_experts');
const FIXTURES: Record<string, string> = {};
for (const name of [
  'found-search.html', 'found-pdp.html', 'not-found.html', 'wrong-variant-pdp.html',
  'auth-required.html', 'auth-failed.html', 'unexpected-markup.html',
]) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://orders.petfoodexperts.com/Search?query=';
const PDP = 'https://orders.petfoodexperts.com/product/wellness-core-grain-free';
const PDP_OTHER = 'https://orders.petfoodexperts.com/product/wellness-core-9';

function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    void opts;
    calls.push({ url });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '33011808')) return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    if (url.startsWith(SEARCH + '000000000000')) return { ok: true, html: FIXTURES['not-found.html'], finalUrl: url };
    if (url.startsWith(SEARCH)) return { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: url };
    if (url === PDP) return { ok: true, html: FIXTURES['found-pdp.html'], finalUrl: url };
    if (url === PDP_OTHER) return { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: url };
    return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
  };
  return { fetchPage, calls };
}

const VALID_SECRET = JSON.stringify({ username: 'ops-user', password: 's3cret-pass' });

function makeRequest(upc: string, extra: Partial<SourcingLookupRequest> = {}): SourcingLookupRequest {
  const controller = new AbortController();
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc,
    gtin: null,
    brandHint: null,
    registerName: null,
    connection: { id: 'conn-pfx', distributorId: 'pet_food_experts', connectorType: 'html_scraper', configuration: {} },
    secret: VALID_SECRET,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('PetFoodExpertsConnector — found (exact UPC match, authenticated)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PetFoodExpertsConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('33011808');
    expect(result.record.name).toBe('Wellness CORE Grain Free');
    expect(result.record.brand).toBe('Wellness');
    expect(result.record.distributorSku).toBe('PFX-0087');
    expect(result.record.weight).toBe('5 lb');
    expect(result.record.unitOfMeasure).toBe('EA');
    expect(result.record.description).toContain('Complete and balanced grain-free');
    expect(result.record.ingredients).toContain('Deboned chicken');
    expect(result.record.features).toContain('Grain free');
    expect(result.record.category).toBe('Dog Food');
    expect(result.record.imageUrls).toContain('https://cdn.insitecloud.net/images/wellness-core.jpg');
    expect(result.record.sourceUrl).toBe(PDP);
    expect(result.matchedFields).toEqual(expect.arrayContaining(['matchedIdentifier', 'name', 'brand', 'distributorSku', 'weight', 'unitOfMeasure', 'description', 'features', 'ingredients', 'category', 'imageUrls', 'sourceUrl']));
    // Price/inventory never present.
    expect(result.record).not.toHaveProperty('price');
    expect(JSON.stringify(result.record)).not.toMatch(/inStock|availability|addToCart|price/i);
  });

  test('record never leaks credentials or raw HTML', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('found');
    const json = JSON.stringify(result);
    expect(json).not.toContain('ops-user');
    expect(json).not.toContain('s3cret-pass');
    expect(json).not.toMatch(/<!DOCTYPE/i);
  });
});

describe('PetFoodExpertsConnector — not found and wrong variant fail closed', () => {
  test('explicit no-result page → not_stocked:no_exact_match', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('000000000000'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('no exact match');
  });

  test('PDP with a different UPC → not_stocked:wrong_variant despite identical name/brand', async () => {
    const { fetchPage } = makeFetcher({
      [PDP]: { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: PDP },
    });
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });
});

describe('PetFoodExpertsConnector — auth and transport failures are bounded', () => {
  test('missing secret fails closed before any transport', async () => {
    const { fetchPage, calls } = makeFetcher();
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808', { secret: null }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('secret_missing');
    expect(calls.length).toBe(0);
  });

  test('malformed credential JSON → credential_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808', { secret: '{not-json' }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('credential_invalid');
  });

  test('search returning the login form → auth_required', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '33011808']: { ok: true, html: FIXTURES['auth-required.html'], finalUrl: SEARCH + '33011808' },
    });
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('auth failure indicator on a fetched page → auth_required (fail closed)', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '33011808']: { ok: true, html: FIXTURES['auth-failed.html'], finalUrl: SEARCH + '33011808' },
    });
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('unrecognized search markup → source_error:unexpected_markup', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '33011808']: { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: SEARCH + '33011808' },
    });
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
  });

  test('transport failure on search propagates its stable code', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '33011808']: { ok: false, code: 'origin_blocked', message: 'off origin' },
    });
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('origin_blocked');
  });

  test('pre-aborted request starts no transport', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });
});

describe('PetFoodExpertsConnector — parser units and exact identifier rule', () => {
  test('search candidate parsing returns same-origin product links only', () => {
    const urls = parsePetFoodExpertsSearchCandidates(FIXTURES['found-search.html']);
    expect(urls).toContain(PDP);
  });

  test('PDP parser extracts the recovered field map', () => {
    const p = parsePetFoodExpertsPdp(FIXTURES['found-pdp.html']);
    expect(p.name).toBe('Wellness CORE Grain Free');
    expect(p.brand).toBe('Wellness');
    expect(p.upc).toBe('33011808');
    expect(p.distributorSku).toBe('PFX-0087');
    expect(p.unitOfMeasure).toBe('EA');
    expect(p.parsed).toBe(true);
  });

  test('wrong-variant PDP is parsed but its UPC differs (never rescued by name/brand)', () => {
    const p = parsePetFoodExpertsPdp(FIXTURES['wrong-variant-pdp.html']);
    expect(p.upc).toBe('012345678901');
    expect(p.parsed).toBe(true);
  });
});

describe('PetFoodExpertsConnector — item-number exact match (product-owner directive 2026-08-15)', () => {
  const ITEM_MATCH_PDP = `
    <html><body>
      <h1 data-test-selector="product-name">DAVE'S PET FOOD DOG RESTRICTED BLAND DIET CHICKEN &amp; RICE 13.2OZ - 12 PACK</h1>
      <div data-test-selector="page_ProductDetailsPage">
        <div data-test-selector="productDetails_productId_4b17acce">
          Item #33011808
          UPC#: CAS: 685038118097, EA: 685038118080
        </div>
      </div>
    </body></html>`;
  test('searching the distributor item number (8-14 digits, exact) resolves the product and carries its real EA barcode', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      calls.push({ url });
      void opts;
      if (url.startsWith(SEARCH)) return { ok: true, html: ITEM_MATCH_PDP, finalUrl: url };
      return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
    };
    const connector = new PetFoodExpertsConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.record.matchedIdentifier).toBe('33011808');
      expect(result.record.distributorSku).toBe('33011808');
      expect(result.record.distributorUpc).toBe('685038118080');
      expect(result.record.name).toContain('DAVE');
    }
    // Single response — the search already rendered the product page.
    expect(calls.length).toBe(1);
  });

  test('a UPC-less page never matches by item number (fail closed)', async () => {
    const noUpc = ITEM_MATCH_PDP.replace('UPC#: CAS: 685038118097, EA: 685038118080', '');
    const fetchPage: ScraperFetchPage = async (url) =>
      url.startsWith(SEARCH) ? { ok: true, html: noUpc, finalUrl: url } : { ok: false, code: 'unexpected', message: 'x' };
    const result = await new PetFoodExpertsConnector({ fetchPage }).lookupByGtin(makeRequest('33011808'));
    expect(result.outcome).toBe('not_stocked');
  });
});

describe('PetFoodExpertsConnector — live-shape parser units (2026-08-15 captures)', () => {
  // Live storefront shape: productId container carries Item # + UPC# CAS/EA;
  // specifications concatenate labels without spaces ("AttributesBrand: …").
  const LIVE_SHAPE_PDP = `
    <html><body>
      <h1>DAVE'S PET FOOD DOG RESTRICTED BLAND DIET CHICKEN &amp; RICE 13.2OZ - 12 PACK</h1>
      <div data-test-selector="page_ProductDetailsPage">
        <div data-test-selector="productDetails_productId_4b17acce">
          Home
          DOG
          Food
          DAVE'S PET FOOD DOG RESTRICTED BLAND DIET CHICKEN &amp; RICE 13.2OZ - 12 PACK
          Daves Pet Food
          DAVE'S PET FOOD DOG RESTRICTED BLAND DIET CHICKEN &amp; RICE 13.2OZ - 12 PACK
          Item #33011808
          UPC#:  CAS: 685038118097, EA: 685038118080
          EDLP: $25.06
          Price: $25.06 / Case
          In Stock
          You have (0) in your shopping cart.
          QTY
          Add to Cart
          add to list
        </div>
        <div data-test-selector="productDetails_specifications">
          Attributes
          Brand: Daves Pet Food
          Flavor: Chicken
          Animal: Dog
          Diet: Sensitive
          Food Form: Can, Pate
          Ingredients
          Chicken, Water Sufficient For Processing, White Rice, Rice Flour, Natural Flavor,
          Guar Gum, Potassium Chloride, Agar-Agar, Salt, Minerals (Ferrous Sulfate,
          Zinc Oxide, Copper Proteinate, Sodium Selenite, Manganese Sulfate, Potassium Iodide),
          Vitamins (Vitamin E Supplement, Thiamin Mononitrate, Niacin Supplement, D-Calcium
          Pantothenate, Pyridoxine Hydrochloride, Riboflavin Supplement, Folic Acid, Biotin,
          Vitamin B12 Supplement), Caramel Color
        </div>
        <div data-test-selector="productDetails_htmlContent"></div>
      </div>
    </body></html>`;

  test('EA barcode is preferred over CAS even when CAS appears first', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    expect(p.upc).toBe('685038118080');
    expect(p.upc).not.toBe('685038118097');
  });

  test('Item # and UPC# are read from the productId container', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    expect(p.distributorSku).toBe('33011808');
    expect(p.upc).toBe('685038118080');
  });

  test('brand regex strips the trailing concatenated sibling label', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    expect(p.brand).toBe('Daves Pet Food');
    expect(p.brand).not.toContain('Flavor');
  });

  // Observed live 2026-08-16 (Old Mother Hubbard / Fromm / Wellness SKUs): the
  // spec run is one glued block with NO separator between the brand value and
  // the next label — "…Brand: Old Mother HubbardFlavor: Peanut Butter…".
  const GLUED_LABEL_PDP = `
    <html><body>
      <h1>OLD MOTHER HUBBARD MILK BAR P'NUTTY BDAY PARTY 10OZ</h1>
      <div data-test-selector="page_ProductDetailsPage">
        <div data-test-selector="productDetails_productId_4b17acce">
          Item #43110438
          UPC#:  CAS: 685038118097, EA: 076344104384
        </div>
        <div data-test-selector="productDetails_specifications">
          AttributesBrand: Old Mother HubbardFlavor: Peanut ButterAnimal: DogTreat
        </div>
        <div data-test-selector="productDetails_htmlContent"></div>
      </div>
    </body></html>`;

  test('brand regex cuts a GLUED sibling label (no whitespace separator)', () => {
    const p = parsePetFoodExpertsPdp(GLUED_LABEL_PDP);
    expect(p.brand).toBe('Old Mother Hubbard');
    expect(p.brand).not.toContain('Flavor');
  });

  test('ingredients section text is captured (bounded, no fabricated copy)', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    expect(p.ingredients).toContain('Chicken, Water Sufficient For Processing');
    expect(p.ingredients).toContain('Caramel Color');
  });

  test('an empty htmlContent div never fabricates a description', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    expect(p.description).toBeNull();
  });

  test('price / stock / availability / add-to-cart markup on the page is NEVER extracted', () => {
    const p = parsePetFoodExpertsPdp(LIVE_SHAPE_PDP);
    const serialized = JSON.stringify(p);
    expect(serialized).not.toMatch(/Price|EDLP|\$25/i);
    expect(serialized).not.toMatch(/In Stock|availability|addToCart|Add to Cart/i);
    // The connector-level record carries none of it either.
    const fetchPage: ScraperFetchPage = async (url) =>
      url.startsWith(SEARCH) ? { ok: true, html: LIVE_SHAPE_PDP, finalUrl: url } : { ok: false, code: 'unexpected', message: 'x' };
    return new PetFoodExpertsConnector({ fetchPage }).lookupByGtin(makeRequest('33011808')).then((result) => {
      expect(result.outcome).toBe('found');
      const recordJson = JSON.stringify(result);
      expect(recordJson).not.toMatch(/Price|EDLP|In Stock|availability|addToCart/i);
    });
  });
});
