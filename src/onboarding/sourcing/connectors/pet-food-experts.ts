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
import { PET_FOOD_EXPERTS_LOGIN } from '../html-scraper/login-config';
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

const PET_FOOD_EXPERTS_ASSET_HOSTS = [
  'orders.petfoodexperts.com',
  'cdn.insitecloud.net',
  // Live product imagery (observed 2026-08-15): per-tenant assets subdomain.
  'assets-6c913b8151.cdn.insitecloud.net',
];
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
  // Per-lookup close would defeat session reuse; the shared manager's
  // lifetime is the process's.
  return { fetchPage, close: async () => {} };
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
  // Live storefront (2026-08-15): `Item #33011808` lives inside the
  // productId container (which also carries UPC#: CAS/EA).
  const block = $("[data-test-selector^='productDetails_productId']").first();
  if (block.length) {
    const m = block.text().match(labelRe);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/**
 * Concatenated text of the live product detail blocks (productId container +
 * specifications + legacy .product-meta). Bounded to the block itself — never
 * the whole document.
 */
function productBlockText($: CheerioAPI): string {
  return [
    $("[data-test-selector^='productDetails_productId']").first().text(),
    $("[data-test-selector='productDetails_specifications']").first().text(),
    $('.product-meta').first().text(),
  ].join(' ');
}

/**
 * Extract the exact UPC/EA from the live product blocks (observed
 * 2026-08-15: `UPC#: CAS: 685038118097, EA: 685038118080` inside the
 * productId container; specs carry Attributes/Brand/Ingredients). The EA
 * (each) barcode is the unit identifier — always prefer it over the CAS
 * (case) barcode; never let the first 8-14 digit run silently pick CAS.
 */
function productUpcFromSpecs(html: string, $: CheerioAPI): string | null {
  const spec = $(
    "[data-test-selector^='productDetails_productId'], [data-test-selector='productDetails_specifications'], .product-meta, .product-specifications",
  ).first();
  const text = (spec.length ? spec.text() : '') + ' ' + textList(html, "[data-test-selector='productUPC']").join(' ');
  const ea = text.match(/EA\s*[:#]?\s*([0-9]{8,14})/i);
  if (ea && ea[1]) return ea[1];
  const cas = text.match(/CAS\s*[:#]?\s*([0-9]{8,14})/i);
  if (cas && cas[1]) return cas[1];
  const generic = text.match(/UPC#?\s*[:#]?\s*([0-9]{8,14})/i);
  return generic && generic[1] ? generic[1] : null;
}

/** Recognizable search page: results container or no-results marker. */
export function isPetFoodExpertsSearchPage(html: string): boolean {
  return (
    anyMatches(html, ["[data-test-selector='productCard']", "[data-test-selector='noResults']", '.no-results-found', '.search-results']) ||
    parsePetFoodExpertsSearchCandidates(html).length > 0
  );
}

/**
 * True only for a PAGE-LEVEL product page (not a search-results card that
 * happens to embed card-level selectors): the storefront's single-match
 * search redirects straight to /Product/<slug> (observed live 2026-08-15).
 */
export function isPetFoodExpertsPdpPage(html: string): boolean {
  return anyMatches(html, [
    "[data-test-selector='page_ProductDetailsPage']",
    "[data-test-selector='productDetails_specifications']",
    "[data-test-selector='productDetails_htmlContent']",
    "[data-test-selector='productDetails_mainImage']",
    '.product-details',
  ]) || loadHtml(html)('h1').first().text().trim().length > 0;
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parsePetFoodExpertsPdp(html: string): PetFoodExpertsPdpData {
  const $ = loadHtml(html);
  const name =
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $("[data-test-selector='product-name']").first().text().replace(/\s+/g, ' ').trim();
  const blockText = productBlockText($);
  const brand =
    labeledSpec($, 'Brand') ||
    // Live specs concatenate labels without separators ("AttributesBrand: Daves
    // Pet Food Flavor: Chicken…") — and sometimes with the value GLUED to the
    // next label ("Old Mother HubbardFlavor: Peanut Butter…", observed
    // 2026-08-16): the capture stops at the first colon (the one terminating
    // the leaked label), so the per-character lookahead below cuts the capture
    // at the FIRST label-colon boundary — glued or whitespace-separated.
    // "Brand: NutriDietAnimal: Dog…" → "NutriDiet"; a brand merely ending in
    // one of the tokens (no following colon) is never truncated.
    (blockText.match(/Brand:\s*([A-Za-z](?:(?!\s*(?:Flavor|Animal|Diet|Food Form|Ingredients)\s*:)[^\n:]){1,80})/) ?? [])[1]
      ?.replace(/\s+/g, ' ')
      ?.trim() ||
    null;
  // Live storefront (2026-08-15) renders UPC#/EA inside the specifications
  // block (EA preferred — see productUpcFromSpecs).
  const upc = productUpcFromSpecs(html, $) ?? productMetaValue(html, $, /UPC#?\s*([0-9]{8,14})/i);
  const distributorSku = productMetaValue(html, $, /Item\s*#?\s*([A-Za-z0-9][A-Za-z0-9 ._-]{1,40}?)(?=\s*UPC#?|\s*$)/i);
  const weight = labeledSpec($, 'Weight');
  let unitOfMeasure =
    $("[data-test-selector='productPrice_unitOfMeasureLabel']").first().text().replace(/\s+/g, ' ').trim() || null;
  if (unitOfMeasure) unitOfMeasure = unitOfMeasure.replace(/\/$/, '').trim() || null;
  const description =
    $("[data-test-selector='productDescription']").first().text().replace(/\s+/g, ' ').trim() ||
    $("[data-test-selector='productDetails_htmlContent']").first().text().replace(/\s+/g, ' ').trim() ||
    $('.product-description').first().text().replace(/\s+/g, ' ').trim();
  const ingredients =
    $("[data-test-selector='productIngredients']").first().text().replace(/\s+/g, ' ').trim() ||
    labeledSpec($, 'Ingredients') ||
    (blockText.match(/Ingredients\s*([A-Za-z][^]{5,500})/) ?? [])[1]?.replace(/\s+/g, ' ').trim() ||
    $('.ingredients').first().text().replace(/\s+/g, ' ').trim();
  const features = textList(
    html,
    "[data-test-selector='productFeatures'] li, .feature-list li, .product-features li",
  );
  const category =
    $("[data-test-selector='pageBreadcrumbs'] a").last().text().replace(/\s+/g, ' ').trim() ||
    $('.breadcrumb a, nav.breadcrumb a').last().text().replace(/\s+/g, ' ').trim() || null;
  const images: string[] = [];
  $("img[data-test-selector='productImage'], img[data-test-selector='productDetails_mainImage'], .product-image-wrap img, .product-image img").each((_i, el) => {
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
      let search = await fetchPage(searchUrl, {
        signal,
        deadlineAt,
        browserRequired: true,
        // SPA hydration markers: results list, no-results, a direct product
        // page, or the authenticated header (never the pre-hydration shell).
        waitForSelectors: [
          "[data-test-selector='productCard']",
          "[data-test-selector='noResults']",
          "[data-test-selector^='productDetails_productId']",
          "[data-test-selector='productDetails_specifications']",
        ],
      });
      if (!search.ok) {
        return { outcome: 'source_error', code: search.code, message: `pet_food_experts search failed: ${search.message}` };
      }
      if (anyMatches(search.html, AUTH_PAGE_SELECTORS)) {
        return { outcome: 'source_error', code: 'auth_required', message: 'pet_food_experts returned the login form instead of search results' };
      }
      // A single-match search redirects straight to the product page
      // (observed live 2026-08-15: /Search?query=… → /Product/<slug>).
      // Recognize a PDP-shaped response before the results-page gate.
      const tryMatchPdp = (html: string, finalUrl: string): SourcingLookupResult | null => {
        if (anyMatches(html, AUTH_PAGE_SELECTORS)) {
          return { outcome: 'source_error', code: 'auth_required', message: 'pet_food_experts returned the login form instead of a product page' };
        }
        const parsed = parsePetFoodExpertsPdp(html);
        if (!parsed.parsed) return null;
        // Primary: exact UPC/EA equality (the contract's authoritative match).
        const upcMatch = parsed.upc !== null && sameGtin(parsed.upc, identifier);
        // Secondary (product-owner directive 2026-08-15): the distributor's
        // own catalog item number is a legitimate EXACT identity for PFX —
        // an 8-14 digit identifier that equals the PDP's Item # (digits
        // only) AND the page still carries a real UPC/EA resolves to the
        // product (e.g. 33011808 → Item #33011808, EA 685038118080). Exact
        // equality only — never fuzzy/substring; a UPC-less page never
        // matches; the record's real barcode travels as distributorUpc.
        const itemNumberMatch =
          !upcMatch &&
          parsed.upc !== null &&
          parsed.distributorSku !== null &&
          parsed.distributorSku.replace(/\D/g, '') === identifier;
        if (upcMatch || itemNumberMatch) {
          const record = buildRecord(identifier, parsed, sameOrigin(finalUrl, PET_FOOD_EXPERTS_NAVIGATION_ORIGIN) ? finalUrl : searchUrl, observedAt);
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
        return { outcome: 'not_stocked', reason: `wrong variant: product page for ${identifier} does not carry the exact UPC/GTIN` };
      };
      const directMatch = isPetFoodExpertsPdpPage(search.html) ? tryMatchPdp(search.html, search.finalUrl) : null;
      if (directMatch) {
        return directMatch;
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
        const pdp = await fetchPage(url, {
          signal,
          deadlineAt,
          browserRequired: true,
          waitForSelectors: [
            "[data-test-selector^='productDetails_productId']",
            "[data-test-selector='productDetails_specifications']",
            "[data-test-selector='productDetails_htmlContent']",
          ],
        });
        if (!pdp.ok) {
          transportError = { code: pdp.code, message: pdp.message };
          continue;
        }
        const matched = tryMatchPdp(pdp.html, pdp.finalUrl);
        if (!matched) continue;
        parsedAny = true;
        if (matched.outcome === 'found') {
          return matched;
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
