import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { BrandSite } from '../../shared/schemas/onboarding';

export interface BrandSiteRow {
  id: string;
  brand_name: string;
  domain: string;
  url_pattern: string | null;
  success_count: number;
  last_used_at: string | null;
  created_at: string;
}

function mapRowToBrandSite(row: BrandSiteRow): BrandSite {
  return {
    id: row.id,
    brandName: row.brand_name,
    domain: row.domain,
    urlPattern: row.url_pattern,
    successCount: row.success_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function upsertBrandSite(
  brandName: string,
  domain: string,
  urlPattern?: string | null,
): BrandSite {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  const existing = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? AND domain = ?',
  ).get(normalizedBrand, normalizedDomain) as BrandSiteRow | undefined;

  if (existing) {
    db.query(
      `UPDATE brand_sites SET success_count = success_count + 1, last_used_at = ?
       ${urlPattern ? ', url_pattern = ?' : ''} WHERE id = ?`,
    ).run(...(urlPattern ? [now, urlPattern, existing.id] : [now, existing.id]));
    return {
      id: existing.id,
      brandName: normalizedBrand,
      domain: normalizedDomain,
      urlPattern: urlPattern ?? existing.url_pattern,
      successCount: existing.success_count + 1,
      lastUsedAt: now,
      createdAt: existing.created_at,
    };
  }

  const id = randomUUID();
  db.query(
    `INSERT INTO brand_sites (id, brand_name, domain, url_pattern, success_count, last_used_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, normalizedBrand, normalizedDomain, urlPattern ?? null, now, now);

  return {
    id,
    brandName: normalizedBrand,
    domain: normalizedDomain,
    urlPattern: urlPattern ?? null,
    successCount: 1,
    lastUsedAt: now,
    createdAt: now,
  };
}

export function findBrandSites(brandName: string): BrandSite[] {
  const db = getDb();
  const normalizedBrand = brandName.toLowerCase().trim();
  const rows = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? ORDER BY success_count DESC',
  ).all(normalizedBrand) as BrandSiteRow[];
  return rows.map(mapRowToBrandSite);
}

export function listAllBrandSites(): BrandSite[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM brand_sites ORDER BY brand_name, success_count DESC',
  ).all() as BrandSiteRow[];
  return rows.map(mapRowToBrandSite);
}

export function deleteBrandSite(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM brand_sites WHERE id = ?').run(id);
  return result.changes > 0;
}
