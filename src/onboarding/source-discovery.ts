/**
 * Source discovery using Serper.dev Google Search API.
 * Finds product pages by UPC, prioritizing official brand pages.
 *
 * Strategy:
 * 1. If known brand domains exist in the database (mapped by the user), search UPC scoped to those domains first
 * 2. Bare UPC search as fallback (returns retailer/distributor pages)
 */

import { getApiKey } from '../db/repositories/api-key-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';
import { consolidateProductName } from './llm-client';
import { getDomainStatus } from '../db/repositories/domain-status-repo';

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
 * 2. Scoped search on brand sites (if mapped) using the canonical product name.
 */
export async function discoverSources(
  upc: string,
  name: string,
  brandHint?: string | null,
): Promise<InsertSourceData[]> {
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

  // ── Pass 2: Scoped Name search ────────────────────────────────────────
  // Consolidate search titles using LLM (or LCS fallback), then search the brand sites.
  const consolidatedName = await consolidateProductName(
    upc,
    upcResults.map(r => ({ title: r.title, snippet: r.snippet })),
    name,
    brandHint,
  );

  const searchName = consolidatedName || name;

  if (searchName && searchName.trim().length > 3) {
    const secondPassQueries: string[] = [];

    // Prioritize searching the consolidated product name on mapped brand domains
    for (const domain of brandDomains.slice(0, 2)) {
      secondPassQueries.push(`${searchName} site:${domain}`);
      
      // Fallback: Search using the original spreadsheet name to bypass bad UPC-based LLM name consolidations
      if (name && searchName.toLowerCase() !== name.toLowerCase()) {
        secondPassQueries.push(`${name} site:${domain}`);
      }
    }

    // Add generic fallback query if we don't have enough candidates
    if (candidates.length < 5) {
      secondPassQueries.push(`${searchName} product page`);
      if (name && searchName.toLowerCase() !== name.toLowerCase()) {
        secondPassQueries.push(`${name} product page`);
      }
    }

    // Execute follow-up queries
    for (const query of secondPassQueries) {
      if (candidates.length >= 15) break;

      try {
        // Sleep slightly to avoid Serper rate-limiting
        await new Promise(r => setTimeout(r, 200));

        const results = await searchSerper(apiKeyRow.api_key, query);
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
        console.error(`[SourceDiscovery] Pass 2 query failed (${query}):`, err);
      }
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  // Return top 10
  return candidates.slice(0, 10);
}

// ─── Serper API ───────────────────────────────────────────────────────────────

/**
 * Execute a Serper.dev search query.
 */
async function searchSerper(apiKey: string, query: string): Promise<SerperSearchResult[]> {
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Serper API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as SerperResponse;
  return data.organic ?? [];
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
function scoreResult(
  result: SerperSearchResult,
  upc: string,
  name: string,
  brandHint: string | null | undefined,
  domain: string,
  knownBrandDomains: string[],
): number {
  let score = 0.3; // base score for being a search result

  const url = result.link.toLowerCase();
  const snippet = (result.snippet ?? '').toLowerCase();
  const title = (result.title ?? '').toLowerCase();

  // ── Positive signals ──────────────────────────────────────────────────

  // Domain is a known brand site — highest trust, always preferred
  if (knownBrandDomains.some(d => domain.includes(d))) {
    score += 0.35;
  }

  // Brand name appears in domain (e.g., "nylabone" in "nylabone.com")
  if (brandHint && domain.includes(brandHint.toLowerCase().replace(/\s+/g, ''))) {
    score += 0.2;
  }

  // UPC appears in snippet or title: strong relevance signal
  if (snippet.includes(upc) || title.includes(upc)) {
    score += 0.2;
  }

  // UPC appears in the URL itself
  if (url.includes(upc)) {
    score += 0.1;
  }

  // URL contains product path patterns (e.g., /product/, /p/, /shop/)
  if (/\/(product|p|shop|item|detail|dp|buy|collections)\//i.test(url)) {
    score += 0.1;
  }

  // Product name words appear in title (use only longer words to avoid false matches)
  const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const matchingWords = nameWords.filter(w => title.includes(w));
  if (nameWords.length > 0) {
    score += 0.1 * (matchingWords.length / nameWords.length);
  }

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

  return Math.max(0, Math.min(1, score));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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
