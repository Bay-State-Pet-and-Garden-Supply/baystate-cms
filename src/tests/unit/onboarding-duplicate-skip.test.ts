import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { listAllBrandSites } from '../../db/repositories/brand-site-repo';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import app from '../../server/app';

describe('Onboarding Duplicate Product Skipping', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'onboarding-skip-test.db');
  const wsId = 'ws-skip-test-id';

  beforeAll(() => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Insert dummy workspace
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });

    // Insert an existing product into catalog index
    insertProductIndex({
      id: 'existing-product-uuid',
      sku: 'SKU-EXISTING',
      filePath: 'products/SKU-EXISTING.json',
      title: 'Existing Product',
      status: 'active',
      price: '19.99',
      inventoryQuantity: 10,
      primaryImage: null,
      productHash: 'hash',
      lastApprovedCommit: 'commit',
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(() => {
    resetSourcingFlagsOverride();
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should skip duplicate SKU and only insert the new product', async () => {
    const payload = {
      name: 'Import Test Batch',
      fileName: 'import.xlsx',
      mapping: {
        upc: 'SKU/UPC',
        name: 'Product Name',
        nameMergeWith: null,
        price: 'Price',
        quantity: null,
        brand: null,
        department: null,
        sourceUrl: null,
      },
      rows: [
        { 'SKU/UPC': 'SKU-EXISTING', 'Product Name': 'Existing Product' },
        { 'SKU/UPC': 'SKU-NEW', 'Product Name': 'New Product' },
      ],
    };

    const res = await app.request('/api/onboarding/batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch).toBeDefined();
    expect(body.batch.totalItems).toBe(1);

    const items = listItemsByBatch(body.batch.id);
    expect(items.length).toBe(1);
    expect(items[0].upc).toBe('SKU-NEW');
    expect(items[0].isDuplicate).toBe(false);
    // Disabled sourcing engine: the surviving new item enters Discovery.
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');
    expect(items[0].sourcingDecision).toBeNull();
  });

  it('should return 400 error when all products in the batch are duplicates', async () => {
    const payload = {
      name: 'Import Duplicates Batch',
      fileName: 'import_duplicates.xlsx',
      mapping: {
        upc: 'SKU/UPC',
        name: 'Product Name',
        nameMergeWith: null,
        price: 'Price',
        quantity: null,
        brand: null,
        department: null,
        sourceUrl: null,
      },
      rows: [
        { 'SKU/UPC': 'SKU-EXISTING', 'Product Name': 'Existing Product' },
      ],
    };

    const res = await app.request('/api/onboarding/batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('All products in this spreadsheet already exist in the catalog.');
  });

  it('should ignore deprecated brandMappings: no brand_sites rows, batch + items still created', async () => {
    const payload = {
      name: 'Import With Deprecated Brand Mappings',
      fileName: 'import_brands.xlsx',
      mapping: {
        upc: 'SKU/UPC',
        name: 'Product Name',
        nameMergeWith: null,
        price: 'Price',
        quantity: null,
        brand: 'Brand',
        department: null,
        sourceUrl: null,
      },
      rows: [
        { 'SKU/UPC': 'SKU-BRANDED-1', 'Product Name': 'Branded Product', 'Brand': 'ACME' },
      ],
      // Legacy upload-wizard field: must be accepted but ignored (ADR 0017
      // follow-up — brand_sites is managed through Settings or Discovery
      // attention actions, never import-time writes).
      brandMappings: { ACME: 'acme.com', 'OTHER BRAND': 'otherbrand.com' },
    };

    const res = await app.request('/api/onboarding/batches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Batch and items are created normally.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch).toBeDefined();
    expect(body.batch.totalItems).toBe(1);

    const items = listItemsByBatch(body.batch.id);
    expect(items).toHaveLength(1);
    expect(items[0].upc).toBe('SKU-BRANDED-1');
    // Disabled sourcing engine: the new item enters Discovery.
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');

    // The deprecated brandMappings payload must NOT write brand_sites rows.
    const sites = listAllBrandSites();
    expect(sites.some(s => s.brandName === 'acme' || s.brandName === 'other brand')).toBe(false);
  });
});
