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
import { PHILLIPS_STOREFRONT_LOGIN } from '../html-scraper/login-config';
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
 * Phillips Pet storefront (`html_scraper + phillips_storefront`) connector
 * (ADR 0014 Amendment B, M4 — tier 2 authenticated storefront).
 *
 * SFCC (Salesforce Commerce Cloud) storefront at `https://shop.phillipspet.com`.
 * The existing `api + phillips` (Endless Aisles REST) connector is untouched
 * and may run in the same generation; this connector has its own
 * `providerId=phillips_storefront` so provenance stays distinct.
 *
 * Search by normalized UPC/GTIN (`ccrz__ProductList` quickSearch). The found
 * rule is EXACT: the PDP's UPC value must equal the normalized lookup
 * identifier. The Python adapter's brand/name heuristic acceptance is NOT
 * ported — an exact identifier mismatch ALWAYS returns
 * `not_stocked:wrong_variant`, even when brand and title overlap. Hidden
 * scanner/template rows can never win or synthesize a result.
 *
 * Auth: a Playwright login against the fixed `/ccrz__CCSiteLogin` page
 * (selectors verified live 2026-08-15: `#emailField`, `#passwordField`,
 * `#send2Dsk`, success `a.doLogout.cc_do_logout`) via the M2 runner.
 * NOTE: SFCC serializes the login form inside a script-wrapped template
 * (`XC_SiteLogin`), invisible to DOM selector queries — auth-page detection
 * therefore also checks the serialized html for the raw `id="emailField"` /
 * `id="send2Dsk"` markup and the static 'Please sign in' panel text.
 *
 * Excluded by policy: price, availability, stock, scanner rows, and
 * arbitrary provider fields.
 */
export const PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN = 'https://shop.phillipspet.com';

const PHILLIPS_STOREFRONT_ASSET_HOSTS = ['shop.phillipspet.com', 'd56ygyjv466yj.cloudfront.net'];

/** Max product candidates followed per lookup (bounded, deterministic). */
const MAX_PDP_CANDIDATES = 3;

/** Static text marker on the SFCC login panel (visible outside scripts). */
const AUTH_PAGE_TEXT = 'Please sign in with your Phillips Pet website credentials';

/** Serialized-markup markers for the script-wrapped SFCC login form. */
const AUTH_PAGE_RAW_MARKERS = ['id="emailField"', 'id="send2Dsk"'];

/** Cheerio-visible auth markers (the real hidden login inputs). */
const AUTH_PAGE_SELECTORS = ['input[id*="phoneLoginForm:hdnUsername"]', '.ccrz__login-form', '.cc-login-panel'];

/** SFCC product-detail links (search results). */
const PRODUCT_DETAIL_HREF_RE = /ccrz__ProductDetails/i;

/** Injectable page fetcher (tests); production uses the bounded session runner. */
export interface PhillipsStorefrontConnectorDeps {
  fetchPage?: ScraperFetchPage;
  now?: () => string;
}

export interface PhillipsStorefrontPdpData {
  upc: string | null;
  name: string | null;
  brand: string | null;
  distributorSku: string | null;
  weight: string | null;
  dimensions: string | null;
  description: string | null;
  category: string | null;
  features: string[];
  images: string[];
  /** Whether the page structurally looked like a PDP (name/upc/sku present). */
  parsed: boolean;
}

function buildPolicy(config: HtmlScraperConnectionConfig | null): HtmlScraperRuntimePolicy {
  return {
    providerId: 'phillips_storefront',
    navigationOrigin: PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN,
    assetHosts: PHILLIPS_STOREFRONT_ASSET_HOSTS,
    responseCapBytes: config?.responseCapBytes ?? HTML_SCRAPER_CEILINGS.responseCapBytes,
    maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
    requestTimeoutMs: config?.requestTimeoutMs ?? HTML_SCRAPER_CEILINGS.requestTimeoutMs,
    requestsPerMinute: config?.requestsPerMinute ?? HTML_SCRAPER_CEILINGS.authRequestsPerMinute,
    sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
    retryCount: HTML_SCRAPER_CEILINGS.retryCount,
    allowBrowserFallback: true,
  };
}

/** Auth-page detection: static text, serialized markup, or parsed selectors. */
function isPhillipsAuthPage(html: string): boolean {
  if (html.includes(AUTH_PAGE_TEXT)) return true;
  for (const marker of AUTH_PAGE_RAW_MARKERS) {
    if (html.includes(marker)) return true;
  }
  return anyMatches(html, AUTH_PAGE_SELECTORS);
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
      loginConfig: PHILLIPS_STOREFRONT_LOGIN,
      credentials,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      browserRequired: opts.browserRequired ?? false,
      waitForSelectors: opts.waitForSelectors ?? [],
    });
    if (result.ok) {
      if (isPhillipsAuthPage(result.html)) {
        return { ok: false, code: 'auth_required', message: 'phillips_storefront returned the login form instead of content' };
      }
      return { ok: true, html: result.html, finalUrl: result.finalUrl };
    }
    return { ok: false, code: result.code, message: result.message };
  };
  return { fetchPage, close: () => manager.closeAll() };
}

/** Search-result rows: product links + the UPC shown on the card (if any). */
export interface PhillipsSearchRow {
  url: string | null;
  upc: string | null;
  name: string | null;
}

/** Parse SFCC quickSearch rows; exact-UPC rows are preferred as candidates. */
export function parsePhillipsSearchRows(html: string): PhillipsSearchRow[] {
  const $ = loadHtml(html);
  const rows: PhillipsSearchRow[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (!PRODUCT_DETAIL_HREF_RE.test(href)) return;
    const abs = resolveUrl(href, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN);
    if (!abs || !sameOrigin(abs, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN)) return;
    const rowEl = $(el).closest('.cc-product-list-item, .row-container, li, .product-card');
    const rowText = rowEl.length ? rowEl.text() : $(el).text();
    const upcMatch = rowText.match(/\bUPC:?\s*([0-9]{8,14})\b/i);
    rows.push({
      url: abs,
      upc: upcMatch ? upcMatch[1].replace(/\D/g, '') : null,
      name: $(el).text().replace(/\s+/g, ' ').trim() || null,
    });
  });
  return dedupeRows(rows).slice(0, MAX_PDP_CANDIDATES);
}

function dedupeRows(rows: PhillipsSearchRow[]): PhillipsSearchRow[] {
  const seen = new Set<string>();
  const out: PhillipsSearchRow[] = [];
  for (const row of rows) {
    const key = row.url ?? row.name ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Recognizable search page: product rows, no-results marker, or plp container. */
export function isPhillipsSearchPage(html: string): boolean {
  return parsePhillipsSearchRows(html).length > 0 || anyMatches(html, ['.no-results', '#plp-desktop-row', '.product-list']);
}

/** Detail-table value by label (UPC / Item Number / Weight / Dimensions). */
function detailValue($: CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $('th').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.toLowerCase() === label.toLowerCase()) {
      const value = $(el).next('td').text().replace(/\s+/g, ' ').trim();
      if (value) {
        found = value;
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parsePhillipsStorefrontPdp(html: string): PhillipsStorefrontPdpData {
  const $ = loadHtml(html);
  const name =
    $('.product-name').first().text().replace(/\s+/g, ' ').trim() ||
    $('h1').first().text().replace(/\s+/g, ' ').trim();
  const brand = $('.product-brand').first().text().replace(/\s+/g, ' ').trim();
  const upc = detailValue($, 'UPC');
  const distributorSku = detailValue($, 'Item Number') ?? detailValue($, 'Item #') ?? detailValue($, 'SKU');
  const weight = detailValue($, 'Weight') ?? detailValue($, 'Ship Weight');
  const dimensions = detailValue($, 'Dimensions');
  const description =
    $('.product-description').first().text().replace(/\s+/g, ' ').trim() ||
    $('#description').first().text().replace(/\s+/g, ' ').trim();
  const features = textList(html, '.feature-list li, .product-features li, #features li');
  const category = $('.breadcrumb').children().last().text().replace(/\s+/g, ' ').trim() || null;
  const images: string[] = [];
  $('.product-detail-image, .product-gallery img, .product-image img').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (src && isAllowedHttpsUrl(resolveUrl(src, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN) ?? src, PHILLIPS_STOREFRONT_ASSET_HOSTS)) {
      images.push(resolveUrl(src, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN) ?? src);
    }
  });
  const parsed = Boolean(name) || Boolean(upc) || Boolean(distributorSku);
  return {
    upc: upc || null,
    name: name || null,
    brand: brand || null,
    distributorSku: distributorSku || null,
    weight: weight || null,
    dimensions: dimensions || null,
    description: description || null,
    category: category || null,
    features,
    images: dedupeStrings(images).slice(0, 50),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: PhillipsStorefrontPdpData, sourceUrl: string, observedAt: string): DistributorCatalogRecord {
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
    dimensions: p.dimensions,
    casePack: null,
    unitOfMeasure: null,
    ingredients: null,
    attributes: {},
    imageUrls: p.images,
    sourceUrl,
    catalogVersion: null,
    observedAt,
    expiresAt: null,
  };
}

export class PhillipsStorefrontConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId = 'phillips_storefront';
  readonly requiresSecret = true;

  constructor(private readonly deps: PhillipsStorefrontConnectorDeps = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no 8-14 digit UPC/GTIN to look up' };
    }

    const parsedSecret = parseHtmlScraperCredentials(request.secret);
    if (!parsedSecret.ok) {
      return { outcome: 'source_error', code: parsedSecret.code, message: parsedSecret.code === 'secret_missing' ? 'phillips_storefront credentials are not configured' : 'phillips_storefront credentials are malformed' };
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
      const searchUrl =
        `${PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN}/ccrz__ProductList?cartID=&operation=quickSearch` +
        `&searchText=${encodeURIComponent(identifier)}&portalUser=&store=DefaultStore&cclcl=en_US`;
      let search = await fetchPage(searchUrl, { signal, deadlineAt });
      if (!search.ok) {
        return { outcome: 'source_error', code: search.code, message: `phillips_storefront search failed: ${search.message}` };
      }
      if (isPhillipsAuthPage(search.html)) {
        return { outcome: 'source_error', code: 'auth_required', message: 'phillips_storefront returned the login form instead of search results' };
      }
      if (!isPhillipsSearchPage(search.html)) {
        return { outcome: 'source_error', code: 'unexpected_markup', message: 'phillips_storefront search response is not a recognizable results page' };
      }

      const rows = parsePhillipsSearchRows(search.html);
      // Prefer rows whose card UPC already matches; the PDP check below is
      // still the authoritative exact-match gate.
      const exactRows = rows.filter((r) => r.upc && sameGtin(r.upc, identifier));
      const candidates = [...exactRows, ...rows.filter((r) => !exactRows.includes(r))];
      if (candidates.length === 0 || candidates.every((r) => r.url === null)) {
        return { outcome: 'not_stocked', reason: `no exact match: no product results for identifier ${identifier}` };
      }

      let parsedAny = false;
      let transportError: { code: string; message: string } | null = null;
      for (const row of candidates) {
        if (!row.url) continue;
        if (signal.aborted) {
          return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled' };
        }
        const pdp = await fetchPage(row.url, { signal, deadlineAt });
        if (!pdp.ok) {
          transportError = { code: pdp.code, message: pdp.message };
          continue;
        }
        if (isPhillipsAuthPage(pdp.html)) {
          return { outcome: 'source_error', code: 'auth_required', message: 'phillips_storefront returned the login form instead of a product page' };
        }
        const parsed = parsePhillipsStorefrontPdp(pdp.html);
        if (!parsed.parsed) continue;
        parsedAny = true;
        if (parsed.upc && sameGtin(parsed.upc, identifier)) {
          const finalUrl = sameOrigin(pdp.finalUrl, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN) ? pdp.finalUrl : row.url;
          const record = buildRecord(identifier, parsed, finalUrl, observedAt);
          const matchedFields = [
            'matchedIdentifier',
            ...(record.name ? ['name'] : []),
            ...(record.brand ? ['brand'] : []),
            ...(record.distributorSku ? ['distributorSku'] : []),
            ...(record.weight ? ['weight'] : []),
            ...(record.dimensions ? ['dimensions'] : []),
            ...(record.description ? ['description'] : []),
            ...(record.features.length > 0 ? ['features'] : []),
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
        return { outcome: 'source_error', code: transportError.code, message: `phillips_storefront PDP fetch failed: ${transportError.message}` };
      }
      return { outcome: 'source_error', code: 'unexpected_markup', message: 'no phillips_storefront product page could be parsed' };
    } finally {
      await defaultRunner?.close();
    }
  }
}
