import { getDb } from '../connection';
import {
  reconcileSitemapUrls,
  getActiveUrlsForDomain,
  getAllDomainUrlCounts,
  normalizeDomain,
} from './brand-url-index-repo';

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
 * Retrieve the cached URL list for a domain's sitemap.
 *
 * Checks persistent `brand_url_index` first. If active URLs exist,
 * returns them directly. Otherwise checks legacy `sitemap_cache`.
 */
export function getCachedSitemapUrls(domain: string): string[] | null {
  const normDomain = normalizeDomain(domain);
  const db = getDb();

  const row = db.query(
    'SELECT urls_json, expires_at FROM sitemap_cache WHERE domain = ?'
  ).get(normDomain) as { urls_json: string; expires_at: string } | undefined;

  if (!row) {
    return null;
  }

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
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
 * Writes to both `brand_url_index` (persistent) and `sitemap_cache` (legacy compatibility).
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

  // 1. Reconcile with persistent brand_url_index
  try {
    reconcileSitemapUrls(
      normDomain,
      urls.map((u) => ({ url: u })),
      sourceUrl,
      fetchedAt,
    );
  } catch (err) {
    console.error(`Failed to reconcile brand_url_index for "${normDomain}":`, err);
  }

  // 2. Legacy sitemap_cache insert
  try {
    db.query(
      `INSERT OR REPLACE INTO sitemap_cache (domain, urls_json, fetched_at, expires_at, source_url)
       VALUES (?, ?, ?, ?, ?)`
    ).run(normDomain, urlsJson, fetchedAt, expiresAt, sourceUrl);
  } catch (err) {
    console.error(`Failed to insert into legacy sitemap_cache for "${normDomain}":`, err);
  }
}

/**
 * Delete all cached sitemap rows.
 */
// fallow-ignore-next-line unused-export
export function clearSitemapCache(): void {
  const db = getDb();
  try {
    db.query('DELETE FROM brand_url_index').run();
    db.query('DELETE FROM brand_url_fts').run();
  } catch { /* best effort */ }
  db.query('DELETE FROM sitemap_cache').run();
}

/**
 * Read-only listing of every sitemap cache row, sorted alphabetically by domain.
 */
export function listAllSitemapCaches(): SitemapCacheRow[] {
  const db = getDb();

  // Combine legacy cache rows and brand_url_index counts
  const legacyRows = db.query(
    'SELECT domain, urls_json, fetched_at, expires_at, source_url FROM sitemap_cache ORDER BY domain ASC',
  ).all() as Array<{
    domain: string;
    urls_json: string;
    fetched_at: string;
    expires_at: string;
    source_url: string | null;
  }>;

  const domainCounts = getAllDomainUrlCounts();
  const domainSet = new Set<string>();

  for (const r of legacyRows) domainSet.add(r.domain);
  for (const d of Object.keys(domainCounts)) domainSet.add(d);

  const sortedDomains = Array.from(domainSet).sort();

  return sortedDomains.map((domain) => {
    const legacy = legacyRows.find((r) => r.domain === domain);
    const activeUrls = getActiveUrlsForDomain(domain);
    let urls = activeUrls;

    if (urls.length === 0 && legacy) {
      try {
        const parsed = JSON.parse(legacy.urls_json);
        if (Array.isArray(parsed)) {
          urls = parsed.filter((u): u is string => typeof u === 'string');
        }
      } catch {
        urls = [];
      }
    }

    const fetchedAt = legacy?.fetched_at || new Date().toISOString();
    const expiresAt = legacy?.expires_at || new Date(Date.now() + SITEMAP_CACHE_DEFAULT_TTL_MS).toISOString();
    const sourceUrl = legacy?.source_url || null;

    return {
      domain,
      urls,
      sitemapUrlsCount: urls.length,
      sitemapFetchedAt: fetchedAt,
      sitemapExpiresAt: expiresAt,
      sitemapSourceUrl: sourceUrl,
    };
  });
}

