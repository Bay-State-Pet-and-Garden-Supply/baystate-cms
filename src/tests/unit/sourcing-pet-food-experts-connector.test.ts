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
