/**
 * Page extractor using Playwright directly.
 * Extracts structured product data from manufacturer product pages
 * using a layered approach: Custom CSS selectors → JSON-LD → meta tags → microdata → HTML heuristics.
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import type { ExtractionData } from '../shared/schemas/onboarding';
import { findProfileByDomain, type ExtractorProfile } from '../db/repositories/extractor-profile-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { recordDomainStatus } from '../db/repositories/domain-status-repo';
import { validateExtraction } from './extraction-validator';
import { supplementPrice } from './price-supplementer';

interface RawExtraction {
  custom: Record<string, string | string[]> | null;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  htmlHeuristics: Record<string, string | string[]>;
  images: string[];
  networkProducts: Record<string, unknown>[];
}

/**
 * Fast-path HTTP extraction using Cheerio.
 * Fetches the page markup and extracts structured data without launching a browser.
 */
export async function extractViaHttp(
  url: string,
  profile?: ExtractorProfile | null
): Promise<ExtractionData> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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

  const raw: RawExtraction = {
    custom,
    jsonLd,
    metaTags,
    microdata,
    htmlHeuristics,
    images,
    networkProducts: [],
  };

  return mergeExtractionLayers(raw, url);
}

/**
 * Extract product data from a URL using a two-tier approach:
 * HTTP Cheerio extraction (fast & lightweight) with fallback to Playwright stealth execution.
 * Returns validated ExtractionData with field provenance tracking.
 */
export async function extractProductData(
  url: string,
  expected?: { name: string; brandHint?: string | null }
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
  try {
    const httpResult = await extractViaHttp(url, profile);
    
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

        // Supplement price if missing on brand domains
        if (!httpResult.price) {
          if (isKnownBrand) {
            const searchNameForPrice = httpResult.title || expected.name;
            const pricing = await supplementPrice(searchNameForPrice, (u) => extractViaHttp(u, null));
            if (pricing.price) {
              httpResult.price = pricing.price;
              httpResult.fieldProvenance.price = 'supplemental-retailer';
            }
          }
        }

        return httpResult;
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

      rawExtraction = {
        custom,
        jsonLd,
        metaTags,
        microdata,
        htmlHeuristics,
        images,
        networkProducts: [],
      };
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

  const result = mergeExtractionLayers(rawExtraction, url);

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

    // Supplement pricing if missing on brand domains
    if (!result.price) {
      if (isKnownBrand) {
        const searchNameForPrice = result.title || expected.name;
        const pricing = await supplementPrice(searchNameForPrice, (u) => extractViaHttp(u, null));
        if (pricing.price) {
          result.price = pricing.price;
          result.fieldProvenance.price = 'supplemental-retailer';
        }
      }
    }
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
    $(profile.imagesSelector).each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (src) images.push(src);
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

  const imgSelectors = [
    '.product-image img', '.pdp-image img', '.product-gallery img',
    '[data-testid="product-image"] img', '#product-images img',
    '.product-media img', '.gallery img', '.product-photo img',
    'img[itemprop="image"]',
    'main img', '#content img', '.content img',
  ];

  for (const sel of imgSelectors) {
    $(sel).each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      if (src && !seen.has(src) && !src.endsWith('.svg') && !src.startsWith('data:image/svg')) {
        seen.add(src);
        images.push(src);
      }
    });
    if (images.length > 0) break;
  }

  $('img[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') ?? '';
    const parts = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    for (const src of parts) {
      if (src && !seen.has(src) && !src.endsWith('.svg') && !src.startsWith('data:image/svg')) {
        seen.add(src);
        images.push(src);
      }
    }
  });

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
      const imgEls = document.querySelectorAll(prof.imagesSelector);
      data.images = Array.from(imgEls)
        .map(el => {
          const img = el as HTMLImageElement;
          return img.src || img.dataset.src || img.getAttribute('data-lazy-src') || '';
        })
        .filter(Boolean);
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

    // Product image selectors
    const imgSelectors = [
      '.product-image img', '.pdp-image img', '.product-gallery img',
      '[data-testid="product-image"] img', '#product-images img',
      '.product-media img', '.gallery img', '.product-photo img',
      'img[itemprop="image"]',
      // Fallback: large images in the main content area
      'main img', '#content img', '.content img',
    ];

    for (const sel of imgSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const img = el as HTMLImageElement;
        const src = img.src || img.dataset.src || img.getAttribute('data-lazy-src') || '';
        if (src && !seen.has(src)) {
          // Filter out tiny images (icons, spacers)
          const naturalWidth = img.naturalWidth || parseInt(img.getAttribute('width') ?? '0');
          const naturalHeight = img.naturalHeight || parseInt(img.getAttribute('height') ?? '0');
          if (naturalWidth > 100 || naturalHeight > 100 || (!naturalWidth && !naturalHeight)) {
            // Skip SVGs and data URIs for icons
            if (!src.endsWith('.svg') && !src.startsWith('data:image/svg')) {
              seen.add(src);
              images.push(src);
            }
          }
        }
      }
      if (images.length > 0) break; // Use the first selector that matches
    }

    // Also check for high-res via srcset
    const srcsets = document.querySelectorAll('img[srcset]');
    for (const el of srcsets) {
      const srcset = el.getAttribute('srcset') ?? '';
      const parts = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
      for (const src of parts) {
        if (src && !seen.has(src) && !src.endsWith('.svg')) {
          seen.add(src);
          images.push(src);
        }
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

// ─── Merge Layers ──────────────────────────────────────────────────────────────

function mergeExtractionLayers(raw: RawExtraction, sourceUrl: string): ExtractionData {
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

  // Title
  const title = pick('title',
    [raw.custom?.title as string, 'custom-selector'],
    [raw.jsonLd?.name as string, 'json-ld'],
    [raw.microdata.name, 'microdata'],
    [raw.metaTags['og:title'], 'meta'],
    [raw.htmlHeuristics.title as string, 'html'],
    [raw.metaTags['page:title'], 'meta'],
  );
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

  if (price) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Images
  const customImages = (raw.custom?.images as string[]) ?? [];
  let primaryImage: string | null = null;
  let provenanceSrc = 'json-ld';

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

  // Use HTML-extracted images if no structured data images
  const allImages = customImages.length > 0 
    ? customImages 
    : (raw.images.length > 0 ? raw.images : []);

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

  const additionalImages = allImages.filter(img => img !== primaryImage);

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
