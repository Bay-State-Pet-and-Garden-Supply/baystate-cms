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
    const fetchPage: ScraperFetchPage = async (url, opts) => {
      calls.push({ url });
      void opts;
      if (url.startsWith(SEARCH)) {
        return { ok: true, html: FIXTURES['wrong-variant-search.html'], finalUrl: url };
      }
      if (url.includes('option=PDCM38777520') || url.includes('option=PDCM38777518')) {
        return { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: url };
      }
      if (url.includes('/Product/')) {
        return { ok: true, html: FIXTURES['other-product-pdp.html'], finalUrl: url };
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
