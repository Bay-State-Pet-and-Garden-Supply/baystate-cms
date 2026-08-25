import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { normalizeDomain } from './brand-url-index-repo';

export interface SitemapRefreshRun {
  id: string;
  domain: string;
  started_at: string;
  completed_at: string;
  status: 'success' | 'failed' | 'blocked';
  source_url: string | null;
  total_urls_observed: number;
  product_urls_eligible: number;
  added_count: number;
  updated_count: number;
  inactivated_count: number;
  duration_ms: number;
  error_message: string | null;
  http_status: number | null;
}

export interface SitemapDiscoveryEvent {
  id: string;
  item_id: string | null;
  upc: string | null;
  domain: string | null;
  created_at: string;
  satisfied_locally: number;
  candidate_url: string | null;
  confidence: number | null;
  source_method: string | null;
}

export interface DiscoveryEconomics {
  totalLookups: number;
  localHitCount: number;
  localHitRate: number;
}

/**
 * Record a completed or failed sitemap refresh run.
 */
export function recordRefreshRun(
  run: Omit<SitemapRefreshRun, 'id'>,
): SitemapRefreshRun {
  const db = getDb();
  const id = `srr_${randomUUID()}`;
  const normDomain = normalizeDomain(run.domain);

  db.prepare(`
    INSERT INTO sitemap_refresh_history (
      id, domain, started_at, completed_at, status, source_url,
      total_urls_observed, product_urls_eligible, added_count,
      updated_count, inactivated_count, duration_ms, error_message, http_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normDomain,
    run.started_at,
    run.completed_at,
    run.status,
    run.source_url,
    run.total_urls_observed,
    run.product_urls_eligible,
    run.added_count,
    run.updated_count,
    run.inactivated_count,
    run.duration_ms,
    run.error_message,
    run.http_status,
  );

  return { id, ...run, domain: normDomain };
}

/**
 * Retrieve the latest refresh run for a domain.
 */
export function getLatestRefreshRun(domain: string): SitemapRefreshRun | null {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  const row = db
    .query('SELECT * FROM sitemap_refresh_history WHERE domain = ? ORDER BY completed_at DESC LIMIT 1')
    .get(normDomain) as SitemapRefreshRun | undefined;

  return row ?? null;
}

/**
 * Retrieve recent refresh history for a domain.
 */
export function listRefreshHistory(domain: string, limit: number = 10): SitemapRefreshRun[] {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  return db
    .query('SELECT * FROM sitemap_refresh_history WHERE domain = ? ORDER BY completed_at DESC LIMIT ?')
    .all(normDomain, limit) as SitemapRefreshRun[];
}

/**
 * Retrieve the most recent refresh run for each known domain.
 */
export function getAllLatestRefreshRuns(): Record<string, SitemapRefreshRun> {
  const db = getDb();
  const rows = db
    .query(`
      SELECT h.*
      FROM sitemap_refresh_history h
      INNER JOIN (
        SELECT domain, MAX(completed_at) as max_completed
        FROM sitemap_refresh_history
        GROUP BY domain
      ) latest ON h.domain = latest.domain AND h.completed_at = latest.max_completed
    `)
    .all() as SitemapRefreshRun[];

  const result: Record<string, SitemapRefreshRun> = {};
  for (const r of rows) {
    result[r.domain] = r;
  }
  return result;
}

export type SitemapDiscoveryEventInput = Partial<
  Pick<SitemapDiscoveryEvent, 'item_id' | 'upc' | 'domain' | 'candidate_url' | 'confidence' | 'source_method' | 'created_at'>
> & {
  satisfied_locally: number;
};

/**
 * Record a discovery event (satisfied locally vs paid search fallback).
 */
export function recordDiscoveryEvent(
  event: SitemapDiscoveryEventInput,
): SitemapDiscoveryEvent {
  const db = getDb();
  const id = `sde_${randomUUID()}`;
  const nowIso = event.created_at || new Date().toISOString();
  const normDomain = event.domain ? normalizeDomain(event.domain) : null;

  db.prepare(`
    INSERT INTO sitemap_discovery_events (
      id, item_id, upc, domain, created_at, satisfied_locally,
      candidate_url, confidence, source_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.item_id || null,
    event.upc || null,
    normDomain,
    nowIso,
    event.satisfied_locally ? 1 : 0,
    event.candidate_url || null,
    event.confidence ?? null,
    event.source_method || null,
  );

  return {
    id,
    item_id: event.item_id || null,
    upc: event.upc || null,
    domain: normDomain,
    created_at: nowIso,
    satisfied_locally: event.satisfied_locally ? 1 : 0,
    candidate_url: event.candidate_url || null,
    confidence: event.confidence ?? null,
    source_method: event.source_method || null,
  };
}

/**
 * Computes discovery economics (local hit rate, searches avoided) for a domain or globally.
 */
export function getDiscoveryEconomics(
  domain?: string | null,
  windowDays: number = 30,
): DiscoveryEconomics {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  let query = `
    SELECT
      COUNT(*) as totalLookups,
      SUM(CASE WHEN satisfied_locally = 1 THEN 1 ELSE 0 END) as localHitCount
    FROM sitemap_discovery_events
    WHERE created_at >= ?
  `;
  const params: (string | number)[] = [sinceIso];

  if (domain) {
    query += ' AND domain = ?';
    params.push(normalizeDomain(domain));
  }

  const row = db.query(query).get(...params) as {
    totalLookups: number;
    localHitCount: number | null;
  };

  const totalLookups = row?.totalLookups ?? 0;
  const localHitCount = row?.localHitCount ?? 0;
  const localHitRate = totalLookups > 0 ? localHitCount / totalLookups : 0;

  return {
    totalLookups,
    localHitCount,
    localHitRate,
  };
}

/**
 * Computes discovery economics broken down by domain.
 */
export function getAllDomainDiscoveryEconomics(
  windowDays: number = 30,
): Record<string, DiscoveryEconomics> {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .query(`
      SELECT
        domain,
        COUNT(*) as totalLookups,
        SUM(CASE WHEN satisfied_locally = 1 THEN 1 ELSE 0 END) as localHitCount
      FROM sitemap_discovery_events
      WHERE created_at >= ? AND domain IS NOT NULL
      GROUP BY domain
    `)
    .all(sinceIso) as Array<{
    domain: string;
    totalLookups: number;
    localHitCount: number | null;
  }>;

  const result: Record<string, DiscoveryEconomics> = {};
  for (const r of rows) {
    const totalLookups = r.totalLookups;
    const localHitCount = r.localHitCount ?? 0;
    const localHitRate = totalLookups > 0 ? localHitCount / totalLookups : 0;

    result[r.domain] = {
      totalLookups,
      localHitCount,
      localHitRate,
    };
  }
  return result;
}

export function deleteTelemetryByDomain(domain: string): void {
  const db = getDb();
  const norm = normalizeDomain(domain);
  db.query('DELETE FROM sitemap_refresh_history WHERE domain = ?').run(norm);
  db.query('DELETE FROM sitemap_discovery_events WHERE domain = ?').run(norm);
}
