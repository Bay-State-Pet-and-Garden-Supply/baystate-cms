// story: e35s10 — brand hub thin view-model API surface, delegates to read-only view-model
import { Hono } from 'hono';
import { listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { listAllProfiles } from '../../db/repositories/extractor-profile-repo';
import { listAllDomainStatuses } from '../../db/repositories/domain-status-repo';
import {
  getAllDomainUrlCounts,
  normalizeDomain,
} from '../../db/repositories/brand-url-index-repo';
import {
  getAllLatestRefreshRuns,
  getAllDomainDiscoveryEconomics,
} from '../../db/repositories/sitemap-telemetry-repo';
import { evaluateDomainSitemapHealth } from '../../onboarding/sitemap-health-evaluator';
import { deriveBrandHubRow } from '../../onboarding/brand-hub/view-model';
import type { BrandHubOverviewResponse } from '../../shared/schemas/onboarding';

export const brandHubRoutes = new Hono();

function buildBrandMap(brandSites: ReturnType<typeof listAllBrandSites>) {
  const brandMap = new Map<string, typeof brandSites>();
  for (const b of brandSites) {
    const norm = normalizeDomain(b.domain);
    const existing = brandMap.get(norm) ?? [];
    existing.push(b);
    brandMap.set(norm, existing);
  }
  return brandMap;
}

function collectDomainUniverse(
  brandSites: ReturnType<typeof listAllBrandSites>,
  profiles: ReturnType<typeof listAllProfiles>,
  allCounts: Record<string, unknown>,
  latestRuns: Record<string, unknown>,
): Set<string> {
  const domainSet = new Set<string>();
  for (const b of brandSites) domainSet.add(normalizeDomain(b.domain));
  for (const p of profiles) domainSet.add(normalizeDomain(p.domain));
  for (const d of Object.keys(allCounts)) domainSet.add(d);
  for (const d of Object.keys(latestRuns)) domainSet.add(d);
  return domainSet;
}

function buildRows(
  domainSet: Set<string>,
  brandMap: Map<string, ReturnType<typeof listAllBrandSites>>,
  profileMap: Map<string, ReturnType<typeof listAllProfiles>[number]>,
  statusMap: Map<string, ReturnType<typeof listAllDomainStatuses>[number]>,
  allCounts: ReturnType<typeof getAllDomainUrlCounts>,
  latestRuns: ReturnType<typeof getAllLatestRefreshRuns>,
  economics: ReturnType<typeof getAllDomainDiscoveryEconomics>,
  now: Date,
): BrandHubOverviewResponse['rows'] {
  const rows: BrandHubOverviewResponse['rows'] = [];
  for (const domain of Array.from(domainSet).sort()) {
    rows.push(buildSingleRow(domain, brandMap, profileMap, statusMap, allCounts, latestRuns, economics, now));
  }
  return rows;
}

function buildSingleRow(
  domain: string,
  brandMap: Map<string, ReturnType<typeof listAllBrandSites>>,
  profileMap: Map<string, ReturnType<typeof listAllProfiles>[number]>,
  statusMap: Map<string, ReturnType<typeof listAllDomainStatuses>[number]>,
  allCounts: ReturnType<typeof getAllDomainUrlCounts>,
  latestRuns: ReturnType<typeof getAllLatestRefreshRuns>,
  economics: ReturnType<typeof getAllDomainDiscoveryEconomics>,
  now: Date,
) {
  const counts = allCounts[domain] ?? { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0 };
  const latestRefresh = latestRuns[domain] ?? null;
  const econ = economics[domain] ?? { totalLookups: 0, localHitCount: 0, localHitRate: 0 };
  const dStatus = statusMap.get(domain) ?? null;
  const prof = profileMap.get(domain) ?? null;
  const brands = brandMap.get(domain) ?? [];
  const health = evaluateDomainSitemapHealth(domain, counts, latestRefresh, latestRefresh ? [latestRefresh] : [], econ, dStatus, now);
  return deriveBrandHubRow({ domain, profile: prof, urlCounts: counts, health, brandSites: brands });
}

function computeTotals(rows: BrandHubOverviewResponse['rows']) {
  return {
    totalDomains: rows.length,
    healthyCount: rows.filter((r) => r.sitemap?.status === 'healthy').length,
    needsAttentionCount: rows.filter((r) => r.sitemap?.needsAttention).length,
    totalProductUrls: rows.reduce((acc, r) => acc + r.urlCounts.productCount, 0),
  };
}

function buildBrandHubOverview(): BrandHubOverviewResponse {
  const brandSites = listAllBrandSites();
  const profiles = listAllProfiles();
  const domainStatuses = listAllDomainStatuses();
  const allCounts = getAllDomainUrlCounts();
  const latestRuns = getAllLatestRefreshRuns();
  const economics = getAllDomainDiscoveryEconomics(30);
  const statusMap = new Map(domainStatuses.map((s) => [s.domain, s]));
  const profileMap = new Map(profiles.map((p) => [p.domain, p]));
  const brandMap = buildBrandMap(brandSites);
  const domainSet = collectDomainUniverse(brandSites, profiles, allCounts, latestRuns);
  const now = new Date();
  const rows = buildRows(domainSet, brandMap, profileMap, statusMap, allCounts, latestRuns, economics, now);
  return { rows, totals: computeTotals(rows), generatedAt: now.toISOString() };
}

brandHubRoutes.get('/onboarding/brand-hub', (c) => {
  const overview = buildBrandHubOverview();
  return c.json(overview);
});

brandHubRoutes.get('/onboarding/brand-hub/overview', (c) => {
  const overview = buildBrandHubOverview();
  return c.json(overview);
});
