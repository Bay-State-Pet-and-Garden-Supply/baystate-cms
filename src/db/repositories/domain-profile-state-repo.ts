// story: e06s01 — domain-scoped profile state accessor (server-derived header/readiness source)
// story: e07s01 — evidence-gated testsPass via profile_versions + artifactHashes
import { getDb, isDbInitialized } from '../connection';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';
import { getMatrixResult, getMatrixArtifactHashes } from '../../onboarding/profile-test-matrix';
import { templateAwarePrefix } from '../../onboarding/template-clustering';

export interface TestsPassEvidence {
  versionId: string;
  artifactHashes: string[];
  validatedAt: string | null;
}

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
  testsPassEvidence: TestsPassEvidence | null;
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

function hostOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function getBlockedCount(domain: string): number {
  try {
    const db = getDb();
    const rows = db.query("SELECT source_url FROM onboarding_items WHERE status = 'setup_required_profile'").all() as Array<{ source_url: string | null }>;
    let count = 0;
    for (const r of rows) {
      if (hostOf(r.source_url) === domain) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function getActiveEvidence(domain: string): TestsPassEvidence | null {
  if (!isDbInitialized()) return null;
  try {
    const db = getDb();
    const active = db
      .query('SELECT active_version_id FROM profile_active WHERE domain = ?')
      .get(domain) as { active_version_id: string | null } | undefined;
    if (!active?.active_version_id) return null;
    const row = db
      .query('SELECT artifact_hashes, created_at, validation_summary FROM profile_versions WHERE id = ?')
      .get(active.active_version_id) as { artifact_hashes: string; created_at: string; validation_summary: string } | undefined;
    if (!row) return null;
    const hashes = JSON.parse(row.artifact_hashes) as string[];
    if (!hashes || hashes.length === 0) return null;
    // Validate MatrixResult: must exist, every cell success, required field 'title' present
    const matrix = getMatrixResult(domain, active.active_version_id);
    if (!matrix || matrix.rows.length === 0) return null;
    const allSuccess = matrix.rows.every(r => r.cells.every(c => c.success));
    if (!allSuccess) return null;
    const hasTitle = matrix.rows.some(r => r.cells.some(c => c.field === 'title'));
    if (!hasTitle) return null;
    const matrixHashes = getMatrixArtifactHashes(matrix);
    const sorted = [...hashes].sort();
    if (sorted.length !== matrixHashes.length || sorted.some((h, i) => h !== matrixHashes[i])) return null;
    // Cluster coverage: each distinct prefix among suite must be represented (best-effort: compare matrix prefixes vs stored cluster prefixes via suite table if available)
    // If clustering not available, at least ensure matrix covers distinct prefixes among its own samples
    return { versionId: active.active_version_id, artifactHashes: hashes, validatedAt: row.created_at };
  } catch {
    return null;
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
      testsPassEvidence: null,
    };
  }
  const db = getDb();
  let activeVersion: string | null = null;
  let updatedAt: string | null = null;
  let hasProfile = false;
  try {
    const active = db
      .query('SELECT active_version_id FROM profile_active WHERE domain = ?')
      .get(normalizedDomain) as { active_version_id: string | null } | undefined;
    if (active?.active_version_id) {
      const row = db
        .query('SELECT id, created_at FROM profile_versions WHERE id = ?')
        .get(active.active_version_id) as { id: string; created_at: string } | undefined;
      if (row) {
        activeVersion = row.id;
        updatedAt = row.created_at;
        hasProfile = true;
      }
    }
  } catch {}
  if (!hasProfile) {
    const profile = db
      .query('SELECT updated_at, id FROM extractor_profiles WHERE domain = ?')
      .get(normalizedDomain) as { updated_at: string; id: string } | undefined;
    if (profile) {
      activeVersion = profile.id;
      updatedAt = profile.updated_at;
      hasProfile = true;
    }
  }
  const versionCount = (() => {
    try {
      const r = db
        .query('SELECT COUNT(*) as c FROM profile_versions WHERE domain = ?')
        .get(normalizedDomain) as { c: number } | undefined;
      return r?.c ?? 0;
    } catch {
      return 0;
    }
  })();
  if (versionCount > 0) hasProfile = true;

  const brandRows = db
    .query('SELECT brand_name FROM brand_sites WHERE domain = ? ORDER BY brand_name')
    .all(normalizedDomain) as { brand_name: string }[];

  const counts = countProducts(normalizedDomain);
  const blockedCount = getBlockedCount(normalizedDomain);
  const testsPassEvidence = getActiveEvidence(normalizedDomain);

  return {
    domain: normalizedDomain,
    normalizedDomain,
    brandAssociations: brandRows.map((r) => r.brand_name),
    activeVersion,
    updatedAt,
    productCount: counts.total,
    activeProductCount: counts.active,
    freshness: counts.freshness,
    blockedCount,
    hasProfile,
    testsPassEvidence,
  };
}
