import type { CheerioAPI } from 'cheerio';
import {
  type DistributorConnector,
  type DistributorCatalogRecord,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
} from '../contracts';
import type { HtmlScraperConnectionConfig, HtmlScraperRequestBudget, HtmlScraperRuntimePolicy, ScraperFetchPage } from '../html-scraper/contracts';
import { HTML_SCRAPER_CEILINGS, parseHtmlScraperConnectionConfig } from '../html-scraper/contracts';
import { PHILLIPS_STOREFRONT_LOGIN } from '../html-scraper/login-config';
import { createCrawleeHtmlScraperEngine, getSharedHtmlScraperManager } from '../html-scraper/session-runner';
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
  // Logged-in SFCC shells embed the login template (raw markers) on EVERY
  // page — auth is declared only when the page also lacks any product or
  // search content (observed live 2026-08-15: emailField + doLogout coexist
  // on product pages).
  if (isPhillipsSearchPage(html)) return false;
  if (PRODUCT_DETAIL_HREF_RE.test(html) || html.includes('ccrz__ProductDetails')) return false;
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
  // SHARED per-connection manager (ADR 0014 Amendment B): one login per
  // 15-minute session window per connection, reused across every item
  // lookup. Memory-only cookies; never closed per lookup — the process owns
  // the browser/session lifetime (Playwright exits with the parent). The
  // request cap is a PER-LOOKUP budget (this fetcher is created per lookup)
  // so a shared manager never accumulates a lifetime request count.
  const manager = getSharedHtmlScraperManager(connectionId, createCrawleeHtmlScraperEngine);
  const budget: HtmlScraperRequestBudget = { used: 0 };
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    const result = await manager.fetchHtml({
      connectionId,
      providerId: policy.providerId,
      url,
      policy,
      budget,
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
  // Per-lookup close would defeat session reuse; the shared manager's
  // lifetime is the process's.
  return { fetchPage, close: async () => {} };
}

/** Search-result rows: product links + the UPC shown on the card (if any). */
export interface PhillipsSearchRow {
  url: string | null;
  upc: string | null;
  name: string | null;
  /** Brand shown on the card (`.cc_brand .branded`, live 2026-08-15). */
  brand: string | null;
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
    const rowEl = $(el).closest('.col-item-title, .cc-product-list-item, .row-container, li, .product-card, .cc-product-item');
    const rowText = rowEl.length ? rowEl.text() : $(el).text();
    const upcMatch = rowText.match(/\bUPC:?\s*([0-9]{8,14})\b/i);
    const brand =
      (rowEl.length ? $(rowEl).find('.cc_brand .branded').first().text() : '')
        .replace(/\s+/g, ' ').trim() || null;
    rows.push({
      url: abs,
      upc: upcMatch ? upcMatch[1].replace(/\D/g, '') : null,
      name: $(el).text().replace(/\s+/g, ' ').trim() || null,
      brand,
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
  return (
    parsePhillipsSearchRows(html).length > 0 ||
    anyMatches(html, ['.no-results', '#plp-desktop-row', '.product-list']) ||
    // No-match pages carry the message as plain text (observed live
    // 2026-08-15: "Sorry, no results were found.").
    /Sorry, no results were found/i.test(html)
  );
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
  if (found) return found;
  // Live SFCC (2026-08-15): `<span class="cc_label">Item #</span>
  // <span class="cc_value">727222</span>` pairs inside the MAIN product
  // region. Recommendation/carousel widgets render the same pair for OTHER
  // products — they are skipped (never the main product's identity).
  $('.cc_label').each((_i, el) => {
    const inCrossSell =
      $(el)
        .parents()
        .toArray()
        .some((anc) => /scanner|carousel|recommend|related|also.?bought/i.test($(anc).attr('class') ?? ''));
    if (inCrossSell) return undefined;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.toLowerCase() === label.toLowerCase()) {
      const value = $(el).next('.cc_value').text().replace(/\s+/g, ' ').trim();
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
  // Main-product name: the rendered SFCC shell carries it in a scoped
  // h3.product_title. The hidden scanner-results template ships the same
  // classes with placeholder text ("TEST PROD NAME") and must be excluded;
  // the breadcrumb is a Handlebars template in the pre-render shell, so it
  // is a LAST-resort fallback only.
  const nonEmpty = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
  const mainTitle = nonEmpty(
    $('h3.product_title:not(.scanner-results-product-title) strong')
      .filter((_i, el) => nonEmpty($(el).text()).length > 0)
      .first()
      .text(),
  );
  const name =
    mainTitle ||
    nonEmpty($('.product-name').first().text()) ||
    nonEmpty($('h1').first().text()) ||
    nonEmpty($('.cc_breadcrumb_item a').last().text());
  const brand =
    nonEmpty($('.product_brand:not(.scanner-results-product-brand) .branded').first().text()) ||
    nonEmpty($('.product-brand').first().text()) ||
    detailValue($, 'Brand');
  const upc =
    nonEmpty($('.upc-value').first().text()) ||
    detailValue($, 'UPC') ||
    (html.match(/"value"\s*:\s*"([0-9]{8,14})"\s*,\s*"name"\s*:\s*"Each UPC"/i) ?? [])[1] ||
    (html.match(/"specValue"\s*:\s*"([0-9]{8,14})"/i) ?? [])[1] ||
    null;
  // Main-product SKU: `.cc_sku .cc_value` (the product detail SKU row).
  // Recommendation cards render their own "Item #" cc_label rows (observed
  // live: 100122 vs the main product's 727222) — those must NOT leak in.
  const mainSku =
    nonEmpty(
      $('.cc_sku .cc_value')
        .filter((_i, el) => nonEmpty($(el).text()).length > 0)
        .first()
        .text(),
    ) || null;
  const distributorSku = mainSku || detailValue($, 'Item Number') || detailValue($, 'SKU') || null;
  const weight = detailValue($, 'Weight') ?? detailValue($, 'Ship Weight');
  const dimensions = detailValue($, 'Dimensions');
  const description =
    $('.product-description').first().text().replace(/\s+/g, ' ').trim() ||
    $('#description').first().text().replace(/\s+/g, ' ').trim();
  const features = textList(html, '.feature-list li, .product-features li, #features li');
  // Category: last breadcrumb item — the shell's Handlebars template renders
  // `{{…}}` placeholders that must never leak. Legacy fixture markup uses
  // `nav.breadcrumb` with anchors/spans (no li).
  const categoryRaw = nonEmpty($('.breadcrumb li a, .breadcrumb a, .breadcrumb span').last().text());
  const category = categoryRaw && !categoryRaw.startsWith('{{') ? categoryRaw : null;
  const images: string[] = [];
  // Main product media only: `#photoContainer` (the live main-image wrapper)
  // plus legacy gallery selectors. Recommendation/carousel widgets are never
  // scanned. Live SFCC serves media over http on the allowlisted CDN —
  // normalize to https for display-only candidates.
  $(
    '#photoContainer img, .cc_main_prod_image img, .mainProdImage, .product-detail-image, .product-gallery img, .product-image img',
  ).each((_i, el) => {
    let src = $(el).attr('src') ?? '';
    src = src.replace(/^http:\/\//, 'https://');
    if (src && isAllowedHttpsUrl(resolveUrl(src, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN) ?? src, PHILLIPS_STOREFRONT_ASSET_HOSTS)) {
      images.push(resolveUrl(src, PHILLIPS_STOREFRONT_NAVIGATION_ORIGIN) ?? src);
    }
  });
  const parsed = Boolean(name) || Boolean(upc) || Boolean(distributorSku);
  // Recommendation/carousel widgets can share the generic gallery selectors
  // (observed live: 100122_t.jpg next to the main 727222.jpg). When the main
  // SKU is known and any collected URL carries it, keep ONLY the product's
  // own media (live SFCC names media by SKU) — never cross-sell imagery.
  let finalImages = dedupeStrings(images);
  if (mainSku) {
    const own = finalImages.filter((u) => u.includes(mainSku));
    if (own.length > 0) finalImages = own;
  }
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
    images: finalImages.slice(0, 50),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: PhillipsStorefrontPdpData, sourceUrl: string, observedAt: string, cardBrand: string | null = null): DistributorCatalogRecord {
  return {
    matchedIdentifier: identifier,
    distributorUpc: p.upc,
    gtin: null,
    distributorSku: p.distributorSku,
    name: trimToLimit(p.name),
    description: trimToLimit(p.description),
    brand: trimToLimit(p.brand) ?? trimToLimit(cardBrand),
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
      let search = await fetchPage(searchUrl, {
        signal,
        deadlineAt,
        browserRequired: true,
        // SFCC renders the product list client-side (Backbone) — wait for
        // hydrated rows before capturing content.
        waitForSelectors: [
          'a[href*="ccrz__ProductDetails"]',
          '#plp-desktop-row .ccrz__productListing',
          '.no-results',
          // No-match queries render "Sorry, no results were found." as plain
          // text (no .no-results element) after a slow XHR (~20 s observed
          // live 2026-08-15) — without this marker the fetch burns its full
          // timeout and reports source_error instead of not_stocked.
          'text=Sorry, no results were found.',
        ],
      });
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
        const pdp = await fetchPage(row.url, {
          signal,
          deadlineAt,
          browserRequired: true,
          // Wait for the LAST hydration signal (.upc-value / specs): the
          // earlier markers (.cc_value, ProductDetails ids) exist in the raw
          // shell and capture a nameless page (flaky name/brand).
          waitForSelectors: ['.upc-value'],
        });
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
          // The card's brand (`.cc_brand .branded`) backs the PDP when the
          // detail page does not render one.
          const record = buildRecord(identifier, parsed, finalUrl, observedAt, row.brand);
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
