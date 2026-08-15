import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BCIConnector } from '../../onboarding/sourcing/connectors/bci';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';

const bciPage = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'bci-page.json'), 'utf8'),
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
      distributorId: 'bci',
      connectorType: 'api',
      configuration: {},
    },
    secret: 'client-id-1:client-secret-1',
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

interface CannedResponse {
  urlContains?: string;
  status?: number;
  body?: unknown;
  contentType?: string;
}

function fakeFetch(responses: CannedResponse[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  let index = 0;
  const impl = async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}),
    );
    calls.push({ url, headers, body: typeof init.body === 'string' ? init.body : undefined });
    const canned = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(canned.body !== undefined ? JSON.stringify(canned.body) : '{}', {
      status: canned.status ?? 200,
      headers: { 'content-type': canned.contentType ?? 'application/json' },
    });
  };
  return { impl, calls };
}

describe('BCI connector (OrderCloud)', () => {
  test('exact xp.UPC match returns found; token is cached and reused', async () => {
    const { impl, calls } = fakeFetch([
      { urlContains: '/oauth/token', body: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 } },
      { body: bciPage },
    ]);
    const connector = new BCIConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });

    const first = await connector.lookupByGtin(makeRequest());
    expect(first.outcome).toBe('found');
    if (first.outcome === 'found') {
      expect(first.record.matchedIdentifier).toBe('012345678905');
      expect(first.record.name).toBe('OrderCloud Fish Food Flakes 2 oz');
    }

    // Token request used form-encoded client credentials WITHOUT leaking the secret.
    const tokenCall = calls.find((c) => c.url.includes('/oauth/token'));
    expect(tokenCall).toBeTruthy();
    expect(tokenCall?.body).toContain('client_id=client-id-1');
    expect(tokenCall?.body).toContain('client_secret=client-secret-1');

    // Second lookup reuses the cached token (no second token call).
    const second = await connector.lookupByGtin(makeRequest());
    expect(second.outcome).toBe('found');
    const tokenCalls = calls.filter((c) => c.url.includes('/oauth/token'));
    expect(tokenCalls.length).toBe(1);
  });

  test('an HTTP 200 with the wrong xp.UPC is never found', async () => {
    const { impl } = fakeFetch([
      { urlContains: '/oauth/token', body: { access_token: 'tok-1', expires_in: 3600 } },
      { body: bciPage },
    ]);
    const connector = new BCIConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest({ upc: '999999999999' }));
    expect(result.outcome).toBe('not_stocked');
  });

  test('token failure becomes auth_failed WITHOUT the secret or body', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: 'invalid_grant', client_secret: 'client-secret-1' } },
    ]);
    const connector = new BCIConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'auth_failed' });
    const message = JSON.stringify(result);
    expect(message).not.toContain('client-secret-1');
    expect(message).not.toContain('invalid_grant');
  });

  test('malformed client-credentials secret fails closed', async () => {
    const connector = new BCIConnector();
    const result = await connector.lookupByGtin(makeRequest({ secret: 'no-colon-here' }));
    expect(result).toMatchObject({ outcome: 'source_error', code: 'secret_malformed' });
  });

  test('missing Items array fails closed as bad_json', async () => {
    const { impl } = fakeFetch([
      { urlContains: '/oauth/token', body: { access_token: 'tok-1', expires_in: 3600 } },
      { body: { Meta: { Page: 1 } } },
    ]);
    const connector = new BCIConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result).toMatchObject({ outcome: 'source_error', code: 'bad_json' });
  });

  test('brand-hint mismatch surfaces as a warning, not a failure', async () => {
    const { impl } = fakeFetch([
      { urlContains: '/oauth/token', body: { access_token: 'tok-1', expires_in: 3600 } },
      { body: bciPage },
    ]);
    const connector = new BCIConnector({ fetchImpl: impl as unknown as unknown as typeof fetch });
    const result = await connector.lookupByGtin(makeRequest({ brandHint: 'TotallyDifferentBrand' }));
    expect(result.outcome).toBe('found');
    if (result.outcome === 'found') {
      expect(result.warnings.some((w) => w.includes('advisory brand hint'))).toBe(true);
    }
  });
});
