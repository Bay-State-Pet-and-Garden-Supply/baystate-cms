/**
 * Deterministic product field discovery module.
 *
 * Scans full and minimized HTML to discover extractable product data
 * fields without LLM assistance. Identifies structured data sources
 * (JSON-LD, microdata, meta/OG tags, Shopify product JSON) and
 * semantic DOM patterns (spec tables, nutrition panels, ingredients
 * lists, accordions, tabs, image galleries).
 *
 * Each discovered field carries a proposed CSS selector, the source
 * kind (json-ld, meta, microdata, html, shopify-json), stability,
 * and an extracted sample value so the phase 2 generator can make
 * informed decisions about what to propose.
 *
 * This module has zero Bun-only imports — safe for the Node.js
 * extraction worker.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { buildStableSelector, type Stability } from '../shared/selector-utils';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Source kind for a discovered field. */
export type DiscoverySourceKind =
  | 'json-ld'
  | 'meta'
  | 'microdata'
  | 'html'
  | 'shopify-json'
  | 'opengraph';

/** A single discovered product field. */
export interface DiscoveredField {
  /** Normalized field key (e.g. 'title', 'price', 'ingredients'). */
  fieldKey: string;
  /** Human-readable label. */
  label: string;
  /** Proposed CSS selector for this field. */
  selector: string;
  /** Stability of the proposed selector. */
  stability: Stability;
  /** Sample value extracted using the proposed selector. */
  sampleValue: string | null;
  /** Where this field was discovered. */
  sourceKind: DiscoverySourceKind;
  /** Confidence that this is the correct field (0-1). */
  confidence: number;
  /** Number of elements matched by the selector. */
  matchCount: number;
  /** Warnings about the discovery (e.g. multiple matches, empty value). */
  warnings: string[];
  /** Category hint for grouping (core, custom, variant). */
  category: 'core' | 'custom' | 'variant';
}

/** Result of a full field discovery scan. */
export interface DiscoveryResult {
  /** All discovered fields, ordered by confidence descending. */
  fields: DiscoveredField[];
  /** Complete list of image candidates discovered. */
  imageCandidates: string[];
  /** Discovered JSON-LD product data, if any. */
  jsonLdData: Record<string, unknown> | null;
  /** Discovered Shopify product JSON data, if any. */
  shopifyData: Record<string, unknown> | null;
  /** Page-level structure signals (e.g. 'shopify', 'woocommerce'). */
  pageSignals: string[];
  /** Inferred sitemap product URL pattern, if detectable. */
  inferredUrlPattern: string | null;
  /** Warnings about the overall discovery process. */
  warnings: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const JSON_LD_PATTERN = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

const PRODUCT_SCRIPT_PATTERNS = [
  /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/i,
  /window\.__STORE__\s*=\s*({[\s\S]*?});\s*<\/script>/i,
  /var\s+(?:productJSON|meta)\s*=\s*({[\s\S]*?});\s*$/m,
  /window\.productJSON\s*=\s*({[\s\S]*?});/i,
  /___product_data\s*=\s*({[\s\S]*?});/i,
];

/** Open Graph / meta field mappings. */
const OG_FIELD_MAP: Record<string, string> = {
  'og:title': 'title',
  'og:description': 'description',
  'og:image': 'primaryImage',
  'og:url': 'sourceUrl',
  'og:type': 'productType',
  'og:brand': 'brand',
  'og:price:amount': 'price',
  'og:price:currency': 'currency',
  'product:price:amount': 'price',
  'product:retailer_item_id': 'sku',
  'product:category': 'category',
};

/** Meta tag name-to-field mappings. */
const META_FIELD_MAP: Record<string, string> = {
  'description': 'description',
  'keywords': 'searchKeywords',
  'twitter:title': 'title',
  'twitter:description': 'description',
  'twitter:image': 'primaryImage',
  'twitter:data1': 'price',
  'twitter:label1': 'priceLabel',
};

/** itemprop attribute mappings. */
const ITEMPROP_FIELD_MAP: Record<string, string> = {
  'name': 'title',
  'description': 'description',
  'price': 'price',
  'priceCurrency': 'currency',
  'brand': 'brand',
  'sku': 'sku',
  'image': 'primaryImage',
  'weight': 'weight',
  'category': 'category',
  'gtin': 'gtin',
  'gtin12': 'gtin',
  'gtin13': 'gtin',
  'gtin14': 'gtin',
  'mpn': 'mpn',
};

/** Semantic class/id substrings mapped to field keys. */
const SEMANTIC_CLASS_MAP: Record<string, string> = {
  'ingredient': 'ingredients',
  'nutrition': 'guaranteedAnalysis',
  'calorie': 'calories',
  'feeding': 'feedingGuidelines',
  'weight': 'weight',
  'dimension': 'dimensions',
  'flavor': 'flavor',
  'flavour': 'flavor',
  'variety': 'flavor',
  'sku': 'sku',
  'sku-id': 'sku',
  'life-stage': 'lifeStage',
  'life_stage': 'lifeStage',
  'lifestage': 'lifeStage',
  'species': 'species',
  'dietary': 'dietaryLabels',
  'diet-label': 'dietaryLabels',
  'badge': 'dietaryLabels',
  'review': 'reviewsRating',
  'rating': 'reviewsRating',
  'size': 'size',
  'volume': 'weight',
  'count': 'count',
  'how-much': 'feedingGuidelines',
  'direction': 'feedingGuidelines',
};

/** Selectors for common product content sections. */
const CONTENT_SECTION_SELECTORS = [
  '[class*="ingredient"]',
  '[class*="nutrition"]',
  '[class*="feeding"]',
  '[class*="accordion"]',
  '[class*="tab"]',
  '[class*="panel"]',
  '[class*="spec"]',
  '[class*="details"]',
  '[class*="description"]',
  '[class*="product-info"]',
  '[class*="product-information"]',
];

// ─── Core Discovery Logic ───────────────────────────────────────────────────

/**
 * Extract JSON-LD product data from the HTML.
 */
function extractJsonLdData($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const html = $.html();
  let match: RegExpExecArray | null;
  JSON_LD_PATTERN.lastIndex = 0;
  while ((match = JSON_LD_PATTERN.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const data = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of data) {
        if (item['@type'] === 'Product' || item['@type'] === 'product') {
          return item as Record<string, unknown>;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract Shopify embedded product JSON from the HTML.
 */
function extractShopifyData($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const html = $.html();
  for (const pattern of PRODUCT_SCRIPT_PATTERNS) {
    const match = pattern.exec(html);
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());
        // Shopify __INITIAL_STATE__ usually has a product sub-key
        if (parsed.product) return parsed.product as Record<string, unknown>;
        if (parsed.products) return (parsed.products as unknown[])[0] as Record<string, unknown>;
        return parsed;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Extract Open Graph and standard meta tags.
 */
function extractMetaFields($: cheerio.CheerioAPI): DiscoveredField[] {
  const fields: DiscoveredField[] = [];

  // Open Graph meta tags
  $('meta[property]').each((_, el) => {
    const prop = $(el).attr('property')?.toLowerCase() ?? '';
    const content = $(el).attr('content')?.trim();
    const fieldKey = OG_FIELD_MAP[prop];
    if (fieldKey && content) {
      fields.push({
        fieldKey,
        label: prop,
        selector: `meta[property="${$(el).attr('property')}"]`,
        stability: 'high',
        sampleValue: content.slice(0, 200),
        sourceKind: 'opengraph',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: fieldKey === 'title' || fieldKey === 'description' || fieldKey === 'price' || fieldKey === 'brand' || fieldKey === 'primaryImage' ? 'core' : 'custom',
      });
    }
  });

  // Standard meta tags
  $('meta[name]').each((_, el) => {
    const name = $(el).attr('name')?.toLowerCase() ?? '';
    const content = $(el).attr('content')?.trim();
    const fieldKey = META_FIELD_MAP[name];
    if (fieldKey && content) {
      // Avoid duplicates with OG tags
      if (!fields.some(f => f.fieldKey === fieldKey && f.sourceKind === 'opengraph')) {
        fields.push({
          fieldKey,
          label: name,
          selector: `meta[name="${$(el).attr('name')}"]`,
          stability: 'high',
          sampleValue: content.slice(0, 200),
          sourceKind: 'meta',
          confidence: 0.85,
          matchCount: 1,
          warnings: [],
          category: fieldKey === 'title' || fieldKey === 'description' || fieldKey === 'price' || fieldKey === 'brand' ? 'core' : 'custom',
        });
      }
    }
  });

  return fields;
}

/**
 * Extract microdata (itemprop) fields.
 */
function extractMicrodataFields($: cheerio.CheerioAPI): DiscoveredField[] {
  const fields: DiscoveredField[] = [];

  $('[itemprop]').each((_, el) => {
    const itemprop = $(el).attr('itemprop')?.toLowerCase() ?? '';
    const fieldKey = ITEMPROP_FIELD_MAP[itemprop];
    if (!fieldKey) return;

    const text = $(el).text().trim();
    const content = $(el).attr('content')?.trim() ?? text;
    const tag = (el.tagName ?? '').toLowerCase();

    if (!content) return;

    const { selector, stability } = buildStableSelector($, el as Element);
    const matchCount = $(selector).length;

    // Avoid duplicates with meta/og fields
    if (fields.some(f => f.fieldKey === fieldKey)) return;

    fields.push({
      fieldKey,
      label: itemprop,
      selector,
      stability,
      sampleValue: content.slice(0, 200),
      sourceKind: 'microdata',
      confidence: stability === 'high' ? 0.95 : stability === 'medium' ? 0.8 : 0.6,
      matchCount,
      warnings: matchCount > 1 ? [`Selector matches ${matchCount} elements`] : [],
      category: fieldKey === 'title' || fieldKey === 'description' || fieldKey === 'price' || fieldKey === 'brand' || fieldKey === 'primaryImage' ? 'core' : 'custom',
    });
  });

  return fields;
}

/**
 * Discover fields from semantic DOM elements (class names, id attributes).
 */
function extractSemanticHtmlFields($: cheerio.CheerioAPI): DiscoveredField[] {
  const fields: DiscoveredField[] = [];
  const seenSelectors = new Set<string>();
  const accumulatedValues = new Map<string, string[]>();

  // Scan for matching semantic patterns in class and id attributes
  for (const [substring, fieldKey] of Object.entries(SEMANTIC_CLASS_MAP)) {
    // Build a selector that matches class or id containing the keyword
    const sel = `[class*="${substring}" i], [id*="${substring}" i]`;
    $(sel).each((_, el) => {
      const tag = ((el as any).tagName ?? '').toLowerCase();
      // Skip noisy tags
      if (['script', 'style', 'noscript', 'template', 'header', 'footer', 'nav'].includes(tag)) return;

      const text = $(el).text().trim();
      if (!text || text.length < 3) return;

      const { selector, stability } = buildStableSelector($, el as Element);
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);

      // Don't add fields that have already been discovered via meta/microdata
      if (fields.some(f => f.fieldKey === fieldKey)) return;

      const matchCount = $(selector).length;
      accumulatedValues.set(fieldKey, [...(accumulatedValues.get(fieldKey) ?? []), text]);
    });
  }

  // Also look at common heading elements for title
  $('h1').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || text.length < 3) return;
    if (fields.some(f => f.fieldKey === 'title')) return;
    const { selector, stability } = buildStableSelector($, el as Element);
    if (seenSelectors.has(selector)) return;
    seenSelectors.add(selector);
    fields.push({
      fieldKey: 'title',
      label: 'Product Title (h1)',
      selector,
      stability,
      sampleValue: text.slice(0, 200),
      sourceKind: 'html',
      confidence: 0.7,
      matchCount: $(selector).length,
      warnings: [],
      category: 'core',
    });
  });

  // Title via semantic class patterns
  for (const cls of ['product-title', 'product-name', 'product__title', 'pdp-title', 'product-single__title']) {
    if (fields.some(f => f.fieldKey === 'title')) break;
    const sel = `.${cls}, [class*="${cls}"]`;
    const $el = $(sel).first();
    if ($el.length === 0) continue;
    const text = $el.text().trim();
    if (!text) continue;
    const el = $el.get(0) as any | undefined;
    if (!el) continue;
    const { selector, stability } = buildStableSelector($, el as Element);
    if (seenSelectors.has(selector)) continue;
    seenSelectors.add(selector);
    fields.push({
      fieldKey: 'title',
      label: `Product Title (${cls})`,
      selector,
      stability,
      sampleValue: text.slice(0, 200),
      sourceKind: 'html',
      confidence: 0.75,
      matchCount: $(selector).length,
      warnings: [],
      category: 'core',
    });
  }

  // Accumulate structured table data (nutrition, specs)
  for (const [fieldKey, values] of accumulatedValues) {
    const bestValue = values.reduce((a, b) => a.length >= b.length ? a : b);
    // Only create field from accumulated values if we have good text
    if (bestValue.length > 5) {
      const firstSelector = [...seenSelectors].find(s => {
        try {
          const text = $(s).first().text().trim();
          return text === bestValue;
        } catch { return false; }
      });
      if (firstSelector) {
        fields.push({
          fieldKey,
          label: fieldKey.charAt(0).toUpperCase() + fieldKey.slice(1),
          selector: firstSelector,
          stability: 'medium',
          sampleValue: bestValue.slice(0, 200),
          sourceKind: 'html',
          confidence: 0.6,
          matchCount: 1,
          warnings: [],
          category: 'custom',
        });
      }
    }
  }

  // Image gallery discovery
  const gallerySelectors = [
    '.product__media-wrapper img',
    '.product__gallery img',
    '.product-single__media img',
    '.media-gallery img',
    '.product-gallery img',
    '.swiper-wrapper img',
    '.slick-slide img',
    '[class*="product-media"] img',
    '[class*="gallery"] img',
    '[data-media-gallery] img',
    '[data-product-media] img',
  ];

  for (const sel of gallerySelectors) {
    const images = $(sel);
    if (images.length >= 2 && !seenSelectors.has(sel)) {
      seenSelectors.add(sel);
      // Use the container selector instead of individual img selector
      const containerSel = sel.replace(/ img$/, '');
      fields.push({
        fieldKey: 'images',
        label: 'Product Images',
        selector: containerSel,
        stability: 'medium',
        sampleValue: `${images.length} image(s) found`,
        sourceKind: 'html',
        confidence: 0.7,
        matchCount: $(containerSel).length,
        warnings: [],
        category: 'core',
      });
    }
  }

  return fields;
}

/**
 * Attempt to infer a sitemap product URL pattern from the page URL and
 * discovered links/anchors.
 */
function inferUrlPattern($: cheerio.CheerioAPI, baseUrl?: string): string | null {
  // Check if this looks like a Shopify URL
  if (baseUrl && /\/products\//.test(baseUrl)) {
    return '/products/[^/]+';
  }
  // Check href patterns on the page
  const productLinks = $('a[href*="/products/"], a[href*="/product/"], a[href*="/p/"]');
  if (productLinks.length > 0) {
    const href = $(productLinks.first()).attr('href') ?? '';
    if (href.includes('/products/')) return '/products/[^/]+';
    if (href.includes('/product/')) return '/product/[^/]+';
    if (href.includes('/p/')) return '/p/[^/]+';
  }
  // Check for WooCommerce-style
  const wooLinks = $('a[href*="/shop/"], a[href*="/product/"]');
  if (wooLinks.length > 0) return '/product/[^/]+';

  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scan HTML and discover all extractable product fields.
 *
 * Runs multiple discovery strategies in parallel and merges results:
 * 1. JSON-LD structured data extraction
 * 2. Shopify embedded product JSON
 * 3. Open Graph and meta tag extraction
 * 4. Microdata (itemprop) extraction
 * 5. Semantic HTML class/id pattern matching
 * 6. Image gallery discovery
 * 7. URL pattern inference
 *
 * Results are deduplicated by field key (later strategies are skipped
 * when a high-confidence earlier strategy already found the field).
 */
export function discoverFields(
  html: string,
  options?: { baseUrl?: string; fullHtml?: string },
): DiscoveryResult {
  const $ = cheerio.load(html);
  const fullHtml = options?.fullHtml ?? html;
  const allFields: DiscoveredField[] = [];
  const pageSignals: string[] = [];
  const warnings: string[] = [];
  const discoveredKeys = new Set<string>();

  // Phase 1: JSON-LD
  const jsonLdData = extractJsonLdData($);
  if (jsonLdData) {
    pageSignals.push('json-ld');
    const name = jsonLdData.name as string | undefined;
    if (name && !discoveredKeys.has('title')) {
      discoveredKeys.add('title');
      allFields.push({
        fieldKey: 'title',
        label: 'Product Name',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: (name as string).slice(0, 200),
        sourceKind: 'json-ld',
        confidence: 0.95,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const desc = jsonLdData.description as string | undefined;
    if (desc && !discoveredKeys.has('description')) {
      discoveredKeys.add('description');
      allFields.push({
        fieldKey: 'description',
        label: 'Description',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: desc.slice(0, 200),
        sourceKind: 'json-ld',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const image = jsonLdData.image as string | string[] | undefined;
    if (image && !discoveredKeys.has('primaryImage')) {
      const imgUrl = Array.isArray(image) ? image[0] : image;
      if (typeof imgUrl === 'string') {
        discoveredKeys.add('primaryImage');
        allFields.push({
          fieldKey: 'primaryImage',
          label: 'Primary Image',
          selector: 'script[type="application/ld+json"]',
          stability: 'high',
          sampleValue: imgUrl.slice(0, 200),
          sourceKind: 'json-ld',
          confidence: 0.85,
          matchCount: 1,
          warnings: [],
          category: 'core',
        });
      }
    }
    // JSON-LD price
    const offers = jsonLdData.offers as Record<string, unknown> | undefined;
    if (offers && typeof offers.price === 'string' && !discoveredKeys.has('price')) {
      discoveredKeys.add('price');
      allFields.push({
        fieldKey: 'price',
        label: 'Price',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: (offers.price as string).slice(0, 200),
        sourceKind: 'json-ld',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const brand = jsonLdData.brand as Record<string, unknown> | string | undefined;
    let brandName: string | null = null;
    if (typeof brand === 'string') brandName = brand;
    else if (brand && typeof brand.name === 'string') brandName = brand.name;
    if (brandName && !discoveredKeys.has('brand')) {
      discoveredKeys.add('brand');
      allFields.push({
        fieldKey: 'brand',
        label: 'Brand',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: brandName,
        sourceKind: 'json-ld',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const sku = jsonLdData.sku as string | undefined;
    if (sku && !discoveredKeys.has('sku')) {
      discoveredKeys.add('sku');
      allFields.push({
        fieldKey: 'sku',
        label: 'SKU',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: sku,
        sourceKind: 'json-ld',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'custom',
      });
    }
    const gtin = (jsonLdData.gtin12 ?? jsonLdData.gtin13 ?? jsonLdData.gtin14 ?? jsonLdData.gtin) as string | undefined;
    if (gtin && !discoveredKeys.has('gtin')) {
      discoveredKeys.add('gtin');
      allFields.push({
        fieldKey: 'gtin',
        label: 'GTIN/UPC',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: gtin,
        sourceKind: 'json-ld',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'custom',
      });
    }
    const weight = jsonLdData.weight as Record<string, unknown> | string | undefined;
    if (weight && !discoveredKeys.has('weight')) {
      const weightStr = typeof weight === 'string' ? weight : (weight.value as string);
      if (weightStr) {
        discoveredKeys.add('weight');
        allFields.push({
          fieldKey: 'weight',
          label: 'Weight',
          selector: 'script[type="application/ld+json"]',
          stability: 'high',
          sampleValue: String(weightStr),
          sourceKind: 'json-ld',
          confidence: 0.85,
          matchCount: 1,
          warnings: [],
          category: 'custom',
        });
      }
    }
  }

  // Phase 2: Shopify embedded product JSON
  const shopifyData = extractShopifyData($);
  if (shopifyData) {
    pageSignals.push('shopify');
    const title = shopifyData.title as string | undefined;
    if (title && !discoveredKeys.has('title')) {
      discoveredKeys.add('title');
      allFields.push({
        fieldKey: 'title',
        label: 'Product Name (Shopify)',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: title.slice(0, 200),
        sourceKind: 'shopify-json',
        confidence: 0.95,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const shopDesc = shopifyData.description as string | undefined;
    if (shopDesc && !discoveredKeys.has('description')) {
      discoveredKeys.add('description');
      allFields.push({
        fieldKey: 'description',
        label: 'Description (Shopify)',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: shopDesc.slice(0, 200),
        sourceKind: 'shopify-json',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const vendor = shopifyData.vendor as string | undefined;
    if (vendor && !discoveredKeys.has('brand')) {
      discoveredKeys.add('brand');
      allFields.push({
        fieldKey: 'brand',
        label: 'Vendor/Brand',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: vendor,
        sourceKind: 'shopify-json',
        confidence: 0.9,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const shopImages = shopifyData.images as string[] | undefined;
    if (Array.isArray(shopImages) && shopImages.length > 0 && !discoveredKeys.has('images')) {
      discoveredKeys.add('images');
      allFields.push({
        fieldKey: 'images',
        label: 'Product Images',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: `${shopImages.length} image(s) available`,
        sourceKind: 'shopify-json',
        confidence: 0.85,
        matchCount: 1,
        warnings: [],
        category: 'core',
      });
    }
    const productType = shopifyData.type as string | undefined;
    if (productType && !discoveredKeys.has('productType')) {
      discoveredKeys.add('productType');
      allFields.push({
        fieldKey: 'productType',
        label: 'Product Type',
        selector: 'script[type="application/ld+json"]',
        stability: 'high',
        sampleValue: productType,
        sourceKind: 'shopify-json',
        confidence: 0.85,
        matchCount: 1,
        warnings: [],
        category: 'custom',
      });
    }
  }

  // Phase 3: Meta/OG tags (only for fields not yet discovered)
  const metaFields = extractMetaFields($);
  for (const field of metaFields) {
    if (!discoveredKeys.has(field.fieldKey)) {
      discoveredKeys.add(field.fieldKey);
      allFields.push(field);
    }
  }

  // Phase 4: Microdata (only for fields not yet discovered)
  const microdataFields = extractMicrodataFields($);
  for (const field of microdataFields) {
    if (!discoveredKeys.has(field.fieldKey)) {
      discoveredKeys.add(field.fieldKey);
      allFields.push(field);
    }
  }

  // Phase 5: Semantic HTML (only for fields not yet discovered)
  const htmlFields = extractSemanticHtmlFields($);
  for (const field of htmlFields) {
    if (!discoveredKeys.has(field.fieldKey)) {
      discoveredKeys.add(field.fieldKey);
      allFields.push(field);
    }
  }

  // Phase 6: URL pattern inference
  const inferredUrlPattern = inferUrlPattern($, options?.baseUrl);

  // Detect page platform signals
  if (fullHtml.includes('shopify.com') || fullHtml.includes('myshopify.com')) {
    pageSignals.push('shopify-platform');
  }
  if (fullHtml.includes('wp-content') || fullHtml.includes('woocommerce')) {
    pageSignals.push('woocommerce');
  }
  if (fullHtml.includes('bigcommerce.com') || fullHtml.includes('bigcommerce')) {
    pageSignals.push('bigcommerce');
  }

  // Collect image candidates from the page
  const imageCandidates: string[] = [];
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('data:') && !src.startsWith('blob:') && !src.endsWith('.svg')) {
      const absUrl = options?.baseUrl ? tryResolve(src, options.baseUrl) : src;
      if (absUrl && !imageCandidates.includes(absUrl)) {
        imageCandidates.push(absUrl);
      }
    }
  });

  // Sort: core fields first, then by confidence descending
  allFields.sort((a, b) => {
    if (a.category !== b.category) return a.category === 'core' ? -1 : 1;
    return b.confidence - a.confidence;
  });

  return {
    fields: allFields,
    imageCandidates: imageCandidates.slice(0, 20),
    jsonLdData,
    shopifyData,
    pageSignals,
    inferredUrlPattern,
    warnings,
  };
}

function tryResolve(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Merge discovered fields into a seed preview object suitable for
 * the profile generator's expected context.
 */
export function discoveryToSeedPreview(
  result: DiscoveryResult,
): {
  title: string | null;
  description: string | null;
  brand: string | null;
  price: string | null;
  images: string[];
  inferredUrlPattern: string | null;
  pageSignals: string[];
} {
  const getValue = (key: string): string | null => {
    const field = result.fields.find(f => f.fieldKey === key);
    return field?.sampleValue ?? null;
  };

  return {
    title: getValue('title'),
    description: getValue('description'),
    brand: getValue('brand'),
    price: getValue('price'),
    images: result.imageCandidates.slice(0, 10),
    inferredUrlPattern: result.inferredUrlPattern,
    pageSignals: result.pageSignals,
  };
}
