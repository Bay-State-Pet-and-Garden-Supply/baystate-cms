import {
  type DistributorConnector,
  type DistributorCatalogRecord,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
} from '../contracts';
import type { HtmlScraperConnectionConfig, HtmlScraperRequestBudget, HtmlScraperRuntimePolicy, ScraperFetchPage } from '../html-scraper/contracts';
import { HTML_SCRAPER_CEILINGS, parseHtmlScraperConnectionConfig } from '../html-scraper/contracts';
import {
  createCrawleeHtmlScraperEngine,
  getSharedHtmlScraperManager,
} from '../html-scraper/session-runner';
import {
  dedupeStrings,
  firstText,
  isAllowedHttpsUrl,
  isNoResultPage,
  loadHtml,
  resolveUrl,
  sameGtin,
  sameOrigin,
} from '../html-scraper/html-utils';

/**
 * Central Pet (`html_scraper + central_pet`) connector (ADR 0014
 * Amendment B, M3 — tier 1 public storefront).
 *
 * Angular storefront at `https://www.centralpet.com`; the search and PDP are
 * client-rendered, so the transport always uses the Playwright engine and
 * waits for `.isc-productContainer` / `#tst_productDetail_erpDescription` /
 * `.no-results-found`. Pure Cheerio parsing runs on the bounded rendered
 * HTML.
 *
 * The found rule is EXACT: the PDP's `UPC` product-spec value must equal the
 * normalized lookup identifier. The Central Pet `Product #` (e.g. 38777521)
 * is extracted as `distributorSku` only — never a lookup authority. Search
 * results may surface sibling variants of the same product family; the
 * connector follows up to a bounded number of candidates and fails closed
 * (`not_stocked:wrong_variant`) unless one carries the exact UPC.
 *
 * Excluded by policy: price, availability/stock, sell-pack quantity, pallet
 * quantity, safety/recommendation copy, and arbitrary provider fields.
 */
export const CENTRAL_PET_NAVIGATION_ORIGIN = 'https://www.centralpet.com';

const CENTRAL_PET_ASSET_HOSTS = [
  'www.centralpet.com',
  'centralpet.com',
  'images.salsify.com',
  'd2gqd42fylojmw.cloudfront.net',
];

/** Max product candidates followed per lookup (bounded, deterministic). */
const MAX_PDP_CANDIDATES = 6;

// Hydration markers ONLY: the raw shell ships isc-productContainer /
// no-results placeholders (resolving the wait pre-render and capturing a
// nameless shell). The Angular app renders .product-spec rows and the
// htmlContent paragraph after hydration — those are what we wait for.
const SEARCH_WAIT_SELECTORS = ['.product-spec, .spec-value', '#tst_productDetail_htmlContent p', '.no-results-found'];
// Specs/MPN/UPC rows hydrate LAST (the accordion) — wait for them so
// the capture includes dimensions/weights, not just the early name.
const PDP_WAIT_SELECTORS = ['.product-spec, .spec-value', '#tst_productDetail_htmlContent p'];

export interface CentralPetConnectorDeps {
  fetchPage?: ScraperFetchPage;
  now?: () => string;
}

export interface CentralPetPdpData {
  upc: string | null;
  name: string | null;
  brand: string | null;
  distributorSku: string | null;
  mpn: string | null;
  weight: string | null;
  casePack: string | null;
  description: string | null;
  category: string | null;
  dimensions: string | null;
  images: string[];
  /** Whether the page structurally looked like a PDP (name or UPC present). */
  parsed: boolean;
}

function buildCentralPetPolicy(config: HtmlScraperConnectionConfig | null): HtmlScraperRuntimePolicy {
  return {
    providerId: 'central_pet',
    navigationOrigin: CENTRAL_PET_NAVIGATION_ORIGIN,
    assetHosts: CENTRAL_PET_ASSET_HOSTS,
    responseCapBytes: config?.responseCapBytes ?? HTML_SCRAPER_CEILINGS.responseCapBytes,
    maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
    requestTimeoutMs: config?.requestTimeoutMs ?? HTML_SCRAPER_CEILINGS.requestTimeoutMs,
    requestsPerMinute: config?.requestsPerMinute ?? HTML_SCRAPER_CEILINGS.publicRequestsPerMinute,
    sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
    retryCount: HTML_SCRAPER_CEILINGS.retryCount,
    allowBrowserFallback: true,
  };
}

function makeDefaultFetcher(connectionId: string, policy: HtmlScraperRuntimePolicy): ScraperFetchPage {
  // SHARED per-connection manager (ADR 0014 Amendment B): one login per
  // 15-minute session window per connection, reused across every item
  // lookup. Memory-only cookies; never closed per lookup — the process owns
  // the browser/session lifetime (Playwright exits with the parent). The
  // request cap is a PER-LOOKUP budget (this fetcher is created per lookup)
  // so a shared manager never accumulates a lifetime request count.
  const manager = getSharedHtmlScraperManager(connectionId, createCrawleeHtmlScraperEngine);
  const budget: HtmlScraperRequestBudget = { used: 0 };
  return async function defaultFetchPage(url, opts) {
    const result = await manager.fetchHtml({
      connectionId,
      providerId: policy.providerId,
      url,
      policy,
      budget,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      browserRequired: true,
      waitForSelectors: opts.waitForSelectors ?? [],
    });
    if (result.ok) return { ok: true, html: result.html, finalUrl: result.finalUrl };
    return { ok: false, code: result.code, message: result.message };
  };
}

/** Search-result candidate PDP links (absolute, same-origin, deduped). */
export function parseCentralPetSearchCandidates(html: string): string[] {
  const $ = loadHtml(html);
  const urls: string[] = [];
  $('a[href*="/Product/"]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const abs = resolveUrl(href, CENTRAL_PET_NAVIGATION_ORIGIN);
    if (abs && sameOrigin(abs, CENTRAL_PET_NAVIGATION_ORIGIN)) urls.push(abs);
  });
  return dedupeStrings(urls).slice(0, MAX_PDP_CANDIDATES);
}

/** Normalize a rendered label like "Product #: " or "Mfg Part #: " to a key. */
function normalizeSpecLabel(raw: string): string {
  return raw.replace(/[:\s]+$/, '').trim();
}

/** Extract `label → value` from `.product-spec` rows (value is the text after the label span). */
function productSpecMap(html: string): Map<string, string> {
  const $ = loadHtml(html);
  const map = new Map<string, string>();
  $('.product-spec').each((_i, el) => {
    const labelSpan = $(el).find('span').first();
    if (labelSpan.length === 0) return;
    const label = normalizeSpecLabel(labelSpan.text());
    const raw = $(el).text();
    const value = raw.replace(labelSpan.text(), '').replace(/\s+/g, ' ').trim();
    if (label && value && !map.has(label)) map.set(label, value);
  });
  return map;
}

/** Extract `label → value` from the specification content tab (`<strong>` + `.spec-value`). */
function specValueList(html: string): Map<string, string> {
  const $ = loadHtml(html);
  const map = new Map<string, string>();
  $('li').each((_i, el) => {
    const strong = $(el).find('strong').first();
    const valueEl = $(el).find('.spec-value').first();
    if (strong.length === 0 || valueEl.length === 0) return;
    const label = normalizeSpecLabel(strong.text());
    const value = valueEl.text().replace(/\s+/g, ' ').trim();
    if (label && value && !map.has(label)) map.set(label, value);
  });
  return map;
}

/** Breadcrumb text (last meaningful crumb — noncanonical distributor category). */
function breadcrumbCategory(html: string): string | null {
  const $ = loadHtml(html);
  const ul = $('ul.breadcrumbs, [class*="breadcrumbs"]').first();
  const link = ul.find('li a').last();
  const text = link.text().replace(/\s+/g, ' ').trim();
  if (text && text !== 'Home') return text;
  return null;
}

/** Zoom/gallery images (HTTPS + approved display-only asset hosts). */
function zoomImages(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('#tst_productDetail_imageZoom img').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (src) out.push(src);
  });
  return dedupeStrings(out).filter((u) => isAllowedHttpsUrl(u, CENTRAL_PET_ASSET_HOSTS)).slice(0, 50);
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parseCentralPetPdp(html: string): CentralPetPdpData {
  const specs = productSpecMap(html);
  const values = specValueList(html);
  const name = firstText(html, ['#tst_productDetail_erpDescription', 'h1']);
  const $ = loadHtml(html);
  const brandEl = $('a[href*="brand.detailPagePath"], a[ng-if*="brand.detailPagePath"]').first();
  const brand = brandEl.length ? brandEl.text().replace(/\s+/g, ' ').trim() : '';
  const upc = specs.get('UPC') ?? null;
  const distributorSku = specs.get('Product #') ?? null;
  const casePack = specs.get('Case Qty') ?? null;
  const height = values.get('Product Height');
  const length = values.get('Product Length');
  const width = values.get('Product Width');
  const dimensions = height && length && width ? `${height} x ${length} x ${width}` : null;
  const description = $('#tst_productDetail_htmlContent').first().text().replace(/\s+/g, ' ').trim() || null;
  const parsed = Boolean(name || upc || distributorSku);
  return {
    upc,
    name,
    brand: brand || null,
    distributorSku,
    mpn: specs.get('Mfg Part #') ?? null,
    weight: values.get('Product Gross Weight') ?? values.get('Gross Weight') ?? values.get('Product Net Weight') ?? null,
    casePack,
    description,
    category: breadcrumbCategory(html),
    dimensions,
    images: zoomImages(html),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: CentralPetPdpData, sourceUrl: string, observedAt: string): DistributorCatalogRecord {
  const attributes: Record<string, string> = {};
  if (p.casePack && /^\d+$/.test(p.casePack.trim())) attributes.packCount = p.casePack.trim();
  return {
    matchedIdentifier: identifier,
    distributorUpc: p.upc,
    gtin: null,
    distributorSku: p.distributorSku,
    name: trimToLimit(p.name),
    description: trimToLimit(p.description),
    brand: trimToLimit(p.brand),
    manufacturerPartNumber: p.mpn,
    weight: p.weight,
    features: [],
    category: p.category,
    dimensions: p.dimensions,
    casePack: p.casePack,
    unitOfMeasure: null,
    ingredients: null,
    attributes,
    imageUrls: p.images,
    sourceUrl,
    catalogVersion: null,
    observedAt,
    expiresAt: null,
  };
}

export class CentralPetConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId = 'central_pet';
  readonly requiresSecret = false;

  constructor(private readonly deps: CentralPetConnectorDeps = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no 8-14 digit UPC/GTIN to look up' };
    }

    const config = parseHtmlScraperConnectionConfig(request.connection.configuration);
    if (config === null && Object.keys(request.connection.configuration ?? {}).length > 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'html_scraper connection configuration is invalid' };
    }
    const policy = buildCentralPetPolicy(config);
    const fetchPage = this.deps.fetchPage ?? makeDefaultFetcher(request.connection.id, policy);
    const signal = request.signal;
    const deadlineAt = request.deadlineAt;
    const observedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    // Pre-abort/expired-deadline starts no transport at all.
    if (signal.aborted) {
      return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled before start' };
    }
    if (new Date(deadlineAt).getTime() <= Date.now()) {
      return { outcome: 'source_error', code: 'timeout', message: 'deadline expired before start' };
    }

    const searchUrl = `${CENTRAL_PET_NAVIGATION_ORIGIN}/Search?criteria=${encodeURIComponent(identifier)}`;
    const search = await fetchPage(searchUrl, { signal, deadlineAt, browserRequired: true, waitForSelectors: SEARCH_WAIT_SELECTORS });
    if (!search.ok) {
      return { outcome: 'source_error', code: search.code, message: `central pet search failed: ${search.message}` };
    }

    // The explicit no-results marker is authoritative BEFORE candidate
    // iteration: the site renders recommendation cards below the empty state,
    // so candidate presence alone never means the searched identifier matched.
    if (isNoResultPage(search.html, ['.no-results-found'])) {
      return { outcome: 'not_stocked', reason: `no exact match: no product results for identifier ${identifier}` };
    }

    // Single-match searches may render the PDP DIRECTLY (observed live
    // 2026-08-15: /Search?criteria=<UPC> served the product page). Recognize
    // a PDP-shaped response before falling back to candidate iteration.
    const tryMatchPdp = (html: string, finalUrl: string): SourcingLookupResult | null => {
      const parsed = parseCentralPetPdp(html);
      if (!parsed.parsed) return null;
      if (parsed.upc && sameGtin(parsed.upc, identifier)) {
        const record = buildRecord(identifier, parsed, sameOrigin(finalUrl, CENTRAL_PET_NAVIGATION_ORIGIN) ? finalUrl : searchUrl, observedAt);
        const matchedFields = [
          'matchedIdentifier',
          ...(record.name ? ['name'] : []),
          ...(record.brand ? ['brand'] : []),
          ...(record.distributorSku ? ['distributorSku'] : []),
          ...(record.manufacturerPartNumber ? ['manufacturerPartNumber'] : []),
          ...(record.weight ? ['weight'] : []),
          ...(record.casePack ? ['casePack', 'packCount'] : []),
          ...(record.description ? ['description'] : []),
          ...(record.category ? ['category'] : []),
          ...(record.dimensions ? ['dimensions'] : []),
          ...(record.imageUrls.length > 0 ? ['imageUrls'] : []),
          ...(record.sourceUrl ? ['sourceUrl'] : []),
        ];
        const warnings: string[] = [];
        if (record.imageUrls.length === 0) warnings.push('no display-only image candidates found on the PDP');
        return { outcome: 'found', record, matchedFields, warnings };
      }
      return { outcome: 'not_stocked', reason: `wrong variant: no product page for ${identifier} carries the exact UPC/GTIN` };
    };
    const directMatch = tryMatchPdp(search.html, search.finalUrl);
    if (directMatch) {
      return directMatch;
    }

    const candidates = parseCentralPetSearchCandidates(search.html);
    if (candidates.length === 0) {
      return { outcome: 'source_error', code: 'unexpected_markup', message: 'central pet search returned no candidates and no no-results marker' };
    }

    let parsedAny = false;
    let transportError: { code: string; message: string } | null = null;
    for (const url of candidates) {
      if (signal.aborted) {
        return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled' };
      }
      const pdp = await fetchPage(url, { signal, deadlineAt, browserRequired: true, waitForSelectors: PDP_WAIT_SELECTORS });
      if (!pdp.ok) {
        transportError = { code: pdp.code, message: pdp.message };
        continue;
      }
      const parsed = parseCentralPetPdp(pdp.html);
      if (!parsed.parsed) continue;
      parsedAny = true;
      const matched = tryMatchPdp(pdp.html, pdp.finalUrl);
      if (matched && matched.outcome === 'found') {
        return matched;
      }
    }

    if (parsedAny) {
      return { outcome: 'not_stocked', reason: `wrong variant: no product page for ${identifier} carries the exact UPC/GTIN` };
    }
    if (transportError) {
      return { outcome: 'source_error', code: transportError.code, message: `central pet PDP fetch failed: ${transportError.message}` };
    }
    return { outcome: 'source_error', code: 'unexpected_markup', message: 'no central pet product page could be parsed' };
  }
}
