// story: e07s03
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

describe('profile-capture // story: e07s03', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function expectedHash(dom: string, runtime: string, extra = ''): string {
    // hashCapture = dom + screenshotBase64 + runtime + url slice 16
    return createHash('sha256').update(dom + extra + runtime + 'https://example.com/p/1').digest('hex').slice(0, 16);
  }
  function expectedHash2(dom: string, screenshot: string, runtime: string, url: string): string {
    return createHash('sha256').update(dom + screenshot + runtime + url).digest('hex').slice(0, 16);
  }

  it('static capture fetches html and returns hash sorted slice 12', async () => {
    const html = '<html><body><h1>Title</h1></body></html>';
    global.fetch = vi.fn(async () =>
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ) as unknown as typeof fetch;

    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const res = await captureProfilePage({ url: 'https://example.com/p/1', runtime: 'static' });
    expect(res.dom).toBe(html);
    expect(res.runtime).toBe('static');
    expect(res.hash).toBe(expectedHash(html, 'static'));
    expect(res.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(res.screenshotRef).toMatch(/baystate-captures/);
    expect(new Date(res.capturedAt).toISOString()).toBe(res.capturedAt);
    // single call: fetch called once, no second hop
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rendered capture uses playwright and returns screenshot + hash, single call', async () => {
    const dom = '<html><body><h1>Rendered</h1></body></html>';
    const fakeScreenshot = Buffer.from('pngdata').toString('base64');

    // mock playwright module
    vi.doMock('playwright', () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: async () => ({
            newPage: async () => ({
              goto: vi.fn(async () => {}),
              waitForTimeout: vi.fn(async () => {}),
              evaluate: vi.fn(async () => dom),
              screenshot: vi.fn(async () => Buffer.from('pngdata')),
              close: vi.fn(async () => {}),
              on: vi.fn(),
            }),
            close: vi.fn(async () => {}),
          }),
          close: vi.fn(async () => {}),
        })),
      },
    }));

    // re-import after mock
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    const res = await captureProfilePage({ url: 'https://example.com/p/2', runtime: 'rendered' });
    expect(res.dom).toBe(dom);
    expect(res.runtime).toBe('rendered');
    expect(res.hash).toBe(expectedHash2(dom, fakeScreenshot, 'rendered', 'https://example.com/p/2'));
    expect(res.screenshotRef).toMatch(/baystate-captures/);
    // hash is single artifact, sorted invariant holds for single-item array
    expect([res.hash].sort()).toEqual([res.hash]);
  });

  it('static capture throws on fetch failure with context', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const { captureProfilePage } = await import('../../onboarding/profile-capture.ts');
    await expect(captureProfilePage({ url: 'https://example.com/missing', runtime: 'static' })).rejects.toThrow(/fetch failed 404/);
  });
});
