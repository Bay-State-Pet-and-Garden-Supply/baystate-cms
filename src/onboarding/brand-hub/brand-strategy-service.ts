// story: e08s01 — aggregation projection (exact normalized-brand authority, singleton workspace, never union)
import { getDb } from '../../db/connection';
import { listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';
import { getSitemapInventory } from '../sitemap-inventory-service';
import { getServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { deriveBrandStrategies } from './brand-strategy-derive';
import type { BrandStrategy } from '../../shared/schemas/brand-strategy';

export { deriveBrandStrategies } from './brand-strategy-derive';

function readinessForDomain(domain: string): BrandStrategy['extractorReadiness'] {
  try {
    const state = getDomainProfileState(domain);
    if (!state.hasProfile) return 'not_configured';
    if (state.testsPassEvidence) return 'active';
    return 'degraded';
  } catch {
    return 'not_configured';
  }
}

export function listBrandStrategies(): BrandStrategy[] {
  const workspace = getServerSingletonWorkspace();
  const brandSites = listAllBrandSites();
  let advisoryProfiles: Array<{ brand: string; aliases: string[]; preferredDistributorIds: string[]; sourcingPolicy: BrandStrategy['sourcingPolicy'] }> = [];
  if (workspace) {
    const db = getDb();
    const rows = db.query('SELECT brand, aliases_json, preferred_distributor_ids_json, sourcing_policy FROM brand_advisory_profiles WHERE workspace_id = ?').all(workspace.id) as Array<{ brand: string; aliases_json: string; preferred_distributor_ids_json: string; sourcing_policy: string | null }>;
    advisoryProfiles = rows.map((r) => {
      let aliases: string[] = [];
      let preferred: string[] = [];
      try { aliases = JSON.parse(r.aliases_json); } catch {}
      try { preferred = JSON.parse(r.preferred_distributor_ids_json); } catch {}
      return { brand: r.brand, aliases, preferredDistributorIds: preferred, sourcingPolicy: (r.sourcing_policy as BrandStrategy['sourcingPolicy']) ?? 'preferred_then_fallback' };
    });
  }
  const sitemapByDomain = new Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>();
  const readinessByDomain = new Map<string, BrandStrategy['extractorReadiness']>();
  const domains = new Set(brandSites.map((s) => s.domain));
  for (const d of domains) {
    const inv = getSitemapInventory(d);
    sitemapByDomain.set(d, { totalUrls: inv.candidateCount, lastRefreshAt: inv.freshness, activeCount: inv.activeProductCount });
    readinessByDomain.set(d, readinessForDomain(d));
  }
  return deriveBrandStrategies({ brandSites: brandSites.map((s) => ({ brandName: s.brandName, domain: s.domain })), advisoryProfiles, sitemapByDomain, readinessByDomain }, readinessForDomain);
}
