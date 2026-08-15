import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrgillConnector, parseOrgillPdp, parseOrgillSearchCandidates } from '../../onboarding/sourcing/connectors/orgill';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'orgill');
const FIXTURES: Record<string, string> = {};
for (const name of [
  'found-search.html', 'found-pdp.html', 'not-found.html', 'wrong-variant-pdp.html',
  'auth-required.html', 'auth-required-alt.html', 'auth-failed.html', 'unexpected-markup.html',
]) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=';
const PDP = 'https://www.orgill.com/ProductDetail.aspx?itemNumber=204711';

/** Deterministic fake fetcher: URL → fixture. Records every call for assertions. */
function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string; browserRequired?: boolean }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    calls.push({ url, browserRequired: opts.browserRequired });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '755625321923')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '755625321924')) {
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
    connection: { id: 'conn-orgill', distributorId: 'orgill', connectorType: 'html_scraper', configuration: {} },
    secret: VALID_SECRET,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('OrgillConnector — found (exact UPC match, authenticated)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new OrgillConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('755625321923');
    expect(result.record.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(result.record.brand).toBe('LANDSCAPERS SELECT');
    expect(result.record.distributorSku).toBe('204711');
    expect(result.record.manufacturerPartNumber).toBe('34609');
    expect(result.record.weight).toBe('20 lb');
    expect(result.record.dimensions).toBe('45 in L');
    expect(result.record.casePack).toBe('4');
    expect(result.record.attributes.packCount).toBe('4');
    expect(result.record.unitOfMeasure).toBe('EA');
    expect(result.record.description).toMatch(/^Professional-grade shovel/);
    expect(result.record.category).toBe('Lawn & Garden');
    expect(result.record.features).toEqual(['16 gauge steel blade', 'Hardwood handle']);
    expect(result.record.sourceUrl).toBe(PDP);
    expect(result.record.observedAt).toBe('2026-08-15T00:00:00.000Z');
    // Forbidden fields are absent.
    expect(result.record).not.toHaveProperty('price');
    expect(result.record).not.toHaveProperty('inventory');
    expect(result.record).not.toHaveProperty('material');
    expect(result.record).not.toHaveProperty('npkRatio');
    expect(result.matchedFields).toContain('matchedIdentifier');
    expect(result.matchedFields).toContain('name');
    expect(result.matchedFields).toContain('casePack');
  });

  test('images are HTTPS display-only candidates on the orgill host only', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.imageUrls.length).toBeGreaterThan(0);
    for (const u of result.record.imageUrls) {
      expect(u.startsWith('https://')).toBe(true);
      expect(new URL(u).hostname.endsWith('orgill.com')).toBe(true);
    }
  });

  test('providerId is orgill and requiresSecret is true', async () => {
    const connector = new OrgillConnector({ fetchPage: async () => ({ ok: false, code: 'unexpected', message: 'x' }) });
    expect(connector.providerId).toBe('orgill');
    expect(connector.connectorType).toBe('html_scraper');
    expect(connector.requiresSecret).toBe(true);
  });
});

describe('OrgillConnector — fail-closed outcomes', () => {
  test('explicit no-result page → not_stocked:no_exact_match', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('000000000000'));
    expect(result).toEqual({ outcome: 'not_stocked', reason: expect.stringContaining('no exact match') });
    expect(calls.map((c) => c.url)).toEqual([SEARCH + '000000000000']);
  });

  test('valid page whose UPC differs from the lookup identifier → not_stocked:wrong_variant', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321924'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });

  test('search returns the login form → source_error:auth_required', async () => {
    const { fetchPage, calls } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['auth-required.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
    expect(calls.length).toBe(1);
  });

  test('login-redirect interstitial (auth-required-alt) → source_error:auth_required', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['auth-required-alt.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('runner-level auth failure → source_error:auth_failed (durable code)', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'auth_failed', message: 'login could not establish an authenticated session' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_failed');
  });

  test('runner-level expired session after re-login → source_error:auth_expired', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'auth_expired', message: 'session re-authentication failed' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_expired');
  });

  test('transport failure on search → source_error with the stable code', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'timeout', message: 'transport timed out' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
  });

  test('missing secret → source_error:secret_missing without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { secret: null }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('secret_missing');
    expect(calls.length).toBe(0);
  });

  test('malformed credential JSON → source_error:credential_invalid without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { secret: '{"username":"u"}' }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('credential_invalid');
    expect(calls.length).toBe(0);
  });

  test('pre-aborted signal → source_error:cancelled without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });

  test('expired deadline → source_error:timeout without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(
      makeRequest('755625321923', { deadlineAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
    expect(calls.length).toBe(0);
  });

  test('no 8-14 digit identifier → source_error:no_identifier', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('001135'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('no_identifier');
    expect(calls.length).toBe(0);
  });

  test('invalid connection configuration fails closed as config_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new OrgillConnector({ fetchPage });
    const request = makeRequest('755625321923');
    request.connection = { ...request.connection, configuration: { loginUrl: 'https://evil.example.com' } };
    const result = await connector.lookupByGtin(request);
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('config_invalid');
  });

  test('PDP fetch transport error maps to bounded source_error', async () => {
    const { fetchPage } = makeFetcher({
      [PDP]: { ok: false, code: 'origin_blocked', message: 'final URL left the provider origin' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('origin_blocked');
  });

  test('unrecognized markup → source_error:unexpected_markup', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
  });
});

describe('OrgillConnector — pure parser units', () => {
  test('parseOrgillSearchCandidates: only same-origin ProductDetail links, deduped, capped', () => {
    const urls = parseOrgillSearchCandidates(FIXTURES['found-search.html']);
    expect(urls).toEqual([PDP]);
    expect(parseOrgillSearchCandidates(FIXTURES['not-found.html'])).toEqual([]);
  });

  test('parseOrgillPdp: exact field extraction with fallbacks and forbidden fields absent', () => {
    const p = parseOrgillPdp(FIXTURES['found-pdp.html']);
    expect(p.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(p.brand).toBe('LANDSCAPERS SELECT');
    expect(p.upc).toBe('755625321923');
    expect(p.distributorSku).toBe('204711');
    expect(p.mpn).toBe('34609');
    expect(p.weight).toBe('20 lb');
    expect(p.dimensions).toBe('45 in L');
    expect(p.casePack).toBe('4');
    expect(p.unitOfMeasure).toBe('EA');
    expect(p.category).toBe('Lawn & Garden');
    expect(p.features).toEqual(['16 gauge steel blade', 'Hardwood handle']);
    expect(p.description).toMatch(/^Professional-grade shovel/);
    expect(p.images[0]).toBe('https://www.orgill.com/images/products/204711.jpg');
    expect(p.parsed).toBe(true);
  });

  test('parseOrgillPdp: wrong-variant page parses but carries a different UPC', () => {
    const p = parseOrgillPdp(FIXTURES['wrong-variant-pdp.html']);
    expect(p.upc).toBe('755625321924');
    expect(p.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(p.parsed).toBe(true);
  });

  test('parseOrgillPdp: login form and unexpected markup are not parsed as PDPs', () => {
    expect(parseOrgillPdp(FIXTURES['auth-required.html']).parsed).toBe(false);
    expect(parseOrgillPdp(FIXTURES['unexpected-markup.html']).parsed).toBe(false);
  });
});
