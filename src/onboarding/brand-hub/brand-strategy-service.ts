// story: e08s01 — aggregation projection (exact normalized-brand authority, singleton workspace, never union)
import { getDb } from '../../db/connection';
import { listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';
import { getSitemapInventory } from '../sitemap-inventory-service';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { deriveBrandStrategies } from './brand-strategy-derive';
import { BrandStrategySchema } from '../../shared/schemas/brand-strategy';
import type { BrandStrategy } from '../../shared/schemas/brand-strategy';
import { SourcingPolicyEnum } from '../../shared/schemas/distributor';
import { listConnectionsByWorkspace } from '../../db/repositories/distributor-repo';

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
  const workspace = requireServerSingletonWorkspace();
  const brandSites = listAllBrandSites();
  let advisoryProfiles: Array<{ brand: string; aliases: string[]; preferredDistributorIds: string[]; sourcingPolicy: BrandStrategy['sourcingPolicy'] }> = [];
  {
    const db = getDb();
    const rows = db.query('SELECT brand, aliases_json, preferred_distributor_ids_json, sourcing_policy FROM brand_advisory_profiles WHERE workspace_id = ?').all(workspace.id) as Array<{ brand: string; aliases_json: string; preferred_distributor_ids_json: string; sourcing_policy: string | null }>;
    advisoryProfiles = rows.map((r) => {
      let aliases: unknown = null;
      let preferred: unknown = null;
      try { aliases = JSON.parse(r.aliases_json); } catch { aliases = null; }
      try { preferred = JSON.parse(r.preferred_distributor_ids_json); } catch { preferred = null; }
      const safeAliases = Array.isArray(aliases) ? (aliases as string[]).filter((v) => typeof v === 'string') : [];
      const safePreferred = Array.isArray(preferred) ? (preferred as string[]).filter((v) => typeof v === 'string') : [];
      const policyParse = SourcingPolicyEnum.safeParse(r.sourcing_policy);
      const sourcingPolicy = policyParse.success ? policyParse.data : 'preferred_then_fallback';
      return { brand: r.brand, aliases: safeAliases, preferredDistributorIds: safePreferred, sourcingPolicy };
    });
  }
  const enabledDistributorIds = [...new Set(listConnectionsByWorkspace(workspace.id, true).map((c) => c.distributorId))];
  const sitemapByDomain = new Map<string, { totalUrls: number; lastRefreshAt: string | null; activeCount: number }>();
  const readinessByDomain = new Map<string, BrandStrategy['extractorReadiness']>();
  const domains = new Set(brandSites.map((s) => s.domain));
  for (const d of domains) {
    const inv = getSitemapInventory(d);
    sitemapByDomain.set(d, { totalUrls: inv.candidateCount, lastRefreshAt: inv.freshness, activeCount: inv.activeProductCount });
    readinessByDomain.set(d, readinessForDomain(d));
  }
  const strategies = deriveBrandStrategies({ brandSites: brandSites.map((s) => ({ brandName: s.brandName, domain: s.domain })), advisoryProfiles, sitemapByDomain, readinessByDomain, enabledDistributorIds }, readinessForDomain);
  for (const s of strategies) BrandStrategySchema.parse(s);
  return strategies;
}
