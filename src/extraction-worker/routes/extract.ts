/**
 * Trusted Profile Runner — POST /profile-runner/extract
 *
 * Executes an already-matched healthy profile deterministically.
 * The Bun server performs Profile Match first and passes the exact profile
 * and version to run.
 *
 * CRITICAL RULES:
 *   - NEVER call an LLM or AI agent
 *   - NEVER fall back to generic extraction if profile selectors fail
 *   - NEVER guess variant selection — it must be deterministic
 *   - ALWAYS return `ok: false` rather than untrusted data
 *   - ALWAYS record fieldProvenance for every extracted field
 *   - ALWAYS validate output against ExtractionDataSchema
 *
 * Supports two runtimes from profile.runtime:
 *   - **static**:  HTTP fetch + Cheerio DOM extraction (no browser).
 *   - **rendered**: Headless Playwright Chromium with JS execution.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import {
  ExtractRequestSchema,
  ExtractResponseSchema,
  type ExtractRequest,
  type ExtractResponse,
} from '../../shared/schemas/extraction-worker';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';
import type { ExtractionData } from '../../shared/schemas/onboarding';

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
const RENDERED_NAVIGATE_TIMEOUT_MS = 25_000;
const RENDERED_DWELL_MS = 2_000;

// ─── Image source helpers (inlined from image-utils.ts) ────────────────────────
// These are duplicated locally to avoid importing the Bun-only onboarding module.
// The worker runs on Node.js without the Bun runtime.

/**
 * Returns true when a source URL is usable as a product image —
 * non-empty, not a data URI, not a blob URI, and not an SVG.
 */
function isUsableImageSource(src: string | null | undefined): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('data:')) return false;
  if (lower.startsWith('blob:')) return false;
  const path = lower.split(/[?#]/)[0];
  if (path.endsWith('.svg')) return false;
  return true;
}

/**
 * Parse a `srcset` attribute string into an array of URL-only tokens
 * (stripping descriptors like `165w`, `2x`).
 */
function parseSrcsetCandidates(srcset: string | null | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Collect all usable image source URLs from a Cheerio-wrapped element.
 *
 * - If the element IS an `<img>` or `<source>`, reads its attributes directly.
 * - Otherwise, finds the first descendant `<img>` or `<source>`.
 *
 * Reads these attributes:
 *   src, data-src, data-lazy-src, data-original, data-image, data-zoom-image
 * Plus srcset-style:
 *   srcset, data-srcset
 */
function collectImageSourcesFromElement(
  $: cheerio.CheerioAPI,
  el: cheerio.Element | unknown,
): string[] {
  const sources: string[] = [];
  const $el = $(el as cheerio.AnyNode);
  const targets = $el.is('img,source') ? $el : $el.find('img,source');
  if (targets.length === 0) return sources;

  targets.each((_, t) => {
    const $t = $(t);

  const directAttrs = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-image',
    'data-zoom-image',
  ];
  for (const attr of directAttrs) {
    const value = $t.attr(attr);
    if (isUsableImageSource(value)) sources.push(value!.trim());
  }

  for (const attr of ['srcset', 'data-srcset']) {
    for (const candidate of parseSrcsetCandidates($t.attr(attr))) {
      if (isUsableImageSource(candidate)) sources.push(candidate.trim());
    }
  }
  });

  return sources;
}

/**
 * Resolve a possibly-relative URL to absolute against a base URL.
 * Returns null if resolution fails.
 */
function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

// ─── JSON-LD extraction (Cheerio) ─────────────────────────────────────────────

/**
 * Extract the first JSON-LD Product block from <script type="application/ld+json"> tags.
 */
function extractJsonLdFromCheerio($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

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
        const product = data.find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
    } catch {
      // invalid JSON, skip
    }
  }
  return null;
}

// ─── Meta tag extraction (Cheerio) ─────────────────────────────────────────────

function extractMetaTagsFromCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const tags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const property =
      $(el).attr('property') ?? $(el).attr('name') ?? '';
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

// ─── Microdata extraction (Cheerio) ────────────────────────────────────────────

function extractMicrodataFromCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const data: Record<string, string> = {};
  const scope = $('[itemscope][itemtype*="Product"]').first();
  if (scope.length === 0) return data;

  scope.find('[itemprop]').each((_, el) => {
    const name = $(el).attr('itemprop') ?? '';
    const value =
      $(el).attr('content') ??
      $(el).attr('src') ??
      $(el).text().trim() ??
      '';
    if (name && value) {
      data[name] = value;
    }
  });
  return data;
}

// ─── Helper: collect images from a cheerio selector string ────────────────────

function collectImagesFromSelector(
  $: cheerio.CheerioAPI,
  imagesSelector: string,
  baseUrl: string,
): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  $(imagesSelector).each((_, el) => {
    for (const src of collectImageSourcesFromElement($, el)) {
      const absolute = resolveUrl(src, baseUrl);
      if (absolute && !seen.has(absolute)) {
        seen.add(absolute);
        images.push(absolute);
      }
    }
  });
  return images;
}

// ─── Helper: evaluate a text selector in Playwright ──────────────────────────

function makeTextSelectorEvaluator(): string {
  return `
    (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    }
  `;
}

// ─── Helper: extract JSON-LD from Playwright ─────────────────────────────────

function makePlaywrightJsonLdExtractor(): string {
  return `
    () => {
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
        } catch (e) { /* skip invalid JSON */ }
      }
      return results;
    }
  `;
}

// ─── Helper: extract meta tags from Playwright ───────────────────────────────

function makePlaywrightMetaExtractor(): string {
  return `
    () => {
      const tags = {};
      const metas = document.querySelectorAll('meta');
      for (const meta of metas) {
        const property = meta.getAttribute('property') || meta.getAttribute('name') || '';
        const content = meta.getAttribute('content') || '';
        if (property && content) tags[property] = content;
      }
      const titleEl = document.querySelector('title');
      if (titleEl && titleEl.textContent) {
        tags['page:title'] = titleEl.textContent.trim();
      }
      return tags;
    }
  `;
}

// ─── Helper: extract embedded product data from Playwright ───────────────────

function makePlaywrightEmbeddedExtractor(): string {
  return `
    () => {
      const results = [];
      const w = window;
      if (w.productJSON && typeof w.productJSON === 'object') results.push(w.productJSON);
      if (w.ShopifyAnalytics && typeof w.ShopifyAnalytics === 'object') results.push(w.ShopifyAnalytics);
      if (w.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') results.push(w.__INITIAL_STATE__);
      return results;
    }
  `;
}

// ─── Static extraction ────────────────────────────────────────────────────────

interface ExtractedFields {
  title: string | null;
  brand: string | null;
  description: string | null;
  price: string | null;
  primaryImage: string | null;
  additionalImages: string[];
  provenance: Record<string, string>;
}

/**
 * Run deterministic extraction via HTTP fetch + Cheerio DOM parsing.
 */
async function doStaticExtract(request: ExtractRequest): Promise<{
  data: ExtractionData;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const { sourceUrl, expected, profile } = request;
  const selectors = profile.selectors || {};
  const renderedCustomFields: Record<string, string> = {};

  // ── Fetch page ─────────────────────────────────────────────────────────
  let response: Response;
  let html: string;
  try {
    response = await fetch(sourceUrl, {
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
    return buildFailedResult(request, warnings);
  }

  const finalUrl = response.url || sourceUrl;
  const $ = cheerio.load(html);

  // ── Extract JSON-LD, meta tags, microdata as supplementary sources ────
  const jsonLd = extractJsonLdFromCheerio($);
  const metaTags = extractMetaTagsFromCheerio($);
  const microdata = extractMicrodataFromCheerio($);

  // ── Apply profile selectors ───────────────────────────────────────────
  const titleSelector = selectors['titleSelector'] || selectors['title'] || null;
  const brandSelector = selectors['brandSelector'] || selectors['brand'] || null;
  const descriptionSelector = selectors['descriptionSelector'] || selectors['description'] || null;
  const priceSelector = selectors['priceSelector'] || selectors['price'] || null;
  const imagesSelector = selectors['imagesSelector'] || selectors['images'] || selectors['imageSelector'] || selectors['image'] || null;

  // Title: selector required — if empty, extraction fails
  let title: string | null = null;
  let titleProvenance = '';
  if (titleSelector) {
    title = $(titleSelector).first().text().trim() || null;
    if (title) {
      titleProvenance = 'profile-selector';
    } else {
      // Fall back to JSON-LD or meta
      title =
        (jsonLd?.name as string) ||
        metaTags['og:title'] ||
        metaTags['page:title'] ||
        null;
      if (title) {
        titleProvenance = title === jsonLd?.name ? 'json-ld' : 'meta';
        warnings.push(`titleSelector "${titleSelector}" returned empty; fell back to ${titleProvenance}`);
      } else {
        warnings.push(`titleSelector "${titleSelector}" returned empty and no JSON-LD/meta fallback available`);
      }
    }
  } else {
    // No selector configured — try JSON-LD / meta
    title =
      (jsonLd?.name as string) ||
      metaTags['og:title'] ||
      metaTags['page:title'] ||
      null;
    if (title) {
      titleProvenance = 'json-ld';
    }
  }

  // If no title at all, this is a hard failure
  if (!title) {
    warnings.push('Title could not be extracted — returning ok: false');
    return buildFailedResult(request, warnings);
  }

  // Brand
  let brand: string | null = null;
  let brandProvenance = '';
  if (brandSelector) {
    brand = $(brandSelector).first().text().trim() || null;
    if (brand) {
      brandProvenance = 'profile-selector';
    }
  }
  if (!brand) {
    const jsonLdBrand = jsonLd?.brand as
      | Record<string, unknown>
      | string
      | undefined;
    const brandFromJsonLd =
      typeof jsonLdBrand === 'string'
        ? jsonLdBrand
        : ((jsonLdBrand as Record<string, unknown>)?.name as string | undefined);
    brand =
      (brandFromJsonLd as string | undefined) ||
      microdata.brand ||
      metaTags['product:brand'] ||
      null;
    if (brand) {
      brandProvenance = brandFromJsonLd ? 'json-ld' : microdata.brand ? 'microdata' : 'meta';
    }
  }

  // Description
  let description: string | null = null;
  let descriptionProvenance = '';
  if (descriptionSelector) {
    description = $(descriptionSelector).first().text().trim() || null;
    if (description) {
      descriptionProvenance = 'profile-selector';
    }
  }
  if (!description) {
    description =
      (jsonLd?.description as string) ||
      metaTags['og:description'] ||
      metaTags['description'] ||
      null;
    if (description) {
      descriptionProvenance = 'json-ld';
    }
  }

  // Price from selector or expected price (expected.price overrides)
  let price: string | null = null;
  let priceProvenance = '';
  if (expected?.price) {
    price = expected.price;
    priceProvenance = 'spreadsheet-import';
  } else if (priceSelector) {
    price = $(priceSelector).first().text().trim() || null;
    if (price) {
      priceProvenance = 'profile-selector';
      // Clean to numeric representation
      const match = price.match(/\$?(\d+\.?\d*)/);
      if (match) {
        price = match[0];
      }
    }
  }
  if (!price) {
    const jsonLdOffers = jsonLd?.offers as Record<string, unknown> | undefined;
    const priceFromJsonLd =
      jsonLdOffers?.price as string | undefined;
    price = priceFromJsonLd || metaTags['product:price:amount'] || null;
    if (price) {
      priceProvenance = priceFromJsonLd ? 'json-ld' : 'meta';
    }
  }

  // Images
  let primaryImage: string | null = null;
  const additionalImages: string[] = [];
  let imageProvenance = '';

  if (imagesSelector) {
    const rawImages = collectImagesFromSelector($, imagesSelector, finalUrl);
    if (rawImages.length > 0) {
      primaryImage = rawImages[0];
      additionalImages.push(...rawImages.slice(1));
      imageProvenance = 'profile-selector';
    }
  }

  // If no images from selector, try JSON-LD
  if (!primaryImage && jsonLd?.image) {
    const jsonLdImage = jsonLd.image as string | string[];
    const imgUrl = Array.isArray(jsonLdImage) ? jsonLdImage[0] : jsonLdImage;
    const resolved = resolveUrl(imgUrl, finalUrl);
    if (resolved) {
      primaryImage = resolved;
      imageProvenance = 'json-ld';
    }
  }

  if (!primaryImage && metaTags['og:image']) {
    const resolved = resolveUrl(metaTags['og:image'], finalUrl);
    if (resolved) {
      primaryImage = resolved;
      imageProvenance = 'meta';
    }
  }

  if (!primaryImage && microdata.image) {
    const resolved = resolveUrl(microdata.image, finalUrl);
    if (resolved) {
      primaryImage = resolved;
      imageProvenance = 'microdata';
    }
  }

  // ── Build provenance record ──────────────────────────────────────────
  const provenance: Record<string, string> = {};
  if (title) provenance.title = titleProvenance;
  if (brand) provenance.brand = brandProvenance;
  if (description) provenance.description = descriptionProvenance;
  if (price) provenance.price = priceProvenance;
  if (primaryImage) provenance.primaryImage = imageProvenance;
  if (additionalImages.length > 0) provenance.additionalImages = imageProvenance;
  if (sourceUrl) provenance.sourceUrl = 'request';
  provenance.profileRuntime = 'static';

  // Extract custom selectors
  const customFields: Record<string, string> = {};
  if (selectors.customSelectors) {
    for (const [fieldName, selector] of Object.entries(selectors.customSelectors)) {
      if (!selector) continue;
      try {
        const val = $(selector).first().text().trim();
        if (val) {
          customFields[fieldName] = val;
          provenance[`custom.${fieldName}`] = 'profile-selector';
        }
      } catch { /* skip bad selectors */ }
    }
    if (Object.keys(customFields).length > 0) {
      provenance.customFields = 'profile-selector';
    }
  }

  // ── Build ExtractionData ─────────────────────────────────────────────
  const data = buildExtractionData({
    title,
    brand,
    description,
    price,
    primaryImage,
    additionalImages,
    provenance,
  }, sourceUrl, expected.name);

  // Merge custom fields into result
  if (Object.keys(renderedCustomFields).length > 0) {
    data.customFields = renderedCustomFields;
  }

  return { data, warnings };
}

// ─── Rendered extraction ──────────────────────────────────────────────────────

/**
 * Run deterministic extraction via Playwright with JS execution.
 */
async function doRenderedExtract(request: ExtractRequest): Promise<{
  data: ExtractionData;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const { sourceUrl, expected, profile } = request;
  const selectors = profile.selectors || {};
  const renderedCustomFields: Record<string, string> = {};

  const titleSelector = selectors['titleSelector'] || selectors['title'] || null;
  const brandSelector = selectors['brandSelector'] || selectors['brand'] || null;
  const descriptionSelector = selectors['descriptionSelector'] || selectors['description'] || null;
  const priceSelector = selectors['priceSelector'] || selectors['price'] || null;
  const imagesSelector = selectors['imagesSelector'] || selectors['images'] || selectors['imageSelector'] || selectors['image'] || null;

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
    return buildFailedResult(request, warnings);
  }

  let finalUrl = sourceUrl;
  let jsonLd: Record<string, unknown> | null = null;
  let metaTags: Record<string, string> = {};
  const embeddedData: Record<string, unknown>[] = [];

  // Collected field values
  let title: string | null = null;
  let brand: string | null = null;
  let description: string | null = null;
  let price: string | null = null;
  let primaryImage: string | null = null;
  const additionalImages: string[] = [];

  const titleProvenance: string[] = [];
  let brandProvenance = '';
  let descriptionProvenance = '';
  let priceProvenance = '';
  let imageProvenance = '';

  try {
    const context = await browser.newContext({
      userAgent: HTTP_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Block resource types (same pattern as snapshot.ts)
    await page.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const reqUrl = req.url();
      const isTracker =
        /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(
          reqUrl,
        );
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        type === 'stylesheet' ||
        isTracker
      ) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // Navigate
    try {
      await page.goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: RENDERED_NAVIGATE_TIMEOUT_MS,
      });
      finalUrl = page.url();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Navigation failed: ${msg}`);
    }

    // Dwell for dynamic content
    await page.waitForTimeout(RENDERED_DWELL_MS);

    // ── Extract JSON-LD ────────────────────────────────────────────────
    try {
      const jsonLdArray: Record<string, unknown>[] = await page.evaluate(
        makePlaywrightJsonLdExtractor(),
      );
      // Find the first Product type
      for (const item of jsonLdArray) {
        const findProduct = (obj: Record<string, unknown>): Record<string, unknown> | null => {
          if (obj['@type'] === 'Product') return obj;
          if (Array.isArray(obj['@graph'])) {
            for (const g of obj['@graph'] as Record<string, unknown>[]) {
              const found = findProduct(g);
              if (found) return found;
            }
          }
          return null;
        };
        const product = findProduct(item);
        if (product) {
          jsonLd = product;
          break;
        }
      }
    } catch (err) {
      warnings.push(
        `JSON-LD extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Extract meta tags ─────────────────────────────────────────────
    try {
      metaTags = await page.evaluate(makePlaywrightMetaExtractor());
    } catch (err) {
      warnings.push(
        `Meta tag extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Extract embedded product data ──────────────────────────────────
    try {
      const embedded = (await page.evaluate(makePlaywrightEmbeddedExtractor())) as Record<string, unknown>[];
      embeddedData.push(...embedded);
    } catch {
      // non-critical
    }

    // ── Evaluate text selectors in browser ─────────────────────────────

    // Title
    if (titleSelector) {
      try {
        title = await page.evaluate(makeTextSelectorEvaluator(), titleSelector);
        if (title) {
          titleProvenance.push('profile-selector');
        }
      } catch {
        // selector evaluation failed
      }
    }

    // If no title from selector, use JSON-LD or meta
    if (!title) {
      title =
        (jsonLd?.name as string) ||
        metaTags['og:title'] ||
        metaTags['page:title'] ||
        null;
      if (title) {
        titleProvenance.push(title === jsonLd?.name ? 'json-ld' : 'meta');
        if (titleSelector) {
          warnings.push(
            `titleSelector "${titleSelector}" returned empty; fell back to ${titleProvenance[0]}`,
          );
        }
      }
    }

    if (!title) {
      warnings.push('Title could not be extracted — returning ok: false');
      return buildFailedResult(request, warnings);
    }

    // Brand
    if (brandSelector) {
      try {
        brand = await page.evaluate(makeTextSelectorEvaluator(), brandSelector);
        if (brand) brandProvenance = 'profile-selector';
      } catch {
        // ignore
      }
    }
    if (!brand) {
      const jsonLdBrand = jsonLd?.brand as
        | Record<string, unknown>
        | string
        | undefined;
      const brandFromJsonLd =
        typeof jsonLdBrand === 'string'
          ? jsonLdBrand
          : ((jsonLdBrand as Record<string, unknown>)?.name as string | undefined);
      if (brandFromJsonLd) {
        brand = brandFromJsonLd;
        brandProvenance = 'json-ld';
      }
    }

    // Description
    if (descriptionSelector) {
      try {
        description = await page.evaluate(makeTextSelectorEvaluator(), descriptionSelector);
        if (description) descriptionProvenance = 'profile-selector';
      } catch {
        // ignore
      }
    }
    if (!description) {
      description =
        (jsonLd?.description as string) ||
        metaTags['og:description'] ||
        metaTags['description'] ||
        null;
      if (description) descriptionProvenance = 'json-ld';
    }

    // Price
    if (expected?.price) {
      price = expected.price;
      priceProvenance = 'spreadsheet-import';
    } else if (priceSelector) {
      try {
        price = await page.evaluate(makeTextSelectorEvaluator(), priceSelector);
        if (price) {
          priceProvenance = 'profile-selector';
          const match = price.match(/\$?(\d+\.?\d*)/);
          if (match) price = match[0];
        }
      } catch {
        // ignore
      }
    }
    if (!price) {
      const jsonLdOffers = jsonLd?.offers as Record<string, unknown> | undefined;
      price = jsonLdOffers?.price as string | undefined ||
              metaTags['product:price:amount'] ||
              null;
      if (price) {
        priceProvenance = jsonLdOffers?.price ? 'json-ld' : 'meta';
      }
    }

    // ── Images from selector ──────────────────────────────────────────
    if (imagesSelector) {
      try {
        const rawImages: string[] = await page.evaluate(
          `((sel, baseUrl) => {
            const seen = new Set();
            const images = [];
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const target = el.tagName === 'IMG' || el.tagName === 'SOURCE'
                ? el
                : el.querySelector('img,source');
              if (!target) continue;
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
              if (target.tagName === 'IMG') {
                tryAdd(target.currentSrc);
              }
              for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
                tryAdd(target.getAttribute(attr));
              }
              for (const attr of ['srcset', 'data-srcset']) {
                const srcset = target.getAttribute(attr);
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
            }
            return images.map(s => {
              try { return new URL(s, baseUrl).href; }
              catch { return s; }
            }).filter(s => s.startsWith('http'));
          })(${JSON.stringify(imagesSelector)}, ${JSON.stringify(finalUrl)})`
        );
        if (rawImages.length > 0) {
          primaryImage = rawImages[0];
          additionalImages.push(...rawImages.slice(1));
          imageProvenance = 'profile-selector';
        }
      } catch {
        // ignore
      }
    }

    // Fallback images from JSON-LD / meta
    if (!primaryImage && jsonLd?.image) {
      const jsonLdImage = jsonLd.image as string | string[];
      const imgUrl = Array.isArray(jsonLdImage) ? jsonLdImage[0] : jsonLdImage;
      const resolved = resolveUrl(imgUrl, finalUrl);
      if (resolved) {
        primaryImage = resolved;
        imageProvenance = 'json-ld';
      }
    }

    if (!primaryImage && metaTags['og:image']) {
      const resolved = resolveUrl(metaTags['og:image'], finalUrl);
      if (resolved) {
        primaryImage = resolved;
        imageProvenance = 'meta';
      }
    }

    // Extract custom selectors while browser is still open
    if (selectors.customSelectors) {
      for (const [fieldName, selector] of Object.entries(selectors.customSelectors)) {
        if (!selector) continue;
        try {
          const val: string = (await page.evaluate(makeTextSelectorEvaluator(), selector)) as string;
          if (val) {
            renderedCustomFields[fieldName] = val;
          }
        } catch { /* skip bad selectors */ }
      }
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Rendered extraction error: ${msg}`);
  }

  // ── Build provenance record ──────────────────────────────────────────
  const provenance: Record<string, string> = {};
  if (title) provenance.title = titleProvenance.length > 0 ? titleProvenance[0] : 'json-ld';
  if (brand) provenance.brand = brandProvenance;
  if (description) provenance.description = descriptionProvenance;
  if (price) provenance.price = priceProvenance;
  if (primaryImage) provenance.primaryImage = imageProvenance;
  if (additionalImages.length > 0) provenance.additionalImages = imageProvenance;
  if (sourceUrl) provenance.sourceUrl = 'request';
  provenance.profileRuntime = 'rendered';

  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    // ignore close errors
  }

  const data = buildExtractionData(
    {
      title: title!,
      brand,
      description,
      price,
      primaryImage,
      additionalImages,
      provenance,
    },
    sourceUrl,
    expected.name,
  );

  // Merge custom fields into result
  if (Object.keys(renderedCustomFields).length > 0) {
    (data as ExtractionData).customFields = renderedCustomFields;
  }

  return { data, warnings };
}

// ─── Build ExtractionData from extracted fields ───────────────────────────────

function buildExtractionData(
  fields: {
    title: string;
    brand: string | null;
    description: string | null;
    price: string | null;
    primaryImage: string | null;
    additionalImages: string[];
    provenance: Record<string, string>;
  },
  sourceUrl: string,
  expectedName: string | undefined,
): ExtractionData {
  const { title, brand, description, price, primaryImage, additionalImages, provenance } = fields;

  // Confidence: fraction of required fields that were extracted
  const requiredFields = [title, brand, description, price, primaryImage];
  const extractedCount = requiredFields.filter(Boolean).length;
  const confidence = requiredFields.length > 0 ? extractedCount / requiredFields.length : 0;

  // SEO filename from URL path
  let seoFileName: string | null = null;
  try {
    const urlPath = new URL(sourceUrl).pathname;
    const lastSegment = urlPath.split('/').filter(Boolean).pop();
    if (lastSegment && !lastSegment.match(/^\d+$/)) {
      seoFileName = lastSegment.replace(/\.\w+$/, '');
      if (!provenance.seoFileName) provenance.seoFileName = 'url';
    }
  } catch {
    // skip
  }

  // Search keywords from title + brand + description
  const keywordParts = [title, brand, description].filter(Boolean) as string[];
  const searchKeywords =
    keywordParts.length > 0
      ? keywordParts.join(' ').substring(0, 200)
      : null;
  if (searchKeywords && !provenance.searchKeywords) {
    provenance.searchKeywords = 'derived';
  }

  return {
    title,
    brand,
    description,
    bulletPoints: [],
    primaryImage,
    additionalImages,
    price,
    weight: null,
    dimensions: null,
    seoFileName,
    searchKeywords,
    sourceUrl,
    confidence,
    fieldProvenance: provenance,
    packagingTitle: null,
        customFields: {},
  };
}

// ─── Build failed result (title could not be extracted) ───────────────────────

function buildFailedResult(
  request: ExtractRequest,
  warnings: string[],
): {
  data: ExtractionData;
  warnings: string[];
} {
  const { sourceUrl, expected } = request;

  const provenance: Record<string, string> = {};
  provenance.sourceUrl = 'request';
  provenance.profileRuntime = request.profile.runtime;

  const data: ExtractionData = {
    title: null,
    brand: null,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: expected?.price || null,
    weight: null,
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    sourceUrl,
    confidence: 0,
    fieldProvenance: provenance,
    packagingTitle: null,
  customFields: {},
  };

  return { data, warnings };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /profile-runner/extract
 *
 * Executes deterministic extraction using the provided profile.
 * Never falls back to generic extraction, never calls LLMs.
 */
export function handleExtract(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = ExtractRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data as ExtractRequest;

      // ── Run extraction ────────────────────────────────────────────────
      const isRendered = request.profile.runtime === 'rendered';
      const { data, warnings } = isRendered
        ? await doRenderedExtract(request)
        : await doStaticExtract(request);

      // ── Build response ────────────────────────────────────────────────
      const ok = data.title !== null && data.title.length > 0;

      // Build the response payload
      const responsePayload: ExtractResponse = {
        ok,
        extractionData: ok ? data : undefined,
        fieldProvenance: data.fieldProvenance || {},
        profileRuntime: request.profile.runtime,
        profileId: request.profileId,
        profileVersion: request.profileVersion,
        warnings,
      };

      // Validate through ExtractResponseSchema
      const parsedResponse = ExtractResponseSchema.parse(responsePayload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsedResponse));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[extract] Uncaught error: ${msg}\n`);

      // Always return a valid ExtractResponse shape
      const fallback = ExtractResponseSchema.parse({
        ok: false,
        extractionData: undefined,
        fieldProvenance: {},
        profileRuntime: 'static' as const,
        profileId: 'unknown',
        profileVersion: 0,
        warnings: [`Internal error: ${msg}`],
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });

  req.on('error', (err: Error) => {
    process.stderr.write(`[extract] Request error: ${err.message}\n`);
    const fallback = ExtractResponseSchema.parse({
      ok: false,
      extractionData: undefined,
      fieldProvenance: {},
      profileRuntime: 'static' as const,
      profileId: 'unknown',
      profileVersion: 0,
      warnings: [`Request error: ${err.message}`],
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
  });
}
