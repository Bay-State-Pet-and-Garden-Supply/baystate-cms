import * as cheerio from 'cheerio';

export interface VariantCandidate {
  url: string | null;
  title: string;
  platformId: string | null;
  options: string[];
  sku: string | null;
  available: boolean;
}

export interface VariantResolutionResult {
  resolvedUrl: string;
  variantId: string | null;
  variantTitle: string | null;
  confidence: number;
  method: 'url_param' | 'jsonld' | 'shopify' | 'woocommerce' | 'single_variant' | 'none';
  totalVariants: number;
  ambiguous: boolean;
}

// fallow-ignore-next-line unused-export — used by tests
export const SIZE_ALIASES: Record<string, string[]> = {
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

// fallow-ignore-next-line unused-export — used by tests
export const COLOR_ALIASES: Record<string, string[]> = {
  lav: ['lavender', 'lav'],
  chkn: ['chicken', 'chkn'],
  turk: ['turkey', 'turk'],
  veg: ['veggies', 'vegetable', 'vegetables', 'veg'],
  smpl: ['sampler', 'smpl'],
  pkg: ['package', 'pkg'],
};

// fallow-ignore-next-line unused-export — used by tests
export function normalizeToken(s: string): string {
  return s.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ') // Strip dots not followed by a digit
    .trim();
}

export function tokenSet(s: string): Set<string> {
  return new Set(normalizeToken(s).split(/\s+/).filter(Boolean));
}

// fallow-ignore-next-line unused-export — used by tests
export function variantDescriptor(v: any): { text: string; tokens: Set<string> } {
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

// fallow-ignore-next-line unused-export — used by tests
export function expandExpectedNameTokens(expected: string): Set<string> {
  const raw = normalizeToken(expected);
  const words = raw.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  for (const w of words) {
    expanded.add(w);
    const aliases = SIZE_ALIASES[w] || COLOR_ALIASES[w];
    if (aliases) {
      for (const a of aliases) {
        expanded.add(normalizeToken(a));
      }
    }
  }
  return expanded;
}

// fallow-ignore-next-line unused-export — used by tests
export function getExpectedSizeAliasForms(expected: string): Set<string> {
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

/**
 * Strategy 1: Extract variants from Schema.org JSON-LD hasVariant / ProductGroup
 */
// fallow-ignore-next-line unused-export — used by tests
export function extractVariantsFromJsonLd(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

  const candidates: VariantCandidate[] = [];

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      const items = data['@graph'] ? data['@graph'] : [data];

      for (const item of items) {
        if (item['@type'] === 'ProductGroup' || item['@type'] === 'Product') {
          const variants = item.hasVariant;
          if (Array.isArray(variants)) {
            for (const v of variants) {
              if (v['@type'] === 'Product') {
                const title = v.name || '';
                const platformId = v.sku || v.gtin || v.mpn || null;
                const sku = v.sku || null;
                const available = v.offers?.availability !== 'http://schema.org/OutOfStock';
                const url = v.url || v.offers?.url || null;

                // Simple option parsing from name (e.g. "Name - Option" or "Name (Option)")
                let options: string[] = [];
                if (title && item.name && title.startsWith(item.name)) {
                  const suffix = title.substring(item.name.length).replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
                  if (suffix) {
                    options = suffix.split(/[\s,\-/]+/).filter(Boolean);
                  }
                }

                candidates.push({
                  url,
                  title,
                  platformId,
                  options,
                  sku,
                  available
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return candidates;
}

/**
 * Strategy 2: Extract variants from Shopify productJSON script embeds
 */
// fallow-ignore-next-line unused-export — used by tests
export function extractVariantsFromShopify(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const candidates: VariantCandidate[] = [];

  // 1. Try script tag with id="ProductJson-..."
  $('script[id^="ProductJson-"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text() || '{}');
      if (Array.isArray(data.variants)) {
        for (const v of data.variants) {
          candidates.push(mapShopifyVariant(v));
        }
      }
    } catch {}
  });

  if (candidates.length > 0) return candidates;

  // 2. Scan script tags content using regexes
  $('script').each((_, el) => {
    const text = $(el).text();
    if (!text) return;

    // Look for window.productJSON = ... or var meta = { product: ... }
    const matchJson = text.match(/(?:window\.productJSON|productJSON)\s*=\s*({[\s\S]+?});/);
    if (matchJson) {
      try {
        const data = JSON.parse(matchJson[1]);
        if (Array.isArray(data.variants)) {
          for (const v of data.variants) {
            candidates.push(mapShopifyVariant(v));
          }
        }
      } catch {}
    }

    const matchMeta = text.match(/var\s+meta\s*=\s*({[\s\S]+?});/);
    if (matchMeta && candidates.length === 0) {
      try {
        const data = JSON.parse(matchMeta[1]);
        if (data.product && Array.isArray(data.product.variants)) {
          for (const v of data.product.variants) {
            candidates.push(mapShopifyVariant(v));
          }
        }
      } catch {}
    }
  });

  return candidates;
}

function mapShopifyVariant(v: any): VariantCandidate {
  const options: string[] = [];
  if (v.option1) options.push(v.option1);
  if (v.option2) options.push(v.option2);
  if (v.option3) options.push(v.option3);

  return {
    url: null, // Construct at return
    title: v.title || v.name || '',
    platformId: v.id ? String(v.id) : null,
    options,
    sku: v.sku || null,
    available: v.available !== false
  };
}

/**
 * Strategy 3: Extract variants from WooCommerce data-product_variations attribute
 */
// fallow-ignore-next-line unused-export — used by tests
export function extractVariantsFromWooCommerce(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const candidates: VariantCandidate[] = [];

  const form = $('form.variations_form[data-product_variations]');
  if (form.length > 0) {
    try {
      const dataStr = form.attr('data-product_variations');
      if (dataStr) {
        const data = JSON.parse(dataStr);
        if (Array.isArray(data)) {
          for (const v of data) {
            const options: string[] = [];
            if (v.attributes) {
              for (const val of Object.values(v.attributes)) {
                if (val && typeof val === 'string') {
                  options.push(val);
                }
              }
            }
            candidates.push({
              url: v.variation_id ? `?variation_id=${v.variation_id}` : null,
              title: options.join(' / '),
              platformId: v.variation_id ? String(v.variation_id) : null,
              options,
              sku: v.sku || null,
              available: v.is_in_stock !== false
            });
          }
        }
      }
    } catch {}
  }

  return candidates;
}

/**
 * Diff register vs expected name to isolate variant tokens
 */
export function diffRegisterVsExpected(
  registerName: string,
  expectedName: string | null,
  brandHint: string | null
): Set<string> {
  const registerTokens = tokenSet(registerName);
  const expectedTokens = expectedName ? tokenSet(expectedName) : new Set<string>();

  const diff = new Set<string>();
  for (const t of registerTokens) {
    if (!expectedTokens.has(t)) {
      diff.add(t);
    }
  }

  // Strip brand hint tokens
  if (brandHint) {
    const brandTokens = tokenSet(brandHint);
    for (const bt of brandTokens) {
      diff.delete(bt);
    }
  }

  return diff;
}

/**
 * Score a candidate variant against variant hint tokens
 */
// fallow-ignore-next-line unused-export — used by tests
export function scoreVariantCandidate(
  v: VariantCandidate,
  hints: Set<string>
): number {
  let score = 0;
  const descText = `${v.title} ${v.options.join(' ')} ${v.sku || ''}`.toLowerCase();
  const descTokens = tokenSet(descText);

  // Token overlaps
  let matches = 0;
  for (const h of hints) {
    const expanded = expandExpectedNameTokens(h);
    for (const eh of expanded) {
      if (descTokens.has(eh)) {
        matches++;
        break; // Match for this hint token found
      }
    }
  }
  score += matches * 10;

  // Exact option matching: major boost
  for (const opt of v.options) {
    const optNorm = normalizeToken(opt);
    for (const h of hints) {
      const expanded = expandExpectedNameTokens(h);
      if (expanded.has(optNorm)) {
        score += 60;
      }
    }
  }

  // SKU matching
  if (v.sku) {
    const skuNorm = normalizeToken(v.sku);
    for (const h of hints) {
      if (skuNorm === normalizeToken(h)) {
        score += 40;
      }
    }
  }

  // Title match
  const titleNorm = normalizeToken(v.title);
  for (const h of hints) {
    const expanded = expandExpectedNameTokens(h);
    if (expanded.has(titleNorm)) {
      score += 30;
    }
  }

  return score;
}

/**
 * Shared Matching Core
 */
// fallow-ignore-next-line unused-export — used by tests
export function matchVariant(
  candidates: VariantCandidate[],
  registerName: string,
  expectedName: string | null,
  brandHint: string | null,
): { matched: VariantCandidate | null; confidence: number; ambiguous: boolean } {
  if (candidates.length === 0) {
    return { matched: null, confidence: 0, ambiguous: false };
  }

  const hints = diffRegisterVsExpected(registerName, expectedName, brandHint);
  const hasHints = hints.size > 0;

  // If no hints found, fallback to standard common token exclusion
  let tokensToUse = hints;
  if (!hasHints) {
    const regTokens = expandExpectedNameTokens(registerName);
    if (brandHint) {
      const brandTokens = tokenSet(brandHint);
      for (const bt of brandTokens) regTokens.delete(bt);
    }

    const variantTexts = candidates.map(c => `${c.title} ${c.options.join(' ')} ${c.sku || ''}`.toLowerCase());
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
    for (const t of regTokens) {
      if (!baseShared.has(t)) distinguishingTokens.add(t);
    }
    tokensToUse = distinguishingTokens.size > 0 ? distinguishingTokens : regTokens;
  }

  let bestScore = 0;
  let secondScore = 0;
  let bestVariant: VariantCandidate | null = null;

  for (const v of candidates) {
    const s = scoreVariantCandidate(v, tokensToUse);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      bestVariant = v;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  if (!bestVariant || bestScore <= 0) {
    return { matched: null, confidence: 0, ambiguous: false };
  }

  // Margin of winner checking (strict 20% or tie protection)
  const isAmbiguous = bestScore === secondScore || (secondScore > 0 && (bestScore - secondScore) / bestScore < 0.2);

  if (isAmbiguous) {
    return { matched: null, confidence: bestScore / 100, ambiguous: true };
  }

  const confidence = Math.min(1.0, bestScore / 100);
  return { matched: bestVariant, confidence, ambiguous: false };
}

/**
 * Top-level resolveVariantUrl
 */
// fallow-ignore-next-line unused-export — used by tests
export async function resolveVariantUrl(
  baseUrl: string,
  registerName: string,
  expectedName: string | null,
  brandHint: string | null,
): Promise<VariantResolutionResult> {
  const resultTemplate = (method: VariantResolutionResult['method'], resolvedUrl = baseUrl, total = 0, variantId: string | null = null, variantTitle: string | null = null): VariantResolutionResult => ({
    resolvedUrl,
    variantId,
    variantTitle,
    confidence: 1.0,
    method,
    totalVariants: total,
    ambiguous: false
  });

  // Early returns
  try {
    const urlObj = new URL(baseUrl);
    if (urlObj.searchParams.has('variant')) {
      return resultTemplate('url_param', baseUrl, 1, urlObj.searchParams.get('variant'));
    }
    if (urlObj.searchParams.has('variation_id')) {
      return resultTemplate('url_param', baseUrl, 1, urlObj.searchParams.get('variation_id'));
    }
  } catch {
    return resultTemplate('none');
  }

  // Fetch page HTML
  let html = '';
  try {
    const response = await fetch(baseUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return resultTemplate('none');
    }
    html = await response.text();
  } catch (err) {
    console.warn(`[variant-resolver] Failed to fetch page for variant resolution: ${baseUrl}`, err);
    return resultTemplate('none');
  }

  // Try Strategy Chain
  let candidates = extractVariantsFromJsonLd(html);
  let method: VariantResolutionResult['method'] = 'jsonld';

  if (candidates.length === 0) {
    candidates = extractVariantsFromShopify(html);
    method = 'shopify';
  }

  if (candidates.length === 0) {
    candidates = extractVariantsFromWooCommerce(html);
    method = 'woocommerce';
  }

  const total = candidates.length;
  if (total === 0) {
    return resultTemplate('none');
  }

  if (total === 1) {
    const single = candidates[0];
    const url = constructVariantUrl(baseUrl, single, method);
    return resultTemplate('single_variant', url, 1, single.platformId, single.title);
  }

  // Run matching
  const match = matchVariant(candidates, registerName, expectedName, brandHint);
  if (match.ambiguous) {
    return {
      resolvedUrl: baseUrl,
      variantId: null,
      variantTitle: null,
      confidence: match.confidence,
      method: 'none',
      totalVariants: total,
      ambiguous: true
    };
  }

  if (match.matched) {
    const url = constructVariantUrl(baseUrl, match.matched, method);
    return {
      resolvedUrl: url,
      variantId: match.matched.platformId,
      variantTitle: match.matched.title,
      confidence: match.confidence,
      method,
      totalVariants: total,
      ambiguous: false
    };
  }

  return resultTemplate('none', baseUrl, total);
}

function constructVariantUrl(base: string, v: VariantCandidate, method: string): string {
  if (v.url && (v.url.startsWith('http://') || v.url.startsWith('https://'))) {
    return v.url;
  }
  if (v.url && v.url.startsWith('?')) {
    const urlObj = new URL(base);
    const params = new URLSearchParams(v.url);
    for (const [key, val] of params.entries()) {
      urlObj.searchParams.set(key, val);
    }
    return urlObj.toString();
  }

  const urlObj = new URL(base);
  if (method === 'shopify' && v.platformId) {
    urlObj.searchParams.set('variant', v.platformId);
    return urlObj.toString();
  }
  if (method === 'woocommerce' && v.platformId) {
    urlObj.searchParams.set('variation_id', v.platformId);
    return urlObj.toString();
  }

  return base;
}
