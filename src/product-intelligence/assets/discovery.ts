/**
 * Deterministic image-candidate discovery parsers (PI-6).
 *
 * Consumes structured extraction artifacts — JSON-LD image values, Shopify
 * and WooCommerce variant-image mappings, and #29-style captured network
 * responses — and normalizes every candidate with full provenance (source
 * page, exact source path, artifact id, extraction method, variant mapping,
 * retrieval timestamp). Every parser is pure and network-free; malformed
 * input yields `[]`, never a throw.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import { sha256Hex } from '../../shared/stable-id';
import type { DiscoveredImageCandidate, NetworkCaptureArtifact } from './schema';

const IMAGE_KEYS = new Set(['image', 'images', 'imageurl', 'featuredimage', 'thumbnail', 'thumbnails', 'productimage', 'primaryimage']);

const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

function isoNow(): string {
  return new Date().toISOString();
}

/** Absolute-ize a URL against the page URL (handles protocol-relative //cdn...). */
function absolutize(raw: string, pageUrl: string): string | null {
  try {
    const base = new URL(pageUrl);
    if (raw.startsWith('//')) return `https:${raw}`;
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function toCandidate(
  rawUrl: unknown,
  pageUrl: string,
  sourcePath: string,
  sourceArtifactId: string,
  method: DiscoveredImageCandidate['extractionMethod'],
  variant: { reference: string | null; name: string | null } = { reference: null, name: null },
): DiscoveredImageCandidate | null {
  if (typeof rawUrl !== 'string') return null;
  const url = absolutize(rawUrl, pageUrl);
  if (!url) return null;
  return {
    url,
    sourcePageUrl: pageUrl,
    sourcePath,
    sourceArtifactId,
    extractionMethod: method,
    variantReference: variant.reference,
    variantName: variant.name,
    retrievedAt: isoNow(),
  };
}

/** Recursively collect image urls from a parsed JSON structure. */
function walkImages(
  node: unknown,
  pageUrl: string,
  sourcePath: string,
  artifactId: string,
  method: DiscoveredImageCandidate['extractionMethod'],
  out: DiscoveredImageCandidate[],
  depth = 0,
  imageContext = false,
): void {
  if (depth > 8 || out.length >= 64) return;
  if (Array.isArray(node)) {
    for (const item of node) walkImages(item, pageUrl, sourcePath, artifactId, method, out, depth + 1, imageContext);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;

  // Url-bearing nodes inside an image context: { url } / ImageObject.
  const urlValue = (record.url ?? record.contentUrl ?? record.src) as unknown;
  if (imageContext && typeof urlValue === 'string') {
    const candidate = toCandidate(urlValue, pageUrl, `${sourcePath}[url]`, artifactId, method, {
      reference: firstId(record),
      name: firstString(record, ['name', 'title']),
    });
    if (candidate) out.push(candidate);
  }

  // Image-named keys: string, array of strings, or image objects.
  for (const [key, value] of Object.entries(record)) {
    if (!IMAGE_KEYS.has(key.toLowerCase())) continue;
    const images = Array.isArray(value) ? value : [value];
    for (const entry of images) {
      if (typeof entry === 'string') {
        const candidate = toCandidate(entry, pageUrl, `${sourcePath}.${key}`, artifactId, method, {
          reference: firstId(record),
          name: firstString(record, ['name', 'title']),
        });
        if (candidate) out.push(candidate);
      } else if (entry !== null && typeof entry === 'object') {
        walkImages(entry, pageUrl, `${sourcePath}.${key}`, artifactId, method, out, depth + 1, true);
      }
    }
  }

  // Recurse into nested containers (variants, offers, @graph).
  for (const [key, value] of Object.entries(record)) {
    if (IMAGE_KEYS.has(key.toLowerCase())) continue;
    if (value !== null && typeof value === 'object') {
      walkImages(value, pageUrl, sourcePath, artifactId, method, out, depth + 1, false);
    }
  }
}

function firstId(record: Record<string, unknown>): string | null {
  for (const key of ['sku', 'gtin', 'mpn', 'id', 'variation_id', 'product_id'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Extract a balanced JSON object for a top-level key (e.g. `"product": {...}`)
 * without requiring the whole page to be JSON. String-aware brace counting
 * makes this resilient to nested objects and escaped quotes.
 */
export function extractBalancedObject(input: string, key: string): string | null {
  const keyIdx = input.indexOf(`"${key}"`);
  if (keyIdx < 0) return null;
  const colonIdx = input.indexOf(':', keyIdx);
  const start = input.indexOf('{', colonIdx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/**
 * Parse JSON-LD `image` values (string, array, or ImageObject) including
 * variant structures. Every candidate records the JSON-LD key as its source
 * path and the script-block content hash as its artifact id.
 */
export function parseJsonLdImages(html: string, pageUrl: string, retrievedAt?: string): DiscoveredImageCandidate[] {
  const out: DiscoveredImageCandidate[] = [];
  const blocks = [...html.matchAll(SCRIPT_RE)];
  for (const match of blocks) {
    const raw = match[1] ?? '';
    if (!/application\/ld\+json/.test(match[0]) && !raw.trim().startsWith('{') && !raw.trim().startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const artifactId = sha256Hex(raw).slice(0, 24);
    walkImages(parsed, pageUrl, 'json_ld', artifactId, 'json_ld', out);
  }
  if (retrievedAt) {
    for (const candidate of out) candidate.retrievedAt = retrievedAt;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shopify embedded state
// ---------------------------------------------------------------------------

interface ShopifyVariant {
  id?: number | string;
  title?: string;
  option1?: string;
  option2?: string;
  option3?: string;
  sku?: string;
  image_id?: number | string;
  image?: { src?: string; url?: string };
}

interface ShopifyImage {
  id?: number | string;
  src?: string;
  url?: string;
  /** Variant ids that share this image (Shopify `variants` sub-array). */
  variants?: Array<number | string | { id?: number | string }>;
}

/**
 * Parse Shopify embedded product state: `Shopify.ProductVariants` +
 * `Shopify.ProductImages` (variant-to-image mapping via image_id), and inline
 * `product` JSON with variants/images. extractionMethod 'platform_api'.
 */
export function parseShopifyVariantImages(html: string, pageUrl: string, retrievedAt?: string): DiscoveredImageCandidate[] {
  const out: DiscoveredImageCandidate[] = [];
  const blocks = [...html.matchAll(SCRIPT_RE)];
  for (const match of blocks) {
    const raw = match[1] ?? '';
    const artifactId = sha256Hex(raw).slice(0, 24);
    if (!artifactId) continue;

    // Inline product JSON: {"product": {"variants": [...], "images": [...]}}.
    const productJson = extractBalancedObject(raw, 'product');
    let product: Record<string, unknown> | null = null;
    if (productJson) {
      try {
        const parsed = JSON.parse(productJson) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') product = parsed;
      } catch {
        product = null;
      }
    }
    if (product && Array.isArray(product.variants)) {
      for (const variant of product.variants as ShopifyVariant[]) {
        const image = variant.image?.src ?? variant.image?.url ?? null;
        if (image) {
          const candidate = toCandidate(image, pageUrl, 'product.variants[].image.src', artifactId, 'platform_api', {
            reference: variant.id != null ? String(variant.id) : (variant.sku ?? null),
            name: variant.title ?? ([variant.option1, variant.option2, variant.option3].filter(Boolean).join(' ') || null),
          });
          if (candidate) out.push(candidate);
        }
      }
    }

    // Shopify.ProductVariants / Shopify.ProductImages.
    const variantsMatch = /ProductVariants\s*=\s*(\[[\s\S]*?\])/.exec(raw);
    const imagesMatch = /ProductImages\s*=\s*(\[[\s\S]*?\])/.exec(raw);
    let variants: ShopifyVariant[] = [];
    let images: ShopifyImage[] = [];
    if (variantsMatch) {
      try {
        variants = JSON.parse(variantsMatch[1]) as ShopifyVariant[];
      } catch {
        variants = [];
      }
    }
    if (imagesMatch) {
      try {
        images = JSON.parse(imagesMatch[1]) as ShopifyImage[];
      } catch {
        images = [];
      }
    }
    const imageByVariant = new Map<number | string, ShopifyImage>();
    for (const image of images) {
      if (image.id != null) imageByVariant.set(String(image.id), image);
      for (const vid of image.variants ?? []) {
        const id = typeof vid === 'object' && vid !== null ? (vid as { id?: number | string }).id : vid;
        if (id != null) imageByVariant.set(String(id), image);
      }
    }
    for (const variant of variants) {
      const image =
        variant.image ?? (variant.image_id != null ? imageByVariant.get(String(variant.image_id)) : undefined);
      const src = image?.src ?? image?.url ?? null;
      if (src) {
        const candidate = toCandidate(src, pageUrl, 'Shopify.ProductVariants[].image', artifactId, 'platform_api', {
          reference: variant.id != null ? String(variant.id) : (variant.sku ?? null),
          name: variant.title ?? ([variant.option1, variant.option2, variant.option3].filter(Boolean).join(' ') || null),
        });
        if (candidate) out.push(candidate);
      }
    }
  }
  if (retrievedAt) {
    for (const candidate of out) candidate.retrievedAt = retrievedAt;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WooCommerce embedded state
// ---------------------------------------------------------------------------

interface WooVariation {
  variation_id?: number | string;
  id?: number | string;
  attributes?: Record<string, string> | Array<{ name?: string; option?: string }>;
  image?: { src?: string; url?: string };
}

/**
 * Parse WooCommerce embedded variations (`wc_single_product_params`,
 * `data-product_variations`, inline product JSON). Variant-to-image mapping
 * arrives as `variation_id`/`id` + `image` object; variant name is derived
 * from declared attributes. extractionMethod 'platform_api'.
 */
export function parseWooCommerceVariantImages(html: string, pageUrl: string, retrievedAt?: string): DiscoveredImageCandidate[] {
  const out: DiscoveredImageCandidate[] = [];
  const blocks = [...html.matchAll(SCRIPT_RE)];
  for (const match of blocks) {
    const raw = match[1] ?? '';
    const artifactId = sha256Hex(raw).slice(0, 24);

    const jsonCandidates: string[] = [];
    const productParams = /wc_single_product_params\s*=\s*(\{[\s\S]*?\})\s*;/.exec(raw);
    if (productParams) jsonCandidates.push(productParams[1]);
    const variationsAttr = /data-product_variations="([\s\S]*?)"/.exec(raw);
    if (variationsAttr) jsonCandidates.push(variationsAttr[1].replace(/&quot;/g, '"'));
    const productJson = extractBalancedObject(raw, 'product');
    if (productJson) jsonCandidates.push(productJson);

    for (const json of jsonCandidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const variations = extractWooVariations(parsed);
      for (const variation of variations) {
        const src = variation.image?.src ?? variation.image?.url ?? null;
        if (!src) continue;
        const reference = variation.variation_id ?? variation.id;
        const candidate = toCandidate(src, pageUrl, 'variations[].image', artifactId, 'platform_api', {
          reference: reference != null ? String(reference) : null,
          name: wooVariantName(variation.attributes),
        });
        if (candidate) out.push(candidate);
      }
    }
  }
  if (retrievedAt) {
    for (const candidate of out) candidate.retrievedAt = retrievedAt;
  }
  return out;
}

function extractWooVariations(node: unknown, out: WooVariation[] = [], depth = 0): WooVariation[] {
  if (depth > 6 || out.length >= 64) return out;
  if (Array.isArray(node)) {
    for (const item of node) extractWooVariations(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  if ((record.variation_id !== undefined || record.id !== undefined) && record.image && typeof record.image === 'object') {
    out.push(record as unknown as WooVariation);
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object') extractWooVariations(value, out, depth + 1);
  }
  return out;
}

function wooVariantName(attributes: WooVariation['attributes']): string | null {
  if (!attributes) return null;
  if (Array.isArray(attributes)) {
    return attributes.map((attr) => attr.option ?? '').filter(Boolean).join(' / ') || null;
  }
  const values = Object.values(attributes).filter(Boolean);
  return values.length > 0 ? values.join(' / ') : null;
}

// ---------------------------------------------------------------------------
// Network captures (#29-style artifacts)
// ---------------------------------------------------------------------------

/**
 * Normalize #29-style captured network responses: any image-named key in a
 * JSON body (string or {url} form) becomes a candidate with
 * extractionMethod 'network_response' and the response url as its source
 * path. Network-discovered URLs inherit no rights approval.
 */
export function parseNetworkCaptures(captures: NetworkCaptureArtifact[], pageUrl: string, retrievedAt?: string): DiscoveredImageCandidate[] {
  const out: DiscoveredImageCandidate[] = [];
  for (const capture of captures) {
    if (capture.jsonBody === null || capture.jsonBody === undefined) continue;
    const artifactId = sha256Hex(`${capture.url}|${JSON.stringify(capture.jsonBody)}`).slice(0, 24);
    walkImages(capture.jsonBody, pageUrl, `network:${capture.url}`, artifactId, 'network_response', out);
  }
  if (retrievedAt) {
    for (const candidate of out) candidate.retrievedAt = retrievedAt;
  }
  return out;
}

/** Catch-all: route a raw HTML/state string through the right parser. */
export function discoverCandidates(
  sourceType: DiscoveredImageCandidate['extractionMethod'] | 'shopify' | 'woocommerce' | 'network_capture',
  content: string,
  pageUrl: string,
  retrievedAt?: string,
): DiscoveredImageCandidate[] {
  switch (sourceType) {
    case 'json_ld':
      return parseJsonLdImages(content, pageUrl, retrievedAt);
    case 'shopify':
      return parseShopifyVariantImages(content, pageUrl, retrievedAt);
    case 'woocommerce':
      return parseWooCommerceVariantImages(content, pageUrl, retrievedAt);
    case 'network_capture': {
      try {
        const parsed = JSON.parse(content);
        const captures: NetworkCaptureArtifact[] = Array.isArray(parsed) ? (parsed as NetworkCaptureArtifact[]) : [parsed as NetworkCaptureArtifact];
        return parseNetworkCaptures(captures, pageUrl, retrievedAt);
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}
