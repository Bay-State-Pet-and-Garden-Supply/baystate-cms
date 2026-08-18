import {
  getDomainUrlCounts,
  normalizeDomain,
  type DomainUrlCounts,
} from '../db/repositories/brand-url-index-repo';
import {
  getLatestRefreshRun,
  listRefreshHistory,
  getDiscoveryEconomics,
  type SitemapRefreshRun,
  type DiscoveryEconomics,
} from '../db/repositories/sitemap-telemetry-repo';
import { getDomainStatus } from '../db/repositories/domain-status-repo';

export type SitemapHealthStatus = 'healthy' | 'stale' | 'missing' | 'error' | 'blocked' | 'unknown';

export const SITEMAP_STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface DomainSitemapHealthSummary {
  domain: string;
  status: SitemapHealthStatus;
  statusReason: string | null;
  needsAttention: boolean;
  attentionReasons: string[];
  totalUrlsCount: number;
  productUrlsCount: number;
  activeUrlsCount: number;
  inactiveUrlsCount: number;
  sitemapSourceUrl: string | null;
  lastRefreshedAt: string | null;
  lastRefreshDurationMs: number | null;
  lastRefreshStatus: 'success' | 'failed' | 'blocked' | null;
  lastRefreshAddedCount: number;
  lastRefreshRemovedCount: number;
  localHitRate: number;
  totalLookups: number;
  serperCallsAvoided: number;
}

/**
 * Pure domain sitemap health derivation given database metrics.
 */
export function evaluateDomainSitemapHealth(
  domain: string,
  counts: DomainUrlCounts,
  latestRefresh: SitemapRefreshRun | null,
  recentRefreshes: SitemapRefreshRun[],
  economics: DiscoveryEconomics,
  domainStatus: ReturnType<typeof getDomainStatus>,
  now: Date = new Date(),
): DomainSitemapHealthSummary {
  const normDomain = normalizeDomain(domain);
  const attentionReasons: string[] = [];
  let status: SitemapHealthStatus = 'unknown';
  let statusReason: string | null = null;

  // 1. Check if domain is blocked or offline
  if (domainStatus && (domainStatus.status === 'blocked' || domainStatus.status === 'offline')) {
    status = 'blocked';
    statusReason = `Domain is marked ${domainStatus.status} (${domainStatus.reason || 'anti-bot/connectivity'})`;
    attentionReasons.push('domain_blocked');
  } else if (!latestRefresh && counts.totalCount === 0) {
    status = 'missing';
    statusReason = 'No sitemap discovered or fetched yet';
    attentionReasons.push('missing_sitemap');
  } else if (latestRefresh?.status === 'failed') {
    status = 'error';
    statusReason = `Last refresh failed: ${latestRefresh.error_message || 'HTTP error'}`;
    attentionReasons.push('refresh_failed');
  } else if (latestRefresh?.completed_at) {
    const refreshAgeMs = now.getTime() - new Date(latestRefresh.completed_at).getTime();
    if (refreshAgeMs > SITEMAP_STALE_THRESHOLD_MS) {
      status = 'stale';
      statusReason = `Sitemap has not been refreshed in ${Math.round(refreshAgeMs / (24 * 3600 * 1000))} days`;
      attentionReasons.push('stale_sitemap');
    } else {
      status = 'healthy';
    }
  } else if (counts.activeCount > 0) {
    status = 'healthy';
  }

  // 2. Check attention signals
  if (counts.activeCount > 0 && counts.productCount === 0) {
    attentionReasons.push('zero_product_urls');
    if (status === 'healthy') statusReason = 'Zero eligible product URLs found in sitemap';
  }

  // Check URL deltas across recent runs
  if (recentRefreshes.length >= 2) {
    const current = recentRefreshes[0];
    const previous = recentRefreshes[1];
    if (current.status === 'success' && previous.status === 'success') {
      if (previous.total_urls_observed > 50 && current.total_urls_observed < previous.total_urls_observed * 0.5) {
        attentionReasons.push('large_url_drop');
        if (status === 'healthy') statusReason = `Significant URL count drop: ${previous.total_urls_observed} → ${current.total_urls_observed}`;
      } else if (previous.total_urls_observed > 20 && current.total_urls_observed > previous.total_urls_observed * 3) {
        attentionReasons.push('large_url_spike');
        if (status === 'healthy') statusReason = `Unusually large URL count surge: ${previous.total_urls_observed} → ${current.total_urls_observed}`;
      }
    }
  }

  // Check discovery fallback rate
  if (economics.totalLookups >= 5 && counts.productCount > 30) {
    if (economics.localHitRate < 0.3) {
      attentionReasons.push('high_paid_search_fallback');
    }
  }

  const needsAttention = attentionReasons.length > 0 || status === 'error' || status === 'blocked' || status === 'stale';

  return {
    domain: normDomain,
    status,
    statusReason,
    needsAttention,
    attentionReasons,
    totalUrlsCount: counts.totalCount,
    productUrlsCount: counts.productCount,
    activeUrlsCount: counts.activeCount,
    inactiveUrlsCount: counts.inactiveCount,
    sitemapSourceUrl: latestRefresh?.source_url || null,
    lastRefreshedAt: latestRefresh?.completed_at || null,
    lastRefreshDurationMs: latestRefresh?.duration_ms || null,
    lastRefreshStatus: latestRefresh?.status || null,
    lastRefreshAddedCount: latestRefresh?.added_count || 0,
    lastRefreshRemovedCount: latestRefresh?.inactivated_count || 0,
    localHitRate: Math.round(economics.localHitRate * 100) / 100,
    totalLookups: economics.totalLookups,
    serperCallsAvoided: economics.serperCallsAvoided,
  };
}

/**
 * Derive sitemap health for a single domain from database.
 */
export function getDomainSitemapHealth(domain: string, now: Date = new Date()): DomainSitemapHealthSummary {
  const normDomain = normalizeDomain(domain);
  const counts = getDomainUrlCounts(normDomain);
  const latestRefresh = getLatestRefreshRun(normDomain);
  const recentRefreshes = listRefreshHistory(normDomain, 5);
  const economics = getDiscoveryEconomics(normDomain);
  const domainStatus = getDomainStatus(normDomain);

  return evaluateDomainSitemapHealth(
    normDomain,
    counts,
    latestRefresh,
    recentRefreshes,
    economics,
    domainStatus,
    now,
  );
}
