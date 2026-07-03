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

export function getLatestExtraction(itemId: string): OnboardingExtractionRow | undefined {
  const db = getDb();
  return db.query(
    'SELECT * FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(itemId) as OnboardingExtractionRow | undefined;
}

function listExtractionsByItem(itemId: string): OnboardingExtractionRow[] {
  const db = getDb();
  return db.query(
    'SELECT * FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as OnboardingExtractionRow[];
}
