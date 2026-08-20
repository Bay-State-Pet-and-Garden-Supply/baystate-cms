// story: e06s02 — sitemap inventory candidate vs confirmed
import { getDb } from '../db/connection';
import { normalizeDomain } from '../db/repositories/brand-url-index-repo';

export interface SitemapInventory {
  candidateCount: number;
  confirmedCount: number;
  freshness: string | null;
  productCount: number;
  activeProductCount: number;
}

function ensureSuiteTable(): void {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS domain_representative_suite (domain TEXT NOT NULL, url TEXT NOT NULL, confirmed_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (domain, url))`);
  } catch {}
}

export function getSitemapInventory(domain: string): SitemapInventory {
  const norm = normalizeDomain(domain);
  ensureSuiteTable();
  const db = getDb();
  const prodRow = db.query("SELECT COUNT(*) as c, MAX(last_sitemap_refresh_at) as freshness, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) as active FROM brand_url_index WHERE domain = ? AND page_type = 'product'").get(norm) as { c: number; freshness: string | null; active: number | null } | undefined;
  const candidateCount = prodRow?.c ?? 0;
  const freshness = prodRow?.freshness ?? null;
  const activeProductCount = prodRow?.active ?? 0;
  let confirmedCount = 0;
  try {
    const suiteRow = db.query('SELECT COUNT(*) as c FROM domain_representative_suite WHERE domain = ?').get(norm) as { c: number } | undefined;
    confirmedCount = suiteRow?.c ?? 0;
  } catch {
    confirmedCount = 0;
  }
  return {
    candidateCount,
    confirmedCount,
    freshness,
    productCount: candidateCount,
    activeProductCount,
  };
}
