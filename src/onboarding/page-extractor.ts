/**
 * Page extractor using Playwright directly.
 * Extracts structured product data from manufacturer product pages
 * using a layered approach: Custom CSS selectors → JSON-LD → meta tags → microdata → HTML heuristics.
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { extractProductJsonFromHtml } from './shopify-json';
import type { ExtractionData } from '../shared/schemas/onboarding';
import { findProfileByDomain, type ExtractorProfile } from '../db/repositories/extractor-profile-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { recordDomainStatus } from '../db/repositories/domain-status-repo';
import { validateExtraction, type ValidationResult } from './extraction-validator';
import {
  addImageSource,
  canonicalizeUrl,
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from './image-utils';


interface RawExtraction {
  custom: Record<string, string | string[]> | null;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  htmlHeuristics: Record<string, string | string[]>;
  images: string[];
  networkProducts: Record<string, unknown>[];
  productJSON?: Record<string, any> | null;
}

/** Standard browser User-Agent used for HTTP and Playwright fetches. */
const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Standard headers used for HTTP extraction. Exported for multi-sample validation. */
export const HTTP_EXTRACTION_HEADERS: Record<string, string> = {
  'User-Agent': HTTP_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

/** Timeout (ms) for HTTP fetches. */
const HTTP_FETCH_TIMEOUT_MS = 15000;

/** Detailed result returned by the HTTP extraction path. */
export interface HttpExtractionDetailed {
  /** The merged, layered extraction result. */
  data: ExtractionData;
  /** Raw HTML fetched from the URL. */
  html: string;
  /** The raw, per-layer extraction payloads (custom/jsonLd/metaTags/...). */
  raw: RawExtraction;
  /**
   * True if the custom selector layer produced any non-empty value for the
   * known product fields. Used by the profile-generation trigger to detect
   * "stale" profiles that should be regenerated.
   */
  customHadAnyValue: boolean;
}

/**
 * Return `true` if a custom-selector extraction produced at least one
 * non-empty value across the known product fields.
 */
function customSelectorsHadAnyValue(
  custom: Record<string, string | string[]> | null,
): boolean {
  if (!custom) return false;
  for (const value of Object.values(custom)) {
    if (Array.isArray(value)) {
      if (value.length > 0) return true;
    } else if (typeof value === 'string' && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Fast-path HTTP extraction using Cheerio. Fetches the page markup and
 * extracts structured data without launching a browser. Returns the
 * detailed diagnostics needed by the profile-generation trigger.
 */
// fallow-ignore-next-line unused-export
export async function extractViaHttpDetailed(
  url: string,
  profile?: ExtractorProfile | null,
  expected?: { name?: string; brandHint?: string | null; price?: string | null },
): Promise<HttpExtractionDetailed> {
  const response = await fetch(url, {
    headers: HTTP_EXTRACTION_HEADERS,
    signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP fetch failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Layer 0: Custom CSS Selectors
  let custom: Record<string, string | string[]> | null = null;
  if (profile) {
    custom = extractCustomSelectorsCheerio($, profile);
  }

  // Layer 1: JSON-LD
  const jsonLd = extractJsonLdCheerio($);

  // Layer 2: Meta Tags
  const metaTags = extractMetaTagsCheerio($);

  // Layer 3: Microdata
  const microdata = extractMicrodataCheerio($);

  // Layer 4: HTML Heuristics
  const htmlHeuristics = extractHtmlHeuristicsCheerio($);

  // Layer 5: Image Gallery
  const images = extractImagesCheerio($, url);

  // Layer 6: Shopify productJSON from script assignments
  const productJSON = extractProductJsonFromHtml(html);

  const raw: RawExtraction = {
    custom,
    jsonLd,
    metaTags,
    microdata,
    htmlHeuristics,
    images,
    networkProducts: [],
    productJSON,
  };

  return {
    data: mergeExtractionLayers(raw, url, expected),
    html,
    raw,
    customHadAnyValue: customSelectorsHadAnyValue(custom),
  };
}

/**
 * Fast-path HTTP extraction using Cheerio. Thin wrapper over
 * `extractViaHttpDetailed` that returns only the merged data — preserves
 * the public API expected by existing callers (notably `supplementPrice`).
 */
async function extractViaHttp(
  url: string,
  profile?: ExtractorProfile | null,
  expected?: { name?: string; brandHint?: string | null; price?: string | null },
): Promise<ExtractionData> {
  const detailed = await extractViaHttpDetailed(url, profile, expected);
  return detailed.data;
}

/**
 * Extract product data from a URL using a two-tier approach:
 * HTTP Cheerio extraction (fast & lightweight) with fallback to Playwright stealth execution.
 * Returns validated ExtractionData with field provenance tracking.
 */
export async function extractProductData(
  url: string,
  expected?: { name: string; brandHint?: string | null; price?: string | null }
): Promise<ExtractionData> {
  let domain = '';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch { /* skip */ }
  const profile = domain ? findProfileByDomain(domain) : null;

  // Determine if it is a known official brand site
  const isKnownBrand = domain && expected?.brandHint
    ? findBrandSites(expected.brandHint).some(s => domain.includes(s.domain) || s.domain.includes(domain))
    : false;

  // 1. Try fast-path HTTP fetch first
  console.log(`[PageExtractor] Trying fast HTTP extraction for: ${url}`);
  let httpDetailed: HttpExtractionDetailed | null = null;
  try {
    httpDetailed = await extractViaHttpDetailed(url, profile, expected);
    const httpResult = httpDetailed.data;

    if (expected) {
      const validation = validateExtraction(httpResult, {
        name: expected.name,
        brandHint: expected.brandHint,
        domain: domain,
      });

      if (validation.valid) {
        console.log(`[PageExtractor] HTTP extraction succeeded and passed validation (confidence: ${validation.confidence})`);

        // Record ok status in domain status
        if (domain) {
          recordDomainStatus(domain, 'ok');
        }

        // Assign spreadsheet price to result, completely bypassing supplemental price lookups or web pricing
        let result = httpResult;
        result.price = expected?.price || null;
        if (expected?.price) {
          result = { ...result };
          result.fieldProvenance = { ...result.fieldProvenance, price: 'spreadsheet-import' };
        } else {
          result = { ...result };
          const { price: _, ...restProvenance } = result.fieldProvenance;
          result.fieldProvenance = restProvenance;
        }

        // Auto profile generation is disabled (operator must explicitly
        // click "Generate Profile" in the Domain Configuration UI).
        // See decision: profiles are domain-scoped; one proposal per
        // domain created on demand, never during extraction.

        return result;
      } else {
        console.warn(`[PageExtractor] HTTP extraction failed validation: ${validation.reason}. Status: ${validation.status}`);
        // If it is blocked or offline, fail over to Playwright.
        // If it is a catalog mismatch, we also attempt Playwright to see if rendering changes the page, but keep validation active.
      }
    } else {
      if (httpResult.title) {
        return httpResult;
      }
    }
  } catch (err) {
    console.warn(`[PageExtractor] HTTP extraction threw an error:`, err);
  }

  // 2. Fallback to Playwright stealth mode
  console.log(`[PageExtractor] Falling back to Playwright stealth extraction for: ${url}`);
  let rawExtraction: RawExtraction | null = null;
  // Captured by task 15 — only populated when extraction succeeds and
  // validation passes. Used as input to the optional Playwright path of
  // the profile generation trigger.
  let playwrightHtml: string | null = null;
  let playwrightCustomHadAnyValue = false;

  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const timeoutMs = isKnownBrand ? 40000 : 25000;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Enable request routing to block images, styles, and analytical pixels
    await page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const reqUrl = req.url();
      const isTracker = /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(reqUrl);

      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet' || isTracker) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const extractTask = async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs - 5000 });
      await page.waitForTimeout(2000);

      // Layer 0: Custom CSS Selectors
      let custom: Record<string, string | string[]> | null = null;
      if (profile) {
        try {
          custom = await extractCustomSelectors(page, profile);
        } catch (err) {
          console.error('[PageExtractor] Custom selector extraction failed:', err);
        }
      }

      // Layer 1: JSON-LD
      const jsonLd = await extractJsonLd(page);

      // Layer 2: Meta Tags
      const metaTags = await extractMetaTags(page);

      // Layer 3: Microdata
      const microdata = await extractMicrodata(page);

      // Layer 4: HTML Heuristics
      const htmlHeuristics = await extractHtmlHeuristics(page);

      // Layer 5: Image Gallery (img tags are still in DOM even if blocked)
      const images = await extractImages(page, url);

      // Layer 6: Shopify productJSON from page context
      const productJSON = await page.evaluate(() => {
        return (window as any).productJSON || null;
      }).catch(() => null);

      rawExtraction = {
        custom,
        jsonLd,
        metaTags,
        microdata,
        htmlHeuristics,
        images,
        networkProducts: [],
        productJSON,
      };
      playwrightCustomHadAnyValue = customSelectorsHadAnyValue(custom);

      // Task 15: capture rendered HTML for the optional Playwright path of
      // the profile generation trigger. Captured only when extraction
      // succeeded, so a later failure does not produce a half-rendered
      // HTML snapshot.
      try {
        playwrightHtml = await page.content();
      } catch (captureErr) {
        console.warn('[PageExtractor] Failed to capture Playwright HTML for profile generation:', captureErr);
        playwrightHtml = null;
      }
    };

    await Promise.race([
      extractTask(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Page extraction timed out (${timeoutMs / 1000}s)`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn(`[PageExtractor] Playwright extraction failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch { /* ignore */ }
  }

  if (!rawExtraction) {
    if (domain) {
      recordDomainStatus(domain, 'offline', 'Failed to render or connect via HTTP and Playwright');
    }
    throw new Error(`Failed to extract data from ${url}`);
  }

  const result = mergeExtractionLayers(rawExtraction, url, expected);

  // 3. Post-extraction validation gate for Playwright result
  if (expected) {
    const validation = validateExtraction(result, {
      name: expected.name,
      brandHint: expected.brandHint,
      domain: domain,
    });
    if (domain) {
      recordDomainStatus(domain, validation.status, validation.reason);
    }

    if (!validation.valid) {
      throw new Error(`Extraction validation failed: ${validation.reason}`);
    }

    // Assign spreadsheet price to result, completely bypassing supplemental price lookups or web pricing
    result.price = expected?.price || null;
    if (expected?.price) {
      result.fieldProvenance.price = 'spreadsheet-import';
    } else {
      delete result.fieldProvenance.price;
    }

    // Task 15: secondary profile generation path. Fires when the HTTP
    // path did NOT pass validation (e.g. page needs JS rendering) but
    // the Playwright render did, and the feature flag is on.
    //
    // This path is proposal-only: the generated selector set is audited
    // Auto profile generation is disabled (operator must explicitly
    // click "Generate Profile" in the Domain Configuration UI).
    // See decision: profiles are domain-scoped; one proposal per
    // domain created on demand, never during extraction.
  }

  return result;
}

// ─── Cheerio Extractor Helpers ────────────────────────────────────────────────

function extractCustomSelectorsCheerio(
  $: cheerio.CheerioAPI,
  profile: ExtractorProfile
): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};
  
  if (profile.titleSelector) {
    data.title = $(profile.titleSelector).first().text().trim() || '';
  }
  if (profile.priceSelector) {
    data.price = $(profile.priceSelector).first().text().trim() || '';
  }
  if (profile.descriptionSelector) {
    data.description = $(profile.descriptionSelector).first().text().trim() || '';
  }
  if (profile.brandSelector) {
    data.brand = $(profile.brandSelector).first().text().trim() || '';
  }
  if (profile.imagesSelector) {
    const images: string[] = [];
    const seen = new Set<string>();
    $(profile.imagesSelector).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        if (!seen.has(src)) {
          seen.add(src);
          images.push(src);
        }
      }
    });
    data.images = images;
  }
  
  return data;
}

function extractJsonLdCheerio($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      if (data['@graph']) {
        const product = (data['@graph'] as Record<string, unknown>[]).find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
      if (data['@type'] === 'Product') return data;
      if (Array.isArray(data)) {
        const product = data.find((item: Record<string, unknown>) => item['@type'] === 'Product');
        if (product) return product;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function extractMetaTagsCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const tags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const property = $(el).attr('property') ?? $(el).attr('name') ?? '';
    const content = $(el).attr('content') ?? '';
    if (property && content) {
      tags[property] = content;
    }
  });

  const titleText = $('title').first().text().trim();
  if (titleText) {
    tags['page:title'] = titleText;
  }

  return tags;
}

function extractMicrodataCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const data: Record<string, string> = {};
  const scope = $('[itemscope][itemtype*="Product"]').first();
  if (scope.length === 0) return data;

  scope.find('[itemprop]').each((_, el) => {
    const name = $(el).attr('itemprop') ?? '';
    const value = $(el).attr('content')
      ?? $(el).attr('src')
      ?? $(el).text().trim()
      ?? '';
    if (name && value) {
      data[name] = value;
    }
  });
  return data;
}

function extractHtmlHeuristicsCheerio($: cheerio.CheerioAPI): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};

  const titleSelectors = [
    'h1.product-title', 'h1.product-name', 'h1.pdp-title',
    '[data-testid="product-title"]', '[data-product-name]',
    '.product-info h1', '.product-detail h1', '.pdp-header h1',
    '#product-title', '#productTitle', '#product-name',
    'h1',
  ];

  for (const sel of titleSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.title = text;
      break;
    }
  }

  const descSelectors = [
    '.product-description', '.pdp-description', '#product-description',
    '[data-testid="product-description"]', '.product-detail__description',
    '.product-info__description',
  ];

  for (const sel of descSelectors) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 20) {
      data.description = text;
      break;
    }
  }

  const bulletSelectors = [
    '.product-features li', '.product-highlights li',
    '.pdp-features li', '#product-features li',
    '[data-testid="product-features"] li',
  ];

  for (const sel of bulletSelectors) {
    const list: string[] = [];
    $(sel).each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) list.push(txt);
    });
    if (list.length > 0) {
      data.bulletPoints = list;
      break;
    }
  }

  const priceSelectors = [
    '.product-price', '.pdp-price', '#product-price',
    '[data-testid="product-price"]', '.price-current',
    '.price', '[itemprop="price"]',
  ];

  for (const sel of priceSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      const match = text.match(/\$?(\d+\.?\d*)/);
      if (match) {
        data.price = match[0];
        break;
      }
    }
  }

  const brandSelectors = [
    '.product-brand', '.pdp-brand', '#product-brand',
    '[data-testid="product-brand"]', '[itemprop="brand"]',
    '.brand-name', '.manufacturer',
  ];

  for (const sel of brandSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.brand = text;
      break;
    }
  }

  const weightSelectors = [
    '[data-testid="product-weight"]', '.product-weight',
    '.pdp-weight',
  ];

  for (const sel of weightSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.weight = text;
      break;
    }
  }

  return data;
}



function extractImagesCheerio($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  const specificSelectors = [
    '.product-image img', '.pdp-image img', '.product-gallery img',
    '[data-testid="product-image"] img', '#product-images img',
    '.product-media img', '.gallery img', '.product-photo img',
    'img[itemprop="image"]',
  ];

  const fallbackSelectors = [
    'main img', '#content img', '.content img',
  ];

  const collectFromSelector = (sel: string) => {
    $(sel).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        addImageSource(src, seen, images);
      }
    });
  };

  // Try product-scoped selectors first, collecting src/srcset from only
  // those matched elements. Do not scan every img[srcset] on the page:
  // many Shopify themes render recommendation/product-card carousels with
  // srcsets before the PDP media, which polluted additionalImages for Woof.
  for (const sel of specificSelectors) {
    collectFromSelector(sel);
  }

  // If no images found from specific product selectors, use bounded content
  // fallbacks. Srcset parsing is still scoped to those fallback matches.
  if (images.length === 0) {
    for (const sel of fallbackSelectors) {
      collectFromSelector(sel);
    }
  }

  return images.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}


// ─── Layer 0: Custom Selector Helper ──────────────────────────────────────────

async function extractCustomSelectors(
  page: import('playwright').Page,
  profile: ExtractorProfile,
): Promise<Record<string, string | string[]>> {
  return page.evaluate((prof) => {
    const data: Record<string, string | string[]> = {};
    
    if (prof.titleSelector) {
      const el = document.querySelector(prof.titleSelector);
      data.title = el?.textContent?.trim() || '';
    }
    if (prof.priceSelector) {
      const el = document.querySelector(prof.priceSelector);
      data.price = el?.textContent?.trim() || '';
    }
    if (prof.descriptionSelector) {
      const el = document.querySelector(prof.descriptionSelector);
      data.description = el?.textContent?.trim() || '';
    }
    if (prof.brandSelector) {
      const el = document.querySelector(prof.brandSelector);
      data.brand = el?.textContent?.trim() || '';
    }
    if (prof.imagesSelector) {
      const parseSrcsetCandidates = (srcset: string | null | undefined): string[] => {
        if (!srcset) return [];
        return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
      };
      const isUsableImageSource = (src: string | null | undefined): src is string => {
        if (!src) return false;
        const trimmed = src.trim();
        if (!trimmed) return false;
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('data:')) return false;
        if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
        return true;
      };
      const imageSourcesForElement = (el: Element): string[] => {
        const target = el instanceof HTMLImageElement || el instanceof HTMLSourceElement
          ? el
          : el.querySelector('img,source');
        if (!target) return [];
        const sources: string[] = [];
        if (target instanceof HTMLImageElement && isUsableImageSource(target.currentSrc)) sources.push(target.currentSrc.trim());
        for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
          const value = target.getAttribute(attr);
          if (isUsableImageSource(value)) sources.push(value.trim());
        }
        for (const attr of ['srcset', 'data-srcset']) {
          for (const candidate of parseSrcsetCandidates(target.getAttribute(attr))) {
            if (isUsableImageSource(candidate)) sources.push(candidate.trim());
          }
        }
        return sources;
      };

      const seen = new Set<string>();
      data.images = Array.from(document.querySelectorAll(prof.imagesSelector))
        .flatMap(imageSourcesForElement)
        .filter(src => {
          if (seen.has(src)) return false;
          seen.add(src);
          return true;
        });
    }
    
    return data;
  }, profile);
}

// ─── Layer 1: JSON-LD ──────────────────────────────────────────────────────────

async function extractJsonLd(page: import('playwright').Page): Promise<Record<string, unknown> | null> {
  const scripts = await page.$$eval(
    'script[type="application/ld+json"]',
    (els) => els.map(el => el.textContent ?? ''),
  );

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      // Handle @graph arrays
      if (data['@graph']) {
        const product = (data['@graph'] as Record<string, unknown>[]).find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
      // Direct Product type
      if (data['@type'] === 'Product') return data;
      // Array of items
      if (Array.isArray(data)) {
        const product = data.find((item: Record<string, unknown>) => item['@type'] === 'Product');
        if (product) return product;
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  return null;
}

// ─── Layer 2: Meta Tags ────────────────────────────────────────────────────────

async function extractMetaTags(page: import('playwright').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const tags: Record<string, string> = {};
    const metas = document.querySelectorAll('meta');

    for (const meta of metas) {
      const property = meta.getAttribute('property') ?? meta.getAttribute('name') ?? '';
      const content = meta.getAttribute('content') ?? '';
      if (property && content) {
        tags[property] = content;
      }
    }

    // Also grab <title>
    const titleEl = document.querySelector('title');
    if (titleEl?.textContent) {
      tags['page:title'] = titleEl.textContent.trim();
    }

    return tags;
  });
}

// ─── Layer 3: Microdata ────────────────────────────────────────────────────────

async function extractMicrodata(page: import('playwright').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const data: Record<string, string> = {};
    const scope = document.querySelector('[itemscope][itemtype*="Product"]');
    if (!scope) return data;

    const props = scope.querySelectorAll('[itemprop]');
    for (const prop of props) {
      const name = prop.getAttribute('itemprop') ?? '';
      const value = prop.getAttribute('content')
        ?? (prop as HTMLImageElement).src
        ?? prop.textContent?.trim()
        ?? '';
      if (name && value) {
        data[name] = value;
      }
    }
    return data;
  });
}

// ─── Layer 4: HTML Heuristics ──────────────────────────────────────────────────

async function extractHtmlHeuristics(page: import('playwright').Page): Promise<Record<string, string | string[]>> {
  return page.evaluate(() => {
    const data: Record<string, string | string[]> = {};

    // Product title selectors (priority order)
    const titleSelectors = [
      'h1.product-title', 'h1.product-name', 'h1.pdp-title',
      '[data-testid="product-title"]', '[data-product-name]',
      '.product-info h1', '.product-detail h1', '.pdp-header h1',
      '#product-title', '#productTitle', '#product-name',
      'h1',
    ];

    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.title = el.textContent.trim();
        break;
      }
    }

    // Description
    const descSelectors = [
      '.product-description', '.pdp-description', '#product-description',
      '[data-testid="product-description"]', '.product-detail__description',
      '.product-info__description',
    ];

    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim() && el.textContent.trim().length > 20) {
        data.description = el.textContent.trim();
        break;
      }
    }

    // Bullet points / features
    const bulletSelectors = [
      '.product-features li', '.product-highlights li',
      '.pdp-features li', '#product-features li',
      '[data-testid="product-features"] li',
    ];

    for (const sel of bulletSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        data.bulletPoints = Array.from(els).map(el => el.textContent?.trim() ?? '').filter(Boolean);
        break;
      }
    }

    // Price
    const priceSelectors = [
      '.product-price', '.pdp-price', '#product-price',
      '[data-testid="product-price"]', '.price-current',
      '.price', '[itemprop="price"]',
    ];

    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        const priceText = el.textContent.trim();
        // Extract price number
        const match = priceText.match(/\$?(\d+\.?\d*)/);
        if (match) {
          data.price = match[0];
          break;
        }
      }
    }

    // Brand
    const brandSelectors = [
      '.product-brand', '.pdp-brand', '#product-brand',
      '[data-testid="product-brand"]', '[itemprop="brand"]',
      '.brand-name', '.manufacturer',
    ];

    for (const sel of brandSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.brand = el.textContent.trim();
        break;
      }
    }

    // Weight
    const weightSelectors = [
      '[data-testid="product-weight"]', '.product-weight',
      '.pdp-weight',
    ];

    for (const sel of weightSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.weight = el.textContent.trim();
        break;
      }
    }

    return data;
  });
}

// ─── Layer 5: Image Extraction ─────────────────────────────────────────────────

async function extractImages(page: import('playwright').Page, baseUrl: string): Promise<string[]> {
  const rawImages = await page.evaluate(() => {
    const images: string[] = [];
    const seen = new Set<string>();

    const specificSelectors = [
      '.product-image img', '.pdp-image img', '.product-gallery img',
      '[data-testid="product-image"] img', '#product-images img',
      '.product-media img', '.gallery img', '.product-photo img',
      'img[itemprop="image"]',
    ];

    const fallbackSelectors = [
      'main img', '#content img', '.content img',
    ];

    const parseSrcsetCandidates = (srcset: string | null | undefined): string[] => {
      if (!srcset) return [];
      return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    };
    const isUsableImageSource = (src: string | null | undefined): src is string => {
      if (!src) return false;
      const trimmed = src.trim();
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('data:')) return false;
      if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
      return true;
    };
    const imageSourcesForElement = (el: Element): string[] => {
      const target = el instanceof HTMLImageElement || el instanceof HTMLSourceElement
        ? el
        : el.querySelector('img,source');
      if (!target) return [];

      const sources: string[] = [];
      if (target instanceof HTMLImageElement && isUsableImageSource(target.currentSrc)) sources.push(target.currentSrc.trim());
      for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
        const value = target.getAttribute(attr);
        if (isUsableImageSource(value)) sources.push(value.trim());
      }
      for (const attr of ['srcset', 'data-srcset']) {
        for (const candidate of parseSrcsetCandidates(target.getAttribute(attr))) {
          if (isUsableImageSource(candidate)) sources.push(candidate.trim());
        }
      }
      return sources;
    };
    const hasLargeEnoughDimensions = (el: Element): boolean => {
      const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
      if (!img) return true;
      const naturalWidth = img.naturalWidth || parseInt(img.getAttribute('width') ?? '0');
      const naturalHeight = img.naturalHeight || parseInt(img.getAttribute('height') ?? '0');
      return naturalWidth > 100 || naturalHeight > 100 || (!naturalWidth && !naturalHeight);
    };
    const collectFromSelector = (sel: string) => {
      for (const el of document.querySelectorAll(sel)) {
        if (!hasLargeEnoughDimensions(el)) continue;
        for (const src of imageSourcesForElement(el)) {
          if (!seen.has(src)) {
            seen.add(src);
            images.push(src);
          }
        }
      }
    };

    for (const sel of specificSelectors) {
      collectFromSelector(sel);
    }

    if (images.length === 0) {
      for (const sel of fallbackSelectors) {
        collectFromSelector(sel);
      }
    }

    return images;
  });

  // Resolve relative URLs to absolute
  return rawImages.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}


// ─── Variant Inference from Expected Name ──────────────────────────────────────────────────

/**
 * Common size aliases used in product catalog names. Lower-cased keys.
 * Values are the canonical tokens we look for in variant option fields.
 */
const SIZE_ALIASES: Record<string, string[]> = {
  xs:        ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  sm:        ['small', 'sm'],
  md:        ['medium', 'med', 'md'],
  lg:        ['large', 'lg'],
  xl:        ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large', 'x small'],
  'x-small': ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  'x-large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'x small': ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  'x large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'xlarge':  ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  small:     ['small', 'sm'],
  medium:    ['medium', 'med', 'md'],
  large:     ['large', 'lg'],
  'extra large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'extra small': ['x-small', 'xsmall', 'extra small', 'xtra small'],
};

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normalizeToken(s).split(/\s+/).filter(Boolean));
}

/**
 * Extract the variant descriptor text from a single Shopify variant
 * object — concatenates title, public_title, name, option1..3, options
 * array, and sku.
 */
function variantDescriptor(v: any): { text: string; tokens: Set<string> } {
  const parts: string[] = [];
  if (v?.title) parts.push(String(v.title));
  if (v?.public_title) parts.push(String(v.public_title));
  if (v?.name) parts.push(String(v.name));
  for (const key of ['option1', 'option2', 'option3']) {
    if (v?.[key]) parts.push(String(v[key]));
  }
  if (Array.isArray(v?.options)) {
    for (const opt of v.options) {
      if (typeof opt === 'string') parts.push(opt);
    }
  }
  if (v?.sku) parts.push(String(v.sku));
  const text = parts.join(' ').toLowerCase();
  return { text, tokens: tokenSet(parts.join(' ')) };
}

/**
 * Expand size aliases found in the expected name into all the strings
 * we might see on a variant option. E.g. "SM" -> "small sm",
 * "LG" -> "large lg", "XL" -> "x large extra large x-large xl".
 */
function expandExpectedNameTokens(expected: string): Set<string> {
  const raw = normalizeToken(expected);
  const words = raw.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  for (const w of words) {
    expanded.add(w);
    // Add the full alias forms AND their individual pieces so token-set
    // overlap and exact option2 comparison both work.
    const aliases = SIZE_ALIASES[w];
    if (aliases) {
      for (const a of aliases) {
        expanded.add(normalizeToken(a));
      }
    }
  }
  return expanded;
}

/**
 * Score a single variant against the expected product name.
 * Higher = better match. Returns 0 if no overlap.
 */
function getExpectedSizeAliasForms(expected: string): Set<string> {
  const raw = normalizeToken(expected);
  const words = raw.split(/\s+/).filter(Boolean);
  const forms = new Set<string>();
  for (const w of words) {
    forms.add(w);
    const aliases = SIZE_ALIASES[w];
    if (aliases) {
      for (const a of aliases) {
        forms.add(normalizeToken(a));
      }
    }
  }
  return forms;
}

function scoreVariant(v: any, expectedTokens: Set<string>, expectedNameLower: string): number {
  const desc = variantDescriptor(v);
  if (!desc.text) return 0;
  let score = 0;
  // Token overlap (each shared token = 1 point)
  let shared = 0;
  for (const t of expectedTokens) {
    if (t.length < 2) continue;
    if (desc.tokens.has(t)) shared++;
  }
  score += shared * 10;
  // Exact option2 (size) match: strong disambiguator. option2 is the
  // size on most Woof/Shopify PDPs; matching it precisely against the
  // FULL alias form (e.g. "x large") breaks ties between "Large" and
  // "X-Large" (both share the "large" piece token).
  const option2 = v?.option2;
  if (option2 && typeof option2 === 'string') {
    const option2Norm = normalizeToken(option2);
    const fullForms = getExpectedSizeAliasForms(expectedNameLower);
    if (fullForms.has(option2Norm) && option2Norm.length >= 2) {
      score += 60;
    }
  }
  // Exact option1 (color) match: also a strong disambiguator.
  const option1 = v?.option1;
  if (option1 && typeof option1 === 'string') {
    const option1Norm = normalizeToken(option1);
    // option1 is a color (multi-word like "Forest Green"), so check
    // both the full form and any multi-word expected tokens.
    for (const t of expectedTokens) {
      if (t.length < 2) continue;
      if (option1Norm === t) { score += 60; break; }
    }
  }
  // Exact title match: very strong signal
  if (desc.text === expectedNameLower) score += 100;
  // Variant title contains the expected name as substring
  if (desc.text.includes(expectedNameLower) && expectedNameLower.length > 3) score += 50;
  // SKU match: strong signal
  if (v?.sku && typeof v.sku === 'string' && expectedNameLower.includes(v.sku.toLowerCase())) {
    score += 40;
  }
  // Variant has featured_image: tiebreaker
  if (v?.featured_image || v?.featured_media || v?.image) score += 1;
  return score;
}

/**
 * Pick the best-matching Shopify variant for an expected product name
 * when the URL doesn't include a `?variant=` parameter. Returns null
 * when the match is ambiguous or below the confidence threshold.
 *
 * Strategy:
 *   1. Expand expected-name tokens (size aliases, color words).
 *   2. Identify tokens that are common to ALL variants (e.g. "Pupsicle")
 *      and exclude them — only differentiating tokens should break ties.
 *   3. Score every variant against the distinguishing token set.
 *   4. Require (a) the top score > 0, (b) the top score is strictly
 *      greater than the runner-up, and (c) the top score clears a
 *      minimum threshold. This prevents guessing when the name is too
 *      generic (e.g. just "Pupsicle" with no color or size).
 */
function inferVariantFromExpectedName(
  variants: any[],
  expectedName: string,
  brandHint?: string | null,
): any | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const expectedNameLower = expectedName.toLowerCase();
  const expectedTokens = expandExpectedNameTokens(expectedName);

  // Exclude generic brand token from the scoring set so a name like
  // "WOOF PUPSICLE LAVENDER SM" doesn't double-count "woof" against
  // variants that all say "woof" in their name.
  if (brandHint) {
    const brandTokens = normalizeToken(brandHint).split(/\s+/).filter(Boolean);
    for (const b of brandTokens) expectedTokens.delete(b);
  }

  // Identify tokens shared across ALL variants (e.g. "Pupsicle"). These
  // are the "base" of the product and should NOT break ties — only
  // differentiating tokens (color/size/sku) should pick a variant.
  const variantTexts = variants.map(v => variantDescriptor(v).text);
  const baseShared = (() => {
    if (variantTexts.length === 0) return new Set<string>();
    const first = tokenSet(variantTexts[0]);
    const common = new Set<string>();
    for (const t of first) {
      if (variantTexts.every(vt => tokenSet(vt).has(t))) common.add(t);
    }
    return common;
  })();

  const distinguishingTokens = new Set<string>();
  for (const t of expectedTokens) {
    if (!baseShared.has(t)) distinguishingTokens.add(t);
  }
  const tokensToUse = distinguishingTokens.size > 0 ? distinguishingTokens : expectedTokens;

  let bestScore = 0;
  let secondScore = 0;
  let bestVariant: any = null;
  for (const v of variants) {
    const s = scoreVariant(v, tokensToUse, expectedNameLower);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      bestVariant = v;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  if (!bestVariant || bestScore <= 0) return null;
  // Require a clear winner: the runner-up must not match the top.
  if (bestScore === secondScore && secondScore > 0) return null;
  // Minimum threshold: at least one distinguishing token must have
  // matched (shared >= 1 with a per-token weight of 10 means score >= 10).
  if (bestScore < 10) return null;
  return bestVariant;
}

// ─── Merge Layers ──────────────────────────────────────────────────────────────

function mergeExtractionLayers(
  raw: RawExtraction,
  sourceUrl: string,
  expected?: { name?: string; brandHint?: string | null; price?: string | null },
): ExtractionData {
  const provenance: Record<string, string> = {};
  let confidenceScore = 0;
  let confidenceFactors = 0;

  // Helper: pick first non-null value, tracking provenance
  function pick(field: string, ...sources: Array<[string | undefined | null, string]>): string | null {
    for (const [value, source] of sources) {
      if (value && value.trim()) {
        provenance[field] = source;
        return value.trim();
      }
    }
    return null;
  }

  // Parse variantId from sourceUrl
  let variantId: string | null = null;
  try {
    const urlObj = new URL(sourceUrl);
    variantId = urlObj.searchParams.get('variant');
  } catch { /* ignore */ }

  let matchedVariant: any = null;
  if (variantId && raw.productJSON && Array.isArray(raw.productJSON.variants)) {
    matchedVariant = raw.productJSON.variants.find(
      (v: any) => v.id?.toString() === variantId || v.id === Number(variantId)
    );
  } else if (expected?.name && raw.productJSON && Array.isArray(raw.productJSON.variants)) {
    matchedVariant = inferVariantFromExpectedName(raw.productJSON.variants, expected.name, expected.brandHint ?? null);
  }

  // Title
  let title = pick('title',
    [raw.custom?.title as string, 'custom-selector'],
    [raw.jsonLd?.name as string, 'json-ld'],
    [raw.microdata.name, 'microdata'],
    [raw.metaTags['og:title'], 'meta'],
    [raw.htmlHeuristics.title as string, 'html'],
    [raw.metaTags['page:title'], 'meta'],
  );

  // If we matched a variant, let's enrich the title to include the variant options
  if (matchedVariant && title) {
    const variantTitle = matchedVariant.title || matchedVariant.name || '';
    if (variantTitle && !title.toLowerCase().includes(variantTitle.toLowerCase())) {
      title = `${title} - ${variantTitle}`;
      provenance.title = 'shopify-variant-enrichment';
    }
  }

  if (title) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Brand
  const jsonLdBrand = raw.jsonLd?.brand as Record<string, unknown> | string | undefined;
  const brandFromJsonLd = typeof jsonLdBrand === 'string'
    ? jsonLdBrand
    : (jsonLdBrand as Record<string, unknown>)?.name as string | undefined;

  const brand = pick('brand',
    [raw.custom?.brand as string, 'custom-selector'],
    [brandFromJsonLd, 'json-ld'],
    [raw.microdata.brand, 'microdata'],
    [raw.htmlHeuristics.brand as string, 'html'],
    [raw.metaTags['product:brand'], 'meta'],
  );
  if (brand) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Description
  const description = pick('description',
    [raw.custom?.description as string, 'custom-selector'],
    [raw.jsonLd?.description as string, 'json-ld'],
    [raw.microdata.description, 'microdata'],
    [raw.metaTags['og:description'], 'meta'],
    [raw.metaTags.description, 'meta'],
    [raw.htmlHeuristics.description as string, 'html'],
  );
  if (description) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Price
  const jsonLdPrice = raw.jsonLd?.offers as Record<string, unknown> | undefined;
  const priceFromJsonLd = jsonLdPrice?.price as string | undefined
    ?? (jsonLdPrice as Record<string, unknown>)?.lowPrice as string | undefined;

  let price = pick('price',
    [raw.custom?.price as string, 'custom-selector'],
    [priceFromJsonLd, 'json-ld'],
    [raw.microdata.price, 'microdata'],
    [raw.metaTags['product:price:amount'], 'meta'],
    [raw.htmlHeuristics.price as string, 'html'],
  );

  // Clean raw price text to numeric representation if extracted via custom-selector
  if (price && provenance.price === 'custom-selector') {
    const match = price.match(/\$?(\d+\.?\d*)/);
    if (match) {
      price = match[0];
    }
  }

  // If we matched a variant and it has a price, override to use it
  if (matchedVariant && matchedVariant.price) {
    const priceVal = typeof matchedVariant.price === 'number'
      ? (matchedVariant.price / 100).toFixed(2)
      : matchedVariant.price;
    price = priceVal.toString();
    provenance.price = 'shopify-variant-enrichment';
  }

  if (price) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Images
  const rawAllImages = (raw.custom?.images as string[]) ?? [];
  const customImages = cleanAndDeduplicateImages(rawAllImages, sourceUrl);
  const extractedImages = raw.images || [];
  const combinedImages = [...customImages, ...extractedImages];
  const allImages = cleanAndDeduplicateImages(combinedImages, sourceUrl);

  let primaryImage: string | null = null;
  let provenanceSrc = 'json-ld';

  // 1. If we matched a variant, try to use the variant's featured image as primaryImage
  if (matchedVariant) {
    let variantImg = matchedVariant.featured_image?.src
      || matchedVariant.featured_media?.preview_image?.src
      || matchedVariant.thumbnail_image?.desktop
      || matchedVariant.image?.src;

    // Fallback: search allImages for filenames matching variant option values (like color names "Tie Dye")
    if (!variantImg && Array.isArray(matchedVariant.options)) {
      for (const opt of matchedVariant.options) {
        if (!opt || typeof opt !== 'string') continue;
        const normalizedOpt = opt.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedOpt.length < 3) continue; // skip short values like size indicators
        
        const match = allImages.find(img => {
          try {
            const filename = new URL(img).pathname.split('/').pop()?.toLowerCase() || '';
            const normalizedFilename = filename.replace(/[^a-z0-9]/g, '');
            return normalizedFilename.includes(normalizedOpt);
          } catch {
            return false;
          }
        });
        
        if (match) {
          variantImg = match;
          break;
        }
      }
    }
      
    if (variantImg) {
      let variantImageUrl: string = variantImg;
      if (variantImageUrl.startsWith('//')) {
        variantImageUrl = 'https:' + variantImageUrl;
      }
      // Force Shopify variant image to 1200px width (high res)
      try {
        const imgUrlObj = new URL(variantImageUrl);
        if (imgUrlObj.hostname.includes('shopify.com') || imgUrlObj.pathname.includes('/cdn/shop/')) {
          const vParam = imgUrlObj.searchParams.get('v');
          imgUrlObj.search = '';
          if (vParam) imgUrlObj.searchParams.set('v', vParam);
          imgUrlObj.searchParams.set('width', '1200');
          variantImageUrl = imgUrlObj.href;
        }
      } catch {
        /* keep the original variant image URL */
      }
      primaryImage = variantImageUrl;
      provenanceSrc = 'shopify-variant';
    }
  }

  // 2. Fall back to custom selector or structured data
  if (!primaryImage) {
    if (customImages.length > 0) {
      primaryImage = customImages[0];
      provenanceSrc = 'custom-selector';
    } else {
      const primaryImageCandidates = [
        raw.jsonLd?.image as string | string[] | undefined,
        raw.metaTags['og:image'],
        raw.microdata.image,
      ];

      for (const candidate of primaryImageCandidates) {
        if (candidate) {
          primaryImage = Array.isArray(candidate) ? candidate[0] : candidate;
          provenanceSrc = 'json-ld';
          break;
        }
      }
    }
  }

  // 3. Normalize primaryImage protocol/relative paths and width if Shopify CDN
  if (primaryImage) {
    try {
      const imgUrlObj = new URL(primaryImage, sourceUrl);
      primaryImage = imgUrlObj.href;
      if (provenanceSrc !== 'shopify-variant') {
        if (imgUrlObj.hostname.includes('shopify.com') || imgUrlObj.pathname.includes('/cdn/shop/')) {
          const vParam = imgUrlObj.searchParams.get('v');
          imgUrlObj.search = '';
          if (vParam) imgUrlObj.searchParams.set('v', vParam);
          imgUrlObj.searchParams.set('width', '1200');
          primaryImage = imgUrlObj.href;
        }
      }
    } catch {
      if (primaryImage.startsWith('//')) {
        primaryImage = 'https:' + primaryImage;
      }
    }
  }

  // Use HTML-extracted images if no structured/variant primary image found
  if (!primaryImage && allImages.length > 0) {
    primaryImage = allImages[0];
    provenanceSrc = 'html';
  }

  if (primaryImage) {
    provenance.primaryImage = provenanceSrc;
    confidenceScore++; 
    confidenceFactors++; 
  } else { 
    confidenceFactors++; 
  }

  // Exclude primaryImage from allImages to get additionalImages
  const primaryCanonical = primaryImage ? canonicalizeUrl(primaryImage, sourceUrl) : '';
  const additionalImages = allImages.filter(img => {
    return canonicalizeUrl(img, sourceUrl) !== primaryCanonical;
  });

  // Bullet points
  const bulletPoints = (raw.htmlHeuristics.bulletPoints as string[] | undefined) ?? [];
  if (bulletPoints.length > 0) provenance.bulletPoints = 'html';

  // Weight
  const weight = pick('weight',
    [raw.jsonLd?.weight as string, 'json-ld'],
    [raw.microdata.weight, 'microdata'],
    [raw.htmlHeuristics.weight as string, 'html'],
  );

  // SEO filename from URL path
  let seoFileName: string | null = null;
  try {
    const urlPath = new URL(sourceUrl).pathname;
    const lastSegment = urlPath.split('/').filter(Boolean).pop();
    if (lastSegment && !lastSegment.match(/^\d+$/)) {
      seoFileName = lastSegment.replace(/\.\w+$/, ''); // strip extension
      provenance.seoFileName = 'url';
    }
  } catch { /* skip */ }

  // Search keywords from title + brand + description
  const keywordParts = [title, brand, description].filter(Boolean);
  const searchKeywords = keywordParts.length > 0
    ? keywordParts.join(' ').substring(0, 200)
    : null;
  if (searchKeywords) provenance.searchKeywords = 'derived';

  // Calculate overall confidence
  const confidence = confidenceFactors > 0 ? confidenceScore / confidenceFactors : 0;

  return {
    title,
    brand,
    description,
    bulletPoints,
    primaryImage,
    additionalImages,
    price,
    weight,
    dimensions: null,
    seoFileName,
    searchKeywords,
    sourceUrl,
    confidence,
    fieldProvenance: provenance,
    packagingTitle: null,
  };
}
