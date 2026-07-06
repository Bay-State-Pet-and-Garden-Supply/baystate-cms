import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
      packagingOcrData: null,
      customFields: {}
    };

    const items = insertItems(batch.id, [{
      upc: '123456123456',
      name: 'Running Shoes',
      price: '89.99',
      rowNumber: 2
    }]);

    const item = items[0];
    
    // Save extraction data, set curation_data with pages, advance to promotion stage
    const curationData = {
      curatedTitle: 'Awesome Running Shoes',
      titleSource: 'web',
      suggestedPages: ['Shoes', 'Running Gear'],
      suggestedProductType: 'Footwear',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    // Create existing product file with brand set (simulates a prior promotion)
    const productFileDir = path.join(tempWorkspaceDir, 'products');
    mkdirSync(productFileDir, { recursive: true });
    const existingProduct = {
      schemaVersion: 1,
      id: 'test-id-1',
      sku: '123456123456',
      status: 'draft',
      core: { name: 'Awesome Running Shoes', price: '89.99', salePrice: null, description: 'Extremely lightweight running shoes.', inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null }, availability: null, weight: '12 oz', taxable: true, media: { primary: 'products/123456123456/images/primary.jpg', additional: [] }, seo: { fileName: 'awesome-running-shoes', searchKeywords: 'running shoes lightweight', googleProductCategory: null } },
      customFields: { ProductField16: 'RunningCo' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };
    writeFileSync(path.join(productFileDir, '123456123456.json'), JSON.stringify(existingProduct));

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
    // Pre-existing product file causes an 'update' operation
    expect(csItems[0].operation).toBe('update');

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
      packagingOcrData: null,
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

    // Add mandatory fields: primary image, brand in customFields, pages
    const curationData = {
      curatedTitle: 'Premium Dog Food',
      titleSource: 'web',
      suggestedPages: ['Dog Food'],
      suggestedProductType: 'Food',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };
    const db2 = getDb();
    db2.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify({ ...extractionData, primaryImage: 'products/987654321098/images/primary.jpg' }),
      JSON.stringify(curationData),
      item.id
    );

    // Create an existing product file with brand set (simulates a prior promotion)
    const productFileDir = path.join(tempWorkspaceDir, 'products');
    mkdirSync(productFileDir, { recursive: true });
    const existingProduct = {
      schemaVersion: 1,
      id: 'test-id-2',
      sku: '987654321098',
      status: 'draft',
      core: { name: 'Premium Dog Food', price: '24.99', salePrice: null, description: 'Healthy dog food.', inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null }, availability: null, weight: null, taxable: true, media: { primary: 'products/987654321098/images/primary.jpg', additional: [] }, seo: { fileName: null, searchKeywords: null, googleProductCategory: null } },
      customFields: { ProductField16: 'DogCo' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };
    writeFileSync(path.join(productFileDir, '987654321098.json'), JSON.stringify(existingProduct));

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);

    const csItems = listChangeSetItems(promoteRes.changeSetId);
    const itemMatch = csItems.find(ci => ci.sku === '987654321098');
    expect(itemMatch).toBeDefined();

    const draftProduct = JSON.parse(itemMatch!.draftJson);
    expect(draftProduct.core.price).toBe('24.99'); // Should be spreadsheet price, not extracted price!
  });

  it('should clean price strings by removing dollar signs and commas', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo C',
      fileName: 'promo3.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'Premium Cat Food',
      brand: 'CatCo',
      description: 'Healthy cat food.',
      bulletPoints: [],
      primaryImage: 'products/888888888888/images/primary.jpg',
      additionalImages: [],
      price: null,
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://catco.com/food',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '888888888888',
      name: 'Cat Food',
      price: '$19,999.95', // Dirty price format
      brandHint: 'CatCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Premium Cat Food',
      titleSource: 'web',
      suggestedPages: ['Cat Food'],
      suggestedProductType: 'Food',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.price).toBe('19999.95'); // cleaned price
  });

  it('should fall back to extraction data price if item price is empty', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo D',
      fileName: 'promo4.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'Premium Dog Treat',
      brand: 'DogCo',
      description: 'Tasty treat.',
      bulletPoints: [],
      primaryImage: 'products/777777777777/images/primary.jpg',
      additionalImages: [],
      price: '$12.50', // extracted price (dirty format)
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://dogco.com/treat',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '777777777777',
      name: 'Dog Treat',
      price: null, // empty in spreadsheet
      brandHint: 'DogCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Premium Dog Treat',
      titleSource: 'web',
      suggestedPages: ['Dog Treats'],
      suggestedProductType: 'Treat',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.price).toBe('12.50'); // fallback to cleaned extracted price
  });

  it('should mark items as failed on missing mandatory fields and return failures list', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo E',
      fileName: 'promo5.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'Missing Details Product',
      brand: null, // missing brand
      description: null,
      bulletPoints: [],
      primaryImage: null, // missing primary image
      additionalImages: [],
      price: null, // missing price
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://unknown.com/product',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '555555555555',
      name: 'Incomplete Item',
      price: null, // missing price
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Incomplete Item',
      titleSource: 'web',
      suggestedPages: [], // missing pages
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].itemId).toBe(item.id);
    expect(promoteRes.failures[0].error).toContain('Missing mandatory fields');

    // Verify in db that stage_status is failed and has error_message
    const updatedRow = db.query('SELECT stage_status, error_message FROM onboarding_items WHERE id = ?').get(item.id) as { stage_status: string; error_message: string };
    expect(updatedRow.stage_status).toBe('failed');
    expect(updatedRow.error_message).toContain('Missing mandatory fields');
  });

  it('should set ProductField1 to new{todaysDate} in MMDDYY format on new product promotion', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo F',
      fileName: 'promo6.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = {
      title: 'New Animal Toy',
      brand: 'ToyCo',
      description: 'Brand new toy.',
      bulletPoints: [],
      primaryImage: 'products/444444444444/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '444444444444',
      name: 'New Animal Toy',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'New Animal Toy',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: 'Toy',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    
    // Format today's date in MMDDYY format
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const expectedField1Value = `new${mm}${dd}${yy}`;
    
    expect(draftProduct.customFields['ProductField1']).toBe(expectedField1Value);
  });
});
