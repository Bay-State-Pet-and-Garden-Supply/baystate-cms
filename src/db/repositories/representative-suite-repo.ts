// story: e06s02 — persistent representative suite 3-10
import { getDb } from '../connection';
import { normalizeDomain } from './brand-url-index-repo';
import { hasValidWaiver } from './waiver-repo';

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_representative_suite (
      domain TEXT NOT NULL,
      url TEXT NOT NULL,
      confirmed_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (domain, url)
    );
  `);
}

export function setRepresentativeSuite(domain: string, urls: string[], actor: string): void {
  if (!actor?.trim()) throw new Error('actor required');
  ensureTable();
  const norm = normalizeDomain(domain);
  if (urls.length > 10) throw new Error('representative suite cannot exceed 10');
  // validate urls exist as product in brand_url_index? allow any http url for test, but check active domain rows if present
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM domain_representative_suite WHERE domain = ?').run(norm);
    const now = new Date().toISOString();
    const stmt = db.prepare('INSERT INTO domain_representative_suite (domain, url, confirmed_by, added_at) VALUES (?, ?, ?, ?)');
    for (const u of urls) {
      if (!u.startsWith('http')) throw new Error(`invalid url ${u}`);
      stmt.run(norm, u, actor.trim(), now);
    }
  })();
}

export function getRepresentativeSuite(domain: string): string[] {
  ensureTable();
  const db = getDb();
  const norm = normalizeDomain(domain);
  const rows = db.query('SELECT url FROM domain_representative_suite WHERE domain = ? ORDER BY added_at, url').all(norm) as { url: string }[];
  return rows.map(r => r.url);
}

export function isSuiteSatisfied(domain: string): boolean {
  ensureTable();
  const suite = getRepresentativeSuite(domain);
  // need waiver check: if suite size <3 but waiver exists, satisfied if at least 1-2 and product count <3
  if (suite.length >= 3) return true;
  if (suite.length === 0) return false;
  // 1-2 only satisfied if waiver exists
  if (suite.length < 3) {
    return hasValidWaiver(domain);
  }
  return false;
}
