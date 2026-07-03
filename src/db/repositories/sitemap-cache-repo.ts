import { getDb } from '../connection';

/**
 * Default TTL for a cached sitemap: 24 hours.
 *
 * Sitemaps can change at any time, but 24 hours is a reasonable
 * "good enough" budget for discovery work that wants to avoid
 * re-fetching the same sitemap.xml on every run.
 */
// fallow-ignore-next-line unused-export
export const SITEMAP_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read-only diagnostics view of a `sitemap_cache` row. Unlike
 * `getCachedSitemapUrls`, this object preserves stale/expired rows
 * and surfaces every field the diagnostics UI needs (counts,
 * timestamps, source URL) without ever calling DELETE.
 */
export interface SitemapCacheRow {
  domain: string;
  urls: string[];
  sitemapUrlsCount: number;
  sitemapFetchedAt: string;
  sitemapExpiresAt: string;
  sitemapSourceUrl: string | null;
}

/**
 * Normalizes a domain name by lowercasing and stripping the www. prefix.
 * Matches the convention used by other repositories in this project so
 * `example.com` and `www.example.com` share the same cache row.
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/**
 * Retrieve the cached URL list for a domain's sitemap.
 *
 * Returns `null` if:
 *   - there is no cache row for the domain, or
 *   - the cache row has expired (`expires_at <= now`).
 *
 * Expired rows are deleted on access so callers don't have to clean
 * up after themselves, mirroring `domain-status-repo.ts` behavior.
 */
export function getCachedSitemapUrls(domain: string): string[] | null {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  const row = db.query(
    'SELECT urls_json, expires_at FROM sitemap_cache WHERE domain = ?'
  ).get(normDomain) as { urls_json: string; expires_at: string } | undefined;

  if (!row) {
    return null;
  }

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    // Expired or invalid expiry — drop the row and report a miss.
    db.query('DELETE FROM sitemap_cache WHERE domain = ?').run(normDomain);
    return null;
  }

  try {
    const parsed = JSON.parse(row.urls_json);
    if (!Array.isArray(parsed)) {
      console.error(
        `Cached sitemap urls_json for "${normDomain}" is not an array; treating as miss.`,
      );
      return null;
    }
    return parsed.filter((u): u is string => typeof u === 'string');
  } catch (err) {
    console.error(`Failed to parse cached sitemap urls for domain "${normDomain}":`, err);
    return null;
  }
}

/**
 * Insert or replace the cached URL list for a domain's sitemap.
 *
 * `fetched_at` is set to "now". `expires_at` is computed as
 * `fetched_at + ttlMs` (default 24h). `sourceUrl` records the actual
 * sitemap URL that was fetched (e.g. `https://example.com/sitemap.xml`),
 * which can differ from the normalized domain.
 */
export function insertSitemapCache(
  domain: string,
  urls: string[],
  sourceUrl: string,
  ttlMs: number = SITEMAP_CACHE_DEFAULT_TTL_MS,
): void {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const now = new Date();
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const urlsJson = JSON.stringify(urls);

  db.query(
    `INSERT OR REPLACE INTO sitemap_cache (domain, urls_json, fetched_at, expires_at, source_url)
     VALUES (?, ?, ?, ?, ?)`
  ).run(normDomain, urlsJson, fetchedAt, expiresAt, sourceUrl);
}

/**
 * Delete all cached sitemap rows. Useful for tests and operator-driven
 * cache invalidation.
 */
// fallow-ignore-next-line unused-export
export function clearSitemapCache(): void {
  const db = getDb();
  db.query('DELETE FROM sitemap_cache').run();
}

/**
 * Read-only listing of every `sitemap_cache` row, sorted alphabetically
 * by domain. Used by the diagnostics surface so it can show stale or
 * malformed rows without triggering cache eviction.
 *
 * Unlike `getCachedSitemapUrls`, this function:
 *   - never deletes expired rows
 *   - never deletes rows with invalid `urls_json`
 *   - returns the raw `fetched_at`/`expires_at`/`source_url` so the
 *     caller can compute its own staleness flag.
 *
 * On a malformed `urls_json` blob, the row is returned with
 * `urls: []` and `sitemapUrlsCount: 0` and a warning is logged;
 * the function does not throw.
 */
export function listAllSitemapCaches(): SitemapCacheRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT domain, urls_json, fetched_at, expires_at, source_url FROM sitemap_cache ORDER BY domain ASC',
  ).all() as Array<{
    domain: string;
    urls_json: string;
    fetched_at: string;
    expires_at: string;
    source_url: string | null;
  }>;

  return rows.map((row) => {
    let urls: string[] = [];
    try {
      const parsed = JSON.parse(row.urls_json);
      if (Array.isArray(parsed)) {
        urls = parsed.filter((u): u is string => typeof u === 'string');
      } else {
        console.error(
          `Cached sitemap urls_json for "${row.domain}" is not an array; reporting empty list.`,
        );
      }
    } catch (err) {
      console.error(
        `Failed to parse cached sitemap urls for domain "${row.domain}":`,
        err,
      );
    }
    return {
      domain: row.domain,
      urls,
      sitemapUrlsCount: urls.length,
      sitemapFetchedAt: row.fetched_at,
      sitemapExpiresAt: row.expires_at,
      sitemapSourceUrl: row.source_url,
    };
  });
}
