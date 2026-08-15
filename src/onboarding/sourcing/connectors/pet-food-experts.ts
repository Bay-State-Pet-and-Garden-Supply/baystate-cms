import type { CheerioAPI } from 'cheerio';
import {
  type DistributorConnector,
  type DistributorCatalogRecord,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
} from '../contracts';
import type { HtmlScraperConnectionConfig, HtmlScraperRuntimePolicy, ScraperFetchPage } from '../html-scraper/contracts';
import { HTML_SCRAPER_CEILINGS, parseHtmlScraperConnectionConfig } from '../html-scraper/contracts';
import { PET_FOOD_EXPERTS_LOGIN } from '../html-scraper/login-config';
import { createCrawleeHtmlScraperEngine, createHtmlScraperSessionManager } from '../html-scraper/session-runner';
import { parseHtmlScraperCredentials } from '../html-scraper/credentials';
import {
  anyMatches,
  dedupeStrings,
  isAllowedHttpsUrl,
  loadHtml,
  resolveUrl,
  sameGtin,
  sameOrigin,
  textList,
} from '../html-scraper/html-utils';

/**
 * Pet Food Experts (`html_scraper + pet_food_experts`) connector
 * (ADR 0014 Amendment B, M4 — tier 2 authenticated storefront).
 *
 * B2B portal at `https://orders.petfoodexperts.com` (React SPA; rendered
 * DOM carries `data-test-selector` markup). Search by normalized UPC/GTIN
 * (`/Search?query={identifier}`). The found rule is EXACT: the PDP's
 * `UPC#`/`EA` product-meta value must equal the normalized lookup
 * identifier — an item number or image filename alone never establishes a
 * match, and name/brand similarity never rescues a mismatch.
 *
 * Auth: a Playwright login against the fixed `/SignIn` page (selectors
 * verified live 2026-08-15: `#userName`, `#password`,
 * `button[data-test-selector='signIn_submit']`, success
 * `[data-test-selector='header_userName']`) establishes an in-memory session
 * via the M2 runner (memory-only cookies, exactly one re-login, 15-minute
 * TTL). A fetched page still carrying the login form or the `signIn_error`
 * indicator is reported as `auth_required` / `auth_failed`.
 *
 * Excluded by policy: price, stock status, add-to-cart inference,
 * availability, pallet quantity, and unreviewed facets.
 */
export const PET_FOOD_EXPERTS_NAVIGATION_ORIGIN = 'https://orders.petfoodexperts.com';

const PET_FOOD_EXPERTS_ASSET_HOSTS = ['orders.petfoodexperts.com', 'cdn.insitecloud.net'];

/** Max product candidates followed per lookup (bounded, deterministic). */
const MAX_PDP_CANDIDATES = 3;

/** Auth-page markers: the login form fields or the sign-in error indicator. */
const AUTH_PAGE_SELECTORS = [
  '#userName',
  '#password',
  "[data-test-selector='signIn_error']",
];

/** Product detail links (search results). */
const PRODUCT_HREF_RE = /\/product\//i;

/** Injectable page fetcher (tests); production uses the bounded session runner. */
export interface PetFoodExpertsConnectorDeps {
  fetchPage?: ScraperFetchPage;
  now?: () => string;
}

export interface PetFoodExpertsPdpData {
  upc: string | null;
  name: string | null;
  brand: string | null;
  distributorSku: string | null;
  weight: string | null;
  description: string | null;
  category: string | null;
  features: string[];
  ingredients: string | null;
  unitOfMeasure: string | null;
  images: string[];
  /** Whether the page structurally looked like a PDP (name/upc/sku present). */
  parsed: boolean;
}

function buildPolicy(config: HtmlScraperConnectionConfig | null): HtmlScraperRuntimePolicy {
  return {
    providerId: 'pet_food_experts',
    navigationOrigin: PET_FOOD_EXPERTS_NAVIGATION_ORIGIN,
    assetHosts: PET_FOOD_EXPERTS_ASSET_HOSTS,
    responseCapBytes: config?.responseCapBytes ?? HTML_SCRAPER_CEILINGS.responseCapBytes,
    maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
    requestTimeoutMs: config?.requestTimeoutMs ?? HTML_SCRAPER_CEILINGS.requestTimeoutMs,
    requestsPerMinute: config?.requestsPerMinute ?? HTML_SCRAPER_CEILINGS.authRequestsPerMinute,
    sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
    retryCount: HTML_SCRAPER_CEILINGS.retryCount,
    allowBrowserFallback: true,
  };
}

/** Production fetcher: ONE session manager per lookup, then closed. */
function makeDefaultFetcher(
  connectionId: string,
  policy: HtmlScraperRuntimePolicy,
  credentials: { username: string; password: string },
): { fetchPage: ScraperFetchPage; close: () => Promise<void> } {
  const manager = createHtmlScraperSessionManager(createCrawleeHtmlScraperEngine());
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    const result = await manager.fetchHtml({
      connectionId,
      providerId: policy.providerId,
      url,
      policy,
      loginConfig: PET_FOOD_EXPERTS_LOGIN,
      credentials,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      browserRequired: opts.browserRequired ?? false,
      waitForSelectors: opts.waitForSelectors ?? [],
    });
    if (result.ok) {
      if (anyMatches(result.html, AUTH_PAGE_SELECTORS)) {
        return { ok: false, code: 'auth_required', message: 'pet_food_experts returned the login form instead of content' };
      }
      return { ok: true, html: result.html, finalUrl: result.finalUrl };
    }
    return { ok: false, code: result.code, message: result.message };
  };
  return { fetchPage, close: () => manager.closeAll() };
}

/** Search-result candidate PDP links (absolute, same-origin, deduped). */
export function parsePetFoodExpertsSearchCandidates(html: string): string[] {
  const $ = loadHtml(html);
  const urls: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (PRODUCT_HREF_RE.test(href)) {
      const abs = resolveUrl(href, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN);
      if (abs && sameOrigin(abs, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN)) urls.push(abs);
    }
  });
  return dedupeStrings(urls).slice(0, MAX_PDP_CANDIDATES);
}

/** Labeled specification value (e.g. `Brand:` / `Weight:` in a dl). */
function labeledSpec($: CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $('dt').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.toLowerCase().replace(/:$/, '') === label.toLowerCase()) {
      const value = $(el).next('dd').text().replace(/\s+/g, ' ').trim();
      if (value) {
        found = value;
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/** First `UPC# …` / `Item # …` product-meta value. */
function productMetaValue(html: string, $: CheerioAPI, labelRe: RegExp): string | null {
  const explicit = textList(html, "[data-test-selector='productUPC'], [data-test-selector='productItemNumber']");
  for (const value of explicit) {
    const m = value.match(labelRe);
    if (m && m[1].trim()) return m[1].trim();
  }
  const meta = $('.product-meta').first();
  if (meta.length) {
    const m = meta.text().match(labelRe);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** Recognizable search page: results container or no-results marker. */
export function isPetFoodExpertsSearchPage(html: string): boolean {
  return (
    anyMatches(html, ["[data-test-selector='productCard']", "[data-test-selector='noResults']", '.no-results-found', '.search-results']) ||
    parsePetFoodExpertsSearchCandidates(html).length > 0
  );
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parsePetFoodExpertsPdp(html: string): PetFoodExpertsPdpData {
  const $ = loadHtml(html);
  const name =
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $("[data-test-selector='product-name']").first().text().replace(/\s+/g, ' ').trim();
  const brand = labeledSpec($, 'Brand');
  const upc = productMetaValue(html, $, /UPC#?\s*([0-9]{8,14})/i);
  const distributorSku = productMetaValue(html, $, /Item\s*#?\s*([A-Za-z0-9][A-Za-z0-9 ._-]*)/i);
  const weight = labeledSpec($, 'Weight');
  let unitOfMeasure =
    $("[data-test-selector='productPrice_unitOfMeasureLabel']").first().text().replace(/\s+/g, ' ').trim() || null;
  if (unitOfMeasure) unitOfMeasure = unitOfMeasure.replace(/\/$/, '').trim() || null;
  const description =
    $("[data-test-selector='productDescription']").first().text().replace(/\s+/g, ' ').trim() ||
    $('.product-description').first().text().replace(/\s+/g, ' ').trim();
  const ingredients =
    $("[data-test-selector='productIngredients']").first().text().replace(/\s+/g, ' ').trim() ||
    $('.ingredients').first().text().replace(/\s+/g, ' ').trim();
  const features = textList(
    html,
    "[data-test-selector='productFeatures'] li, .feature-list li, .product-features li",
  );
  const category = $('.breadcrumb a, nav.breadcrumb a').last().text().replace(/\s+/g, ' ').trim() || null;
  const images: string[] = [];
  $("img[data-test-selector='productImage'], .product-image-wrap img, .product-image img").each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (src && isAllowedHttpsUrl(resolveUrl(src, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN) ?? src, PET_FOOD_EXPERTS_ASSET_HOSTS)) {
      images.push(resolveUrl(src, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN) ?? src);
    }
  });
  const parsed = Boolean(name) || Boolean(upc) || Boolean(distributorSku);
  return {
    upc: upc || null,
    name: name || null,
    brand: brand || null,
    distributorSku: distributorSku || null,
    weight: weight || null,
    description: description || null,
    category: category || null,
    features,
    ingredients: ingredients || null,
    unitOfMeasure,
    images: dedupeStrings(images).slice(0, 50),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: PetFoodExpertsPdpData, sourceUrl: string, observedAt: string): DistributorCatalogRecord {
  return {
    matchedIdentifier: identifier,
    distributorUpc: p.upc,
    gtin: null,
    distributorSku: p.distributorSku,
    name: trimToLimit(p.name),
    description: trimToLimit(p.description),
    brand: trimToLimit(p.brand),
    manufacturerPartNumber: null,
    weight: p.weight,
    features: p.features.slice(0, 30),
    category: p.category,
    dimensions: null,
    casePack: null,
    unitOfMeasure: p.unitOfMeasure,
    ingredients: trimToLimit(p.ingredients),
    attributes: {},
    imageUrls: p.images,
    sourceUrl,
    catalogVersion: null,
    observedAt,
    expiresAt: null,
  };
}

export class PetFoodExpertsConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId = 'pet_food_experts';
  readonly requiresSecret = true;

  constructor(private readonly deps: PetFoodExpertsConnectorDeps = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no 8-14 digit UPC/GTIN to look up' };
    }

    const parsedSecret = parseHtmlScraperCredentials(request.secret);
    if (!parsedSecret.ok) {
      return { outcome: 'source_error', code: parsedSecret.code, message: parsedSecret.code === 'secret_missing' ? 'pet_food_experts credentials are not configured' : 'pet_food_experts credentials are malformed' };
    }
    const credentials = parsedSecret.credentials;

    const config = parseHtmlScraperConnectionConfig(request.connection.configuration);
    if (config === null && Object.keys(request.connection.configuration ?? {}).length > 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'html_scraper connection configuration is invalid' };
    }
    const policy = buildPolicy(config);
    const signal = request.signal;
    const deadlineAt = request.deadlineAt;
    const observedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    if (signal.aborted) {
      return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled before start' };
    }
    if (new Date(deadlineAt).getTime() <= Date.now()) {
      return { outcome: 'source_error', code: 'timeout', message: 'deadline expired before start' };
    }

    const defaultRunner = this.deps.fetchPage ? null : makeDefaultFetcher(request.connection.id, policy, credentials);
    const fetchPage = this.deps.fetchPage ?? defaultRunner!.fetchPage;
    try {
      const searchUrl = `${PET_FOOD_EXPERTS_NAVIGATION_ORIGIN}/Search?query=${encodeURIComponent(identifier)}`;
      let search = await fetchPage(searchUrl, { signal, deadlineAt });
      if (!search.ok) {
        return { outcome: 'source_error', code: search.code, message: `pet_food_experts search failed: ${search.message}` };
      }
      if (anyMatches(search.html, AUTH_PAGE_SELECTORS)) {
        return { outcome: 'source_error', code: 'auth_required', message: 'pet_food_experts returned the login form instead of search results' };
      }
      if (!isPetFoodExpertsSearchPage(search.html)) {
        return { outcome: 'source_error', code: 'unexpected_markup', message: 'pet_food_experts search response is not a recognizable results page' };
      }

      const candidates = parsePetFoodExpertsSearchCandidates(search.html);
      if (candidates.length === 0) {
        return { outcome: 'not_stocked', reason: `no exact match: no product results for identifier ${identifier}` };
      }

      let parsedAny = false;
      let transportError: { code: string; message: string } | null = null;
      for (const url of candidates) {
        if (signal.aborted) {
          return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled' };
        }
        const pdp = await fetchPage(url, { signal, deadlineAt });
        if (!pdp.ok) {
          transportError = { code: pdp.code, message: pdp.message };
          continue;
        }
        if (anyMatches(pdp.html, AUTH_PAGE_SELECTORS)) {
          return { outcome: 'source_error', code: 'auth_required', message: 'pet_food_experts returned the login form instead of a product page' };
        }
        const parsed = parsePetFoodExpertsPdp(pdp.html);
        if (!parsed.parsed) continue;
        parsedAny = true;
        if (parsed.upc && sameGtin(parsed.upc, identifier)) {
          const finalUrl = sameOrigin(pdp.finalUrl, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN) ? pdp.finalUrl : url;
          const record = buildRecord(identifier, parsed, finalUrl, observedAt);
          const matchedFields = [
            'matchedIdentifier',
            ...(record.name ? ['name'] : []),
            ...(record.brand ? ['brand'] : []),
            ...(record.distributorSku ? ['distributorSku'] : []),
            ...(record.weight ? ['weight'] : []),
            ...(record.unitOfMeasure ? ['unitOfMeasure'] : []),
            ...(record.description ? ['description'] : []),
            ...(record.features.length > 0 ? ['features'] : []),
            ...(record.ingredients ? ['ingredients'] : []),
            ...(record.category ? ['category'] : []),
            ...(record.imageUrls.length > 0 ? ['imageUrls'] : []),
            ...(record.sourceUrl ? ['sourceUrl'] : []),
          ];
          const warnings: string[] = [];
          if (record.imageUrls.length === 0) warnings.push('no display-only image candidates found on the PDP');
          return { outcome: 'found', record, matchedFields, warnings };
        }
      }

      if (parsedAny) {
        return { outcome: 'not_stocked', reason: `wrong variant: product page for ${identifier} does not carry the exact UPC/GTIN` };
      }
      if (transportError) {
        return { outcome: 'source_error', code: transportError.code, message: `pet_food_experts PDP fetch failed: ${transportError.message}` };
      }
      return { outcome: 'source_error', code: 'unexpected_markup', message: 'no pet_food_experts product page could be parsed' };
    } finally {
      await defaultRunner?.close();
    }
  }
}
