/**
 * Snapshot route — POST /profile-tooling/snapshot
 *
 * Fetches a single page for Profile Builder diagnostics. Supports two runtimes:
 *
 *   - **static**:  Plain HTTP fetch + regex HTML extraction (no browser).
 *   - **rendered**: Headless Playwright Chromium with image/font/stylesheet
 *                   blocking, JS execution, and optional screenshot capture.
 *
 * All artifact files are written under:
 *   <cwd>/.shopsite-cms/artifacts/profile-builder/<domain>/<job-id>/
 *
 * The response always passes through SnapshotResponseSchema validation so the
 * caller receives a well-structured result even when warnings are present.
 * Errors are surfaced in the `warnings` array; uncaught exceptions return a
 * minimal SnapshotResponse with the error in warnings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import { SnapshotRequestSchema, SnapshotResponseSchema } from '../../shared/schemas/extraction-worker';
import type { SnapshotResponse } from '../../shared/schemas/extraction-worker';
import { resolveArtifactDir, writeArtifact, generateJobId, extractDomainFromUrl } from '../artifacts';

// ─── HTTP constants (sourced from page-extractor.ts) ──────────────────────────

const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HTTP_EXTRACTION_HEADERS: Record<string, string> = {
  'User-Agent': HTTP_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const HTTP_FETCH_TIMEOUT_MS = 15_000;
const RENDERED_TIMEOUT_MS = 25_000;
const RENDERED_DWELL_MS = 2_000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function findBalancedBrace(text: string, startIdx: number, maxChars = 800_000): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = startIdx; i < text.length && i < startIdx + maxChars; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Static HTML extraction helpers ──────────────────────────────────────────

function extractJsonLdFromHtml(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === 'object') results.push(item as Record<string, unknown>);
        }
      } else if (data && typeof data === 'object') {
        results.push(data as Record<string, unknown>);
      }
    } catch {
      // skip invalid JSON blocks
    }
  }
  return results;
}

function extractMetaTagsFromHtml(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const metaRegex = /<meta[\s\S]*?>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const getAttr = (name: string): string | null => {
      const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
      const m = tag.match(re);
      return m ? m[1] : null;
    };
    const property = getAttr('property') ?? getAttr('name');
    const content = getAttr('content');
    if (property && content) {
      tags[property] = content;
    }
  }

  // Also grab <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) {
    tags['page:title'] = titleMatch[1].trim();
  }

  return tags;
}

/**
 * Extract embedded Shopify product data objects from HTML using regex scanning.
 * Looks for patterns like:
 *   window.productJSON = { ... }
 *   var productJSON = { ... }
 *   window.ShopifyAnalytics = { ... }
 *   window.__INITIAL_STATE__ = { ... }
 */
function extractEmbeddedProductDataFromHtml(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const patterns = [
    { pattern: /window\.productJSON\s*=\s*/g, name: 'productJSON' },
    { pattern: /var\s+productJSON\s*=\s*/g, name: 'productJSON' },
    { pattern: /window\.ShopifyAnalytics\s*=\s*/g, name: 'ShopifyAnalytics' },
    { pattern: /window\.__INITIAL_STATE__\s*=\s*/g, name: '__INITIAL_STATE__' },
    { pattern: /let\s+meta\s*=\s*/g, name: 'meta' },
    { pattern: /var\s+meta\s*=\s*/g, name: 'meta' },
  ];

  for (const { pattern } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const assignEnd = match.index + match[0].length;
      const braceStart = html.indexOf('{', assignEnd);
      if (braceStart === -1) continue;
      const braceEnd = findBalancedBrace(html, braceStart);
      if (braceEnd === -1) continue;
      try {
        const raw = html.substring(braceStart, braceEnd + 1);
        let obj: unknown;
        try {
          obj = JSON.parse(raw);
        } catch {
          // Trailing commas are common in JS object literals but invalid in JSON.
          // Strip trailing commas before closing braces as a best-effort recovery.
          const cleaned = raw.replace(/,([ \t]*[\]}])/g, '$1');
          obj = JSON.parse(cleaned);
        }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          results.push(obj as Record<string, unknown>);
        }
      } catch {
        // skip unparseable blocks
      }
    }
  }

  return results;
}

function extractImageCandidatesFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  // Collect all <img> tags
  const imgRegex = /<img[\s\S]*?>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const getAttr = (name: string): string | null => {
      const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
      const m = tag.match(re);
      return m ? m[1] : null;
    };

    // Collect sources from multiple attributes
    const src = getAttr('src');
    const dataSrc = getAttr('data-src');
    const dataOriginal = getAttr('data-original');
    const srcset = getAttr('srcset');

    const rawSources = [src, dataSrc, dataOriginal];
    for (const raw of rawSources) {
      if (raw && isUsableImageSrc(raw) && !seen.has(raw)) {
        seen.add(raw);
        candidates.push(raw);
      }
    }

    // Parse srcset candidates
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url && isUsableImageSrc(url) && !seen.has(url)) {
          seen.add(url);
          candidates.push(url);
        }
      }
    }
  }

  return candidates;
}

function isUsableImageSrc(src: string): boolean {
  const trimmed = src.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return false;
  if (trimmed.startsWith('blob:')) return false;
  // Reject SVGs by extension
  const path = trimmed.split(/[?#]/)[0];
  if (path.endsWith('.svg')) return false;
  return true;
}

function extractPageStructureSignalsFromHtml(html: string): string[] {
  const signals: string[] = [];
  const lower = html.toLowerCase();

  // CSS class .product on any element
  if (/class\s*=\s*["'][^"']*\bproduct\b[^"']*["']/i.test(html)) {
    signals.push('css-class:product');
  }

  // data-product attribute
  if (/data-product\b/i.test(html)) signals.push('attr:data-product');

  // Shopify scripts
  if (/cdn\.shopify\.com/i.test(html)) signals.push('script:shopify');

  // JSON-LD Product type
  if (/"@type"\s*:\s*"Product"/i.test(html)) signals.push('jsonld:Product');

  // og:type = product
  if (/property\s*=\s*["']og:type["'][\s\S]*?content\s*=\s*["']product["']/i.test(html)) {
    signals.push('meta:og:type=product');
  }

  // Microdata Product scope
  if (/itemscope[\s\S]*?itemtype[\s\S]*?Product/i.test(html)) {
    signals.push('microdata:Product');
  }

  // Product price meta
  if (/product:price:amount/i.test(html)) signals.push('meta:product:price:amount');

  // Product brand meta
  if (/product:brand/i.test(html)) signals.push('meta:product:brand');

  // price selector presence
  if (/["']\.price["']|["']#price["']|class\s*=\s*["'][^"']*price[^"']*["']/i.test(html)) {
    signals.push('selector:price');
  }

  // add-to-cart form / button
  if (/add\-to\-cart|add_to_cart|data\-product\-id/i.test(html)) {
    signals.push('interaction:add-to-cart');
  }

  // Pinterest / rich-pin
  if (/pinterest/i.test(html)) signals.push('script:pinterest');

  return signals;
}

/**
 * Strip non-content tags from raw HTML to produce a minified page.
 * Removes: style, svg, noscript, header, footer, nav, script tags
 * and collapses whitespace.
 */
function stripNonContentTags(html: string): string {
  let result = html;
  // Remove comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  // Remove style blocks
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove svg blocks (including inner content)
  result = result.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // Remove noscript blocks
  result = result.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Remove header, footer, nav blocks
  result = result.replace(/<header[\s\S]*?<\/header>/gi, '');
  result = result.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  result = result.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  // Remove all script tags
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Collapse whitespace
  result = result.replace(/\s{2,}/g, ' ');
  result = result.replace(/>\s+</g, '><');
  return result.trim();
}

// ─── Rendered (Playwright) extraction helpers ─────────────────────────────────

// The evaluate callbacks are defined as string-wrapped functions to avoid
// tsx injecting `__name` runtime helpers that are unavailable in the
// Playwright browser evaluation context.

function makeJsonLdExtractor(): string {
  return `
    (() => {
      const results = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const raw = (script.textContent || '').trim();
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item && typeof item === 'object') results.push(item);
            }
          } else if (data && typeof data === 'object') {
            results.push(data);
          }
        } catch (e) {
          // skip
        }
      }
      return results;
    })()`;
}

async function extractJsonLdFromPage(
  page: import('playwright').Page,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(makeJsonLdExtractor());
}

function makeEmbeddedProductDataExtractor(): string {
  return `
    (() => {
      const results = [];
      const w = window;
      if (w.productJSON && typeof w.productJSON === 'object') results.push(w.productJSON);
      if (w.ShopifyAnalytics && typeof w.ShopifyAnalytics === 'object') results.push(w.ShopifyAnalytics);
      if (w.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') results.push(w.__INITIAL_STATE__);
      return results;
    })()`;
}

async function extractEmbeddedProductDataFromPage(
  page: import('playwright').Page,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(makeEmbeddedProductDataExtractor());
}

function makeImageCandidatesExtractor(): string {
  // Produces JavaScript source evaluated in the browser.
  // Using string split on space character instead of regex \\s+ to
  // avoid template-literal escaping issues with the backslash.
  return `
    (() => {
      const seen = new Set();
      const images = [];
      const imgEls = document.querySelectorAll('img');
      for (const img of imgEls) {
        const tryAdd = (src) => {
          if (!src) return;
          const t = src.trim();
          if (!t) return;
          const l = t.toLowerCase();
          if (l.startsWith('data:')) return;
          if (l.startsWith('blob:')) return;
          const p = l.split(/[?#]/)[0];
          if (p.endsWith('.svg')) return;
          if (seen.has(t)) return;
          seen.add(t);
          images.push(t);
        };
        tryAdd(img.getAttribute('src'));
        tryAdd(img.getAttribute('currentSrc'));
        tryAdd(img.getAttribute('data-src'));
        tryAdd(img.getAttribute('data-original'));
        tryAdd(img.getAttribute('data-lazy-src'));
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          for (const part of srcset.split(',')) {
            const url = part.trim().split(' ')[0];
            if (url && !url.startsWith('data:') && !seen.has(url)) {
              seen.add(url);
              images.push(url);
            }
          }
        }
      }
      return images;
    })()`;
}

async function extractImageCandidatesFromPage(
  page: import('playwright').Page,
  baseUrl: string,
): Promise<string[]> {
  const rawImages = await page.evaluate(makeImageCandidatesExtractor()) as string[];

  // Resolve relative URLs to absolute
  return rawImages.map((src: string) => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}

function makePageStructureSignalsExtractor(): string {
  return `
    (() => {
      const signals = [];
      if (document.querySelector('.product')) signals.push('css-class:product');
      if (document.querySelector('[data-product]')) signals.push('attr:data-product');
      const scripts = document.querySelectorAll('script[src]');
      for (const s of scripts) {
        if ((s.src || '').includes('cdn.shopify.com')) {
          signals.push('script:shopify');
          break;
        }
      }
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          const data = JSON.parse(s.textContent || '{}');
          const hasProduct = (obj) => {
            if (obj && typeof obj === 'object') {
              if (obj['@type'] === 'Product') return true;
              if (Array.isArray(obj['@graph']) && obj['@graph'].some(hasProduct)) return true;
            }
            return false;
          };
          if (hasProduct(data)) {
            signals.push('jsonld:Product');
            break;
          }
        } catch (e) {}
      }
      const ogType = document.querySelector('meta[property="og:type"]');
      if (ogType && ogType.getAttribute('content') === 'product') signals.push('meta:og:type=product');
      if (document.querySelector('[itemscope][itemtype*="Product"]')) signals.push('microdata:Product');
      if (document.querySelector('meta[property="product:price:amount"]')) signals.push('meta:product:price:amount');
      if (document.querySelector('meta[property="product:brand"]')) signals.push('meta:product:brand');
      if (document.querySelector('.price, #price, [class*="price"]')) signals.push('selector:price');
      if (document.querySelector('[data-product-id], .add-to-cart, .add_to_cart, [class*="add-to-cart"], [class*="add_to_cart"]')) signals.push('interaction:add-to-cart');
      const allS = document.querySelectorAll('script');
      for (const s of allS) {
        if ((s.src || '').includes('pinterest')) {
          signals.push('script:pinterest');
          break;
        }
      }
      return signals;
    })()`;
}

async function extractPageStructureSignalsFromPage(
  page: import('playwright').Page,
): Promise<string[]> {
  return page.evaluate(makePageStructureSignalsExtractor());
}

// ─── Snapshot execution ────────────────────────────────────────────────────────

async function doStaticSnapshot(
  url: string,
  captureScreenshot: boolean,
  domain: string,
  jobId: string,
): Promise<SnapshotResponse> {
  const warnings: string[] = [];
  const artifactDir = resolveArtifactDir(domain, jobId);


  // Fetch
  let response: Response;
  let html: string;
  try {
    response = await fetch(url, {
      headers: HTTP_EXTRACTION_HEADERS,
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) {
      warnings.push(`HTTP fetch returned ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Static fetch failed: ${msg}`);
    return buildSnapshotResponse({
      url,
      finalUrl: url,
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings,
    });
  }

  const finalUrl = response.url || url;

  // Write raw HTML artifact
  const htmlRef = writeArtifact(artifactDir, 'page.html', html);

  // Extraction phases
  const jsonLd = extractJsonLdFromHtml(html);
  const metaTags = extractMetaTagsFromHtml(html);
  const embeddedProductData = extractEmbeddedProductDataFromHtml(html);

  // Resolve image URLs against base
  const baseUrl = finalUrl;
  const rawImageCandidates = extractImageCandidatesFromHtml(html);
  const imageCandidates = rawImageCandidates.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));

  const pageStructureSignals = extractPageStructureSignalsFromHtml(html);

  // Build minified HTML artifact
  const minified = stripNonContentTags(html);
  writeArtifact(artifactDir, 'page.min.html', minified);

  // Static mode cannot capture screenshots or network
  let screenshotRef: string | null = null;
  if (captureScreenshot) {
    warnings.push('Screenshot capture requires rendered runtime, skipping');
  }

  return buildSnapshotResponse({
    url,
    finalUrl,
    htmlRef,
    screenshotRef,
    jsonLd,
    embeddedProductData,
    imageCandidates,
    pageStructureSignals,
    warnings,
  });
}

async function doRenderedSnapshot(
  url: string,
  captureScreenshot: boolean,
  domain: string,
  jobId: string,
): Promise<SnapshotResponse> {
  const warnings: string[] = [];
  const artifactDir = resolveArtifactDir(domain, jobId);


  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to launch Playwright: ${msg}`);
    return buildSnapshotResponse({
      url,
      finalUrl: url,
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings,
    });
  }

  let finalUrl = url;
  let htmlRef: string | null = null;
  let screenshotRef: string | null = null;
  let jsonLd: Record<string, unknown>[] = [];
  let embeddedProductData: Record<string, unknown>[] = [];
  let imageCandidates: string[] = [];
  let pageStructureSignals: string[] = [];

  try {
    const context = await browser.newContext({
      userAgent: HTTP_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Block resource types
    const blockPatterns = [
      'image', 'font', 'stylesheet', 'media',
    ];
    await page.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const reqUrl = req.url();
      const isTracker =
        /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(reqUrl);

      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet' || isTracker) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // Navigate
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: RENDERED_TIMEOUT_MS,
      });
      finalUrl = page.url();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Navigation failed: ${msg}`);
    }

    // Dwell for dynamic content
    await page.waitForTimeout(RENDERED_DWELL_MS);

    // Capture full-page HTML
    try {
      const html = await page.content();
      htmlRef = writeArtifact(artifactDir, 'page.html', html);

      // Write minified HTML
      const minified = stripNonContentTags(html);
      writeArtifact(artifactDir, 'page.min.html', minified);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to capture page HTML: ${msg}`);
    }

    // Capture screenshot
    if (captureScreenshot) {
      try {
        const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
        screenshotRef = writeArtifact(artifactDir, 'screenshot.png', screenshotBuffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Screenshot capture failed: ${msg}`);
      }
    }

    // Extraction phases — all via page.evaluate
    try {
      jsonLd = await extractJsonLdFromPage(page);
    } catch (err) {
      warnings.push(`JSON-LD extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      embeddedProductData = await extractEmbeddedProductDataFromPage(page);
    } catch (err) {
      warnings.push(`Embedded product data extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      imageCandidates = await extractImageCandidatesFromPage(page, finalUrl);
    } catch (err) {
      warnings.push(`Image candidate extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      pageStructureSignals = await extractPageStructureSignalsFromPage(page);
    } catch (err) {
      warnings.push(`Page structure signal extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Rendered snapshot error: ${msg}`);
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore close errors
    }
  }

  return buildSnapshotResponse({
    url,
    finalUrl,
    htmlRef,
    screenshotRef,
    jsonLd,
    embeddedProductData,
    imageCandidates,
    pageStructureSignals,
    warnings,
  });
}

// ─── Response builder ──────────────────────────────────────────────────────────

interface SnapshotInput {
  url: string;
  finalUrl: string;
  htmlRef: string | null;
  screenshotRef: string | null;
  jsonLd: Record<string, unknown>[];
  embeddedProductData: Record<string, unknown>[];
  imageCandidates: string[];
  pageStructureSignals: string[];
  warnings: string[];
}

function buildSnapshotResponse(input: SnapshotInput): SnapshotResponse {
  // Deduplicate warnings
  const warnings = [...new Set(input.warnings)];

  // Parse through Zod to ensure schema compliance
  const parsed = SnapshotResponseSchema.parse({
    url: input.url,
    finalUrl: input.finalUrl,
    htmlRef: input.htmlRef,
    screenshotRef: input.screenshotRef,
    jsonLd: input.jsonLd,
    embeddedProductData: input.embeddedProductData,
    imageCandidates: input.imageCandidates,
    pageStructureSignals: input.pageStructureSignals,
    warnings,
  });

  return parsed;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /profile-tooling/snapshot
 *
 * Parses the JSON body, dispatches to the appropriate runtime, and
 * responds with a validated SnapshotResponse.
 */
export function handleSnapshot(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = SnapshotRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map(p => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data;
      const domain = extractDomainFromUrl(request.url);
      const jobId = generateJobId();

      let result: SnapshotResponse;

      if (request.runtime === 'static') {
        result = await doStaticSnapshot(
          request.url,
          request.captureScreenshot,
          domain,
          jobId,
        );
      } else {
        result = await doRenderedSnapshot(
          request.url,
          request.captureScreenshot,
          domain,
          jobId,
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
    
      // Build a minimal valid response
      const fallback = SnapshotResponseSchema.parse({
        url: '',
        finalUrl: '',
        htmlRef: null,
        screenshotRef: null,
        jsonLd: [],
        embeddedProductData: [],
        imageCandidates: [],
        pageStructureSignals: [],
        warnings: [`Internal error: ${msg}`],
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });

  req.on('error', (err: Error) => {
    const fallback = SnapshotResponseSchema.parse({
      url: '',
      finalUrl: '',
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings: [`Request error: ${err.message}`],
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
  });
}
