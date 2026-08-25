/**
 * Source discovery over locally indexed official brand domains.
 *
 * Brands and their official domains are configured ahead of time by the
 * operator (`brand_sites`, Settings → Domain Configuration). There is NO
 * external web-search/SERP dependence: discovery resolves candidates from
 *
 *   1. **Step 0 — local brand URL index** (`brand_url_index`, populated by
 *      sitemap sync / Shopify catalog ingest): exact UPC/SKU, token and
 *      LLM-selected matches (`local-brand-url-finder.ts`). A high-confidence
 *      match validated by HEAD/GET short-circuits everything else.
 *   2. **Sitemap pass**: fetch (cache-first) the mapped domain's sitemap and
 *      run the matcher's passes (UPC exact, product URL filter, token overlap
 *      + LLM selection) against the indexed URLs.
 *
 * Items that match a distributor record never enter Discovery at all — the
 * sourcing engine routes them straight to Extraction.
 */

import { findBrandSites } from '../db/repositories/brand-site-repo';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';
import { getCachedSitemapUrls, insertSitemapCache } from '../db/repositories/sitemap-cache-repo';
import { fetchAndParseSitemap } from './sitemap-fetcher';
import { matchSitemapUrls, type SitemapMatchResult } from './sitemap-matcher';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { isKnownRetailerOrDistributorDomain } from './discovery/retailer-domain-list';
import { scoreBrandDomainMatch } from './discovery/official-domain';
import { resolveVariantsForCandidates } from './variant-url-resolver';
import { findLocalBrandCandidates } from './local-brand-url-finder';
import { getActiveUrlsForDomain } from '../db/repositories/brand-url-index-repo';
import { recordDiscoveryEvent } from '../db/repositories/sitemap-telemetry-repo';

/** Minimal structural fetch signature — lets Product Intelligence inject the
 *  policy-gateway bound transport (P0-1); onboarding keeps the global fetch. */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Discover candidate product page URLs from the brand's locally indexed
 * official domain (brand_url_index + sitemap). Never throws for "missing
 * search key" style setup — when no candidates can be produced the caller
 * parks the item via its standard needs_input outcomes.
 */
export async function discoverSources(
  upc: string,
  name: string,
  brandHint?: string | null,
  options?: {
    price?: number | null;
    existingExpectedName?: string | null;
    /**
     * P0-1 (round 3): injected transport so Product Intelligence can bind
     * every HTTP call in the discovery chain (sitemap, variant-page
     * fetches) to the policy gateway. The onboarding pipeline keeps the
     * default global fetch.
     */
    networkFetch?: NetworkFetch;
    /**
     * Frozen classification model-policy view (issue #17 item A). Protected
     * LLM page-selection calls route through it.
     */
    modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null;
  }
): Promise<{
  candidates: InsertSourceData[];
  consolidatedName: string | null;
  noDomainMapped?: boolean;
}> {
  // Retrieve pre-mapped brand domains from database
  const activeBrandHint = brandHint;
  const activeBrandDomains: string[] = [];
  if (activeBrandHint) {
    const knownSites = findBrandSites(activeBrandHint);
    for (const site of knownSites) {
      const bareDomain = cleanDomainString(site.domain);
      if (bareDomain && !activeBrandDomains.includes(bareDomain)) {
        activeBrandDomains.push(bareDomain);
      }
    }
  }

  const primaryDomain: string | null = activeBrandDomains[0] ?? null;

  // A known brand with no official domain mapped halts discovery before any
  // lookup: the operator must map a domain in Settings first (needs_input_setup).
  if (activeBrandHint && activeBrandHint.trim() && activeBrandDomains.length === 0) {
    console.log(`[SourceDiscovery] Brand "${activeBrandHint}" has no official domain configured. Halting discovery.`);
    return {
      candidates: [],
      consolidatedName: options?.existingExpectedName ?? null,
      noDomainMapped: true,
    };
  }

  const candidates: InsertSourceData[] = [];

  // ── Step 0: Priority Local Brand URL Index Lookup ─────────────────────────
  // When a brand domain is mapped, attempt cheap local discovery first.
  // If a high-confidence match (confidence >= 0.85) is found and verified,
  // we return it immediately without running the sitemap matcher.
  if (primaryDomain && activeBrandDomains.length > 0) {
    const activeUrls = getActiveUrlsForDomain(primaryDomain);
    if (activeUrls.length === 0) {
      try {
        await fetchSitemapForDiscovery(primaryDomain, options?.networkFetch);
      } catch { /* best effort */ }
    }

    try {
      const localMatches = await findLocalBrandCandidates(
        primaryDomain,
        {
          upc,
          name,
          brandHint: activeBrandHint,
          price: options?.price,
        },
        { modelPolicy: options?.modelPolicy }
      );

      const topLocal = localMatches[0];
      if (topLocal && topLocal.confidence >= 0.85) {
        console.log(`[SourceDiscovery] ✓ High-confidence local sitemap match for UPC ${upc} on ${primaryDomain} (${topLocal.url}, confidence: ${topLocal.confidence.toFixed(2)}). Validating URL...`);

        let isValid = true;
        const fetchFn = options?.networkFetch || fetch;
        try {
          const checkRes = await fetchFn(topLocal.url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(6000),
          });
          if (!checkRes.ok && checkRes.status !== 405) {
            const getRes = await fetchFn(topLocal.url, {
              method: 'GET',
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
              signal: AbortSignal.timeout(6000),
            });
            if (!getRes.ok) isValid = false;
          }
        } catch {
          if (topLocal.matchType !== 'upc_exact') {
            isValid = false;
          }
        }

        if (isValid) {
          console.log(`[SourceDiscovery] ✓ Local match validated for ${topLocal.url}. Short-circuiting sitemap matching.`);

          const localCandidates: InsertSourceData[] = localMatches.map((m) => {
            const rankSignals = buildRankSignals(activeBrandHint, primaryDomain!);
            return {
              url: m.url,
              title: m.title || null,
              snippet: sitemapSnippetFor(m.matchType),
              domain: primaryDomain!,
              confidence: m.confidence,
              sourceMethod: m.sourceMethod as InsertSourceData['sourceMethod'],
              ...(rankSignals ? { metadataJson: JSON.stringify(rankSignals) } : {}),
            };
          });

          try {
            recordDiscoveryEvent({
              upc,
              domain: primaryDomain,
              satisfied_locally: 1,
              candidate_url: topLocal.url,
              confidence: topLocal.confidence,
              source_method: topLocal.sourceMethod,
            });
          } catch { /* best effort */ }

          return {
            candidates: localCandidates,
            // Expected name comes from the imported spreadsheet row only;
            // discovery never synthesizes or persists an expected name.
            consolidatedName: options?.existingExpectedName ?? null,
          };
        } else {
          console.log(`[SourceDiscovery] Local candidate ${topLocal.url} failed validation. Falling through to sitemap matching.`);
        }
      }
    } catch (err) {
      console.warn(`[SourceDiscovery] Local candidate search failed for ${primaryDomain}:`, err);
    }
  }

  // ── Sitemap pass ──────────────────────────────────────────────────────────
  // Fetch (cache-first) the mapped domain's sitemap and run the three-pass
  // matcher (UPC exact, product URL filter, token overlap + LLM selection)
  // against the indexed URLs using the item's spreadsheet name. Sitemap
  // failures NEVER throw — they surface as zero candidates.
  const consolidatedName = options?.existingExpectedName ?? null;

  if (primaryDomain) {
    const prepared = await fetchSitemapForDiscovery(primaryDomain, options?.networkFetch);
    if (prepared && prepared.urls.length > 0) {
      try {
        const matches = await matchSitemapUrls(
          prepared.urls,
          name,
          consolidatedName,
          upc,
          primaryDomain,
          prepared.productUrlPattern,
          options?.modelPolicy,
        );
        for (const match of matches) {
          candidates.push(convertSitemapMatchToCandidate(match));
        }
      } catch (err) {
        console.warn(
          `[SourceDiscovery] Sitemap matching failed for ${primaryDomain}:`,
          err,
        );
      }
    }
  }

  // Run variant resolution on the candidates before ranking.
  const variantResolved = await resolveVariantsForCandidates({
    candidates,
    upc,
    rawName: name,
    expectedName: consolidatedName || name,
    brandHint: activeBrandHint ?? null,
    brandDomains: activeBrandDomains,
    price: options?.price,
    // P0-1 (round 3): the variant resolver's page fetches ride the same
    // injected transport as the sitemap calls above.
    fetchFn: options?.networkFetch,
  });

  // Sort by confidence descending and cap to the top 10.
  const topCandidates = selectTopCandidates(variantResolved, 10).map(c => ({
    ...c,
    confidence: Math.max(0, Math.min(1, c.confidence))
  }));

  // ── Log meaningful discovery results ──────────────────────────────────
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
    console.log(`[SourceDiscovery] No matching source URLs found for UPC ${upc}. Search name used: "${name}"`);
  }

  try {
    recordDiscoveryEvent({
      upc,
      domain: primaryDomain,
      satisfied_locally: 0,
      candidate_url: topCandidates[0]?.url || null,
      confidence: topCandidates[0]?.confidence || null,
      source_method: topCandidates[0]?.sourceMethod || null,
    });
  } catch { /* best effort */ }

  return {
    candidates: topCandidates,
    consolidatedName,
  };
}

// ─── Ranking-signal metadata ─────────────────────────────────────────────────

/**
 * Rank-signal metadata for a candidate (epic #46 follow-up, phase 6):
 * why this candidate was promoted/demoted — explainable discovery.
 */
function buildRankSignals(
  brandHint: string | null | undefined,
  domain: string,
): { rankSignals: { strongBrandDomainMatch: boolean; brandDomainMatchScore: number; knownRetailerDomain: boolean } } | null {
  const brandDomainMatchScore = scoreBrandDomainMatch(brandHint, domain);
  const knownRetailerDomain = isKnownRetailerOrDistributorDomain(domain);
  if (brandDomainMatchScore < 0.5 && !knownRetailerDomain) return null;
  return {
    rankSignals: {
      strongBrandDomainMatch: brandDomainMatchScore >= 0.5,
      brandDomainMatchScore,
      knownRetailerDomain,
    },
  };
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
 * warning and surfaces as a `null` return value.
 */
async function fetchSitemapForDiscovery(
  domain: string,
  networkFetch?: NetworkFetch,
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
    // P0-1 (round 3): thread the injected transport into the sitemap fetcher
    // (it already accepts fetchFn); default = global fetch for onboarding.
    const result = await fetchAndParseSitemap(domain, productUrlPattern, networkFetch);
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
 * Convert a single `SitemapMatchResult` from the matcher into the
 * generic `InsertSourceData` shape used by the pipeline. The
 * snippet is a short, human-readable label that records *how* the
 * URL was selected so the discovery drawer can show why a sitemap
 * URL is being surfaced. Title is null because the sitemap only
 * carries URLs — the extraction stage is what produces a title.
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

function sitemapSnippetFor(matchType: string): string {
  switch (matchType) {
    case 'upc_exact':
      return 'Sitemap match: UPC exact';
    case 'sku_exact':
      return 'Sitemap match: SKU exact';
    case 'llm_selected':
      return 'Sitemap match: LLM-selected by product name';
    case 'token_overlap':
    default:
      return 'Sitemap match: name-token overlap';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Pick the top N candidates by confidence (plain descending sort).
 */
function selectTopCandidates<T extends { confidence: number }>(
  candidates: T[],
  limit: number,
): T[] {
  if (candidates.length <= limit) return [...candidates];
  return [...candidates]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
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

/**
 * Clean a brand site domain to return only the bare domain name.
 */
function cleanDomainString(domainStr: string): string {
  const cleaned = domainStr.trim().toLowerCase();
  try {
    const urlString = cleaned.match(/^https?:\/\//i) ? cleaned : `https://${cleaned}`;
    const parsed = new URL(urlString);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return cleaned.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}
