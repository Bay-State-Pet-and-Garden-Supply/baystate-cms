// story: e08s01 — pure derivation for Brand Strategy (no DB, no side effects)
import type { BrandStrategy, BrandStrategyOfficialDomain } from '../../shared/schemas/brand-strategy';

function normalizeExact(value: string): string {
  return value.toLowerCase().trim();
}

function normalizeDiagnostic(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function freshnessFor(lastRefreshAt: string | null, activeCount: number): 'fresh' | 'stale' | 'missing' {
  if (!lastRefreshAt || activeCount === 0) return 'missing';
  const ageMs = Date.now() - new Date(lastRefreshAt).getTime();
  if (Number.isNaN(ageMs)) return 'missing';
  return ageMs < 7 * 24 * 3600 * 1000 ? 'fresh' : 'stale';
}

export interface DeriveParams {
  brandSites: Array<{ brandName: string; domain: string }>;
  advisoryProfiles: Array<{ brand: string; aliases: string[]; preferredDistributorIds: string[]; sourcingPolicy: BrandStrategy['sourcingPolicy'] }>;
  sitemapByDomain?: Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>;
  readinessByDomain?: Map<string, BrandStrategy['extractorReadiness']>;
  enabledDistributorIds?: string[];
}

export function deriveBrandStrategies(params: DeriveParams, readinessFallback?: (domain: string) => BrandStrategy['extractorReadiness']): BrandStrategy[] {
  const exactKeys = new Set<string>();
  for (const s of params.brandSites) exactKeys.add(normalizeExact(s.brandName));
  for (const p of params.advisoryProfiles) exactKeys.add(normalizeExact(p.brand));

  const diagnosticIndex = new Map<string, string[]>();
  for (const key of exactKeys) {
    const diag = normalizeDiagnostic(key);
    const list = diagnosticIndex.get(diag) ?? [];
    list.push(key);
    diagnosticIndex.set(diag, list);
  }

  const profileByExact = new Map<string, DeriveParams['advisoryProfiles'][number]>();
  for (const p of params.advisoryProfiles) profileByExact.set(normalizeExact(p.brand), p);

  const sitesByExact = new Map<string, Array<{ domain: string }>>();
  for (const s of params.brandSites) {
    const key = normalizeExact(s.brandName);
    const list = sitesByExact.get(key) ?? [];
    list.push({ domain: s.domain });
    sitesByExact.set(key, list);
  }

  const enabledIds = params.enabledDistributorIds ?? [];
  const result: BrandStrategy[] = [];
  for (const exact of [...exactKeys].sort()) {
    const advisory = profileByExact.get(exact) ?? null;
    const sites = sitesByExact.get(exact) ?? [];

    const officialDomains: BrandStrategyOfficialDomain[] = sites.map(({ domain }) => {
      const norm = domain.toLowerCase().replace(/^www\./, '').trim();
      const inv = params.sitemapByDomain?.get(norm) ?? null;
      const totalUrls = inv?.totalUrls ?? 0;
      const lastRefreshAt = inv?.lastRefreshAt ?? null;
      const activeCount = inv?.activeCount ?? 0;
      return {
        domain: norm,
        sitemap: { totalUrls, freshCount: activeCount, lastRefreshAt, freshness: freshnessFor(lastRefreshAt, activeCount) },
      };
    });

    const aliases = advisory?.aliases ?? [];
    const preferredDistributorIds = advisory?.preferredDistributorIds ?? [];
    const sourcingPolicy = advisory?.sourcingPolicy ?? 'advisory';

    let extractorReadiness: BrandStrategy['extractorReadiness'];
    if (officialDomains.length === 0) {
      const hasPreferred = preferredDistributorIds.length > 0;
      const isEligible = sourcingPolicy === 'preferred_only' || hasPreferred;
      extractorReadiness = isEligible ? 'profile_bypass_eligible' : 'not_configured';
    } else {
      const first = officialDomains[0].domain;
      extractorReadiness = params.readinessByDomain?.get(first) ?? (readinessFallback ? readinessFallback(first) : 'not_configured');
    }

    const diagKey = normalizeDiagnostic(exact);
    const collisions = (diagnosticIndex.get(diagKey) ?? []).filter((k) => k !== exact);
    const ambiguous = collisions.map((candidateBrand) => ({ candidateBrand, reason: 'whitespace-normalized match' }));

    const unmatched = !advisory || sites.length === 0;

    const displayBrand = advisory?.brand ?? params.brandSites.find((s) => normalizeExact(s.brandName) === exact)?.brandName ?? exact;
    const fallbackTier = enabledIds.filter((id) => !preferredDistributorIds.includes(id));

    result.push({
      brandKey: displayBrand,
      normalizedBrand: exact,
      aliases,
      preferredDistributorIds,
      sourcingPolicy,
      fallbackTier,
      officialDomains,
      extractorReadiness,
      ambiguous,
      unmatched,
      possibleMatches: ambiguous,
    });
  }

  return result;
}
