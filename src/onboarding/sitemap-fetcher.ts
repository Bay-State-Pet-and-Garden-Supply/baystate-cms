/**
 * Sitemap fetcher for the onboarding Discovery stage.
 *
 * Discovers and parses sitemaps (or sitemap indexes) for a brand domain
 * and returns the flattened list of URLs they advertise.
 *
 * Discovery protocol (option C — full):
 *
 *   1. Try a list of *standard* sitemap paths in order on the origin
 *      (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`,
 *      `/sitemap.php`). The first one that returns a successful
 *      `urlset` or `sitemapindex` is used.
 *   2. If every standard path 404s / errors, fetch `/robots.txt` and
 *      look for `Sitemap:` directives. Each declared sitemap URL is
 *      then tried in order until one resolves to a real sitemap.
 *   3. Shopify stores commonly expose product listings at
 *      `/sitemap_products_1.xml` (and `_2`, `_3`, …). We try the
 *      first one as a final fallback after the standard paths and
 *      robots-driven URLs have been exhausted.
 *
 * Parsing rules:
 *
 *   - `<loc>([^<]+)</loc>` is extracted with a single global regex —
 *     no XML library is imported. This is intentional: sitemaps have
 *     a flat, well-known structure and a real parser would be heavier
 *     than the problem requires.
 *   - The presence of a `<sitemapindex>` root element tells us we
 *     have an index document; we then recurse into each child
 *     `<sitemap><loc>…</loc></sitemap>` URL up to a hard cap of
 *     `MAX_INDEX_DEPTH` to prevent run-away fan-out.
 *   - The presence of a `<urlset>` root element tells us we have a
 *     plain URL list, and we extract every `<url><loc>…</loc></url>`.
 *   - Documents that look like neither a urlset nor a sitemapindex
 *     are skipped with a warning so a misconfigured CDN doesn't
 *     silently break discovery.
 *   - `Content-Encoding: gzip` *and* the gzip magic bytes
 *     (`1f 8b`) on the body are both honored, because some servers
 *     ship pre-gzipped bodies without setting the header.
 *
 * Optional filtering:
 *
 *   - When `productUrlPattern` is a valid regex string, every
 *     extracted URL is matched against it (case-insensitive) and
 *     only matches survive. An invalid pattern logs a warning and
 *     disables filtering rather than throwing — a typo in a profile
 *     must not break the discovery pipeline.
 *
 * Caching:
 *
 *   - This function does NOT read or write the cache. The caller
 *     (`source-discovery.ts`) is expected to consult
 *     `sitemap-cache-repo.getCachedSitemapUrls()` first and to call
 *     this fetcher only when the cache is stale or missing. Successful
 *     results are written back to the cache by the caller via
 *     `sitemap-cache-repo.insertSitemapCache(domain, urls, sourceUrl)`.
 */

import { recordDomainStatus } from '../db/repositories/domain-status-repo';

// ── Public types ────────────────────────────────────────────────────────────

export interface SitemapFetchResult {
  urls: string[];
  /**
   * The actual sitemap URL that was fetched to produce the result set.
   * For sitemap indexes, this is the root URL of the index, not the
   * inner `<loc>`s that were followed. Empty string when no sitemap
   * was found.
   */
  sourceUrl: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-fetch timeout (ms). Mirrors `HTTP_FETCH_TIMEOUT_MS` in `page-extractor.ts`. */
const FETCH_TIMEOUT_MS = 15000;

/** Hard cap on how many nested sitemap indexes we will follow. */
const MAX_INDEX_DEPTH = 3;

/**
 * User-Agent sent on every request. Mirrors the standard agent used by
 * `page-extractor.ts` so the same sites do not double-rotate us.
 */
const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Accept header set on every sitemap fetch. */
const ACCEPT_HEADER = 'application/xml, text/xml, */*';

/** Standard paths tried in order before falling back to robots.txt. */
const STANDARD_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap.php',
];

/**
 * Shopify-specific fallbacks. Most Shopify stores expose at least
 * `/sitemap_products_1.xml` even when no other sitemap is reachable.
 * We try the first one and, if the response is a valid urlset, accept
 * it. Higher-numbered shards (`_2.xml`, `_3.xml`, …) are NOT iterated
 * because the index document (when present) already covers them.
 */
const SHOPIFY_SITEMAP_PATHS = [
  '/sitemap_products_1.xml',
];

/** Magic bytes that prefix any gzip stream. */
const GZIP_MAGIC = [0x1f, 0x8b];

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Discover, fetch, and parse the sitemap for a brand domain.
 *
 * @param domain             The brand/retailer domain, with or without
 *                           a `www.` prefix and with or without a
 *                           scheme. Anything that `new URL(...)` can
 *                           resolve against `https://` is accepted.
 * @param productUrlPattern  Optional regex string. When provided and
 *                           valid, only URLs that match it are kept.
 *                           When omitted or invalid, the full set of
 *                           URLs returned by the sitemap is returned.
 * @returns A `{ urls, sourceUrl }` pair. `urls` is a flat, deduplicated
 *          array. `sourceUrl` is the URL of the first sitemap document
 *          that produced a result; empty when nothing was found.
 */
export async function fetchAndParseSitemap(
  domain: string,
  productUrlPattern?: string | null,
): Promise<SitemapFetchResult> {
  const origin = normalizeOrigin(domain);
  if (!origin) {
    console.warn(`[SitemapFetcher] Cannot derive origin from "${domain}" — returning empty result.`);
    return { urls: [], sourceUrl: '' };
  }

  console.log(`[SitemapFetcher] Discovering sitemap for ${origin}`);

  // Compile the optional product URL pattern once. Invalid patterns
  // disable filtering rather than aborting the whole fetch.
  const pattern = compilePattern(productUrlPattern);

  // ── Step 1: try standard sitemap paths ────────────────────────────────
  for (const path of STANDARD_SITEMAP_PATHS) {
    const url = origin + path;
    const result = await tryFetchSitemap(url, 0);
    if (result) {
      const filtered = applyPattern(result.urls, pattern);
      console.log(
        `[SitemapFetcher] Sitemap found via standard path ${path} (${filtered.length} URL(s) after filter).`,
      );
      try { recordDomainStatus(stripWww(origin), 'ok'); } catch { /* non-critical */ }
      return { urls: filtered, sourceUrl: result.sourceUrl };
    }
  }

  console.log(
    `[SitemapFetcher] All standard paths failed for ${origin}; falling back to /robots.txt.`,
  );

  // ── Step 2: try robots.txt Sitemap: directives ────────────────────────
  const robotsUrls = await parseRobotsSitemaps(origin + '/robots.txt');
  for (const robotsUrl of robotsUrls) {
    const result = await tryFetchSitemap(robotsUrl, 0);
    if (result) {
      const filtered = applyPattern(result.urls, pattern);
      console.log(
        `[SitemapFetcher] Sitemap found via robots.txt directive ${robotsUrl} (${filtered.length} URL(s) after filter).`,
      );
      try { recordDomainStatus(stripWww(origin), 'ok'); } catch { /* non-critical */ }
      return { urls: filtered, sourceUrl: result.sourceUrl };
    }
  }

  // ── Step 3: try Shopify-specific paths ────────────────────────────────
  for (const path of SHOPIFY_SITEMAP_PATHS) {
    const url = origin + path;
    const result = await tryFetchSitemap(url, 0);
    if (result) {
      const filtered = applyPattern(result.urls, pattern);
      console.log(
        `[SitemapFetcher] Sitemap found via Shopify path ${path} (${filtered.length} URL(s) after filter).`,
      );
      try { recordDomainStatus(stripWww(origin), 'ok'); } catch { /* non-critical */ }
      return { urls: filtered, sourceUrl: result.sourceUrl };
    }
  }

  console.log(`[SitemapFetcher] No sitemap discovered for ${origin}.`);
  return { urls: [], sourceUrl: '' };
}

// ── Sitemap fetching helpers ───────────────────────────────────────────────

/**
 * Fetch a single sitemap URL and recurse into child sitemaps if the
 * document turns out to be a `<sitemapindex>`.
 *
 * Returns `null` when the URL does not yield a parseable sitemap
 * (network error, 404, non-XML body, neither urlset nor sitemapindex).
 * The caller uses `null` to decide whether to try the next candidate.
 *
 * @param url      The sitemap URL to fetch.
 * @param depth    Current recursion depth. 0 at the root; capped at
 *                 `MAX_INDEX_DEPTH` to bound fan-out.
 * @param pattern  Compiled product URL pattern, or `null` when no
 *                 filtering is requested.
 */
async function tryFetchSitemap(
  url: string,
  depth: number,
): Promise<SitemapFetchResult | null> {
  const body = await fetchSitemapBody(url);
  if (body === null) return null;

  const detected = detectSitemapKind(body);
  if (detected === null) {
    console.log(`[SitemapFetcher] ${url} is not a recognizable sitemap; skipping.`);
    return null;
  }

  if (detected === 'index') {
    if (depth >= MAX_INDEX_DEPTH) {
      console.warn(
        `[SitemapFetcher] Sitemap index at ${url} exceeds max depth ${MAX_INDEX_DEPTH}; skipping children.`,
      );
      return { urls: [], sourceUrl: url };
    }
    const childUrls = extractAllLocs(body);
    console.log(
      `[SitemapFetcher] ${url} is a sitemap index with ${childUrls.length} child sitemap(s); recursing (depth ${depth + 1}).`,
    );
    const collected: string[] = [];
    for (const child of childUrls) {
      const childResult = await tryFetchSitemap(child, depth + 1);
      if (childResult) {
        for (const u of childResult.urls) collected.push(u);
      }
    }
    return { urls: dedupe(collected), sourceUrl: url };
  }

  // detected === 'urlset'
  const urls = extractAllLocs(body);
  return { urls: dedupe(urls), sourceUrl: url };
}

// ── Network helpers ────────────────────────────────────────────────────────

/**
 * Fetch a sitemap URL and return its decoded body as a string, or
 * `null` when the response is unusable (non-2xx, non-XML content type,
 * network error, malformed body, etc.).
 *
 * Honors `Content-Encoding: gzip` and the gzip magic bytes for
 * pre-compressed bodies served without the header.
 */
async function fetchSitemapBody(url: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': ACCEPT_HEADER,
      },
      // Bun's `fetch` accepts `signal` on the init object.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[SitemapFetcher] Network error fetching ${url}:`, err);
    return null;
  }

  if (!response.ok) {
    console.log(`[SitemapFetcher] ${url} → HTTP ${response.status}; skipping.`);
    return null;
  }

  // Reject obvious non-XML content types so we don't try to parse an
  // HTML error page as a sitemap. Missing/empty content types fall
  // through; we let the body-level check decide.
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType && !looksLikeXmlContentType(contentType)) {
    console.log(
      `[SitemapFetcher] ${url} → Content-Type "${contentType}" does not look like XML; skipping.`,
    );
    return null;
  }

  // Read the body as a Uint8Array so we can detect gzip pre-encoding
  // even when the server forgot to set Content-Encoding.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    console.log(`[SitemapFetcher] ${url} returned an empty body; skipping.`);
    return null;
  }

  const contentEncoding = (response.headers.get('content-encoding') ?? '').toLowerCase();
  if (contentEncoding.includes('gzip') || isGzipBytes(bytes)) {
    try {
      return new TextDecoder('utf-8').decode(gunzip(bytes));
    } catch (err) {
      console.warn(`[SitemapFetcher] Failed to gunzip body from ${url}:`, err);
      return null;
    }
  }

  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (err) {
    console.warn(`[SitemapFetcher] Failed to decode body from ${url}:`, err);
    return null;
  }
}

/**
 * Decompress a gzip byte buffer using `Bun.gunzipSync` when running
 * inside the Bun runtime, falling back to `node:zlib` in environments
 * (notably vitest under Node) where `Bun` is not a global. The
 * production runtime is always Bun, so the fast path is taken there.
 */
function gunzip(bytes: Uint8Array): Uint8Array {
  // `Bun` is declared as a global by `@types/bun` so the runtime
  // check is just a narrow guard for test environments that don't
  // load it. In production we always take the Bun.gunzipSync path.
  const bunGlobal = (globalThis as { Bun?: { gunzipSync?: (b: Uint8Array) => Uint8Array } }).Bun;
  if (bunGlobal && typeof bunGlobal.gunzipSync === 'function') {
    return bunGlobal.gunzipSync(bytes);
  }
  // Fallback path for Node-based test runners. Lazy-imported so the
  // Bun production path never has to load `node:zlib`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.gunzipSync(bytes));
}

/**
 * Parse `/robots.txt` and return any URLs declared via `Sitemap:`
 * directives. Returns an empty array when the file is missing, empty,
 * or unparseable; never throws.
 */
async function parseRobotsSitemaps(robotsUrl: string): Promise<string[]> {
  let body: string | null = null;
  try {
    const response = await fetch(robotsUrl, {
      headers: {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': 'text/plain, text/*, */*;q=0.1',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.log(`[SitemapFetcher] robots.txt ${robotsUrl} → HTTP ${response.status}.`);
      return [];
    }
    body = await response.text();
  } catch (err) {
    console.warn(`[SitemapFetcher] robots.txt fetch failed (${robotsUrl}):`, err);
    return [];
  }

  if (!body) return [];

  const sitemaps: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Sitemap directive is case-insensitive on the directive name.
    const match = line.match(/^sitemap\s*:\s*(.+)$/i);
    if (match) {
      const candidate = match[1].trim();
      if (candidate) sitemaps.push(candidate);
    }
  }
  console.log(
    `[SitemapFetcher] robots.txt ${robotsUrl} declared ${sitemaps.length} Sitemap directive(s).`,
  );
  return sitemaps;
}

// ── XML helpers ────────────────────────────────────────────────────────────

/**
 * Detect whether a body is a sitemap index, a regular urlset, or
 * neither. Detection is based on the presence of the corresponding
 * root element tag. The check is case-insensitive and tolerant of
 * XML processing instructions / BOMs.
 */
function detectSitemapKind(body: string): 'index' | 'urlset' | null {
  // Look for the first opening root tag. Strip a leading BOM if any
  // so we don't accidentally match against the byte-order mark as text.
  const cleaned = body.replace(/^\uFEFF/, '').trimStart();
  if (!cleaned) return null;
  // `<sitemapindex` is more specific than `<urlset`, so check it first.
  if (/<sitemapindex[\s>]/i.test(cleaned)) return 'index';
  if (/<urlset[\s>]/i.test(cleaned)) return 'urlset';
  return null;
}

/**
 * Extract every `<loc>…</loc>` payload in document order.
 * The regex is intentionally narrow — anything containing `<` inside
 * the tag would be malformed XML anyway, and we don't need to support
 * CDATA or entity encoding for sitemap documents.
 */
function extractAllLocs(body: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[1].trim();
    if (value) out.push(value);
  }
  return out;
}

// ── Pattern + URL helpers ───────────────────────────────────────────────────

/**
 * Compile the optional product URL pattern. Returns `null` when no
 * pattern is given or when the pattern fails to compile. We never
 * throw here because a typo in a profile should not break the
 * sitemap pipeline.
 */
function compilePattern(productUrlPattern?: string | null): RegExp | null {
  if (!productUrlPattern) return null;
  try {
    // If the pattern contains no regex special chars, treat it as a
    // URL path-prefix segment (e.g. "products" → match /products/ in
    // the URL path). This prevents substring false-positives like
    // blog slugs that happen to contain the word "products".
    const REGEX_SPECIAL = /[\^$.*+?()[\]{}|]/;
    const source = REGEX_SPECIAL.test(productUrlPattern)
      ? productUrlPattern
      : `/${productUrlPattern.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
    return new RegExp(source, 'i');
  } catch (err) {
    console.warn(
      `[SitemapFetcher] Invalid productUrlPattern "${productUrlPattern}" — disabling URL filter.`,
      err,
    );
    return null;
  }
}

/**
 * Filter the URL list against the compiled pattern. Returns the
 * input unchanged when no pattern is set.
 */
function applyPattern(urls: string[], pattern: RegExp | null): string[] {
  if (!pattern) return urls;
  return urls.filter(u => pattern.test(u));
}

/**
 * Normalize the input domain into a usable `https://origin` string
 * (no trailing slash). Accepts:
 *   - bare domains        `example.com`
 *   - domains with scheme `https://example.com/`
 *   - domains with paths  `https://example.com/foo`
 *   - leading `www.`      preserved (we want to hit the same host
 *                          the user typed)
 *
 * Returns an empty string when the input cannot be coerced.
 */
function normalizeOrigin(domain: string): string {
  if (!domain) return '';
  let candidate = domain.trim();
  if (!candidate) return '';
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname;
    if (!host) return '';
    // We deliberately keep the user-provided path/scheme on purpose,
    // but sitemaps are always at the origin, so we strip the path
    // and any auth, and force https.
    return `https://${host}`;
  } catch {
    return '';
  }
}

/**
 * Strip an optional `www.` prefix for use with `recordDomainStatus`,
 * which normalizes domains in the same way as `domain-status-repo`.
 */
function stripWww(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/**
 * Deduplicate a list of URLs while preserving first-encountered order.
 * Comparison is case-insensitive on the full URL because the same
 * page can appear in a sitemap index and its child sitemap with
 * different casing conventions.
 */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * Return true if a Content-Type header looks like an XML document.
 * Accepts `application/xml`, `text/xml`, and the `+xml` suffix
 * convention (e.g. `application/atom+xml`).
 */
function looksLikeXmlContentType(contentType: string): boolean {
  if (contentType.includes('xml')) return true;
  // Some servers return `text/plain` for XML bodies; we accept that
  // as a fallback because the body-level check still runs.
  if (contentType.startsWith('text/plain')) return true;
  return false;
}

/**
 * Return true if the first two bytes of `bytes` are the gzip magic
 * header (`1f 8b`). Used to detect pre-compressed bodies served
 * without a `Content-Encoding: gzip` header.
 */
function isGzipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    bytes[0] === GZIP_MAGIC[0] &&
    bytes[1] === GZIP_MAGIC[1]
  );
}

// (No additional public exports; only `fetchAndParseSitemap` is part
// of the contract described in the task.)
