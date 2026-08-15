import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BradleyConnector, parseBradleyPdp, parseBradleySearchCandidates } from '../../onboarding/sourcing/connectors/bradley';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'bradley');
const FIXTURES: Record<string, string> = {};
for (const name of ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html']) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://www.bradleycaldwell.com/search?term=';
const PDP = 'https://www.bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135';

/** Deterministic fake fetcher: URL → fixture. Records every call for assertions. */
function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string; browserRequired?: boolean }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    calls.push({ url, browserRequired: opts.browserRequired });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '018653299524')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '018653299520')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '000000000000')) {
      return { ok: true, html: FIXTURES['not-found.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH)) {
      return { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: url };
    }
    if (url === PDP) {
      return { ok: true, html: FIXTURES['found-pdp.html'], finalUrl: url };
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
    connection: { id: 'conn-bradley', distributorId: 'bradley', connectorType: 'html_scraper', configuration: {} },
    secret: null,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('BradleyConnector — found (exact UPC match)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('018653299524'));

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    const { record, matchedFields } = result;
    expect(record.matchedIdentifier).toBe('018653299524');
    expect(record.name).toBe('E-Z HANG SCALE');
    expect(record.brand).toBe('KERBL');
    expect(record.distributorSku).toBe('001135');
    expect(record.manufacturerPartNumber).toBe('099917');
    expect(record.weight).toBe('3.1 lb');
    expect(record.attributes.size).toBe('UP TO 55 LB');
    expect(record.attributes.packCount).toBe('6');
    expect(record.casePack).toBe('6');
    expect(record.unitOfMeasure).toBe('EA');
    expect(record.description).toMatch(/^For quick weight control, for economic forage control/);
    expect(record.ingredients).toMatch(/^nickel-plated/);
    expect(record.sourceUrl).toBe(PDP);
    expect(record.observedAt).toBe('2026-08-15T00:00:00.000Z');
    expect(matchedFields).toEqual(expect.arrayContaining(['matchedIdentifier', 'name', 'brand', 'distributorSku', 'manufacturerPartNumber', 'weight', 'size', 'packCount', 'casePack', 'unitOfMeasure', 'description', 'ingredients', 'sourceUrl']));
  });

  test('images are HTTPS display-only candidates on the BigCommerce asset host only', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('018653299524'));
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.record.imageUrls.length).toBeGreaterThan(0);
    for (const url of result.record.imageUrls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(new URL(url).hostname).toMatch(/bigcommerce\.com|bradleycaldwell\.com$/);
      expect(url).toMatch(/001135/); // product's own gallery images only — never recommendation cards
    }
  });

  test('public connector: requiresSecret=false and a null secret is ignored', async () => {
    const connector = new BradleyConnector({});
    expect(connector.connectorType).toBe('html_scraper');
    expect(connector.providerId).toBe('bradley');
    expect(connector.requiresSecret).toBe(false);
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    expect(result.outcome).toBe('found');
  });
});

describe('BradleyConnector — fail-closed outcomes', () => {
  test('explicit no-result page → not_stocked:no_exact_match (no browser fallback)', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('000000000000'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('no exact match');
    // The real (large) no-result page must NOT trigger the browser fallback.
    expect(calls.some((c) => c.browserRequired)).toBe(false);
  });

  test('valid page whose UPC differs from the lookup identifier → not_stocked:wrong_variant', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299520'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });

  test('tiny static shell triggers EXACTLY ONE browser fallback then source_error:unexpected_markup', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('999999999999'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
    const browserCalls = calls.filter((c) => c.browserRequired);
    expect(browserCalls.length).toBe(1); // exactly one browser fallback — never unbounded
  });

  test('transport failure on search → source_error with the stable code', async () => {
    const { fetchPage } = makeFetcher({ [SEARCH + '018653299524']: { ok: false, code: 'timeout', message: 'transport timed out' } });
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
  });

  test('pre-aborted signal → source_error:cancelled without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });

  test('no 8-14 digit identifier → source_error:no_identifier (001135 stays parser-only)', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('001135'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('no_identifier');
    expect(calls.length).toBe(0);
  });

  test('invalid connection configuration fails closed as config_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage });
    const result = await connector.lookupByGtin(
      makeRequest('018653299524', { connection: { id: 'c', distributorId: 'bradley', connectorType: 'html_scraper', configuration: { evilSelector: '#x' } } }),
    );
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('config_invalid');
  });

  test('no price/inventory/stock/pallet data ever enters the record', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    if (result.outcome !== 'found') throw new Error('expected found');
    const flat = JSON.stringify(result.record);
    for (const forbidden of ['price', 'inventory', 'stock', 'pallet', 'availability', 'FOB', 'Country']) {
      expect(flat.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(result.record.features).toEqual([]);
  });
});

describe('Bradley pure parsers (fixture-based)', () => {
  test('parseBradleySearchCandidates extracts only product-slug links', () => {
    const candidates = parseBradleySearchCandidates(FIXTURES['found-search.html']);
    expect(candidates).toEqual([PDP]);
  });

  test('no-result page yields zero candidates', () => {
    expect(parseBradleySearchCandidates(FIXTURES['not-found.html'])).toEqual([]);
  });

  test('parseBradleyPdp extracts the full recovered field map', () => {
    const pdp = parseBradleyPdp(FIXTURES['found-pdp.html']);
    expect(pdp.parsed).toBe(true);
    expect(pdp.upc).toBe('018653299524');
    expect(pdp.name).toBe('E-Z HANG SCALE');
    expect(pdp.brand).toBe('KERBL');
    expect(pdp.distributorSku).toBe('001135');
    expect(pdp.mpn).toBe('099917');
    expect(pdp.weight).toBe('3.1 lb');
    expect(pdp.size).toBe('UP TO 55 LB');
    expect(pdp.casePack).toBe('6');
    expect(pdp.unitOfMeasure).toBe('EA');
    expect(pdp.description).toMatch(/^For quick weight control/);
    expect(pdp.ingredients).toMatch(/^nickel-plated/);
    expect(pdp.images.length).toBeGreaterThan(0);
    expect(pdp.images.every((u) => /001135/.test(u))).toBe(true);
  });

  test('unexpected shell parses as not-a-PDP', () => {
    const pdp = parseBradleyPdp(FIXTURES['unexpected-markup.html']);
    expect(pdp.parsed).toBe(false);
  });
});
