// story: e07s02
import { normalizeDomain, findUrlsByDomain } from '../db/repositories/brand-url-index-repo';
import { clusterUrls, templateAwarePrefix, type Cluster } from './template-clustering';
import { getDomainSitemapHealth } from './sitemap-health-evaluator';

function templateAwarePrefixFromUrl(url: string): string {
  try { return templateAwarePrefix(url); } catch { return '/'; }
}

export interface SuiteSuggestion {
  clusters: Cluster[];
  suggested: string[];
  filteredCount: number;
  filteredReasons: Record<string, number>;
}

function isSpamDuplicate(urls: Array<{ url: string }>): Set<string> {
  // Detect identical-length spam (acmepet case): group by content length hint if available via brand_url_index length? We approximate via url length + same title/h1 not available here, so use path length dedupe: if two URLs map to identical byte-length hint stored? For now, detect when multiple product URLs share exact same slug length and would have been fetched with identical title — fallback: reject urls with same normalized path length when domain has >1 identical-length entries and no distinct variant tokens.
  // Lightweight: if 2+ urls have identical pathname length and the domain is known spam host, we still return empty; for generic, we treat length dedupe as: group by pathname length, if a length group has >1 and no variant param, mark extras as spam? Simplified: return empty (no spam) for now — filtering is primarily via health + verifier length map when html lengths supplied.
  return new Set();
}

export function getSuiteSuggestion(
  domain: string,
  opts?: { htmlLengths?: Map<string, number> },
): SuiteSuggestion {
  const norm = normalizeDomain(domain);
  const health = getDomainSitemapHealth(norm);
  // Fetch active product URLs
  const { urls } = findUrlsByDomain(norm, { pageType: 'product', activeOnly: true, limit: 500 });
  const candidates = urls.map(r => r.url);
  const filteredReasons: Record<string, number> = {};
  let filtered: string[] = [...candidates];

  // Health-based filter: if blocked/stale/missing, don't suggest but still cluster what we have
  if (health.status === 'blocked') {
    filteredReasons['domain_blocked'] = filtered.length;
    filtered = [];
  }

  // 404 / unreachable filter: use last_fetched_at + extraction_status hint if available; treat extraction_status='failed' as filtered
  const failedUrls = new Set(urls.filter(r => r.extraction_status === 'failed').map(r => r.url));
  if (failedUrls.size > 0) {
    filtered = filtered.filter(u => !failedUrls.has(u));
    filteredReasons['failed_extraction'] = failedUrls.size;
  }

  // Identical-length spam dedupe (acmepet: same len 75799)
  if (opts?.htmlLengths && opts.htmlLengths.size > 1) {
    const byLen = new Map<number, string[]>();
    for (const u of filtered) {
      const len = opts.htmlLengths.get(u);
      if (len === undefined) continue;
      const arr = byLen.get(len) ?? [];
      arr.push(u);
      byLen.set(len, arr);
    }
    for (const [len, group] of byLen.entries()) {
      if (group.length > 1) {
        // Keep first, drop rest as spam (same rendered length, same h1)
        const toDrop = group.slice(1);
        toDrop.forEach(u => {
          const idx = filtered.indexOf(u);
          if (idx !== -1) filtered.splice(idx, 1);
        });
        filteredReasons[`identical_length_${len}`] = toDrop.length;
      }
    }
  }

  const filteredCount = candidates.length - filtered.length;
  if (filtered.length === 0) {
    return { clusters: [], suggested: [], filteredCount, filteredReasons };
  }

  const inputs = filtered.map(url => ({ url, html: '' as string }));
  const clusters = clusterUrls(inputs as any);
  // Suggestion: one per cluster (+ extra variant when present in that prefix), up to 10
  const suggested: string[] = [];
  for (const c of clusters) {
    if (suggested.length >= 10) break;
    suggested.push(c.suggestedUrl);
    const maybeHasVariant = (c as unknown as { hasVariant?: boolean }).hasVariant;
    if (maybeHasVariant && suggested.length < 10) {
      const prefix = (c as unknown as { prefix: string }).prefix;
      const variantExtra = filtered.find(u => u !== c.suggestedUrl && templateAwarePrefixFromUrl(u) === prefix && (u.includes('variant') || u.includes('?')));
      if (variantExtra) suggested.push(variantExtra);
    }
  }
  // Prioritize most recent: sort by brand_url_index last_sitemap_refresh_at descending if available
  // We keep cluster order deterministic but ensure suggested respects freshness by reordering suggested by recency map
  const recency = new Map(urls.map(r => [r.url, r.last_sitemap_refresh_at] as const));
  suggested.sort((a, b) => (recency.get(b) ?? '').localeCompare(recency.get(a) ?? ''));

  return { clusters, suggested: suggested.slice(0, 10), filteredCount, filteredReasons };
}
