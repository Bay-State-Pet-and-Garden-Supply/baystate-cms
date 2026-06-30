import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createBatch,
  findBatchById,
  listBatches,
  updateBatchStatus,
  deleteBatch
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemStatus
} from '../../db/repositories/onboarding-item-repo';
import {
  insertSources,
  listSourcesByItem,
  selectSource,
  getSelectedSource
} from '../../db/repositories/onboarding-source-repo';
import {
  insertExtraction,
  getLatestExtraction
} from '../../db/repositories/onboarding-extraction-repo';
import {
  upsertApiKey,
  getApiKey,
  listApiKeys
} from '../../db/repositories/api-key-repo';
import {
  upsertBrandSite,
  findBrandSites
} from '../../db/repositories/brand-site-repo';

describe('Onboarding Repositories CRUD', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'onboarding-test.db');
  const wsId = 'workspace-test-id';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create a dummy workspace in DB to satisfy foreign keys
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', '/tmp/ws', '/tmp/ws/.git', now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should support batch and item CRUD operations', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Weekly Import A',
      fileName: 'weekly_import_a.xlsx',
      totalItems: 2,
    });

    expect(batch.id).toBeDefined();
    expect(batch.name).toBe('Weekly Import A');
    expect(batch.status).toBe('imported');

    const items = insertItems(batch.id, [
      { upc: '111111111111', name: 'Product 1', price: '9.99', rowNumber: 2 },
      { upc: '222222222222', name: 'Product 2', price: '19.99', rowNumber: 3 }
    ]);

    expect(items.length).toBe(2);
    expect(items[0].upc).toBe('111111111111');

    const batchItems = listItemsByBatch(batch.id);
    expect(batchItems.length).toBe(2);

    updateItemStatus(items[0].id, 'discovering');
    const updatedItem = findItemById(items[0].id);
    expect(updatedItem?.status).toBe('discovering');

    const batchDetails = findBatchById(batch.id);
    expect(batchDetails).toBeDefined();

    updateBatchStatus(batch.id, 'discovering');
    const updatedBatch = findBatchById(batch.id);
    expect(updatedBatch?.status).toBe('discovering');
  });

  it('should support source discovery candidate CRUD operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch B', fileName: 'b.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '333333333333', name: 'Product 3', rowNumber: 2 }]);
    const item = items[0];

    const sources = insertSources(item.id, [
      { url: 'https://site1.com/p', title: 'Site 1 Product', confidence: 0.9, domain: 'site1.com' },
      { url: 'https://site2.com/p', title: 'Site 2 Product', confidence: 0.5, domain: 'site2.com' }
    ]);

    expect(sources.length).toBe(2);
    
    const candidates = listSourcesByItem(item.id);
    expect(candidates.length).toBe(2);
    expect(candidates[0].confidence).toBe(0.9);

    selectSource(candidates[0].id);
    const selected = getSelectedSource(item.id);
    expect(selected?.url).toBe('https://site1.com/p');
  });

  it('should support extraction result CRUD operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch C', fileName: 'c.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '444444444444', name: 'Product 4', rowNumber: 2 }]);
    const item = items[0];

    const extractionData = {
      title: 'Scraped Product 4',
      brand: 'TestBrand',
      description: 'Extracted product description',
      bulletPoints: ['Feature 1', 'Feature 2'],
      primaryImage: 'products/444444444444/images/primary.jpg',
      additionalImages: [],
      price: '14.99',
      weight: '1 lb',
      dimensions: null,
      seoFileName: 'scraped-product-4',
      searchKeywords: 'keywords',
      sourceUrl: 'https://testsite.com/product4',
      confidence: 0.8,
      fieldProvenance: { title: 'html' }
    };

    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://testsite.com/product4',
      extractionDataJson: JSON.stringify(extractionData),
      extractionMethod: 'crawlee_playwright',
      confidence: 0.8,
    });

    const latest = getLatestExtraction(item.id);
    expect(latest).toBeDefined();
    expect(latest?.source_url).toBe('https://testsite.com/product4');
    expect(JSON.parse(latest!.extraction_data_json).title).toBe('Scraped Product 4');
  });

  it('should support api keys and brand sites CRUD operations', () => {
    // API Keys
    upsertApiKey('serper', 'test-serper-key');
    const keyRow = getApiKey('serper');
    expect(keyRow?.api_key).toBe('test-serper-key');

    const keyList = listApiKeys();
    expect(keyList.some(k => k.service === 'serper')).toBe(true);

    // Brand Sites
    upsertBrandSite('Nike', 'nike.com');
    upsertBrandSite('Nike', 'nike.com'); // Upsert should increment/succeed
    
    const brandMatches = findBrandSites('Nike');
    expect(brandMatches.length).toBe(1);
    expect(brandMatches[0].domain).toBe('nike.com');
  });
});
