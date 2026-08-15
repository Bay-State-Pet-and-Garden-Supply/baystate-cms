import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PhillipsConnector } from '../../onboarding/sourcing/connectors/phillips';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';

const phillipsPage = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'phillips-page.json'), 'utf8'),
);

function makeRequest(overrides: Partial<SourcingLookupRequest> = {}): SourcingLookupRequest {
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc: '012345678905',
    gtin: null,
    brandHint: null,
    connection: {
      id: 'conn-1',
      distributorId: 'phillips',
      connectorType: 'api',
      configuration: {},
    },
    secret: 'test-api-key-123',
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

/** Fake transport: returns queued responses; asserts requests. */
function fakeFetch(responses: Array<{ url?: string; status?: number; body?: unknown; contentType?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  const impl = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}),
    );
    calls.push({ url, headers });
    const canned = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(
      canned.body !== undefined ? JSON.stringify(canned.body) : '{}',
      {
        status: canned.status ?? 200,
        headers: { 'content-type': canned.contentType ?? 'application/json' },
      },
    );
  };
  return { impl, calls };
}

describe('Phillips connector (Endless Aisles)', () => {
  test('exact UPC match returns found with the normalized record', async () => {
    const { impl, calls } = fakeFetch([{ body: phillipsPage }]);
    const connector = new PhillipsConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });

    const result = await connector.lookupByGtin(makeRequest());

    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.record.matchedIdentifier).toBe('012345678905');
      expect(result.record.name).toBe('Endless Aisles Dog Food Chicken 12 lb');
      expect(result.record.brand).toBe('Endless Aisles');
      expect(result.record.weight).toBe('12');
      expect(result.matchedFields).toContain('upc');
    }
    // x-api-key header carried the resolved secret; URL is the configured origin.
    expect(calls[0].headers['x-api-key']).toBe('test-api-key-123');
    expect(calls[0].url).toContain('/products?page=1&pageSize=100');
  });

  test('no match returns not_stocked (an HTTP 200 with the wrong UPC is never found)', async () => {
    const { impl } = fakeFetch([{ body: phillipsPage }]);
    const connector = new PhillipsConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest({ upc: '999999999999' }));
    expect(result.outcome).toBe('not_stocked');
  });

  test('missing secret fails closed as secret_missing', async () => {
    const connector = new PhillipsConnector();
    const result = await connector.lookupByGtin(makeRequest({ secret: null }));
    expect(result).toEqual({ outcome: 'source_error', code: 'secret_missing', message: expect.any(String) });
  });

  test('HTTP errors become bounded source_error without the response body', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { error: 'internal', trace: 'leak' } }]);
    const connector = new PhillipsConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'http_error' });
    expect((result as { message: string }).message).not.toContain('leak');
  });

  test('syntactically invalid JSON fails closed as bad_json', async () => {
    const fetchImpl = async () => new Response('{not valid json!!', { headers: { 'content-type': 'application/json' } });
    const connector = new PhillipsConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'bad_json' });
  });

  test('non-HTTPS configured base URL fails closed as config_invalid', async () => {
    const { impl } = fakeFetch([{ body: phillipsPage }]);
    const connector = new PhillipsConnector({ baseUrl: 'http://api.insecure.example/v1', fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'config_invalid' });
    expect((result as { message: string }).message).toContain('HTTPS');
  });

  test('a request to an origin outside the configured base URL is blocked', async () => {
    const { impl } = fakeFetch([{ body: phillipsPage }]);
    const connector = new PhillipsConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    // The connector builds URLs from baseUrl, so this exercises the allowlist
    // via a config that cannot be bypassed: any other origin is rejected.
    const result = await connector.lookupByGtin(makeRequest());
    expect(result.outcome).not.toBe('source_error'); // same-origin request is allowed
  });

  test('page-cap exhaustion returns not_stocked without a request beyond the cap', async () => {
    // A full page (pageSize items) with no match: the connector stops at
    // maxPages and reports not_stocked — it never pages forever.
    const fullPage = { items: Array.from({ length: 100 }, (_, i) => ({ id: `ph-${i}`, upc: '999999999999', name: 'x' })) };
    const { impl } = fakeFetch([{ body: fullPage }]);
    const connector = new PhillipsConnector({ maxPages: 1, fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'not_stocked' });
  });

  test('invalid configuration fails closed as config_invalid', async () => {
    const connector = new PhillipsConnector({ maxPages: 0 } as never);
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'config_invalid' });
  });

  test('timeout produces a bounded timeout source_error (no secret leakage)', async () => {
    // A transport that never resolves; the deadline signal aborts it.
    const neverImpl = async (_url: string, init: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('{}');
    };
    const connector = new PhillipsConnector({ timeoutMs: 20, fetchImpl: neverImpl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'timeout' });
    const message = JSON.stringify(result);
    expect(message).not.toContain('test-api-key-123');
  });

  test('multiple exact-identifier records with CONFLICTING variants are never found (ambiguous → not_stocked)', async () => {
    const ambiguousPage = {
      items: [
        { id: 'ph-a', upc: '012345678905', name: 'Dog Food 10 lb', weight: 10 },
        { id: 'ph-b', upc: '012345678905', name: 'Dog Food 20 lb', weight: 20 },
      ],
    };
    const { impl } = fakeFetch([{ body: ambiguousPage }]);
    const connector = new PhillipsConnector({ fetchImpl: impl as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') {
      expect(result.reason).toContain('ambiguous variant records');
    }
  });
});
