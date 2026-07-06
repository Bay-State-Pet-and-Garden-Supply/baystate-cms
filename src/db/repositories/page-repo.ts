import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface PageRow {
  id: string;
  name: string;
  fileName: string | null;
  parentId: string | null;
  pageHash: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listPages(): PageRow[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM page_index ORDER BY name ASC').all() as Record<string, any>[];
  return rows.map(mapPageRow);
}

export function getPage(id: string): PageRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM page_index WHERE id = ?').get(id) as Record<string, any> | undefined;
  return row ? mapPageRow(row) : null;
}

// fallow-ignore-next-line unused-export
export function getPageByName(name: string): PageRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM page_index WHERE name = ?').get(name) as Record<string, any> | undefined;
  return row ? mapPageRow(row) : null;
}

export function upsertPage(page: Omit<PageRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): PageRow {
  const db = getDb();
  const id = page.id ?? randomUUID();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       parent_id = EXCLUDED.parent_id,
       page_hash = EXCLUDED.page_hash,
       last_synced_at = COALESCE(EXCLUDED.last_synced_at, page_index.last_synced_at),
       updated_at = EXCLUDED.updated_at`,
    [
      id, page.name, page.fileName, page.parentId, page.pageHash,
      page.lastSyncedAt, now, now
    ]
  );

  return {
    id,
    name: page.name,
    fileName: page.fileName,
    parentId: page.parentId,
    pageHash: page.pageHash,
    lastSyncedAt: page.lastSyncedAt,
    createdAt: now,
    updatedAt: now
  };
}

export function deletePage(id: string): void {
  const db = getDb();
  const page = getPage(id);
  if (page) {
    db.run('DELETE FROM product_pages WHERE page_name = ?', [page.name]);
  }
  db.run('DELETE FROM page_index WHERE id = ?', [id]);
}

// ─── Product-Page Assignments (backward-compatible) ─────────────────────────

/**
 * Assign a product to a page using stable page identity.
 * Inserts both page_id and page_name for backward compatibility.
 */
export function assignProductToPageId(productSku: string, pageId: string, pageName: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, ?, ?)',
    [productSku, pageName, pageId, now]
  );
}

/**
 * Assign a product to a page by page name (backward-compatible wrapper).
 * Resolves page name to id when a matching page exists in page_index.
 */
export function assignProductToPage(productSku: string, pageName: string): void {
  const page = getPageByName(pageName);
  if (page) {
    assignProductToPageId(productSku, page.id, pageName);
  } else {
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO product_pages (product_sku, page_name, created_at) VALUES (?, ?, ?)',
      [productSku, pageName, now]
    );
  }
}

function unassignProductFromPage(productSku: string, pageName: string): void {
  const db = getDb();
  db.run('DELETE FROM product_pages WHERE product_sku = ? AND page_name = ?', [productSku, pageName]);
}

export function getProductPages(productSku: string): string[] {
  const db = getDb();
  const rows = db.query('SELECT page_name FROM product_pages WHERE product_sku = ?').all(productSku) as Array<{ page_name: string }>;
  return rows.map(r => r.page_name);
}

/**
 * Get product page assignments including both page ID and page name.
 */
export function getProductPageAssignments(productSku: string): Array<{ pageId: string | null; pageName: string }> {
  const db = getDb();
  const rows = db.query('SELECT page_id, page_name FROM product_pages WHERE product_sku = ?').all(productSku) as Array<{ page_id: string | null; page_name: string }>;
  return rows.map(r => ({ pageId: r.page_id ? String(r.page_id) : null, pageName: String(r.page_name) }));
}

function getPageProducts(pageName: string): string[] {
  const db = getDb();
  const rows = db.query('SELECT product_sku FROM product_pages WHERE page_name = ?').all(pageName) as Array<{ product_sku: string }>;
  return rows.map(r => r.product_sku);
}

export function clearProductPages(productSku: string): void {
  const db = getDb();
  db.run('DELETE FROM product_pages WHERE product_sku = ?', [productSku]);
}

function mapPageRow(row: Record<string, any>): PageRow {
  return {
    id: String(row.id),
    name: String(row.name),
    fileName: row.file_name ? String(row.file_name) : null,
    parentId: row.parent_id ? String(row.parent_id) : null,
    pageHash: String(row.page_hash),
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
