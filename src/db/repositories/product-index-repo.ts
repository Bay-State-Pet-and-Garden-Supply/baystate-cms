import { getDb } from '../connection';

export interface ProductIndexRow {
  id: string;
  sku: string;
  filePath: string;
  title: string;
  status: string;
  price: string | null;
  inventoryQuantity: number | null;
  primaryImage: string | null;
  productHash: string;
  lastApprovedCommit: string | null;
  lastPulledRemoteHash: string | null;
  lastSyncedRemoteHash: string | null;
  lastSyncedAt: string | null;
  syncStatus: string;
  hasAdvancedBlocks: number;
  hasWarnings: number;
  createdAt: string;
  updatedAt: string;
}

export function findProductBySku(sku: string): ProductIndexRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM product_index WHERE sku = ?').get(sku) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listProducts(filter?: { status?: string; search?: string }): ProductIndexRow[] {
  const db = getDb();
  let sql = 'SELECT * FROM product_index';
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    p.push(filter.status);
  }
  if (filter?.search) {
    conditions.push('(sku LIKE ? OR title LIKE ?)');
    p.push(`%${filter.search}%`, `%${filter.search}%`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY title ASC';

  const rows = db.query(sql).all(...p) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function insertProductIndex(row: ProductIndexRow): void {
  const db = getDb();
  db.run(
    `INSERT INTO product_index (id, sku, file_path, title, status, price, inventory_quantity, primary_image,
       product_hash, last_approved_commit, last_pulled_remote_hash, last_synced_remote_hash,
       last_synced_at, sync_status, has_advanced_blocks, has_warnings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.sku, row.filePath, row.title, row.status, row.price,
      row.inventoryQuantity, row.primaryImage, row.productHash,
      row.lastApprovedCommit, row.lastPulledRemoteHash, row.lastSyncedRemoteHash,
      row.lastSyncedAt, row.syncStatus, row.hasAdvancedBlocks, row.hasWarnings,
      row.createdAt, row.updatedAt,
    ],
  );
}

export function updateProductSyncStatus(sku: string, syncStatus: string): void {
  const db = getDb();
  db.run('UPDATE product_index SET sync_status = ?, updated_at = ? WHERE sku = ?', [
    syncStatus, new Date().toISOString(), sku,
  ]);
}

export function updateProductIndex(row: Partial<ProductIndexRow> & { sku: string }): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (row.title !== undefined) { sets.push('title = ?'); params.push(row.title); }
  if (row.status !== undefined) { sets.push('status = ?'); params.push(row.status); }
  if (row.price !== undefined) { sets.push('price = ?'); params.push(row.price); }
  if (row.inventoryQuantity !== undefined) { sets.push('inventory_quantity = ?'); params.push(row.inventoryQuantity); }
  if (row.primaryImage !== undefined) { sets.push('primary_image = ?'); params.push(row.primaryImage); }
  if (row.productHash !== undefined) { sets.push('product_hash = ?'); params.push(row.productHash); }
  if (row.lastApprovedCommit !== undefined) { sets.push('last_approved_commit = ?'); params.push(row.lastApprovedCommit); }
  if (row.lastPulledRemoteHash !== undefined) { sets.push('last_pulled_remote_hash = ?'); params.push(row.lastPulledRemoteHash); }
  if (row.lastSyncedRemoteHash !== undefined) { sets.push('last_synced_remote_hash = ?'); params.push(row.lastSyncedRemoteHash); }
  if (row.lastSyncedAt !== undefined) { sets.push('last_synced_at = ?'); params.push(row.lastSyncedAt); }
  if (row.syncStatus !== undefined) { sets.push('sync_status = ?'); params.push(row.syncStatus); }
  if (row.hasAdvancedBlocks !== undefined) { sets.push('has_advanced_blocks = ?'); params.push(row.hasAdvancedBlocks); }
  if (row.hasWarnings !== undefined) { sets.push('has_warnings = ?'); params.push(row.hasWarnings); }

  params.push(row.sku);
  db.run(`UPDATE product_index SET ${sets.join(', ')} WHERE sku = ?`, params);
}

export function deleteProductIndex(sku: string): void {
  const db = getDb();
  db.run('DELETE FROM product_index WHERE sku = ?', [sku]);
}

function mapRow(row: Record<string, unknown>): ProductIndexRow {
  return {
    id: String(row.id),
    sku: String(row.sku),
    filePath: String(row.file_path),
    title: String(row.title),
    status: String(row.status),
    price: row.price ? String(row.price) : null,
    inventoryQuantity: row.inventory_quantity != null ? Number(row.inventory_quantity) : null,
    primaryImage: row.primary_image ? String(row.primary_image) : null,
    productHash: String(row.product_hash),
    lastApprovedCommit: row.last_approved_commit ? String(row.last_approved_commit) : null,
    lastPulledRemoteHash: row.last_pulled_remote_hash ? String(row.last_pulled_remote_hash) : null,
    lastSyncedRemoteHash: row.last_synced_remote_hash ? String(row.last_synced_remote_hash) : null,
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    syncStatus: String(row.sync_status),
    hasAdvancedBlocks: Number(row.has_advanced_blocks),
    hasWarnings: Number(row.has_warnings),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
