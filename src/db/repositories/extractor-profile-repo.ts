import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface ExtractorProfile {
  id: string;
  domain: string;
  titleSelector: string | null;
  priceSelector: string | null;
  descriptionSelector: string | null;
  brandSelector: string | null;
  imagesSelector: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbProfile {
  id: string;
  domain: string;
  title_selector: string | null;
  price_selector: string | null;
  description_selector: string | null;
  brand_selector: string | null;
  images_selector: string | null;
  created_at: string;
  updated_at: string;
}

function mapToProfile(db: DbProfile): ExtractorProfile {
  return {
    id: db.id,
    domain: db.domain,
    titleSelector: db.title_selector,
    priceSelector: db.price_selector,
    descriptionSelector: db.description_selector,
    brandSelector: db.brand_selector,
    imagesSelector: db.images_selector,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

export function findProfileByDomain(domain: string): ExtractorProfile | null {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const row = db.query('SELECT * FROM extractor_profiles WHERE domain = ?').get(normalizedDomain) as DbProfile | undefined;
  return row ? mapToProfile(row) : null;
}

export function listAllProfiles(): ExtractorProfile[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM extractor_profiles ORDER BY domain').all() as DbProfile[];
  return rows.map(mapToProfile);
}

export function upsertProfile(
  domain: string,
  selectors: {
    titleSelector?: string | null;
    priceSelector?: string | null;
    descriptionSelector?: string | null;
    brandSelector?: string | null;
    imagesSelector?: string | null;
  },
): ExtractorProfile {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  
  const existing = db.query('SELECT * FROM extractor_profiles WHERE domain = ?').get(normalizedDomain) as DbProfile | undefined;

  const tSel = selectors.titleSelector ?? null;
  const pSel = selectors.priceSelector ?? null;
  const dSel = selectors.descriptionSelector ?? null;
  const bSel = selectors.brandSelector ?? null;
  const iSel = selectors.imagesSelector ?? null;

  if (existing) {
    db.query(`
      UPDATE extractor_profiles 
      SET title_selector = ?, price_selector = ?, description_selector = ?, brand_selector = ?, images_selector = ?, updated_at = ? 
      WHERE domain = ?
    `).run(tSel, pSel, dSel, bSel, iSel, now, normalizedDomain);

    return mapToProfile({
      ...existing,
      title_selector: tSel,
      price_selector: pSel,
      description_selector: dSel,
      brand_selector: bSel,
      images_selector: iSel,
      updated_at: now,
    });
  }

  const id = randomUUID();
  db.query(`
    INSERT INTO extractor_profiles (id, domain, title_selector, price_selector, description_selector, brand_selector, images_selector, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalizedDomain, tSel, pSel, dSel, bSel, iSel, now, now);

  return {
    id,
    domain: normalizedDomain,
    titleSelector: tSel,
    priceSelector: pSel,
    descriptionSelector: dSel,
    brandSelector: bSel,
    imagesSelector: iSel,
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteProfile(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM extractor_profiles WHERE id = ?').run(id);
  return result.changes > 0;
}
