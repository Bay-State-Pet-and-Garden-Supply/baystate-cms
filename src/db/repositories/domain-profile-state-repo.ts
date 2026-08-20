// story: e06s01 — domain-scoped profile state accessor (server-derived header/readiness source)
import { getDb } from '../connection';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';

export interface DomainProfileState {
  domain: string;
  normalizedDomain: string;
  brandAssociations: string[];
  activeVersion: string | null;
  updatedAt: string | null;
  productCount: number;
  activeProductCount: number;
  freshness: string | null;
  blockedCount: number;
  hasProfile: boolean;
}

function countProducts(domain: string): { total: number; active: number; freshness: string | null } {
  const db = getDb();
  const row = db
    .query(
      'SELECT COUNT(*) as total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) as active, MAX(last_sitemap_refresh_at) as freshness FROM brand_url_index WHERE domain = ?',
    )
    .get(domain) as { total: number; active: number | null; freshness: string | null } | undefined;
  if (!row) return { total: 0, active: 0, freshness: null };
  return { total: row.total ?? 0, active: row.active ?? 0, freshness: row.freshness ?? null };
}

function getBlockedCount(_domain: string): number {
  // e06s04 will implement real park count from onboarding_items with status setup_required_profile
  // For shell, return 0 — header still shows blockedCount type and readiness can derive Degraded via hasProfile flag
  try {
    const db = getDb();
    const row = db
      .query("SELECT COUNT(*) as c FROM onboarding_items WHERE status = 'setup_required_profile'")
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

// story: e06s01
export function getDomainProfileState(rawDomain: string): DomainProfileState {
  const normalizedDomain = normalizeBrandHubDomain(rawDomain);
  if (!normalizedDomain) {
    return {
      domain: '',
      normalizedDomain: '',
      brandAssociations: [],
      activeVersion: null,
      updatedAt: null,
      productCount: 0,
      activeProductCount: 0,
      freshness: null,
      blockedCount: 0,
      hasProfile: false,
    };
  }
  const db = getDb();
  const profile = db
    .query('SELECT updated_at, id FROM extractor_profiles WHERE domain = ?')
    .get(normalizedDomain) as { updated_at: string; id: string } | undefined;

  const brandRows = db
    .query('SELECT brand_name FROM brand_sites WHERE domain = ? ORDER BY brand_name')
    .all(normalizedDomain) as { brand_name: string }[];

  const counts = countProducts(normalizedDomain);
  const blockedCount = getBlockedCount(normalizedDomain);

  return {
    domain: normalizedDomain,
    normalizedDomain,
    brandAssociations: brandRows.map((r) => r.brand_name),
    activeVersion: profile ? profile.id : null,
    updatedAt: profile?.updated_at ?? null,
    productCount: counts.total,
    activeProductCount: counts.active,
    freshness: counts.freshness,
    blockedCount,
    hasProfile: !!profile,
  };
}
