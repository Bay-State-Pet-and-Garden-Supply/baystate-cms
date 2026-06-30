import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { OnboardingItem, ItemStatus } from '../../shared/schemas/onboarding';

export interface OnboardingItemRow {
  id: string;
  batch_id: string;
  upc: string;
  name: string;
  price: string | null;
  quantity: number | null;
  brand_hint: string | null;
  department_hint: string | null;
  source_url: string | null;
  status: string;
  error_message: string | null;
  retry_count: number;
  is_duplicate: number;
  existing_sku: string | null;
  extraction_data_json: string | null;
  curation_data_json: string | null;
  row_number: number;
  created_at: string;
  updated_at: string;
}

export interface InsertItemData {
  upc: string;
  name: string;
  price?: string | null;
  quantity?: number | null;
  brandHint?: string | null;
  departmentHint?: string | null;
  sourceUrl?: string | null;
  rowNumber: number;
  isDuplicate?: boolean;
  existingSku?: string | null;
}

export function mapRowToItem(row: OnboardingItemRow): OnboardingItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    upc: row.upc,
    name: row.name,
    price: row.price,
    quantity: row.quantity,
    brandHint: row.brand_hint,
    departmentHint: row.department_hint,
    sourceUrl: row.source_url,
    status: row.status as ItemStatus,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    isDuplicate: row.is_duplicate === 1,
    existingSku: row.existing_sku,
    extractionData: row.extraction_data_json ? JSON.parse(row.extraction_data_json) : null,
    curationData: row.curation_data_json ? JSON.parse(row.curation_data_json) : null,
    rowNumber: row.row_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertItems(batchId: string, items: InsertItemData[]): OnboardingItem[] {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.query(
    `INSERT INTO onboarding_items
      (id, batch_id, upc, name, price, quantity, brand_hint, department_hint, source_url,
       status, error_message, retry_count, is_duplicate, existing_sku, extraction_data_json, curation_data_json, row_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', NULL, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
  );

  const inserted: OnboardingItem[] = [];

  const insertAll = db.transaction(() => {
    for (const item of items) {
      const id = randomUUID();
      const isDuplicateNum = item.isDuplicate ? 1 : 0;
      stmt.run(
        id,
        batchId,
        item.upc,
        item.name,
        item.price ?? null,
        item.quantity ?? null,
        item.brandHint ?? null,
        item.departmentHint ?? null,
        item.sourceUrl ?? null,
        isDuplicateNum,
        item.existingSku ?? null,
        item.rowNumber,
        now,
        now,
      );
      inserted.push({
        id,
        batchId,
        upc: item.upc,
        name: item.name,
        price: item.price ?? null,
        quantity: item.quantity ?? null,
        brandHint: item.brandHint ?? null,
        departmentHint: item.departmentHint ?? null,
        sourceUrl: item.sourceUrl ?? null,
        status: 'imported',
        errorMessage: null,
        retryCount: 0,
        isDuplicate: !!item.isDuplicate,
        existingSku: item.existingSku ?? null,
        extractionData: null,
        curationData: null,
        rowNumber: item.rowNumber,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  insertAll();

  return inserted;
}

export function findItemById(id: string): OnboardingItem | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_items WHERE id = ?').get(id) as OnboardingItemRow | undefined;
  return row ? mapRowToItem(row) : undefined;
}

export function listItemsByBatch(
  batchId: string,
  statusFilter?: ItemStatus | ItemStatus[],
): OnboardingItem[] {
  const db = getDb();

  let rows: OnboardingItemRow[];
  if (!statusFilter) {
    rows = db.query(
      'SELECT * FROM onboarding_items WHERE batch_id = ? ORDER BY row_number',
    ).all(batchId) as OnboardingItemRow[];
  } else {
    const statuses = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
    const placeholders = statuses.map(() => '?').join(', ');
    rows = db.query(
      `SELECT * FROM onboarding_items WHERE batch_id = ? AND status IN (${placeholders}) ORDER BY row_number`,
    ).all(batchId, ...statuses) as OnboardingItemRow[];
  }

  return rows.map(mapRowToItem);
}

export function updateItemStatus(
  id: string,
  status: ItemStatus,
  errorMessage?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
  ).run(status, errorMessage ?? null, now, id);
}

export function updateItemSourceUrl(id: string, url: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET source_url = ?, status = ?, updated_at = ? WHERE id = ?',
  ).run(url, 'source_confirmed', now, id);
}

export function updateItemExtractionData(id: string, extractionDataJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
  ).run(extractionDataJson, now, id);
}

export function updateItemCurationData(id: string, curationDataJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?',
  ).run(curationDataJson, now, id);
}

export function incrementRetryCount(id: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    'UPDATE onboarding_items SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?',
  ).run(now, id);
  const row = db.query('SELECT retry_count FROM onboarding_items WHERE id = ?').get(id) as { retry_count: number };
  return row.retry_count;
}

export function countItemsByStatus(batchId: string): Record<string, number> {
  const db = getDb();
  const rows = db.query(
    'SELECT status, COUNT(*) as count FROM onboarding_items WHERE batch_id = ? GROUP BY status',
  ).all(batchId) as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

export function getNextPendingItems(
  batchId: string,
  status: ItemStatus,
  limit: number,
): OnboardingItem[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_items WHERE batch_id = ? AND status = ? ORDER BY row_number LIMIT ?',
  ).all(batchId, status, limit) as OnboardingItemRow[];
  return rows.map(mapRowToItem);
}
