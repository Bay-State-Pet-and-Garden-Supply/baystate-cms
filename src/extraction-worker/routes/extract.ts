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
import * as cheerio from 'cheerio';
import type { Element, AnyNode } from 'domhandler';
import { runRenderedPage } from '../browser/rendered-page-runner';
import { loadWorkerBrowserConfig } from '../browser/config';
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
  el: Element | unknown,
): string[] {
  const sources: string[] = [];
  const $el = $(el as AnyNode);
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


/** Strip query params from an image URL for deduplication. */
function canonicalImageUrl(url: string): string {
  try { return url.split('?')[0].split('#')[0]; } catch { return url; }
}

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
      if (!absolute) continue;
      const canonical = canonicalImageUrl(absolute);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        images.push(absolute);
      }
    }
  });
  // Cap at 30 images to prevent gallery explosions
  if (images.length > 30) images.length = 30;
  return images;
}

// ─── Helper: evaluate a text selector in Playwright ──────────────────────────

function makeTextSelectorEvaluator(sel: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      return el ? (el.textContent || '').trim() : '';
    })()
  `;
}

// ─── Helper: extract JSON-LD from Playwright ─────────────────────────────────

function makePlaywrightJsonLdExtractor(): string {
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
        } catch (e) { /* skip invalid JSON */ }
      }
      return results;
    })()
  `;
}

// ─── Helper: extract meta tags from Playwright ───────────────────────────────

function makePlaywrightMetaExtractor(): string {
  return `
    (() => {
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
    })()
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
      // Concatenate optional title selectors (e.g. subheadings, taglines)
      const toSel = request.profile.titleOptionalSelectors;
      if (toSel && toSel.length > 0) {
        const extras = toSel
          .map(sel => $(sel).first().text().trim())
          .filter(Boolean)
          .join(' — ');
        if (extras) {
          title += ' — ' + extras;
        }
      }
    } else {
      warnings.push(`titleSelector "${titleSelector}" returned empty — failing extraction`);
      return buildFailedResult(request, warnings);
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
    } else {
      warnings.push(`descriptionSelector "${descriptionSelector}" returned empty — failing extraction`);
      return buildFailedResult(request, warnings);
    }
  } else {
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
    } else {
      warnings.push(`priceSelector "${priceSelector}" returned empty — failing extraction`);
      return buildFailedResult(request, warnings);
    }
  } else {
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
    } else {
      warnings.push(`imagesSelector "${imagesSelector}" returned empty — failing extraction`);
      return buildFailedResult(request, warnings);
    }
  } else {
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
  if (profile.customSelectors) {
    for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
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
  if (Object.keys(customFields).length > 0) {
    data.customFields = customFields;
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

  // The runner + extractor is wrapped so we can lazily pull selectors into
  // the Playwright callback without serialising the whole request object.
  const runnerConfig = loadWorkerBrowserConfig();

  const result = await runRenderedPage(
    {
      url: sourceUrl,
      navigationTimeoutMs: RENDERED_NAVIGATE_TIMEOUT_MS,
      dwellMs: RENDERED_DWELL_MS,
    },
    async ({ page }, dwellMs) => {
      // Dwell for dynamic content before any checks or extraction.
      // This allows JS-rendered content to appear and improves
      // Cloudflare pass-through by simulating real user behavior.
      await page.waitForTimeout(dwellMs);

      // ── Apply variant selection strategy if present ──────────────
      // Before extracting fields, try to select the correct variant
      // matching expected product hints (name/upc). This must be
      // deterministic — never guess.
      const variantStrategy = request.profile.variantSelectionStrategy;
      if (variantStrategy && variantStrategy.containerSelector) {
        let variantSelected = false;
        const strategyDesc = `${variantStrategy.optionType} on ${variantStrategy.containerSelector}`;
        const expectedName = request.expected?.name?.toLowerCase() || '';
        const expectedUpc = request.expected?.upc?.toLowerCase() || '';
        const hints = [expectedName, expectedUpc].filter(Boolean);
        const hintText = hints.join(' ');
        try {

          if (variantStrategy.optionType === 'dropdown') {
            // For dropdown select: find option whose text matches expected name
            const selected = await page.evaluate(
              `((containerSel, hint) => {
                const container = document.querySelector(containerSel);
                if (!container) return false;
                const selects = container.tagName === 'SELECT'
                  ? [container]
                  : Array.from(container.querySelectorAll('select'));
                if (selects.length === 0) return false;
                const select = selects[0];
                for (const opt of Array.from(select.options)) {
                  const txt = (opt.textContent || '').trim().toLowerCase();
                  if (hint && (txt.includes(hint) || hint.includes(txt))) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
                return false;
              })(${JSON.stringify(variantStrategy.containerSelector)}, ${JSON.stringify(hintText)})`
            );
            if (selected) {
              variantSelected = true;
              await page.waitForTimeout(300);
            }
          } else if (variantStrategy.optionType === 'button_group' || variantStrategy.optionType === 'radio') {
            // For button/radio group: click the button whose text matches expected name
            const selected = await page.evaluate(
              `((containerSel, hint) => {
                const container = document.querySelector(containerSel);
                if (!container) return false;
                const buttons = container.querySelectorAll('button, [role="button"], [role="radio"], input[type="radio"] + label');
                for (const btn of buttons) {
                  const txt = (btn.textContent || '').trim().toLowerCase();
                  if (hint && (txt.includes(hint) || hint.includes(txt))) {
                    if (btn.tagName === 'INPUT' && btn.type === 'radio') {
                      btn.checked = true;
                    } else {
                      (btn).click();
                    }
                    return true;
                  }
                }
                return false;
              })(${JSON.stringify(variantStrategy.containerSelector)}, ${JSON.stringify(hintText)})`
            );
            if (selected) {
              variantSelected = true;
              await page.waitForTimeout(300);
            }
          }
        } catch (err) {
          warnings.push(`Variant selection via ${strategyDesc} encountered an error: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!variantSelected && hints.length > 0) {
          warnings.push(`Variant selection via ${strategyDesc} did not match any option for expected "${hints.join(', ')}" — failing extraction`);
          return buildFailedResult(request, warnings);
        }
      }

      // ── Detect Cloudflare / WAF challenge pages early ────────────────
      const pageTitle = await page.title();
      if (
        !pageTitle ||
        pageTitle.includes('Just a moment') ||
        pageTitle.includes('Cloudflare') ||
        pageTitle.includes('Attention Required') ||
        pageTitle.includes('verify you are human')
      ) {
        // Return a sentinel so the caller knows it was blocked
        return {
          blocked: true as const,
          title: null, brand: null, description: null,
          price: null, primaryImage: null, additionalImages: [] as string[],
          provenance: {} as Record<string, string>,
          customFields: {} as Record<string, string>,
        };
      }

      const finalUrl = page.url();

      // ── Block only trackers (not images/fonts/styles — those help
      //     Cloudflare fingerprinting and are needed for profile selectors)
      await page.route('**/*', async (route) => {
        const req = route.request();
        const reqUrl = req.url();
        if (
          /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(reqUrl)
        ) {
          await route.abort();
        } else {
          await route.continue();
        }
      });

      // ── Extract JSON-LD ──────────────────────────────────────────────
      let jsonLd: Record<string, unknown> | null = null;
      try {
        const jsonLdArray: Record<string, unknown>[] = await page.evaluate(
          makePlaywrightJsonLdExtractor(),
        );
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
      } catch {
        // non-critical
      }

      // ── Extract meta tags ───────────────────────────────────────────
      let metaTags: Record<string, string> = {};
      try {
        metaTags = await page.evaluate(makePlaywrightMetaExtractor());
      } catch {
        // non-critical
      }

      // ── Selector helpers ────────────────────────────────────────────
      const titleSelector = selectors['titleSelector'] || selectors['title'] || null;
      const brandSelector = selectors['brandSelector'] || selectors['brand'] || null;
      const descriptionSelector = selectors['descriptionSelector'] || selectors['description'] || null;
      const priceSelector = selectors['priceSelector'] || selectors['price'] || null;
      const imagesSelector = selectors['imagesSelector'] || selectors['images'] || selectors['imageSelector'] || selectors['image'] || null;

      const evalText = async (sel: string): Promise<string> => {
        try {
          return await page.evaluate(makeTextSelectorEvaluator(sel));
        } catch {
          return '';
        }
      };

      // ── Title ────────────────────────────────────────────────────────
      let title: string | null = null;
      const titleProvenance: string[] = [];

      if (titleSelector) {
        title = await evalText(titleSelector);
        if (title) {
          titleProvenance.push('profile-selector');
          // Concatenate optional title selectors (e.g. subheadings, taglines)
          const toSel = request.profile.titleOptionalSelectors;
          if (toSel && toSel.length > 0) {
            for (const sel of toSel) {
              const extra = await evalText(sel);
              if (extra) {
                title += ' — ' + extra;
              }
            }
          }
        } else {
          warnings.push(`titleSelector "${titleSelector}" returned empty — failing extraction`);
          return buildFailedResult(request, warnings);
        }
      } else {
        title =
          (jsonLd?.name as string) ||
          metaTags['og:title'] ||
          metaTags['page:title'] ||
          null;
        if (title) {
          const src = title === jsonLd?.name ? 'json-ld' : 'meta';
          titleProvenance.push(src);
        }
      }

      // ── Brand ─────────────────────────────────────────────────────────
      let brand: string | null = null;
      let brandProvenance = '';
      if (brandSelector) {
        brand = await evalText(brandSelector);
        if (brand) brandProvenance = 'profile-selector';
      }
      if (!brand) {
        const jb = jsonLd?.brand as Record<string, unknown> | string | undefined;
        const bfj = typeof jb === 'string' ? jb : (jb as Record<string, unknown>)?.name as string | undefined;
        if (bfj) { brand = bfj; brandProvenance = 'json-ld'; }
      }

      // ── Description ──────────────────────────────────────────────────
      let description: string | null = null;
      let descriptionProvenance = '';
      if (descriptionSelector) {
        description = await evalText(descriptionSelector);
        if (description) {
          descriptionProvenance = 'profile-selector';
        } else {
          warnings.push(`descriptionSelector "${descriptionSelector}" returned empty — failing extraction`);
          return buildFailedResult(request, warnings);
        }
      } else {
        description =
          (jsonLd?.description as string) ||
          metaTags['og:description'] ||
          metaTags['description'] ||
          null;
        if (description) descriptionProvenance = 'json-ld';
      }

      // ── Price ─────────────────────────────────────────────────────────
      let price: string | null = null;
      let priceProvenance = '';
      if (expected?.price) {
        price = expected.price;
        priceProvenance = 'spreadsheet-import';
      } else if (priceSelector) {
        price = await evalText(priceSelector);
        if (price) {
          priceProvenance = 'profile-selector';
          const m = price.match(/\$?(\d+\.?\d*)/);
          if (m) price = m[0];
        } else {
          warnings.push(`priceSelector "${priceSelector}" returned empty — failing extraction`);
          return buildFailedResult(request, warnings);
        }
      } else {
        const offers = jsonLd?.offers as Record<string, unknown> | undefined;
        price = (offers?.price as string) || metaTags['product:price:amount'] || null;
        if (price) priceProvenance = offers?.price ? 'json-ld' : 'meta';
      }

      // ── Images from selector ────────────────────────────────────────
      let primaryImage: string | null = null;
      const additionalImages: string[] = [];
      let imageProvenance = '';

      if (imagesSelector) {
        try {
          const rawImages: string[] = await page.evaluate(
            `((sel, baseUrl) => {
              const seen = new Set();
              const images = [];
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const targets = el.tagName === 'IMG' || el.tagName === 'SOURCE'
                  ? [el]
                  : Array.from(el.querySelectorAll('img,source'));
                for (const target of targets) {
                  const tryAdd = (src) => {
                    if (!src) return;
                    const t = src.trim();
                    if (!t) return;
                    const l = t.toLowerCase();
                    if (l.startsWith('data:')) return;
                    if (l.startsWith('blob:')) return;
                    const p = l.split(/[?#]/)[0];
                    if (p.endsWith('.svg')) return;
                    if (seen.has(p)) return;
                    seen.add(p);
                    images.push(t);
                  };
                  if (target.tagName === 'IMG') tryAdd(target.currentSrc);
                  for (const attr of ['src','data-src','data-lazy-src','data-original','data-image','data-zoom-image']) {
                    tryAdd(target.getAttribute(attr));
                  }
                  for (const attr of ['srcset','data-srcset']) {
                    const srcset = target.getAttribute(attr);
                    if (srcset) {
                      for (const part of srcset.split(',')) {
                        const url = part.trim().split(' ')[0];
                        if (url && !url.startsWith('data:')) {
                          const lUrl = url.toLowerCase();
                          const p = lUrl.split(/[?#]/)[0];
                          if (!seen.has(p)) {
                            seen.add(p);
                            images.push(url);
                          }
                        }
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
            additionalImages.push(...rawImages.slice(1).slice(0, 29));
            imageProvenance = 'profile-selector';
          } else {
            warnings.push(`imagesSelector "${imagesSelector}" returned empty — failing extraction`);
            return buildFailedResult(request, warnings);
          }
        } catch (err: any) {
          warnings.push(`imagesSelector "${imagesSelector}" evaluation failed: ${err.message} — failing extraction`);
          return buildFailedResult(request, warnings);
        }
      } else {
        // Fallback images from JSON-LD / meta
        if (!primaryImage && jsonLd?.image) {
          const img = jsonLd.image as string | string[];
          const url = Array.isArray(img) ? img[0] : img;
          const resolved = resolveUrl(url, finalUrl);
          if (resolved) { primaryImage = resolved; imageProvenance = 'json-ld'; }
        }
        if (!primaryImage && metaTags['og:image']) {
          const resolved = resolveUrl(metaTags['og:image'], finalUrl);
          if (resolved) { primaryImage = resolved; imageProvenance = 'meta'; }
        }
      }

      // ── Custom selectors ────────────────────────────────────────────
      const customFields: Record<string, string> = {};
      if (profile.customSelectors) {
        for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
          if (!selector) continue;
          const val = await evalText(selector);
          if (val) customFields[fieldName] = val;
        }
      }

      // ── Build provenance ────────────────────────────────────────────
      const provenance: Record<string, string> = {};
      if (title) provenance.title = titleProvenance[0] || 'json-ld';
      if (brand) provenance.brand = brandProvenance;
      if (description) provenance.description = descriptionProvenance;
      if (price) provenance.price = priceProvenance;
      if (primaryImage) provenance.primaryImage = imageProvenance;
      if (additionalImages.length > 0) provenance.additionalImages = imageProvenance;
      if (sourceUrl) provenance.sourceUrl = 'request';
      provenance.profileRuntime = 'rendered';
      if (Object.keys(customFields).length > 0) provenance.customFields = 'profile-selector';

      return {
        blocked: false as const,
        title: title ?? null,
        brand: brand ?? null,
        description: description ?? null,
        price: price ?? null,
        primaryImage: primaryImage ?? null,
        additionalImages,
        provenance,
        customFields,
      };
    },
    runnerConfig,
  );

  // ── Handle runner failure (could not launch / navigate) ──────────────
  if (!result.ok) {
    warnings.push(`Rendered extraction failed: ${result.error}`);
    return buildFailedResult(request, warnings);
  }

  const extracted = result.data;

  if ('data' in extracted) {
    return extracted;
  }

  // ── Cloudflare block detection ───────────────────────────────────────
  if (extracted.blocked) {
    warnings.push('Page appears to be blocked by Cloudflare or WAF');
    return buildFailedResult(request, warnings);
  }

  // ── Hard fail when no title extracted ────────────────────────────────
  const title = extracted.title;
  if (!title) {
    warnings.push('Title could not be extracted — returning ok: false');
    return buildFailedResult(request, warnings);
  }

  const data = buildExtractionData(
    {
      title,
      brand: extracted.brand,
      description: extracted.description,
      price: extracted.price,
      primaryImage: extracted.primaryImage,
      additionalImages: extracted.additionalImages,
      provenance: extracted.provenance,
    },
    sourceUrl,
    expected.name,
  );

  // Merge custom fields into result
  if (Object.keys(extracted.customFields).length > 0) {
    (data as ExtractionData).customFields = extracted.customFields;
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
    packagingOcrData: null,
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
    packagingOcrData: null,
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
