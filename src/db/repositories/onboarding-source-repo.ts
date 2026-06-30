import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingSource } from '../../shared/schemas/onboarding';

export interface OnboardingSourceRow {
  id: string;
  item_id: string;
  url: string;
  title: string | null;
  snippet: string | null;
  domain: string | null;
  confidence: number;
  is_selected: number;
  source_method: string;
  created_at: string;
}

export interface InsertSourceData {
  url: string;
  title?: string | null;
  snippet?: string | null;
  domain?: string | null;
  confidence: number;
  sourceMethod?: string;
}

function mapRowToSource(row: OnboardingSourceRow): OnboardingSource {
  return {
    id: row.id,
    itemId: row.item_id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    domain: row.domain,
    confidence: row.confidence,
    isSelected: row.is_selected === 1,
    sourceMethod: row.source_method,
    createdAt: row.created_at,
  };
}

export function insertSources(itemId: string, sources: InsertSourceData[]): OnboardingSource[] {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.query(
    `INSERT INTO onboarding_sources
      (id, item_id, url, title, snippet, domain, confidence, is_selected, source_method, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );

  const inserted: OnboardingSource[] = [];

  const insertAll = db.transaction(() => {
    for (const source of sources) {
      const id = randomUUID();
      stmt.run(
        id,
        itemId,
        source.url,
        source.title ?? null,
        source.snippet ?? null,
        source.domain ?? null,
        source.confidence,
        source.sourceMethod ?? 'serper',
        now,
      );
      inserted.push({
        id,
        itemId,
        url: source.url,
        title: source.title ?? null,
        snippet: source.snippet ?? null,
        domain: source.domain ?? null,
        confidence: source.confidence,
        isSelected: false,
        sourceMethod: source.sourceMethod ?? 'serper',
        createdAt: now,
      });
    }
  });
  insertAll();

  return inserted;
}

export function listSourcesByItem(itemId: string): OnboardingSource[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_sources WHERE item_id = ? ORDER BY confidence DESC',
  ).all(itemId) as OnboardingSourceRow[];
  return rows.map(mapRowToSource);
}

export function selectSource(sourceId: string): void {
  const db = getDb();
  const source = db.query('SELECT item_id FROM onboarding_sources WHERE id = ?').get(sourceId) as
    | { item_id: string }
    | undefined;
  if (!source) return;

  db.transaction(() => {
    db.query('UPDATE onboarding_sources SET is_selected = 0 WHERE item_id = ?').run(source.item_id);
    db.query('UPDATE onboarding_sources SET is_selected = 1 WHERE id = ?').run(sourceId);
  })();
}

export function getSelectedSource(itemId: string): OnboardingSource | undefined {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM onboarding_sources WHERE item_id = ? AND is_selected = 1',
  ).get(itemId) as OnboardingSourceRow | undefined;
  return row ? mapRowToSource(row) : undefined;
}

export function deleteSourcesByItem(itemId: string): void {
  const db = getDb();
  db.query('DELETE FROM onboarding_sources WHERE item_id = ?').run(itemId);
}
