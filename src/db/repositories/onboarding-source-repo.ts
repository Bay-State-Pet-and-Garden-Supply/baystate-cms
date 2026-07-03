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

// fallow-ignore-next-line unused-export
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

/** Lightweight sample used by the profile governance service's
 *  cross-sample validation. Joins `onboarding_sources` to
 *  `onboarding_items` so the caller has the expected product name,
 *  brand hint, and item id for the URL. Used to verify that a
 *  generated selector set generalizes across multiple product pages
 *  on the same domain before a human operator is allowed to approve
 *  it. Promotion still requires explicit per-field approval
 *  regardless of multi-sample results (profile-governance invariant,
 *  Phase 3 task 13). */
export interface ValidationSampleRow {
  url: string;
  expectedName: string;
  brandHint: string | null;
  itemId: string;
  isSelected: number;
  confidence: number;
}

/**
 * List URLs from a domain that are good candidates for cross-page
 * profile validation.
 *
 * Policy (Phase 3 task 14, decision 8):
 *   - Only sources the operator has confirmed (`is_selected = 1`).
 *     Random high-confidence-but-unselected URLs are excluded.
 *   - Exact-match or suffix-match domain comparison: `domain = ?`
 *     or `domain LIKE '%.domain'`. The previous broad `%domain%`
 *     match is removed because it was allowing unrelated domains
 *     (e.g. `notmywoof.com` matching `mywoof.com`) to bleed into
 *     validation samples.
 *   - URL deduplication within the result.
 *   - `expectedName` prefers `expected_name` when present, otherwise
 *     falls back to the raw `name` column.
 *   - `brandHint` is `brand_hint` and may be null.
 *
 * The function does not fetch HTML. The caller is expected to do a
 * separate HTTP fetch (using the same headers as the page extractor)
 * and pair the URL with the fetched HTML before running
 * `validateRevisionAcrossConfirmedSamples`.
 */
export function listValidationSamplesByDomain(
  domain: string,
  limit = 5,
): ValidationSampleRow[] {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));

  // Selected sources for the exact domain, plus subdomain suffix
  // (e.g. `us.mywoof.com` should still match `mywoof.com`). The
  // previous `LIKE '%mywoof%'` implementation matched `notmywoof.com`
  // too, which produced cross-brand pollution; the explicit suffix
  // match closes that gap.
  const rows = db
    .query(
      `SELECT s.url AS url,
              COALESCE(i.expected_name, i.name) AS expectedName,
              i.brand_hint AS brandHint,
              i.id AS itemId,
              s.is_selected AS isSelected,
              s.confidence AS confidence
         FROM onboarding_sources s
         JOIN onboarding_items i ON s.item_id = i.id
        WHERE s.is_selected = 1
          AND s.domain IS NOT NULL
          AND (LOWER(s.domain) = ? OR LOWER(s.domain) LIKE ?)
        ORDER BY s.confidence DESC, s.created_at DESC
        LIMIT ?`,
    )
    .all(
      normalizedDomain,
      `%.${normalizedDomain}`,
      safeLimit * 2, // over-fetch a little; we will dedupe and trim below
    ) as ValidationSampleRow[];

  // Deduplicate by URL and cap to the requested limit. Confirmed
  // sources for the same product can appear multiple times if the
  // same URL was inserted on different scans.
  const seen = new Set<string>();
  const deduped: ValidationSampleRow[] = [];
  for (const row of rows) {
    if (!row.url) continue;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    deduped.push(row);
    if (deduped.length >= safeLimit) break;
  }
  return deduped;
}
