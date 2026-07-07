import { extractProductJsonFromHtml } from './shopify-json';
import { diffRegisterVsExpected, tokenSet } from './variant-resolver';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';

export interface VariantResolutionContext {
  upc: string;
  rawName: string;
  expectedName: string;
  brandHint: string | null;
  price?: number | null;
}

export interface ShopifyVariantCandidate {
  id: string;
  title: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  image?: string | null;
  url: string;
}

export type VariantResolutionResult =
  | { status: 'no_variants' }
  | {
      status: 'resolved';
      platform: 'shopify';
      variant: ShopifyVariantCandidate & { score: number; matchedSignals: string[] };
      confidence: number;
      matchedSignals: string[];
    }
  | {
      status: 'ambiguous';
      platform: 'shopify';
      variants: Array<ShopifyVariantCandidate & { score: number; matchedSignals: string[] }>;
      confidence: number;
      matchedSignals: string[];
    };

const COMMON_COLORS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink',
  'brown', 'grey', 'gray', 'lavender', 'gold', 'silver', 'lav', 'chkn', 'turk', 'veg',
]);
const COMMON_SIZES = new Set([
  's', 'm', 'l', 'xl', 'xxl', 'xs', 'small', 'medium', 'large', 'mini', 'giant',
  'standard', 'pack', 'count', 'ct', 'oz', 'lb', 'g', 'kg', 'ml', 'sm', 'md', 'lg',
]);

function isVariantToken(t: string): boolean {
  const lower = t.toLowerCase();
  if (COMMON_COLORS.has(lower) || COMMON_SIZES.has(lower)) return true;
  if (/^\d+(oz|lb|g|kg|ml|ct|pack|s)?$/i.test(lower)) return true;
  return false;
}

function buildVariantUrl(baseUrl: string, variantId: string): string {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('variant', variantId);
    return urlObj.toString();
  } catch {
    return `${baseUrl}?variant=${variantId}`;
  }
}

/**
 * Score a Shopify variant candidate deterministically against product metadata.
 */
export function scoreShopifyVariant(
  v: Omit<ShopifyVariantCandidate, 'url'>,
  context: VariantResolutionContext,
  hints: Set<string>,
  variantNameTokens: Set<string>
): { score: number; matchedSignals: string[] } {
  let score = 0;
  const matchedSignals: string[] = [];

  // 1. UPC/barcode exact match (Highest Priority)
  const normUpc = context.upc ? String(context.upc).trim().replace(/^0+/, '') : '';
  const normBarcode = v.barcode ? String(v.barcode).trim().replace(/^0+/, '') : '';
  if (normUpc && normBarcode && normUpc === normBarcode) {
    score += 1000;
    matchedSignals.push('barcode-exact');
  }

  // Set up token sets for variant description
  const varTitleTokens = tokenSet(v.title);
  const varOptionTokens = new Set<string>();
  if (v.option1) tokenSet(v.option1).forEach(t => varOptionTokens.add(t));
  if (v.option2) tokenSet(v.option2).forEach(t => varOptionTokens.add(t));
  if (v.option3) tokenSet(v.option3).forEach(t => varOptionTokens.add(t));

  // 2. Expected name token match (size/color/flavor)
  for (const h of hints) {
    if (varTitleTokens.has(h) || varOptionTokens.has(h)) {
      score += 20;
      matchedSignals.push(`hint-token:${h}`);
    }
  }

  for (const vt of variantNameTokens) {
    if (varTitleTokens.has(vt) || varOptionTokens.has(vt)) {
      score += 30;
      matchedSignals.push(`variant-token:${vt}`);
    }
  }

  // 3. Variant option exact match
  for (const opt of [v.option1, v.option2, v.option3]) {
    if (!opt) continue;
    const normOpt = opt.toLowerCase().trim();
    if (hints.has(normOpt) || variantNameTokens.has(normOpt)) {
      score += 60;
      matchedSignals.push(`option-exact:${normOpt}`);
    }
  }

  // 4. SKU contains helper
  if (v.sku && context.rawName.toLowerCase().includes(v.sku.toLowerCase())) {
    score += 50;
    matchedSignals.push(`sku-contains:${v.sku}`);
  }

  // 5. Price sanity check
  if (context.price !== undefined && context.price !== null && v.price !== null && v.price !== undefined) {
    const diff = Math.abs(v.price - context.price);
    if (diff < 0.01) {
      score += 15;
      matchedSignals.push('price-exact');
    } else if (diff < 1.0) {
      score += 5;
      matchedSignals.push('price-close');
    }
  }

  return { score, matchedSignals };
}

/**
 * Resolve Shopify variants from raw HTML.
 */
export function resolveVariantsFromHtml(
  baseUrl: string,
  html: string,
  context: VariantResolutionContext
): VariantResolutionResult {
  const productJson = extractProductJsonFromHtml(html);
  if (!productJson || !Array.isArray(productJson.variants) || productJson.variants.length === 0) {
    return { status: 'no_variants' };
  }

  const realVariants = productJson.variants.filter(
    (v: any) => v && v.title !== 'Default Title' && v.title !== 'Default'
  );
  if (realVariants.length === 0) {
    return { status: 'no_variants' };
  }

  // Normalize variants
  const candidates: ShopifyVariantCandidate[] = productJson.variants.map((v: any) => {
    let dollarPrice: number | null = null;
    if (v.price !== undefined && v.price !== null) {
      const priceStr = String(v.price);
      if (priceStr.includes('.')) {
        dollarPrice = parseFloat(priceStr);
      } else {
        const cents = parseInt(priceStr, 10);
        if (!isNaN(cents)) {
          dollarPrice = cents / 100;
        }
      }
    }

    let imageUrl: string | null = null;
    if (v.featured_image) {
      imageUrl = typeof v.featured_image === 'string' ? v.featured_image : v.featured_image.src || null;
    } else if (v.image) {
      imageUrl = typeof v.image === 'string' ? v.image : v.image.src || null;
    }

    return {
      id: String(v.id),
      title: v.title || '',
      option1: v.option1 || null,
      option2: v.option2 || null,
      option3: v.option3 || null,
      sku: v.sku || null,
      barcode: v.barcode || null,
      price: dollarPrice,
      image: imageUrl,
      url: buildVariantUrl(baseUrl, String(v.id)),
    };
  });

  // Extract hints and specific variant tokens from expected context
  const hints = diffRegisterVsExpected(context.rawName, context.expectedName, context.brandHint);
  const rawTokens = tokenSet(context.rawName);
  const expectedTokens = tokenSet(context.expectedName);
  const allTokens = new Set([...rawTokens, ...expectedTokens]);
  const variantNameTokens = new Set<string>();
  for (const t of allTokens) {
    if (isVariantToken(t)) {
      variantNameTokens.add(t);
    }
  }

  // Score all variant candidates
  const scored = candidates.map(c => {
    const { score, matchedSignals } = scoreShopifyVariant(c, context, hints, variantNameTokens);
    return { ...c, score, matchedSignals };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) {
    return { status: 'no_variants' };
  }

  const second = scored[1];
  let ambiguous = false;
  if (second) {
    const bestHasBarcode = best.matchedSignals.includes('barcode-exact');
    const secondHasBarcode = second.matchedSignals.includes('barcode-exact');
    
    if (best.score === second.score) {
      ambiguous = true;
    } else if (second.score > 0) {
      // If best has barcode-exact and second doesn't, it's NOT ambiguous (barcode is absolute match)
      if (bestHasBarcode && !secondHasBarcode) {
        ambiguous = false;
      } else {
        const margin = (best.score - second.score) / best.score;
        if (margin < 0.2) {
          ambiguous = true;
        }
      }
    }
  }

  if (ambiguous) {
    return {
      status: 'ambiguous',
      platform: 'shopify',
      variants: scored,
      confidence: best.score / 100,
      matchedSignals: best.matchedSignals,
    };
  }

  return {
    status: 'resolved',
    platform: 'shopify',
    variant: best,
    confidence: Math.min(1.0, best.score / 100),
    matchedSignals: best.matchedSignals,
  };
}

/**
 * Main entry point: run variant resolution on candidates.
 */
export async function resolveVariantsForCandidates(options: {
  candidates: InsertSourceData[];
  upc: string;
  rawName: string;
  expectedName: string;
  brandHint: string | null;
  brandDomains: string[];
  price?: number | null;
}): Promise<InsertSourceData[]> {
  const { candidates, upc, rawName, expectedName, brandHint, brandDomains, price } = options;

  // Identify the bounded set: Top 3 candidates, sitemap candidates, and official domain candidates.
  const boundedSet = new Set<InsertSourceData>();
  candidates.slice(0, 3).forEach(c => boundedSet.add(c));
  for (const c of candidates) {
    if (c.domain && brandDomains.some(d => {
      const normD = d.toLowerCase().replace(/^www\./, '').trim();
      const normC = c.domain!.toLowerCase().replace(/^www\./, '').trim();
      return normC === normD || normC.endsWith('.' + normD);
    })) {
      boundedSet.add(c);
    }
    if (c.sourceMethod && c.sourceMethod.startsWith('sitemap_')) {
      boundedSet.add(c);
    }
  }

  const boundedList = Array.from(boundedSet);
  const resolvedMap = new Map<string, VariantResolutionResult>();

  // Fetch page HTML and run resolution in parallel
  await Promise.all(
    boundedList.map(async (cand) => {
      try {
        const response = await fetch(cand.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) return;
        const html = await response.text();

        const result = resolveVariantsFromHtml(cand.url, html, {
          upc,
          rawName,
          expectedName,
          brandHint,
          price,
        });
        if (result.status !== 'no_variants') {
          resolvedMap.set(cand.url, result);
        }
      } catch (err) {
        console.warn(`[variant-url-resolver] Error resolving variants for ${cand.url}:`, err);
      }
    })
  );

  // Build the new candidates array
  const output: InsertSourceData[] = [];
  for (const c of candidates) {
    const resolved = resolvedMap.get(c.url);
    if (!resolved) {
      output.push(c);
      continue;
    }

    if (resolved.status === 'resolved') {
      output.push({
        url: resolved.variant.url,
        title: c.title ? `${c.title} - ${resolved.variant.title}` : resolved.variant.title,
        snippet: c.snippet,
        domain: c.domain,
        confidence: Math.max(0, Math.min(1, resolved.confidence)),
        sourceMethod: 'shopify_variant',
        metadataJson: JSON.stringify({
          variantResolution: {
            status: 'resolved',
            platform: 'shopify',
            variantId: resolved.variant.id,
            variantTitle: resolved.variant.title,
            confidence: resolved.confidence,
            matchedSignals: resolved.matchedSignals,
          },
        }),
      });
    } else if (resolved.status === 'ambiguous') {
      for (const v of resolved.variants) {
        output.push({
          url: v.url,
          title: c.title ? `${c.title} - ${v.title}` : v.title,
          snippet: c.snippet,
          domain: c.domain,
          confidence: Math.max(0, Math.min(1, v.score / 100)),
          sourceMethod: 'shopify_variant',
          metadataJson: JSON.stringify({
            variantResolution: {
              status: 'ambiguous',
              platform: 'shopify',
              variantId: v.id,
              variantTitle: v.title,
              confidence: v.score / 100,
              matchedSignals: v.matchedSignals,
              baseUrl: c.url,
            },
          }),
        });
      }
    }
  }

  return output;
}
