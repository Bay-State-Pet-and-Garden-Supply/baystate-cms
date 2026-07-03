import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { promoteItems } from '../../onboarding/draft-promoter';
import { listChangeSets, listChangeSetItems } from '../../db/repositories/change-set-repo';
import type { ExtractionData } from '../../shared/schemas/onboarding';

describe('Draft Promoter Service', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'promoter-test.db');
  const tempWorkspaceDir = path.resolve(import.meta.dirname, 'temp-workspace');
  const wsId = 'ws-promoter-id';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create temp workspace folder
    try { mkdirSync(tempWorkspaceDir, { recursive: true }); } catch { /* ok */ }

    // Insert dummy workspace
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Promoter WS', tempWorkspaceDir, path.join(tempWorkspaceDir, '.git'), now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should successfully build product drafts and promote them to a change set', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo A',
      fileName: 'promo.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'Awesome Running Shoes',
      brand: 'RunningCo',
      description: 'Extremely lightweight running shoes.',
      bulletPoints: ['Lightweight', 'Breathable'],
      primaryImage: 'products/123456123456/images/primary.jpg',
      additionalImages: [],
      price: '89.99',
      weight: '12 oz',
      dimensions: null,
      seoFileName: 'awesome-running-shoes',
      searchKeywords: 'running shoes lightweight',
      sourceUrl: 'https://runningco.com/shoes',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' },
      packagingTitle: null,
        customFields: {}
    };

    const items = insertItems(batch.id, [{
      upc: '123456123456',
      name: 'Running Shoes',
      price: '89.99',
      rowNumber: 2
    }]);

    const item = items[0];
    
    // Save extraction data and advance to promotion stage
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.changeSetId).toBeDefined();

    // Check Change Sets
    const csList = listChangeSets(wsId);
    expect(csList.length).toBe(1);
    expect(csList[0].id).toBe(promoteRes.changeSetId);
    expect(csList[0].title).toContain('Onboarding: Onboard Promo A');

    // Check Change Set Items
    const csItems = listChangeSetItems(promoteRes.changeSetId);
    expect(csItems.length).toBe(1);
    expect(csItems[0].sku).toBe('123456123456');
    expect(csItems[0].operation).toBe('create');

    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.sku).toBe('123456123456');
    expect(draftProduct.core.name).toBe('Awesome Running Shoes');
    expect(draftProduct.core.price).toBe('89.99');
    expect(draftProduct.core.media.primary).toBe('products/123456123456/images/primary.jpg');
  });

  it('should strictly use spreadsheet price and ignore extraction price', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo B',
      fileName: 'promo2.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'Premium Dog Food',
      brand: 'DogCo',
      description: 'Healthy dog food.',
      bulletPoints: [],
      primaryImage: null,
      additionalImages: [],
      price: '19.99', // extracted price
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      customFields: {},
      sourceUrl: 'https://dogco.com/food',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '987654321098',
      name: 'Dog Food',
      price: '24.99', // spreadsheet price (different from extraction!)
      rowNumber: 2
    }]);

    const item = items[0];
    
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);

    const csItems = listChangeSetItems(promoteRes.changeSetId);
    const itemMatch = csItems.find(ci => ci.sku === '987654321098');
    expect(itemMatch).toBeDefined();

    const draftProduct = JSON.parse(itemMatch!.draftJson);
    expect(draftProduct.core.price).toBe('24.99'); // Should be spreadsheet price, not extracted price!
  });
});
