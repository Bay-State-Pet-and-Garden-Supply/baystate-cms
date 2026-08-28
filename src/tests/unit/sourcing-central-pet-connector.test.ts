import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CentralPetConnector, parseCentralPetPdp, parseCentralPetSearchCandidates } from '../../onboarding/sourcing/connectors/central-pet';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'central_pet');
const FIXTURES: Record<string, string> = {};
for (const name of ['found-search.html', 'found-pdp.html', 'wrong-variant-search.html', 'wrong-variant-pdp.html', 'other-product-pdp.html', 'not-found.html', 'unexpected-markup.html']) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://www.centralpet.com/Search?criteria=';
const ORIGIN = 'https://www.centralpet.com';

/** Deterministic fake fetcher: URL → fixture; logs calls with browserRequired. */
function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string; browserRequired?: boolean }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    calls.push({ url, browserRequired: opts.browserRequired });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '035585775210')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '000000000000')) {
      return { ok: true, html: FIXTURES['not-found.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH)) {
      return { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: url };
    }
    if (url.includes('option=PDCM38777521')) {
      return { ok: true, html: FIXTURES['found-pdp.html'], finalUrl: url };
    }
    if (url.includes('option=PDCM38777520') || url.includes('option=PDCM38777518')) {
      return { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: url };
    }
    if (url.includes('/Product/')) {
      return { ok: true, html: FIXTURES['other-product-pdp.html'], finalUrl: url };
    }
    return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
  };
  return { fetchPage, calls };
}

function makeRequest(upc: string, extra: Partial<SourcingLookupRequest> = {}): SourcingLookupRequest {
  const controller = new AbortController();
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc,
    gtin: null,
    brandHint: null,
    registerName: null,
    connection: { id: 'conn-central', distributorId: 'central_pet', connectorType: 'html_scraper', configuration: {} },
    secret: null,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    ...extra,
  };
}

describe('CentralPetConnector — found (exact UPC match)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage, calls } = makeFetcher();
    const connector = new CentralPetConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('035585775210'));

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    const { record, matchedFields } = result;
    expect(record.matchedIdentifier).toBe('035585775210');
    expect(record.name).toBe('KONG Air Dog Squeaker Tennis Ball Dog Toy');
    expect(record.brand).toBe('KONG');
    expect(record.distributorSku).toBe('38777521');
    expect(record.manufacturerPartNumber).toBe('AST2B');
    expect(record.weight).toBe('0.0700 lb');
    expect(record.attributes.packCount).toBe('48');
    expect(record.casePack).toBe('48');
    expect(record.category).toBe('Squeaker Toys');
    expect(record.description).toMatch(/^Special nonabrasive tennis ball fabric will not wear down a dog's teeth/);
    expect(record.observedAt).toBe('2026-08-15T00:00:00.000Z');
    expect(matchedFields).toEqual(expect.arrayContaining(['matchedIdentifier', 'name', 'brand', 'distributorSku', 'manufacturerPartNumber', 'weight', 'packCount', 'casePack', 'description', 'category', 'sourceUrl']));
    // Angular storefront always renders via the browser engine.
    expect(calls.every((c) => c.browserRequired)).toBe(true);
  });

  test('images are HTTPS display-only candidates on approved asset hosts only', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('035585775210'));
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.record.imageUrls.length).toBeGreaterThan(0);
    for (const url of result.record.imageUrls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(new URL(url).hostname).toMatch(/centralpet\.com|salsify\.com|cloudfront\.net$/);
    }
  });

  test('public connector: requiresSecret=false and a null secret is ignored', async () => {
    const connector = new CentralPetConnector({});
    expect(connector.connectorType).toBe('html_scraper');
    expect(connector.providerId).toBe('central_pet');
    expect(connector.requiresSecret).toBe(false);
    const { fetchPage } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('found');
  });
});

describe('CentralPetConnector — fail-closed outcomes', () => {
  test('explicit no-results marker → not_stocked:no_exact_match', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('000000000000'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('no exact match');
  });

  test('candidates that never carry the exact UPC → not_stocked:wrong_variant (bounded iteration)', async () => {
    const calls: Array<{ url: string }> = [];
    // A bare search LIST (no embedded PDP detail) forces candidate iteration;
    // every candidate PDP carries a different UPC.
    const SEARCH_LIST_HTML = `
      <html><body>
        <div class="isc-productContainer">
          <a href="${ORIGIN}/Product/200004369-JW-Pet-Hol-ee-Football-Dog-Toy?option=PDCM36543118">JW Pet Hol-ee Football</a>
        </div>
        <div class="isc-productContainer">
          <a href="${ORIGIN}/Product/200004371-JW-Pet-Hol-ee-Roller-Dog-Toy?option=PDCM36543109">JW Pet Hol-ee Roller</a>
        </div>
      </body></html>`;
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      calls.push({ url });
      void opts;
      if (url.startsWith(SEARCH)) {
        return { ok: true, html: SEARCH_LIST_HTML, finalUrl: url };
      }
      if (url.includes('/Product/')) {
        return { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: url };
      }
      return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
    };
    const connector = new CentralPetConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
    // Bounded candidate iteration: at most MAX_PDP_CANDIDATES (6) PDP fetches.
    const pdpCalls = calls.filter((c) => c.url.includes('/Product/'));
    expect(pdpCalls.length).toBeLessThanOrEqual(6);
  });

  test('search response embedding the exact PDP (single-match storefront) → found with ZERO additional fetches', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      calls.push({ url });
      void opts;
      if (url.startsWith(SEARCH)) {
        // Real storefront behavior (observed live 2026-08-15): a single-match
        // search renders the product detail INLINE on the search response.
        return { ok: true, html: FIXTURES['wrong-variant-search.html'], finalUrl: url };
      }
      return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
    };
    const connector = new CentralPetConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.record.name).toContain('KONG');
    }
    // Direct-PDP recognition: no candidate PDP fetch is needed.
    expect(calls.filter((c) => c.url.includes('/Product/')).length).toBe(0);
  });

  test('no candidates AND no no-results marker → source_error:unexpected_markup', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('999999999999'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
  });

  test('transport failure on search → source_error with the stable code', async () => {
    const { fetchPage } = makeFetcher({ [SEARCH + '035585775210']: { ok: false, code: 'timeout', message: 'transport timed out' } });
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
  });

  test('no 8-14 digit identifier → source_error:no_identifier', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('123'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('no_identifier');
    expect(calls.length).toBe(0);
  });

  test('no price/stock/sell-pack/pallet data ever enters the record', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('035585775210'));
    if (result.outcome !== 'found') throw new Error('expected found');
    const flat = JSON.stringify(result.record);
    for (const forbidden of ['price', 'inventory', 'stock', 'pallet', 'sellpack', 'availability']) {
      expect(flat.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(result.record.features).toEqual([]);
    expect(result.record.unitOfMeasure).toBeNull();
    expect(result.record.ingredients).toBeNull();
  });
});

describe('CentralPet pure parsers (fixture-based)', () => {
  test('parseCentralPetSearchCandidates extracts product links only (same-origin, deduped)', () => {
    const candidates = parseCentralPetSearchCandidates(FIXTURES['found-search.html']);
    expect(candidates.length).toBeGreaterThan(0);
    for (const url of candidates) {
      expect(url.startsWith('https://www.centralpet.com/Product/')).toBe(true);
      expect(url).toContain('option=');
    }
    // The synthetic exact-variant link is the FIRST candidate (bounded iteration reaches it).
    expect(candidates[0]).toContain('option=PDCM38777521');
  });

  test('no-result page still surfaces recommendation cards to the parser (connector marker check is authoritative)', () => {
    // The site renders recommendations below the empty state, so the parser
    // legitimately finds links; the CONNECTOR decides no_exact_match from the
    // explicit `.no-results-found` marker BEFORE iterating candidates.
    expect(parseCentralPetSearchCandidates(FIXTURES['not-found.html']).length).toBeGreaterThan(0);
  });

  test('parseCentralPetPdp extracts the full recovered field map', () => {
    const pdp = parseCentralPetPdp(FIXTURES['found-pdp.html']);
    expect(pdp.parsed).toBe(true);
    expect(pdp.upc).toBe('035585775210');
    expect(pdp.name).toBe('KONG Air Dog Squeaker Tennis Ball Dog Toy');
    expect(pdp.brand).toBe('KONG');
    expect(pdp.distributorSku).toBe('38777521');
    expect(pdp.mpn).toBe('AST2B');
    expect(pdp.weight).toBe('0.0700 lb');
    expect(pdp.casePack).toBe('48');
    expect(pdp.description).toMatch(/^Special nonabrasive tennis ball fabric/);
    expect(pdp.category).toBe('Squeaker Toys');
    expect(pdp.dimensions).toBe('2.50 in x 2.50 in x 2.50 in');
    expect(pdp.images.length).toBeGreaterThan(0);
  });

  test('unexpected shell parses as not-a-PDP', () => {
    const pdp = parseCentralPetPdp(FIXTURES['unexpected-markup.html']);
    expect(pdp.parsed).toBe(false);
  });
});

describe('CentralPetConnector — live-shaped markup (captured 2026-08-15, inline fixtures)', () => {
  // Faithful to the real rendered PDP: `.product-spec` rows (Product #, Mfg
  // Part #, UPC, Sell Pk Qty, Case Qty, Pallet Qty), the specs accordion
  // (`<li><strong>…</strong><span class="spec-value">…</span></li>` rows incl.
  // Recommended For / Battery / Safety), the Angular description paragraph,
  // breadcrumb category, and the image zoom gallery. The template-only rows
  // (`{{ product.upcCode }}` etc.) replicate the second spec block the live
  // page ships.
  const LIVE_PDP = `
    <html><body>
      <div id="tst_productDetail_erpDescription">KONG Air Dog Squeaker Tennis Ball Dog Toy</div>
      <p><a ng-if="vm.product.brand.detailPagePath" href="/brands/kong">KONG</a></p>
      <div id="tst_productDetail_htmlContent" class="product-cm" ng-bind-html="vm.product.htmlContent|trusted">
        <p>Special nonabrasive tennis ball fabric will not wear down a dog's teeth.</p>
      </div>
      <ul class="breadcrumbs"><li><a href="/">Home</a></li><li><a href="/Dog">Dog</a></li><li><a href="/Dog/Toys">Toys and Chews</a></li><li><a href="/Dog/Toys/Squeaker">Squeaker Toys</a></li></ul>
      <div class="product-spec"> <span>Product #: </span>38777521 </div>
      <div class="product-spec"> <span>Mfg Part #: </span>AST2B </div>
      <div class="product-spec"> <span>UPC: </span>035585775210 </div>
      <div class="product-spec"> <span>Sell Pk Qty: </span>1 </div>
      <div class="product-spec"> <span>Case Qty: </span>48 </div>
      <div class="product-spec"> <span>Pallet Qty: </span>8448 </div>
      <div class="product-spec"> <span>Product #: </span>{{ product.modelNumber.replace('SAPM','').replace('PDCM','') }} </div>
      <div class="product-spec"> <span>UPC: </span>{{ product.upcCode }} </div>
      <ul>
        <li><strong>Product Gross Weight:</strong> <span class="spec-value">0.0700 lb</span></li>
        <li><strong>Product Net Weight:</strong> <span class="spec-value">0.0700 lb</span></li>
        <li><strong>Product Height:</strong> <span class="spec-value">2.50 in</span></li>
        <li><strong>Product Length:</strong> <span class="spec-value">2.50 in</span></li>
        <li><strong>Product Width:</strong> <span class="spec-value">2.50 in</span></li>
        <li><strong>Recommended For:</strong> <span class="spec-value">Chew; Fetch; Interactive Play</span></li>
        <li><strong>Battery Required:</strong> <span class="spec-value">No</span></li>
        <li><strong>Safety Warnings:</strong> <span class="spec-value">Designed for light/moderate chewing.</span></li>
      </ul>
      <div id="tst_productDetail_imageZoom">
        <img src="https://d2gqd42fylojmw.cloudfront.net/userfiles/kong.jpg">
        <img src="https://images.salsify.com/image/upload/kong2.jpg">
        <img src="http://www.centralpet.com/insecure.jpg">
      </div>
      <div class="availability">In Stock</div>
      <div class="review-summary">4.8 stars (12 reviews)</div>
    </body></html>`;

  test('parses every mapped merchandising field from the live spec rows', () => {
    const pdp = parseCentralPetPdp(LIVE_PDP);
    expect(pdp.parsed).toBe(true);
    expect(pdp.upc).toBe('035585775210');
    expect(pdp.name).toBe('KONG Air Dog Squeaker Tennis Ball Dog Toy');
    expect(pdp.brand).toBe('KONG');
    expect(pdp.distributorSku).toBe('38777521');
    expect(pdp.mpn).toBe('AST2B');
    expect(pdp.casePack).toBe('48');
    expect(pdp.weight).toBe('0.0700 lb');
    expect(pdp.dimensions).toBe('2.50 in x 2.50 in x 2.50 in');
    expect(pdp.category).toBe('Squeaker Toys');
    expect(pdp.description).toContain('nonabrasive tennis ball fabric');
    // HTTPS + allowlisted asset hosts only; the insecure http: host is dropped.
    expect(pdp.images).toEqual([
      'https://d2gqd42fylojmw.cloudfront.net/userfiles/kong.jpg',
      'https://images.salsify.com/image/upload/kong2.jpg',
    ]);
  });

  test('forbidden and arbitrary spec rows never enter the record; attributes stays variant-axes-only', async () => {
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      void opts;
      return { ok: true, html: LIVE_PDP, finalUrl: url };
    };
    const connector = new CentralPetConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    const { record } = result;
    // Only the numeric Case Qty becomes the built-in packCount variant axis.
    expect(Object.keys(record.attributes)).toEqual(['packCount']);
    expect(record.attributes.packCount).toBe('48');
    const flat = JSON.stringify(record).toLowerCase();
    for (const forbidden of [
      'sell pk qty', 'pallet qty', 'pallet', 'recommended for', 'battery', 'safety',
      'in stock', 'availability', 'reviews', '4.8', 'price', 'sellpack',
    ]) {
      expect(flat).not.toContain(forbidden);
    }
    expect(record.features).toEqual([]);
    expect(record.unitOfMeasure).toBeNull();
    expect(record.ingredients).toBeNull();
  });

  test('Net Weight is the weight fallback when Gross Weight is absent', () => {
    const noGross = LIVE_PDP.replace('<strong>Product Gross Weight:</strong> <span class="spec-value">0.0700 lb</span>', '');
    const pdp = parseCentralPetPdp(noGross);
    expect(pdp.weight).toBe('0.0700 lb');
  });

  test('dimensions fail closed when a dimension row is missing (never half-assembled)', () => {
    const noLength = LIVE_PDP.replace('<li><strong>Product Length:</strong> <span class="spec-value">2.50 in</span></li>', '');
    const pdp = parseCentralPetPdp(noLength);
    expect(pdp.dimensions).toBeNull();
  });

  test('direct-PDP search recognition: the live-shaped PDP returned from /Search resolves found with zero product-link fetches', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      calls.push({ url });
      void opts;
      if (url.startsWith(SEARCH)) return { ok: true, html: LIVE_PDP, finalUrl: url };
      return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
    };
    const result = await new CentralPetConnector({ fetchPage }).lookupByGtin(makeRequest('035585775210'));
    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') expect(result.record.name).toContain('KONG');
    expect(calls.filter((c) => c.url.includes('/Product/')).length).toBe(0);
  });
});
