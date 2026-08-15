import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PhillipsStorefrontConnector, parsePhillipsStorefrontPdp, parsePhillipsSearchRows } from '../../onboarding/sourcing/connectors/phillips-storefront';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'phillips_storefront');
const FIXTURES: Record<string, string> = {};
for (const name of [
  'found-search.html', 'found-pdp.html', 'not-found.html', 'wrong-variant-pdp.html',
  'auth-required.html', 'auth-required-alt.html', 'auth-failed.html', 'unexpected-markup.html',
]) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://shop.phillipspet.com/ccrz__ProductList?cartID=&operation=quickSearch&searchText=';
const PDP = 'https://shop.phillipspet.com/ccrz__ProductDetails?sku=FROMM-GOLD-30';
const PDP_OTHER = 'https://shop.phillipspet.com/ccrz__ProductDetails?sku=FROMM-GOLD-30B';

function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    void opts;
    calls.push({ url });
    // Match overrides by prefix (the connector appends the full quickSearch tail).
    const hit = Object.entries(overrides).find(([key]) => url.startsWith(key))?.[1];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '072705115310')) return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
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
    connection: { id: 'conn-phillips-store', distributorId: 'phillips_storefront', connectorType: 'html_scraper', configuration: {} },
    secret: VALID_SECRET,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('PhillipsStorefrontConnector — found (exact UPC match, authenticated)', () => {
  test('returns a merchandising-depth record with exact identity and its own providerId', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    expect(connector.providerId).toBe('phillips_storefront'); // never 'phillips'
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('072705115310');
    expect(result.record.name).toBe('Fromm Gold Large Breed Dog 30 lb');
    expect(result.record.brand).toBe('FROMM FAMILY FOODS LLC');
    expect(result.record.distributorSku).toBe('FROMM-GOLD-30');
    expect(result.record.weight).toBe('30 lb');
    expect(result.record.dimensions).toBe('24 x 16 x 6 in');
    expect(result.record.description).toContain('Fromm Gold Large Breed Adult');
    expect(result.record.features).toContain('Large breed formula');
    expect(result.record.category).toBe('Fromm Gold');
    expect(result.record.imageUrls).toContain('https://d56ygyjv466yj.cloudfront.net/img/fromm-gold-30.jpg');
    expect(result.record.sourceUrl).toBe(PDP);
    expect(result.matchedFields).toEqual(expect.arrayContaining(['matchedIdentifier', 'name', 'brand', 'distributorSku', 'weight', 'dimensions', 'description', 'features', 'category', 'imageUrls', 'sourceUrl']));
    expect(JSON.stringify(result.record)).not.toMatch(/inStock|availability|price/i);
  });

  test('record never leaks credentials or raw HTML', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('found');
    const json = JSON.stringify(result);
    expect(json).not.toContain('ops-user');
    expect(json).not.toContain('s3cret-pass');
    expect(json).not.toMatch(/<!DOCTYPE/i);
  });
});

describe('PhillipsStorefrontConnector — not found and wrong variant fail closed', () => {
  test('explicit no-result page → not_stocked:no_exact_match', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('000000000000'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('no exact match');
  });

  test('PDP with a different UPC → not_stocked:wrong_variant despite identical name/brand (no heuristic rescue)', async () => {
    const { fetchPage } = makeFetcher({
      [PDP]: { ok: true, html: FIXTURES['wrong-variant-pdp.html'], finalUrl: PDP },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });
});

describe('PhillipsStorefrontConnector — auth and transport failures are bounded', () => {
  test('missing secret fails closed before any transport', async () => {
    const { fetchPage, calls } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310', { secret: null }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('secret_missing');
    expect(calls.length).toBe(0);
  });

  test('malformed credential JSON → credential_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310', { secret: '{"user' }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('credential_invalid');
  });

  test('search returning the real SFCC login page → auth_required (raw-string marker detection)', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '072705115310']: { ok: true, html: FIXTURES['auth-required.html'], finalUrl: SEARCH + '072705115310' },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('unauthenticated quickSearch shell → auth_required', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '072705115310']: { ok: true, html: FIXTURES['auth-required-alt.html'], finalUrl: SEARCH + '072705115310' },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('auth failure indicator → auth_required (fail closed)', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '072705115310']: { ok: true, html: FIXTURES['auth-failed.html'], finalUrl: SEARCH + '072705115310' },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('unrecognized search markup → source_error:unexpected_markup', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '072705115310']: { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: SEARCH + '072705115310' },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
  });

  test('transport failure on search propagates its stable code', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '072705115310']: { ok: false, code: 'body_too_large', message: 'over cap' },
    });
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('body_too_large');
  });

  test('pre-aborted request starts no transport', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });
});

describe('PhillipsStorefrontConnector — parser units and search-row preference', () => {
  test('search rows parse exact-UPC candidates and are origin-constrained', () => {
    const rows = parsePhillipsSearchRows(FIXTURES['found-search.html']);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].upc).toBe('072705115310');
    expect(rows[0].url).toBe(PDP);
    expect(rows[0].name).toContain('Fromm Gold');
  });

  test('PDP parser extracts the recovered field map', () => {
    const p = parsePhillipsStorefrontPdp(FIXTURES['found-pdp.html']);
    expect(p.name).toBe('Fromm Gold Large Breed Dog 30 lb');
    expect(p.brand).toBe('FROMM FAMILY FOODS LLC');
    expect(p.upc).toBe('072705115310');
    expect(p.distributorSku).toBe('FROMM-GOLD-30');
    expect(p.weight).toBe('30 lb');
    expect(p.dimensions).toBe('24 x 16 x 6 in');
    expect(p.parsed).toBe(true);
  });

  test('exact-UPC search rows are followed first even when other rows exist', async () => {
    const { fetchPage, calls } = makeFetcher();
    const connector = new PhillipsStorefrontConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('072705115310'));
    expect(result.outcome).toBe('found');
    expect(calls.map((c) => c.url)).toContain(PDP);
  });
});
