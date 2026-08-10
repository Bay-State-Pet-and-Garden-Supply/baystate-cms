import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface OnboardingExtractionRow {
  id: string;
  item_id: string;
  source_url: string;
  extraction_data_json: string;
  extraction_method: string;
  confidence: number;
  images_json: string | null;
  raw_structured_data_json: string | null;
  created_at: string;
}

export function insertExtraction(data: {
  itemId: string;
  sourceUrl: string;
  extractionDataJson: string;
  extractionMethod: string;
  confidence: number;
  imagesJson?: string | null;
  rawStructuredDataJson?: string | null;
}): OnboardingExtractionRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.query(
    `INSERT INTO onboarding_extractions
      (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.itemId,
    data.sourceUrl,
    data.extractionDataJson,
    data.extractionMethod,
    data.confidence,
    data.imagesJson ?? null,
    data.rawStructuredDataJson ?? null,
    now,
  );

  return {
    id,
    item_id: data.itemId,
    source_url: data.sourceUrl,
    extraction_data_json: data.extractionDataJson,
    extraction_method: data.extractionMethod,
    confidence: data.confidence,
    images_json: data.imagesJson ?? null,
    raw_structured_data_json: data.rawStructuredDataJson ?? null,
    created_at: now,
  };
}

/**
 * Update the extraction_data_json on the latest extraction record for an item.
 * Used when a user edits extraction results via the pipeline board save flow.
 */
export function updateLatestExtractionData(itemId: string, extractionDataJson: string): void {
  const db = getDb();
  db.query(
    `UPDATE onboarding_extractions
     SET extraction_data_json = ?
     WHERE id = (SELECT id FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1)`,
  ).run(extractionDataJson, itemId);
}

export function getLatestExtraction(itemId: string): OnboardingExtractionRow | undefined {
  const db = getDb();
  return db.query(
    'SELECT * FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(itemId) as OnboardingExtractionRow | undefined;
}

/**
 * Latest extraction `source_url` per onboarding item, in ONE batched query.
 * Returns a Map keyed by item id; items without any extraction row are
 * absent from the map. Used by cohort readiness to bind each member's
 * selected source to the source recorded when its extraction evidence was
 * frozen (issue #30 round-3 R4).
 */
export function getLatestExtractionSourcesByItemIds(itemIds: string[]): Map<string, string> {
  const db = getDb();
  const sources = new Map<string, string>();
  if (itemIds.length === 0) return sources;
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT e.item_id, e.source_url
     FROM onboarding_extractions e
     JOIN (
       SELECT item_id, MAX(created_at) AS max_created_at
       FROM onboarding_extractions
       WHERE item_id IN (${placeholders})
       GROUP BY item_id
     ) latest ON latest.item_id = e.item_id AND latest.max_created_at = e.created_at`,
  ).all(...itemIds) as Array<{ item_id: string; source_url: string }>;
  for (const row of rows) sources.set(row.item_id, row.source_url);
  return sources;
}

function listExtractionsByItem(itemId: string): OnboardingExtractionRow[] {
  const db = getDb();
  return db.query(
    'SELECT * FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as OnboardingExtractionRow[];
}
