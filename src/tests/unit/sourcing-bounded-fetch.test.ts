import { describe, test, expect } from 'vitest';
import { boundedFetchJson, SourcingHttpError } from '../../onboarding/sourcing/bounded-fetch';

const ORIGIN = 'https://api.example.com';

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

describe('boundedFetchJson (ADR 0014 network bounds)', () => {
  test('blocks non-HTTPS URLs', async () => {
    await expect(
      boundedFetchJson('http://api.example.com/x', ORIGIN, {}),
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  test('blocks requests to origins outside the configured base URL', async () => {
    await expect(
      boundedFetchJson('https://evil.example.com/x', ORIGIN, {}),
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  test('never follows redirects (redirect_blocked)', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } });
    await expect(
      boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'redirect_blocked' });
  });

  test('rejects non-JSON content types', async () => {
    const fetchImpl = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
    await expect(
      boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'bad_content_type' });
  });

  test('enforces the streaming body cap without allocating the full body', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(10_000) });
    const fetchImpl = async () => new Response(big, { headers: { 'content-type': 'application/json' } });
    await expect(
      boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'body_too_large' });
  });

  test('caller cancellation yields cancelled (not timeout)', async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url: string, init: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return new Response('{}');
    };
    const promise = boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal });
    // Let the fetch start, then cancel from the caller side.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  test('deadline expiry yields timeout', async () => {
    const fetchImpl = async (_url: string, init: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      return new Response('{}');
    };
    await expect(
      boundedFetchJson(
        `${ORIGIN}/x`,
        ORIGIN,
        {},
        { fetchImpl: fetchImpl as unknown as typeof fetch, deadlineAt: new Date(Date.now() + 10).toISOString() },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  test('an already-expired deadline fails fast as timeout', async () => {
    await expect(
      boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { deadlineAt: new Date(Date.now() - 1000).toISOString() }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  test('parses JSON and returns the parsed value', async () => {
    const fetchImpl = async () => jsonResponse({ items: [{ upc: '012345678905' }] });
    const data = await boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(data).toEqual({ items: [{ upc: '012345678905' }] });
  });

  test('syntactically invalid JSON yields bad_json', async () => {
    const fetchImpl = async () => new Response('{not json!!', { headers: { 'content-type': 'application/json' } });
    await expect(
      boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'bad_json' });
  });

  test('errors carry stable non-secret codes (SourcingHttpError)', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } });
    try {
      await boundedFetchJson(`${ORIGIN}/x`, ORIGIN, {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SourcingHttpError);
      expect((e as SourcingHttpError).code).toBe('http_error');
      expect((e as Error).message).not.toContain('nope');
    }
  });
});
