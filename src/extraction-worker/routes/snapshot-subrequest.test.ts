/**
 * Round-5 P1-3: HTTP browser subrequests ride the pinned transport.
 *
 * fulfillPinnedSubrequest closes the DNS-rebinding TOCTOU for intercepted
 * http subrequests: the request is fetched through the validated IP literal
 * (Host header preserved) so Chromium never opens its own connection to the
 * destination. https requests are NOT pinnable (TLS SNI) and must return null
 * so the caller keeps route.continue() with the preflight checks.
 *
 * Bun test — the parent registers this file in package.json test:db.
 * (vitest does not discover files outside src/tests/, so no exclude needed.)
 */
import { describe, it, expect } from 'bun:test';
import { fulfillPinnedSubrequest } from './snapshot';

function fakeResponse(init: { status?: number; headers?: Record<string, string>; body?: string }): Response {
  const body = init.body ?? '';
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

describe('fulfillPinnedSubrequest', () => {
  it('fetches http subrequests through the pinned IP literal with Host + original method/headers/body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const spyFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return fakeResponse({
        headers: { 'content-type': 'application/json', 'content-length': '11' },
        body: '{"ok":true}',
      });
    };
    const resolveFn = async (hostname: string): Promise<string | null> => (hostname === 'api.example.com' ? '203.0.113.7' : null);

    const result = await fulfillPinnedSubrequest(
      {
        url: 'http://api.example.com/v1/product?id=1',
        method: 'POST',
        headers: { host: 'api.example.com', 'content-type': 'application/json', 'x-api-key': 'abc', 'content-length': '9' },
        body: Buffer.from('{"a":1}'),
      },
      { resolveFn, fetchFn: spyFetch, timeoutMs: 5000 },
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    // The connection goes to the validated address literal, not the hostname.
    expect(calls[0].url).toBe('http://203.0.113.7/v1/product?id=1');
    expect(calls[0].init?.method).toBe('POST');
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Host).toBe('api.example.com');
    // hop-by-hop headers are stripped; application headers survive.
    expect(headers?.['x-api-key']).toBe('abc');
    expect(headers?.['content-type']).toBe('application/json');
    expect(headers?.host).toBeUndefined();
    expect(headers?.['content-length']).toBeUndefined();
    // body forwarded as Uint8Array (clean BodyInit).
    expect(new TextDecoder().decode(calls[0].init?.body as Uint8Array)).toBe('{"a":1}');
    // fulfill shape: status + hop-by-hop-free response headers + body.
    expect(result?.status).toBe(200);
    expect(result?.headers['content-type']).toBe('application/json');
    expect(result?.headers['content-length']).toBeUndefined();
    expect(result?.body.toString('utf8')).toBe('{"ok":true}');
  });

  it('never pins https subrequests (TLS SNI residual) — returns null without fetching', async () => {
    let fetched = false;
    const spyFetch = async (): Promise<Response> => {
      fetched = true;
      return fakeResponse({});
    };
    const result = await fulfillPinnedSubrequest(
      { url: 'https://api.example.com/v1/product' },
      { resolveFn: async () => '203.0.113.7', fetchFn: spyFetch },
    );
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it('never pins IP-literal hosts — returns null (already address-bound)', async () => {
    let fetched = false;
    const result = await fulfillPinnedSubrequest(
      { url: 'http://203.0.113.7/v1/product' },
      { fetchFn: async () => { fetched = true; return fakeResponse({}); } },
    );
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it('fails closed when the hostname cannot be proven public — no fetch', async () => {
    let fetched = false;
    await expect(
      fulfillPinnedSubrequest(
        { url: 'http://internal.example.com/v1' },
        {
          resolveFn: async () => null, // NXDOMAIN / private / lookup failure
          fetchFn: async () => { fetched = true; return fakeResponse({}); },
        },
      ),
    ).rejects.toThrow(/cannot be proven public/);
    expect(fetched).toBe(false);
  });

  it('fails closed on redirect-denied destinations via resolveFn', async () => {
    let fetched = false;
    await expect(
      fulfillPinnedSubrequest(
        { url: 'http://shop.example.com/data.json' },
        {
          resolveFn: async (hostname) => (hostname === 'shop.example.com' ? null : null),
          fetchFn: async () => { fetched = true; return fakeResponse({}); },
        },
      ),
    ).rejects.toThrow(/cannot be proven public/);
    expect(fetched).toBe(false);
  });

  it('forwards GET without a body and preserves query strings for capture provenance', async () => {
    const calls: Array<{ url: string }> = [];
    const result = await fulfillPinnedSubrequest(
      { url: 'http://cdn.example.com/products.json?t=123', method: 'GET', headers: {} },
      {
        resolveFn: async () => '198.51.100.4',
        fetchFn: async (input: string | URL | Request) => {
          calls.push({ url: String(input) });
          return fakeResponse({ body: '[]' });
        },
      },
    );
    expect(calls[0].url).toBe('http://198.51.100.4/products.json?t=123');
    expect(result?.body.toString('utf8')).toBe('[]');
  });

  it('round-6 P1-4: caps the response stream — an oversized body rejects regardless of Content-Length', async () => {
    const spyFetch = async (): Promise<Response> => fakeResponse({ body: 'x'.repeat(5000) });
    await expect(
      fulfillPinnedSubrequest(
        { url: 'http://api.example.com/big.json' },
        {
          resolveFn: async () => '203.0.113.7',
          fetchFn: spyFetch,
          maxResponseBytes: 1000,
        },
      ),
    ).rejects.toThrow(/exceeds 1000 bytes/);
  });

  it('round-6 P1-4: a declared Content-Length over the cap rejects before streaming', async () => {
    const spyFetch = async (): Promise<Response> =>
      fakeResponse({ headers: { 'content-length': '99999' }, body: 'small' });
    await expect(
      fulfillPinnedSubrequest(
        { url: 'http://api.example.com/declared.json' },
        {
          resolveFn: async () => '203.0.113.7',
          fetchFn: spyFetch,
          maxResponseBytes: 1000,
        },
      ),
    ).rejects.toThrow(/declares 99999 bytes/);
  });

  it('round-6 P1-4: the per-snapshot aggregate budget aborts once cumulative bytes exceed the cap', async () => {
    const budget = { bytes: 0 };
    const spyFetch = async (): Promise<Response> => fakeResponse({ body: 'A'.repeat(1500) });
    const opts = {
      resolveFn: async () => '203.0.113.7',
      fetchFn: spyFetch,
      maxAggregateBytes: 2000,
    };
    const first = await fulfillPinnedSubrequest({ url: 'http://api.example.com/1.json' }, { ...opts, budget });
    expect(first).not.toBeNull();
    expect(budget.bytes).toBe(1500);
    // Second response would push the aggregate to 3000 > 2000 → rejected.
    await expect(fulfillPinnedSubrequest({ url: 'http://api.example.com/2.json' }, { ...opts, budget })).rejects.toThrow(
      /aggregate subrequest budget exceeded/,
    );
    expect(budget.bytes).toBe(1500); // unchanged after the rejection
  });

  it('round-6 P1-4: an oversized request body is denied before any fetch (spy never fires)', async () => {
    let fetched = false;
    await expect(
      fulfillPinnedSubrequest(
        { url: 'http://api.example.com/post', method: 'POST', body: Buffer.from('y'.repeat(2000)) },
        {
          resolveFn: async () => '203.0.113.7',
          fetchFn: async () => { fetched = true; return fakeResponse({}); },
          maxBodyBytes: 500,
        },
      ),
    ).rejects.toThrow(/subrequest body exceeds 500 bytes/);
    expect(fetched).toBe(false);
  });
});
