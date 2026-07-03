/**
 * Source discovery using Serper.dev Google Search API + brand-sitemap pass.
 * Finds product pages by UPC, prioritizing official brand pages.
 *
 * Strategy (three parallel/converging passes):
 * 1. **Pass 1 — UPC search**: Bare UPC lookup to harvest initial context
 *    (retailer/marketplace listings) and to feed the LLM name-consolidation step.
 * 2. **Pass 2 — consolidated-name search**: After LLM/LCS consolidates a clean
 *    canonical product name, run *at least one* unrestricted Google search for
 *    that name to find the official brand/product page. Mapped brand-domain
 *    scoped searches are added as well-known signals when available.
 * 3. **Sitemap pass**: The brand domain's sitemap is fetched in parallel
 *    with Pass 1 (URLs only, no matching). Once Pass 1 + name consolidation
 *    complete, the matcher's three passes (UPC exact, product URL filter,
 *    token overlap + LLM selection) run against the cached sitemap URLs
 *    using the consolidated name. Sitemap candidates are merged with the
 *    Serper pool using the boost/penalty rules below; the result is sorted,
 *    capped to the top 10, and returned alongside the consolidated name.
 *
 * Cross-source merge rules:
 *   - Sitemap URL already in Serper pool: confidence +0.15 (independent
 *     confirmation that this is the canonical product URL).
 *   - Serper candidate on the official brand domain whose URL is not in
 *     the sitemap set: confidence -0.2 (the sitemap is the most complete
 *     inventory of a brand's product URLs, so a brand-domain hit the
 *     sitemap doesn't know about is often a stale or off-domain listing).
 *
 * Sitemap errors NEVER throw. The function returns the Serper-only
 * results when the sitemap pass fails, with a logged warning, so the
 * operator can still review the discovery drawer.
 */

import { getApiKey } from '../db/repositories/api-key-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';
import { consolidateProductName } from './llm-client';
import { getDomainStatus } from '../db/repositories/domain-status-repo';
import { getCachedSerperResults, insertSerperCache } from '../db/repositories/serper-cache-repo';
import { getCachedSitemapUrls, insertSitemapCache } from '../db/repositories/sitemap-cache-repo';
import { fetchAndParseSitemap } from './sitemap-fetcher';
import { matchSitemapUrls, type SitemapMatchResult } from './sitemap-matcher';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';

interface SerperSearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperResponse {
  organic: SerperSearchResult[];
  searchParameters?: { q: string };
}

/**
 * Discover candidate product page URLs using Serper.dev.
 *
 * Implements a two-pass strategy:
 * 1. General search on UPC to harvest canonical naming via LLM.
 * 2. **Mandatory** unrestricted search on the consolidated name so we always
 *    surface official/brand product pages. Optional mapped-brand-domain
 *    scoped searches and original-name fallbacks are layered on top.
 */
export async function discoverSources(
  upc: string,
  name: string,
  brandHint?: string | null,
): Promise<{ candidates: InsertSourceData[]; consolidatedName: string | null }> {
  const apiKeyRow = getApiKey('serper');
  if (!apiKeyRow) {
    throw new Error('Serper.dev API key not configured. Go to Onboarding Settings to add it.');
  }

  const candidates: InsertSourceData[] = [];
  const seenUrls = new Set<string>();

  // Retrieve pre-mapped brand domains from database
  const brandDomains: string[] = [];
  if (brandHint) {
    const knownSites = findBrandSites(brandHint);
    for (const site of knownSites) {
      brandDomains.push(site.domain);
    }
  }

  // Kick off the sitemap fetch (URLs only, no matching yet) in parallel
  // with the Pass 1 UPC search. The matching step is deferred until the
  // consolidated name is available from the LLM/LCS pass below, so we
  // don't burn an LLM call on the raw item name. Sitemap failures are
  // swallowed inside `fetchSitemapForDiscovery` and surface as `null`,
  // so the parallel promise can never reject.
  const primaryDomain: string | null = brandDomains[0] ?? null;
  const sitemapFetchPromise: Promise<SitemapFetched | null> = primaryDomain
    ? fetchSitemapForDiscovery(primaryDomain)
    : Promise.resolve(null);

  // ── Pass 1: Bare UPC search ───────────────────────────────────────────
  // Gather initial context about the product from retailers and marketplaces.
  let upcResults: SerperSearchResult[] = [];
  try {
    upcResults = await searchSerper(apiKeyRow.api_key, upc);
    for (const result of upcResults) {
      if (seenUrls.has(result.link)) continue;
      seenUrls.add(result.link);

      const resultDomain = extractDomain(result.link);
      const domainStatus = getDomainStatus(resultDomain);
      if (domainStatus && (domainStatus.status === 'blocked' || domainStatus.status === 'offline')) {
        console.log(`[SourceDiscovery] Skipping candidate ${result.link} because domain ${resultDomain} is marked ${domainStatus.status}`);
        continue;
      }

      const confidence = scoreResult(result, upc, name, brandHint, resultDomain, brandDomains);

      candidates.push({
        url: result.link,
        title: result.title,
        snippet: result.snippet,
        domain: resultDomain,
        confidence,
        sourceMethod: 'serper_upc',
      });
    }
  } catch (err) {
    console.error(`[SourceDiscovery] Pass 1 UPC search failed:`, err);
  }

  // ── Pass 2: Consolidated-name search ──────────────────────────────────
  // Consolidate search titles using LLM (or LCS fallback), then run an
  // **unconditional** unrestricted Google search on the consolidated name.
  // Mapped brand-domain searches and original-name fallbacks are layered
  // on top — but the consolidated-name search fires regardless of how
  // many UPC candidates we already collected.
  const consolidatedName = await consolidateProductName(
    upc,
    upcResults.map(r => ({ title: r.title, snippet: r.snippet })),
    name,
    brandHint,
  );

  const searchName = consolidatedName || name;
  // Clean the search name so the LLM-returned phrase works inside a query
  // (e.g. strip stray double quotes that some models include).
  const cleanSearchName = searchName ? searchName.replace(/"/g, '').trim() : '';
  const searchNameChanged = !!(name && cleanSearchName && cleanSearchName.toLowerCase() !== name.toLowerCase());

  if (cleanSearchName && cleanSearchName.length > 3) {
    // Query descriptors: `mandatory` queries are NOT skipped by the 15-candidate
    // pre-query cap so the operator always gets a Pass 2 chance at the
    // official product page.
    type Pass2Query = { query: string; mandatory?: boolean };
    const secondPassQueries: Pass2Query[] = [];
    const seenSecondPass = new Set<string>();
    const addSecondPassQuery = (query: string, mandatory = false) => {
      const normalized = query.trim();
      if (!normalized) return;
      if (seenSecondPass.has(normalized)) return;
      seenSecondPass.add(normalized);
      secondPassQueries.push({ query: normalized, mandatory });
    };

    // Mandatory unrestricted consolidated-name search — always fires when
    // we have a usable name. This is the search the operator relies on for
    // finding the official brand/product page even when brand sites are
    // not pre-mapped or the UPC pass already returned 10 retailer results.
    addSecondPassQuery(`${cleanSearchName} product page`, true);

    // Prioritize searching the consolidated product name on mapped brand
    // domains (best signal for official pages).
    for (const domain of brandDomains.slice(0, 2)) {
      addSecondPassQuery(`${cleanSearchName} site:${domain}`);
      // Fallback: Search using the original spreadsheet name to bypass bad
      // UPC-based LLM name consolidations.
      if (searchNameChanged) {
        addSecondPassQuery(`${name} site:${domain}`);
      }
    }

    // Low-candidate fallback: if Pass 1 produced almost nothing, also
    // search the original spreadsheet name in case the LLM consolidation
    // drifted from the real product.
    if (candidates.length < 5 && searchNameChanged) {
      addSecondPassQuery(`${name} product page`);
    }

    // Execute follow-up queries. Mandatory queries ignore the 15-candidate
    // pre-query cap; non-mandatory ones still respect it.
    for (const q of secondPassQueries) {
      if (!q.mandatory && candidates.length >= 15) break;

      console.log(`[SourceDiscovery] Pass 2 search for UPC ${upc}: "${q.query}"`);

      try {
        // Sleep slightly to avoid Serper rate-limiting
        await new Promise(r => setTimeout(r, 200));

        const results = await searchSerper(apiKeyRow.api_key, q.query);
        for (const result of results) {
          if (seenUrls.has(result.link)) continue;
          seenUrls.add(result.link);

          const resultDomain = extractDomain(result.link);
          const domainStatus = getDomainStatus(resultDomain);
          if (domainStatus && (domainStatus.status === 'blocked' || domainStatus.status === 'offline')) {
            console.log(`[SourceDiscovery] Skipping candidate ${result.link} because domain ${resultDomain} is marked ${domainStatus.status}`);
            continue;
          }

          const confidence = scoreResult(result, upc, name, brandHint, resultDomain, brandDomains);

          candidates.push({
            url: result.link,
            title: result.title,
            snippet: result.snippet,
            domain: resultDomain,
            confidence,
            sourceMethod: 'serper_name',
          });
        }
      } catch (err) {
        console.error(`[SourceDiscovery] Pass 2 query failed (${q.query}):`, err);
      }
    }
  }

  // ── Sitemap pass (deferred matching) ──────────────────────────────────
  // The fetch kicked off in parallel with Pass 1 above is (almost
  // certainly) resolved by now. Run the matcher with the consolidated
  // name so the operator gets the strongest possible signal. Sitemap
  // failures are logged and never thrown — we always continue with
  // the Serper-only results.
  let sitemapCandidates: InsertSourceData[] = [];
  if (primaryDomain) {
    const settled = await Promise.allSettled([sitemapFetchPromise]);
    const prepared = settled[0].status === 'fulfilled' ? settled[0].value : null;
    if (prepared && prepared.urls.length > 0) {
      try {
        const matches = await matchSitemapUrls(
          prepared.urls,
          name,
          consolidatedName,
          upc,
          primaryDomain,
          prepared.productUrlPattern,
        );
        sitemapCandidates = matches.map(convertSitemapMatchToCandidate);
      } catch (err) {
        console.warn(
          `[SourceDiscovery] Sitemap matching failed for ${primaryDomain}:`,
          err,
        );
      }
    } else if (settled[0].status === 'rejected') {
      console.warn(
        `[SourceDiscovery] Sitemap fetch rejected for ${primaryDomain}:`,
        settled[0].reason,
      );
    }
  }

  // Merge sitemap candidates with the Serper pool, applying the
  // cross-source boost/penalty rules before we sort and cap.
  const merged = mergeSitemapAndSerperCandidates(candidates, sitemapCandidates, primaryDomain);

  // Sort by confidence descending
  merged.sort((a, b) => b.confidence - a.confidence);

  // Cap to the top 10 — but guarantee that at least one `serper_name`
  // AND at least one `sitemap_name`/`sitemap_upc` candidate survive
  // the slice whenever any are available, so the discovery drawer
  // shows results from every discovery method that produced a hit.
  // Sitemap candidates that the cross-source boost pushed above 1.0
  // are clamped back into [0, 1] here.
  const topCandidates = selectTopCandidates(merged, 10).map(c => ({
    ...c,
    confidence: Math.max(0, Math.min(1, c.confidence))
  }));

  // ── Log meaningful discovery results ──────────────────────────────────
  if (consolidatedName) {
    console.log(`[SourceDiscovery] Consolidated name for UPC ${upc}: "${consolidatedName}"`);
  } else {
    console.log(`[SourceDiscovery] No consolidated name for UPC ${upc} (LLM unavailable or no results)`);
  }

  if (topCandidates.length > 0) {
    const top = topCandidates[0];
    console.log(`[SourceDiscovery] Found ${topCandidates.length} source candidates for UPC ${upc}. Top result: ${top.url} (confidence: ${(top.confidence * 100).toFixed(0)}%, domain: ${top.domain})`);

    if (topCandidates.length > 1) {
      const runnersUp = topCandidates.slice(1, 4).map(c =>
        `  · ${c.url} (${(c.confidence * 100).toFixed(0)}%, ${c.domain})`
      );
      console.log(`[SourceDiscovery] Runner-up sources for UPC ${upc}:\n${runnersUp.join('\n')}`);
    }
  } else {
    console.log(`[SourceDiscovery] No matching source URLs found for UPC ${upc}. Search name used: "${searchName}"`);
  }

  return {
    candidates: topCandidates,
    consolidatedName: consolidatedName || null
  };
}

// ─── Serper API ───────────────────────────────────────────────────────────────

/**
 * Execute a Serper.dev search query.
 */
async function searchSerper(apiKey: string, query: string): Promise<SerperSearchResult[]> {
  const cached = getCachedSerperResults(query);
  if (cached) {
    console.log(`[SourceDiscovery] Using cached Serper results for query: "${query}"`);
    return cached;
  }

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: 10,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Serper API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as SerperResponse;
  const results = data.organic ?? [];
  insertSerperCache(query, results);
  return results;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a search result for relevance as a product page.
 * Returns 0.0–1.0.
 *
 * Scoring priorities:
 * - Known brand domains get the highest boost (official brand pages are preferred)
 * - Brand name in domain is a strong signal
 * - UPC in content is the next strongest signal
 * - Product URL path patterns are a moderate signal
 * - Marketplaces are lightly penalized (valid fallback but not preferred)
 * - Social media, review, and irrelevant sites are heavily penalized
 */
// fallow-ignore-next-line unused-export
export function scoreResult(
  result: SerperSearchResult,
  upc: string,
  name: string,
  brandHint: string | null | undefined,
  domain: string,
  knownBrandDomains: string[],
): number {
  let score = 0.2; // base score for being a search result

  const url = result.link.toLowerCase();
  const snippet = (result.snippet ?? '').toLowerCase();
  const title = (result.title ?? '').toLowerCase();

  // ── Positive signals ──────────────────────────────────────────────────

  // Domain is a known brand site
  if (knownBrandDomains.some(d => domain.includes(d))) {
    score += 0.35;
  }

  // Brand name appears in domain (e.g., "nylabone" in "nylabone.com")
  if (brandHint && domain.includes(brandHint.toLowerCase().replace(/\s+/g, ''))) {
    score += 0.15;
  }

  // UPC appears in snippet or title: strong relevance signal
  if (snippet.includes(upc) || title.includes(upc)) {
    score += 0.15;
  }

  // UPC appears in the URL itself
  if (url.includes(upc)) {
    score += 0.05;
  }

  // Determine product and listing/CMS patterns
  const hasProductIndicator = /\/(products?|p|item|details?|dp|gp|buy)\//i.test(url);
  const isListingPage = /\/(collections?|category|categories|product-category|brands?|tags?|search)\//i.test(url) && !hasProductIndicator;
  const isCmsOrBlogPage = /\/(blogs?|articles?|pages)\//i.test(url) && !hasProductIndicator;

  // URL contains product path patterns (e.g., /products/, /product/, /p/, /shop/)
  if (hasProductIndicator || /\/shop\//i.test(url)) {
    score += 0.1;
  }

  // Penalize listing/category pages to avoid selecting them over specific products
  if (isListingPage) {
    score -= 0.35;
  }

  // Penalize general blog or CMS landing pages
  if (isCmsOrBlogPage) {
    score -= 0.25;
  }

  // Penalize support/help/docs subdomains (not standard e-commerce shop pages)
  const isSupportOrHelpDomain = /^(support|help|docs|faq|kb|service|info|blog|developer|api|mail|admin|portal|shop-help|connect|careers|about)\./i.test(domain);
  if (isSupportOrHelpDomain) {
    score -= 0.5;
  }

  // Advanced product name word matching (filtering out variant terms for base matching)
  const VARIANT_KEYWORDS = new Set([
    'small', 'medium', 'large', 'mini', 'giant', 'toy', 'sm', 'md', 'lg', 'xl', 'xxl', 'xs', 'size',
    'red', 'blue', 'green', 'yellow', 'orange', 'pink', 'purple', 'black', 'white', 'grey', 'gray', 'brown', 'lavender', 'teal', 'gold', 'silver',
    'pack', 'pk', 'count', 'ct', 'pcs', 'piece', 'pieces', 'bag', 'box', 'can', 'oz', 'lbs', 'lb'
  ]);

  const allNameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const baseNameWords = allNameWords.filter(w => !VARIANT_KEYWORDS.has(w));
  const titleWords = title.toLowerCase().split(/[^\w]+/).filter(w => w.length > 3);

  const wordsToMatch = baseNameWords.length > 0 ? baseNameWords : allNameWords;

  // 1. Base Matches (with bidirectional substring matching for concatenated words)
  let baseMatches = 0;
  for (const nw of wordsToMatch) {
    if (title.includes(nw) || titleWords.some(tw => nw.includes(tw))) {
      baseMatches++;
    }
  }

  // 2. Variant Matches (tie-breaker)
  let variantMatches = 0;
  const variantWords = allNameWords.filter(w => VARIANT_KEYWORDS.has(w));
  for (const vw of variantWords) {
    if (title.includes(vw) || titleWords.some(tw => vw.includes(tw)) || url.includes(vw)) {
      variantMatches++;
    }
  }

  const baseOverlap = wordsToMatch.length > 0 ? baseMatches / wordsToMatch.length : 0;
  const variantOverlap = variantWords.length > 0 ? variantMatches / variantWords.length : 0;

  // Add overlap weights: 0.25 max for base matching + 0.05 max for variant tie-breakers
  score += 0.25 * baseOverlap + 0.05 * variantOverlap;

  // Domain looks like a pet retailer / specialty shop
  if (/pet|animal|dog|cat|paw|woof|bark|feed|farm|supply|agway/.test(domain)) {
    score += 0.05;
  }

  // ── Negative signals ──────────────────────────────────────────────────

  // Penalize large marketplaces (useful fallback but not preferred over brand/retailer pages)
  if (/amazon\.com|ebay\.com|walmart\.com|target\.com|alibaba\.com|aliexpress\.com|temu\.com/.test(domain)) {
    score -= 0.1;
  }

  // Penalize social media sites (Facebook/Instagram noise from test data)
  if (/facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|pinterest\.com|reddit\.com/.test(domain)) {
    score -= 0.25;
  }

  // Penalize review/comparison/coupon sites
  if (/review|compare|versus|bestbuy\.com|pricewatch|coupon|deal/.test(domain)) {
    score -= 0.1;
  }

  // Penalize non-product content indicators in title
  if (/clearance|haul|sale|coupon|unboxing|review/i.test(title) && !/product|shop|buy/i.test(title)) {
    score -= 0.1;
  }

  // Heavily penalize irrelevant domains (random e-commerce noise for some UPCs)
  if (/newegg\.com|zoro\.com|instacart\.com|issuu\.com|mercadolibre/.test(domain)) {
    score -= 0.3;
  }

  return Math.max(0, score);
}

// ─── Sitemap discovery helpers ────────────────────────────────────────────────

/**
 * Result of a sitemap fetch. `urls` is the flat list of URLs from the
 * sitemap (possibly filtered by `productUrlPattern`); `productUrlPattern`
 * is propagated so the matcher can re-use the same filter on its
 * cached copy; `sourceUrl` is the original sitemap URL that produced
 * the result (used as the cache's `source_url` audit trail).
 */
interface SitemapFetched {
  urls: string[];
  productUrlPattern: string | null;
  sourceUrl: string;
}

/**
 * Cache-first sitemap fetch for a brand domain.
 *
 * Consults `getCachedSitemapUrls` first; on a cache miss, looks up the
 * extractor profile's `sitemapProductUrlPattern` to use as a URL filter
 * and calls `fetchAndParseSitemap` to discover and parse the sitemap.
 * Successful fresh fetches are persisted via `insertSitemapCache` so
 * the next call short-circuits the network round-trip.
 *
 * Never throws — any error (cache miss without a network, profile
 * lookup failure, fetch error, cache write failure) is logged as a
 * warning and surfaces as a `null` return value. This is what makes
 * the parallel `discoverSources` integration safe: the returned
 * promise always resolves, so `Promise.allSettled` is only used
 * defensively at the call site.
 */
async function fetchSitemapForDiscovery(
  domain: string,
): Promise<SitemapFetched | null> {
  try {
    const cached = getCachedSitemapUrls(domain);
    if (cached) {
      const profile = findProfileByDomain(domain);
      return {
        urls: cached,
        productUrlPattern: profile?.sitemapProductUrlPattern ?? null,
        sourceUrl: '',
      };
    }

    // Cache miss — fetch (and best-effort cache) the sitemap.
    const profile = findProfileByDomain(domain);
    const productUrlPattern = profile?.sitemapProductUrlPattern ?? null;
    const result = await fetchAndParseSitemap(domain, productUrlPattern);
    if (result.urls.length > 0) {
      try {
        insertSitemapCache(domain, result.urls, result.sourceUrl);
      } catch (cacheErr) {
        // Cache write failures are not fatal — the URLs are still
        // usable for this run; the next call will just re-fetch.
        console.warn(
          `[SourceDiscovery] Failed to cache sitemap for ${domain}:`,
          cacheErr,
        );
      }
    }
    return {
      urls: result.urls,
      productUrlPattern,
      sourceUrl: result.sourceUrl,
    };
  } catch (err) {
    console.warn(
      `[SourceDiscovery] Sitemap fetch failed for ${domain}:`,
      err,
    );
    return null;
  }
}

/**
 * High-level sitemap discovery pass: fetch the domain's sitemap and
 * run the three-pass matcher against the item's name + UPC.
 *
 * Used as the integration point in `discoverSources`; returns
 * `InsertSourceData[]` shaped the same way as the Serper candidates
 * so downstream merging is uniform. Returns `[]` on any error so
 * sitemap failures never break the Serper-driven pipeline.
 *
 * Note: this function is intentionally defined as a public entry
 * point for callers (e.g. tests, future bulk-sitemap tooling) that
 * want the full fetch+match in one call. The inline integration in
 * `discoverSources` deliberately uses the lower-level
 * `fetchSitemapForDiscovery` + `matchSitemapUrls` helpers so the
 * network fetch can run in parallel with Pass 1 and the matching can
 * be deferred until the consolidated name is available.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function discoverFromSitemap(
  domain: string,
  itemName: string,
  consolidatedName: string | null,
  upc: string,
): Promise<InsertSourceData[]> {
  const prepared = await fetchSitemapForDiscovery(domain);
  if (!prepared || prepared.urls.length === 0) {
    return [];
  }

  let matches: SitemapMatchResult[];
  try {
    matches = await matchSitemapUrls(
      prepared.urls,
      itemName,
      consolidatedName,
      upc,
      domain,
      prepared.productUrlPattern,
    );
  } catch (err) {
    console.warn(
      `[SourceDiscovery] Sitemap matching failed for ${domain}:`,
      err,
    );
    return [];
  }

  return matches.map(convertSitemapMatchToCandidate);
}

/**
 * Convert a single `SitemapMatchResult` from the matcher into the
 * generic `InsertSourceData` shape used by the Serper pipeline. The
 * snippet is a short, human-readable label that records *how* the
 * URL was selected so the discovery drawer can show why a sitemap
 * URL is being surfaced alongside the Serper hits. Title is null
 * because the sitemap only carries URLs — the extraction stage is
 * what produces a title.
 */
function convertSitemapMatchToCandidate(
  match: SitemapMatchResult,
): InsertSourceData {
  return {
    url: match.url,
    title: null,
    snippet: sitemapSnippetFor(match.matchType),
    domain: extractDomain(match.url),
    confidence: match.confidence,
    sourceMethod: match.sourceMethod,
  };
}

function sitemapSnippetFor(matchType: SitemapMatchResult['matchType']): string {
  switch (matchType) {
    case 'upc_exact':
      return 'Sitemap match: UPC exact';
    case 'llm_selected':
      return 'Sitemap match: LLM-selected by product name';
    case 'token_overlap':
      return 'Sitemap match: name-token overlap';
  }
}

/**
 * Merge sitemap candidates with the Serper pool, applying the
 * cross-source boost/penalty rules:
 *
 *   - Sitemap URL already in Serper pool: keep the sitemap candidate
 *     with confidence +0.15 (an independent signal that this is the
 *     canonical product URL).
 *   - Sitemap URL not in Serper pool: add as a new candidate.
 *   - Serper candidate on the official brand domain whose URL is not
 *     in the sitemap set: confidence -0.2. The sitemap is the most
 *     complete inventory of a brand's product URLs, so a brand-domain
 *     hit that the sitemap doesn't know about is often a stale,
 *     discontinued, or off-domain listing.
 *
 * Returns a single list with no duplicate URLs. The merge preserves
 * the original order of the sitemap candidates so the LLM-pick
 * (always first in the matcher's output) is surfaced in slot 0.
 */
function mergeSitemapAndSerperCandidates(
  serperCandidates: InsertSourceData[],
  sitemapCandidates: InsertSourceData[],
  primaryBrandDomain: string | null,
): InsertSourceData[] {
  if (sitemapCandidates.length === 0) {
    return serperCandidates;
  }

  const sitemapUrlSet = new Set<string>(
    sitemapCandidates.map(c => normalizeUrlForMerge(c.url)),
  );

  const result: InsertSourceData[] = [];
  const emitted = new Set<string>();

  for (const sc of sitemapCandidates) {
    const norm = normalizeUrlForMerge(sc.url);
    if (emitted.has(norm)) continue;
    const inSerperPool = serperCandidates.some(
      c => normalizeUrlForMerge(c.url) === norm,
    );
    result.push(
      inSerperPool
        ? { ...sc, confidence: clamp01(sc.confidence + 0.15) }
        : sc,
    );
    emitted.add(norm);
  }

  for (const sc of serperCandidates) {
    const norm = normalizeUrlForMerge(sc.url);
    if (emitted.has(norm)) continue;
    const penalized =
      primaryBrandDomain !== null &&
      (sc.domain ?? '').toLowerCase() === primaryBrandDomain.toLowerCase() &&
      !sitemapUrlSet.has(norm);
    result.push(
      penalized
        ? { ...sc, confidence: clamp01(sc.confidence - 0.2) }
        : sc,
    );
    emitted.add(norm);
  }

  return result;
}

/**
 * Normalize a URL for set membership during the sitemap/Serper merge.
 * Comparison is case-insensitive and tolerant of trailing slashes so
 * `https://shop.com/p/foo` and `https://shop.com/p/foo/` count as the
 * same URL. The scheme/host/path-suffix structure is preserved.
 */
function normalizeUrlForMerge(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Pick the top N candidates by confidence, but ensure at least one
 * candidate from each *priority group* survives the slice when any
 * exist. The groups are:
 *
 *   - `serper_name`           — the consolidated-name Google search.
 *   - `sitemap_name` / `sitemap_upc` — the sitemap matcher results.
 *
 * Without this guarantee, a 10-strong Pass 1 set of retailer pages
 * can crowd out the one or two official product pages returned by
 * the name search or the sitemap, which means the operator never
 * sees that source's output in the discovery drawer.
 *
 * When a swap is required, the lowest-confidence *selected* candidate
 * from outside the protected set is replaced with the highest-
 * confidence *unselected* candidate from the priority group. The
 * protected set is the union of all priority methods, so a swap in
 * one group cannot undo a swap in another group.
 */
function selectTopCandidates<T extends { sourceMethod?: string; confidence: number }>(
  candidates: T[],
  limit: number,
): T[] {
  if (candidates.length <= limit) return [...candidates];

  // Indexes grouped by method to avoid mutating the input.
  const byMethod = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    const key = c.sourceMethod ?? 'unknown';
    const arr = byMethod.get(key) ?? [];
    arr.push(i);
    byMethod.set(key, arr);
  });

  // Default behavior: take the top `limit` by confidence.
  let top = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.confidence - a.c.confidence)
    .slice(0, limit)
    .map(x => x.i);

  // Priority groups: at least one candidate from each group must
  // survive when any exist. Methods in PROTECTED_METHODS cannot be
  // evicted by a swap (so swaps in different groups don't fight).
  const PRIORITY_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['serper_name'],
    ['sitemap_name', 'sitemap_upc'],
  ];
  const PROTECTED_METHODS = new Set<string>(PRIORITY_GROUPS.flat());

  for (const group of PRIORITY_GROUPS) {
    const selectedSet = new Set(top);
    const isInGroup = (m: number): boolean =>
      group.includes(candidates[m]?.sourceMethod ?? '');
    const selectedGroupCount = top.filter(isInGroup).length;
    const anyGroupAvailable = group.some(method =>
      (byMethod.get(method) ?? []).some(m => !selectedSet.has(m)),
    );
    if (selectedGroupCount > 0 || !anyGroupAvailable) {
      // The slice already includes a candidate from this group, or
      // no candidate exists to rescue.
      continue;
    }

    // Find the highest-confidence unselected candidate from this group.
    const unselectedGroupIndexes = group.flatMap(method =>
      (byMethod.get(method) ?? []).filter(m => !selectedSet.has(m)),
    );
    const bestGroup = unselectedGroupIndexes
      .map(m => ({ m, c: candidates[m].confidence }))
      .sort((a, b) => b.c - a.c)[0]?.m;
    if (bestGroup === undefined) {
      continue;
    }

    // Evict the lowest-confidence selected *non-protected* candidate.
    const evictableIndexes = top.filter(
      m => !PROTECTED_METHODS.has(candidates[m]?.sourceMethod ?? ''),
    );
    const victim = evictableIndexes
      .map(m => ({ m, c: candidates[m].confidence }))
      .sort((a, b) => a.c - b.c)[0]?.m;
    if (victim === undefined) {
      continue;
    }

    top = top.slice();
    const victimPos = top.indexOf(victim);
    top[victimPos] = bestGroup;
    // Re-sort by confidence desc to keep the array ordered.
    top.sort((a, b) => candidates[b].confidence - candidates[a].confidence);
  }

  return top.map(i => candidates[i]);
}

/**
 * Extract domain from a URL.
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
