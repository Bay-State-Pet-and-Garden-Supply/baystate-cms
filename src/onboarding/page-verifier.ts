/**
 * Lightweight page verification for discovery candidates.
 *
 * Before auto-selecting a sourceUrl, the verifier fetches the top few
 * candidate pages and computes a product-identity verification score
 * from lightweight HTML signals (no headful browser needed). This
 * closes the gap between "probably the right page" (ranking) and
 * "we have evidence this is the exact product page" (verification).
 *
 * Signals scored:
 *   - domain official?                         (+ yes / — no)
 *   - page looks like product detail?           (+ yes / - penalty)
 *   - title/name similarity                     (+ score)
 *   - brand match in page text                  (+ score)
 *   - UPC/barcode/GTIN present in page          (+++ huge boost)
 *   - SKU present in page                       (+ boost)
 *   - JSON-LD Product schema present            (+ boost)
 *   - Shopify productJSON present               (+ boost)
 *   - variant resolved via productJSON          (+++ huge boost)
 *   - canonical URL matches candidate           (+ boost)
 *   - category/search/blog page                 ( - penalty)
 */

import { extractProductJsonFromHtml } from './shopify-json';
import { isOfficialDomainMatch } from './domain-utils';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';

// ─── Public types ────────────────────────────────────────────────────────────

export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VerificationContext {
  upc: string;
  expectedName: string;
  brandHint: string | null;
  price?: number | null;
  officialDomains: string[];
}

export interface VerificationResult {
  /** The original candidate, enriched with verification signals. */
  candidate: InsertSourceData;
  /** Raw verification score (0–∞, not clamped). Higher = stronger evidence. */
  verificationScore: number;
  /** Individual signal breakdown for diagnostics / review UI. */
  signals: VerificationSignals;
  /** When true, the candidate has strong enough evidence for auto-selection. */
  hasStrongProof: boolean;
  /** Human-readable reason for the auto-select / skip decision. */
  decisionReason: string;
}

export interface VerificationSignals {
  domainOfficial: boolean;
  isProductDetailPage: boolean;
  isListingOrSearchPage: boolean;
  isBlogOrCmsPage: boolean;
  titleSimilarity: number;
  brandInPage: boolean;
  upcInPage: boolean;
  skuInPage: boolean;
  hasJsonLdProduct: boolean;
  hasShopifyProductJson: boolean;
  variantResolved: boolean;
  canonicalMatchesCandidate: boolean;
  /** Page title as extracted from <title> tag (raw, for diagnostics). */
  pageTitle: string | null;
  /** Word-level overlap score between expected name and page title. */
  titleNameOverlap: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Signals that independently qualify a candidate for auto-selection. */
// fallow-ignore-next-line unused-export — used by tests
export const STRONG_PROOF_THRESHOLD = 40;

/** Minimum number of identity signals required for strong proof. */
// fallow-ignore-next-line unused-export — used by tests
export const MIN_IDENTITY_SIGNALS = 2;

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Verify a single candidate URL by fetching its HTML and scoring
 * product-identity signals. Returns `null` when the page cannot be
 * fetched (network error, timeout, non-200).
 */
// fallow-ignore-next-line unused-export — used by tests
export async function verifyCandidate(
  candidate: InsertSourceData,
  context: VerificationContext,
  fetchFn: NetworkFetch = fetch,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult | null> {
  let html: string;
  const localCapMs = 12_000;
  const effectiveTimeout =
    typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, localCapMs)
      : localCapMs;
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
  const composedSignal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetchFn(candidate.url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: composedSignal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const signals = extractVerificationSignals(html, candidate.url, context);
  const score = computeVerificationScore(signals);
  const hasStrongProof =
    score >= STRONG_PROOF_THRESHOLD && hasIdentityProof(signals) &&
    !signals.isListingOrSearchPage &&
    !signals.isBlogOrCmsPage;

  return {
    candidate,
    verificationScore: score,
    signals,
    hasStrongProof,
    decisionReason: buildDecisionReason(signals, score, hasStrongProof),
  };
}

/**
 * Verify the top N candidates (up to `maxCandidates`) in parallel.
 * Returns results sorted by verification score descending, with
 * failed fetches filtered out.
 */
export async function verifyTopCandidates(
  candidates: InsertSourceData[],
  context: VerificationContext,
  maxCandidates = 3,
  fetchFn: NetworkFetch = fetch,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult[]> {
  const toVerify = candidates.slice(0, maxCandidates);
  if (toVerify.length === 0) return [];

  const settled = await Promise.allSettled(
    toVerify.map(c => verifyCandidate(c, context, fetchFn, options)),
  );

  const results: VerificationResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value !== null) {
      results.push(s.value);
    }
  }
  results.sort((a, b) => b.verificationScore - a.verificationScore);
  return results;
}

// ─── Signal extraction ───────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export
export function extractVerificationSignals(
  html: string,
  url: string,
  context: VerificationContext,
): VerificationSignals {
  const lowerHtml = html.toLowerCase();
  const lowerName = context.expectedName.toLowerCase();
  const candidateDomain = extractHostname(url);

  // ── Page title ────────────────────────────────────────────────────────
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;

  // ── Meta description ──────────────────────────────────────────────────
  const metaDescMatch = html.match(
    /<meta\s[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta\s[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i,
  );
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

  // ── Canonical URL ─────────────────────────────────────────────────────
  const canonMatch = html.match(
    /<link\s[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<link\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*>/i,
  );
  const canonicalUrl = canonMatch ? canonMatch[1].trim() : null;

  // ── JSON-LD Product ───────────────────────────────────────────────────
  const hasJsonLdProduct = /"@type"\s*:\s*"Product"/i.test(html);

  // ── Shopify productJSON ───────────────────────────────────────────────
  const productJson = extractProductJsonFromHtml(html);
  const hasShopifyProductJson = productJson !== null;

  // ── Variant resolution (via productJSON) ──────────────────────────────
  let variantResolved = false;
  if (productJson && Array.isArray(productJson.variants)) {
    const realVariants = productJson.variants.filter(
      (v: any) => v && v.title !== 'Default Title' && v.title !== 'Default',
    );
    if (realVariants.length > 0) {
      // Check if any variant matches UPC/barcode or name tokens
      const normUpc = context.upc.replace(/\D+/g, '');
      const nameTokens = tokenize(lowerName);
      for (const v of realVariants) {
        const vBarcode = v.barcode ? String(v.barcode).replace(/\D+/g, '') : '';
        if (normUpc && vBarcode === normUpc) {
          variantResolved = true;
          break;
        }
        const vTitle = (v.title || '').toLowerCase();
        const vOpt1 = (v.option1 || '').toLowerCase();
        const vOpt2 = (v.option2 || '').toLowerCase();
        const vOpt3 = (v.option3 || '').toLowerCase();
        const combined = `${vTitle} ${vOpt1} ${vOpt2} ${vOpt3}`;
        let nameHits = 0;
        for (const t of nameTokens) {
          if (combined.includes(t)) nameHits++;
        }
        if (nameHits >= Math.max(1, Math.floor(nameTokens.length * 0.4))) {
          variantResolved = true;
          break;
        }
      }
    }
  }

  // ── UPC / barcode in page ─────────────────────────────────────────────
  const upcDigits = context.upc.replace(/\D+/g, '');
  const upcInPage = upcDigits.length >= 8 && html.includes(upcDigits);

  // ── SKU presence ──────────────────────────────────────────────────────
  // Lightweight SKU detection: look for common SKU patterns in meta/property tags.
  const skuInPage =
    /"sku"\s*:\s*"[^"]+"/i.test(html) ||
    /<meta\s[^>]*property\s*=\s*["']product:retailer_item_id["'][^>]*/i.test(html) ||
    /"@type"\s*:\s*"Product"[^}]*"sku"/is.test(html);

  // ── Brand match ───────────────────────────────────────────────────────
  let brandInPage = false;
  if (context.brandHint) {
    const brandLower = context.brandHint.toLowerCase().trim();
    // Check in JSON-LD brand, meta tags, and page title
    const brandInJsonLd = new RegExp(
      `"brand"\\s*:\\s*(\\{[^}]*"name"\\s*:\\s*"[^"]*${escapeRegex(brandLower)}[^"]*"[^}]*\\}|"${escapeRegex(brandLower)}")`,
      'i',
    ).test(html);
    const brandInMeta = new RegExp(
      `<meta\\s[^>]*content\\s*=\\s*["'][^"']*${escapeRegex(brandLower)}[^"']*["'][^>]*`,
      'i',
    ).test(html);
    const brandInTitle = pageTitle
      ? pageTitle.toLowerCase().includes(brandLower)
      : false;
    brandInPage = brandInJsonLd || brandInMeta || brandInTitle;
  }

  // ── Title/name similarity ─────────────────────────────────────────────
  const titleSimilarity = pageTitle
    ? computeTitleSimilarity(pageTitle, context.expectedName)
    : 0;

  // ── Title word-level overlap ──────────────────────────────────────────
  const titleNameOverlap = pageTitle
    ? computeTokenOverlap(pageTitle, tokenize(lowerName))
    : 0;

  // ── Page type detection (from URL + title) ────────────────────────────
  const urlLower = url.toLowerCase();
  const hasProductIndicator =
    /\/(products?|p|item|details?|dp|gp|buy)\//i.test(urlLower);
  const isListingOrSearchPage =
    /\/(collections?|category|categories|product-category|brands?|tags?|search|shop-all|all-products)\//i.test(
      urlLower,
    ) && !hasProductIndicator;
  const isBlogOrCmsPage =
    /\/(blogs?|articles?|pages|about|contact|faq)\//i.test(urlLower) &&
    !hasProductIndicator;
  const isProductDetailPage = hasProductIndicator && !isListingOrSearchPage && !isBlogOrCmsPage;

  // ── Domain official ───────────────────────────────────────────────────
  let domainOfficial = false;
  if (candidateDomain) {
    domainOfficial = context.officialDomains.some(d =>
      isOfficialDomainMatch(candidateDomain, d),
    );
  }

  // ── Canonical matches candidate ───────────────────────────────────────
  const canonicalMatchesCandidate =
    canonicalUrl !== null && normalizeUrl(canonicalUrl) === normalizeUrl(url);

  return {
    domainOfficial,
    isProductDetailPage,
    isListingOrSearchPage,
    isBlogOrCmsPage,
    titleSimilarity,
    brandInPage,
    upcInPage,
    skuInPage,
    hasJsonLdProduct,
    hasShopifyProductJson,
    variantResolved,
    canonicalMatchesCandidate,
    pageTitle,
    titleNameOverlap,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export
export function computeVerificationScore(signals: VerificationSignals): number {
  let score = 0;

  // ── Positive signals ──────────────────────────────────────────────────

  // Domain is official — strong positive
  if (signals.domainOfficial) {
    score += 25;
  }

  // Page looks like product detail (not search/blog/listing)
  if (signals.isProductDetailPage) {
    score += 15;
  }

  // UPC/barcode in page — strongest single signal
  if (signals.upcInPage) {
    score += 60;
  }

  // Variant resolved via productJSON — very strong signal
  if (signals.variantResolved) {
    score += 50;
  }

  // Shopify productJSON present
  if (signals.hasShopifyProductJson) {
    score += 15;
  }

  // JSON-LD Product schema
  if (signals.hasJsonLdProduct) {
    score += 20;
  }

  // SKU present
  if (signals.skuInPage) {
    score += 10;
  }

  // Title similarity (0–1 scale, weighted)
  score += signals.titleSimilarity * 20;

  // Title word overlap bonus (0–1 scale)
  score += signals.titleNameOverlap * 10;

  // Brand match in page content
  if (signals.brandInPage) {
    score += 10;
  }

  // Canonical URL matches candidate — indicates canonical product page
  if (signals.canonicalMatchesCandidate) {
    score += 10;
  }

  // ── Negative signals ──────────────────────────────────────────────────

  if (signals.isListingOrSearchPage) {
    score -= 30;
  }

  if (signals.isBlogOrCmsPage) {
    score -= 40;
  }

  return score;
}

// ─── Decision logic ───────────────────────────────────────────────────────────

/**
 * Returns true when the signals include enough product-identity evidence
 * to distinguish this page from a generic category/listing on the same
 * domain. Requires at least MIN_IDENTITY_SIGNALS from: UPC in page,
 * variant resolved, JSON-LD Product + title match + brand match combo,
 * Shopify productJSON + title match, or SKU presence.
 */
// fallow-ignore-next-line unused-export
export function hasIdentityProof(signals: VerificationSignals): boolean {
  let count = 0;

  // Strongest single signals — one qualifies entirely
  if (signals.upcInPage) count += 3;
  if (signals.variantResolved) count += 3;

  // JSON-LD Product + title similarity + brand — combo requires all three
  if (signals.hasJsonLdProduct && signals.titleSimilarity >= 0.4 && signals.brandInPage) {
    count += 2;
  }

  // Shopify productJSON + title match
  if (signals.hasShopifyProductJson && signals.titleSimilarity >= 0.4) {
    count += 2;
  }

  // Weaker but still valid when combined with domain officia
  if (signals.skuInPage) count += 1;
  if (signals.titleNameOverlap >= 0.6) count += 1;

  return count >= MIN_IDENTITY_SIGNALS;
}

// fallow-ignore-next-line unused-export
export function buildDecisionReason(
  signals: VerificationSignals,
  score: number,
  hasStrongProof: boolean,
): string {
  const parts: string[] = [];

  if (signals.upcInPage) parts.push('UPC found in page');
  if (signals.variantResolved) parts.push('variant resolved via productJSON');
  if (signals.hasJsonLdProduct) parts.push('JSON-LD Product schema present');
  if (signals.hasShopifyProductJson) parts.push('Shopify productJSON present');
  if (signals.domainOfficial) parts.push('official domain');
  if (signals.brandInPage) parts.push('brand match');
  if (signals.isProductDetailPage) parts.push('product detail page');
  if (signals.isListingOrSearchPage) parts.push('WARNING: listing/search page');
  if (signals.isBlogOrCmsPage) parts.push('WARNING: blog/CMS page');
  if (signals.titleSimilarity >= 0.5) parts.push(`title similarity ${(signals.titleSimilarity * 100).toFixed(0)}%`);

  const signalStr = parts.length > 0 ? parts.join(', ') : 'no strong signals';
  const verdict = hasStrongProof ? 'verified' : 'needs review';

  return `[${verdict}] score=${score.toFixed(0)} | ${signalStr}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 2);
}

function computeTokenOverlap(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let matches = 0;
  for (const t of tokens) {
    if (lower.includes(t)) matches++;
  }
  return matches / tokens.length;
}

/**
 * Compute a fuzzy title similarity score (0–1) between a page title and
 * the expected product name. Uses token overlap + length ratio.
 */
function computeTitleSimilarity(pageTitle: string, expectedName: string): number {
  const titleTokens = tokenize(pageTitle);
  const nameTokens = tokenize(expectedName);
  if (nameTokens.length === 0) return 0;

  let matchCount = 0;
  for (const nt of nameTokens) {
    if (titleTokens.some(tt => tt.includes(nt) || nt.includes(tt))) {
      matchCount++;
    }
  }

  const overlap = matchCount / nameTokens.length;
  // Penalize very short titles (likely not product pages)
  const lengthRatio = Math.min(1, titleTokens.length / Math.max(1, nameTokens.length));

  return overlap * 0.7 + lengthRatio * 0.3;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
