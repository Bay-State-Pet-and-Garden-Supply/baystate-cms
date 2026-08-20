// story: e07s03
import { createHash } from 'node:crypto';

export interface CaptureResult {
  dom: string;
  screenshotBase64: string;
  runtime: string;
  hash: string;
  capturedAt: string;
}

function hashDom(dom: string, runtime: string): string {
  return createHash('sha256').update(dom + runtime).digest('hex').slice(0, 12);
}

export async function captureProfilePage(input: {
  url: string;
  runtime: 'static' | 'rendered';
}): Promise<CaptureResult> {
  const runtime = input.runtime;
  if (runtime === 'static') return captureStatic(input.url);
  return captureRendered(input.url);
}

async function captureStatic(url: string): Promise<CaptureResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'BaystateCMS-capture/1.0' },
    });
    if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
    const dom = await res.text();
    return {
      dom,
      screenshotBase64: '',
      runtime: 'static',
      hash: hashDom(dom, 'static'),
      capturedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function captureRendered(url: string): Promise<CaptureResult> {
  let browser: any = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    const screenshotBase64 = await page.screenshot({ type: 'png' }).then((buf: Buffer) => buf.toString('base64'));
    await context.close();
    return {
      dom,
      screenshotBase64,
      runtime: 'rendered',
      hash: hashDom(dom, 'rendered'),
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      if (browser) await browser.close();
    } catch {}
    // fallback to static on playwright failure, log warning
    console.warn(`[profile-capture] rendered capture failed for ${url}: ${msg}, falling back to static`);
    return captureStatic(url);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
}
