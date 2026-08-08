import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { promoteItems } from '../../onboarding/draft-promoter';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { listChangeSets, listChangeSetItems } from '../../db/repositories/change-set-repo';
import { assignProductToPageId } from '../../db/repositories/page-repo';
import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';

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

  function seedAttributeMapping(db: any, attributeId: string, catalogField: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_attribute_mappings
       (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        wsId,
        `map-${attributeId}`,
        attributeId,
        catalogField,
        JSON.stringify({ format: 'direct', separator: ', ', prefix: '', suffix: '' }),
        now,
        now,
      ],
    );
  }

  function seedAcceptedCategoryProposal(db: any, sku: string, pageName: string, runOverride?: string) {
    const runId = runOverride ?? `run-${sku}`;
    const now = new Date().toISOString();
    const item = db.query(
      'SELECT id, curation_data_json FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1',
    ).get(sku) as { id: string; curation_data_json: string | null };
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, wsId, item.id, sku, 'completed', now]
    );
    const curationData = item.curation_data_json ? JSON.parse(item.curation_data_json) : {};
    curationData.classificationRunId = runId;
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(curationData), item.id],
    );

    const pageId = `page-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
    db.run(
      `INSERT OR IGNORE INTO page_index (id, name, file_name, page_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [pageId, pageName, `${pageName.replace(/\s+/g, '-').toLowerCase()}.html`, 'dummy-hash', now, now]
    );

    const proposalId = `prop-${sku}-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [proposalId, runId, sku, 'category_page', pageName, JSON.stringify({ pageId, pageName }), 1.0, 'accepted', now]
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now]
    );
  }

  function seedPromotionReadyItem(batchName: string, sku: string) {
    const batch = createBatch({
      workspaceId: wsId,
      name: batchName,
      fileName: `${sku}.csv`,
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{
      upc: sku,
      name: `Product ${sku}`,
      price: '$9.99',
      brandHint: 'Test Brand',
      rowNumber: 1,
    }]);
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: `Product ${sku}`,
      brand: 'Test Brand',
      description: 'Promotion classification test product.',
      bulletPoints: [],
      primaryImage: `products/${sku}/images/primary.jpg`,
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/${sku}`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const curationData = {
      curatedTitle: `Product ${sku}`,
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO page_index
       (id, name, file_name, page_hash, created_at, updated_at)
       VALUES ('promotion-toys-page', 'Toys', 'toys.html', 'promotion-toys-hash', ?, ?)`,
      [now, now],
    );
    db.run(
      `UPDATE onboarding_items
       SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion',
           stage_status = 'pending', status = 'ready'
       WHERE id = ?`,
      [JSON.stringify(extractionData), JSON.stringify(curationData), item.id],
    );
    return { batch, item, curationData };
  }

  it('should successfully build product drafts and promote them to a change set', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo A',
      fileName: 'promo.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
    });

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

    seedAcceptedCategoryProposal(db, '123456123456', 'Shoes');

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.changeSetId).toBeDefined();

    // Check Change Sets
    const csList = listChangeSets(wsId);
    expect(csList.length).toBe(1);
    expect(csList[0].id).toBe(promoteRes.changeSetId);
    expect(csList[0].title).toContain('Onboarding: Onboard Promo A');

    // Check Change Set Items
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
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

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
    });

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

    seedAcceptedCategoryProposal(db2, '987654321098', 'Dog Food');

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
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

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
    });

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

    seedAcceptedCategoryProposal(db, '888888888888', 'Cat Food');

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
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

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
    });

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

    seedAcceptedCategoryProposal(db, '777777777777', 'Dog Treats');

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
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

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
      sourceUrl: 'https://missing.com/item',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

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

    seedAcceptedCategoryProposal(db, '555555555555', 'Some Page');

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

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
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
    });

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

    seedAcceptedCategoryProposal(db, '444444444444', 'Toys');

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    
    // Format today's date in MMDDYY format
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const expectedField1Value = `new${mm}${dd}${yy}`;
    
    expect(draftProduct.customFields['ProductField1']).toBe(expectedField1Value);
  });

  it('should fail promotion if no accepted category proposals exist', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo Fail',
      fileName: 'promo_fail.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'No Proposals Product',
      brand: 'ToyCo',
      description: 'Brand new toy.',
      bulletPoints: [],
      primaryImage: 'products/333333333333/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy-fail',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '333333333333',
      name: 'No Proposals Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'No Proposals Product',
      titleSource: 'web',
      suggestedPages: [],
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

    const initialCsCount = listChangeSets(wsId).length;

    // We do NOT seed any accepted category proposals here.
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].itemId).toBe(item.id);
    expect(promoteRes.failures[0].error).toContain('No accepted product page proposals or manual page assignments exist');
    expect(promoteRes.changeSetId).toBeNull();

    // Verify no change set was created in the database
    const csList = listChangeSets(wsId);
    expect(csList.length).toBe(initialCsCount);
  });

  it('does not leak accepted category proposals from a historical run', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Historical Proposal Isolation',
      fileName: 'historical-proposal.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [{
      upc: '222222222222',
      name: 'Active Run Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 1,
    }])[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Active Run Product',
      brand: 'ToyCo',
      description: 'A product whose old run must not leak.',
      bulletPoints: [],
      primaryImage: 'products/222222222222/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.example/active-run-product',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' },
    });
    const db = getDb();
    db.run(
      `UPDATE onboarding_items
       SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready'
       WHERE id = ?`,
      [JSON.stringify(extractionData), JSON.stringify({
        curatedTitle: 'Active Run Product',
        titleSource: 'web',
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
      }), item.id],
    );

    // Historical run has an accepted page proposal.
    seedAcceptedCategoryProposal(db, item.upc, 'Toys');

    // The item's current run has no accepted page proposal.
    const activeRunId = `active-run-${item.upc}`;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
      [activeRunId, wsId, item.id, item.upc, now, now],
    );
    const currentCuration = JSON.parse((db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(item.id) as { curation_data_json: string }).curation_data_json);
    currentCuration.classificationRunId = activeRunId;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(currentCuration),
      item.id,
    ]);

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('No accepted product page proposals');
  });

  it('fails promotion when only curationData.suggestedPages exist without accepted proposals or manual DB assignments', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo Fallback',
      fileName: 'promo_fallback.xlsx',
      totalItems: 1
    });

    const db = getDb();
    db.run(
      "INSERT OR IGNORE INTO page_index (id, name, file_name, parent_id, page_hash, last_synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ['toy-page-id', 'Toys', 'toys.html', null, 'hash', null, new Date().toISOString(), new Date().toISOString()]
    );

    const extractionData = {
      title: 'Manual Page Product',
      primaryImage: 'products/999999999999/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy-success',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '999999999999',
      name: 'Manual Page Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 3
    }]);

    const item = items[0];

    const curationData = {
      curatedTitle: 'Manual Page Product',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: 'Toy',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('No accepted product page proposals');
  });

  it('promotes the reviewer-corrected Product Type target rather than prediction metadata', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Corrected Product Type',
      'TYPE-CORRECTED-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-type-corrected';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    db.run(
      `INSERT OR IGNORE INTO page_index (id, name, file_name, page_hash, created_at, updated_at)
       VALUES ('page-toys', 'Toys', 'toys.html', 'dummy-hash', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-type-corrected', ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
      [runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] }), now],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-page-corrected', ?, ?, 'category_page', 'Toys', ?, 1.0, 'accepted', ?)`,
      [runId, item.upc, JSON.stringify({ pageId: 'page-toys', pageName: 'Toys' }), now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, revised_target_id,
        has_revised_target, decision_key, created_at)
       VALUES ('decision-type-corrected', 'proposal-type-corrected', 'accepted', ?,
               'cat-food-wet', 1, 'type-corrected-token', ?)`,
      [JSON.stringify({ productTypeId: 'cat-food-wet' }), now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-page-corrected', 'proposal-page-corrected', 'accepted', 'page-corrected-token', ?)`,
      [now],
    );

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const history = db.query(
      `SELECT event_json FROM classification_history_events
       WHERE product_sku = ? AND event_type = 'promotion'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(item.upc) as { event_json: string };
    expect(JSON.parse(history.event_json).acceptedProductType).toBe('cat-food-wet');
  });

  it('uses the shared Product Type rule for historical one-sided, clear, and conflicting decisions', async () => {
    const scenarios = [
      {
        suffix: 'value-only',
        revisedValueJson: JSON.stringify({ productTypeId: 'cat-food-wet' }),
        revisedTargetId: null,
        hasRevisedTarget: 0,
        expected: 'cat-food-wet',
      },
      {
        suffix: 'target-only',
        revisedValueJson: null,
        revisedTargetId: 'bird-food',
        hasRevisedTarget: 1,
        expected: 'bird-food',
      },
      {
        suffix: 'target-clear',
        revisedValueJson: null,
        revisedTargetId: null,
        hasRevisedTarget: 1,
        expected: null,
      },
      {
        suffix: 'conflicting-pair',
        revisedValueJson: JSON.stringify({ productTypeId: 'cat-food-wet' }),
        revisedTargetId: 'bird-food',
        hasRevisedTarget: 1,
        expected: 'bird-food',
      },
    ] as const;

    for (const scenario of scenarios) {
      const sku = `TYPE-HISTORY-${scenario.suffix.toUpperCase()}`;
      const { batch, item, curationData } = seedPromotionReadyItem(
        `Historical Product Type ${scenario.suffix}`,
        sku,
      );
      const db = getDb();
      const now = new Date().toISOString();
      const runId = `run-type-history-${scenario.suffix}`;
      const proposalId = `proposal-type-history-${scenario.suffix}`;
      db.run(
        `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
         VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
        [runId, wsId, item.id, item.upc, now, now],
      );
      db.run(
        'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
        [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
      );
      db.run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
          confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
        [proposalId, runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] }), now],
      );
      db.run(
        `INSERT OR IGNORE INTO page_index (id, name, file_name, page_hash, created_at, updated_at)
         VALUES ('page-toys', 'Toys', 'toys.html', 'dummy-hash', ?, ?)`,
        [now, now],
      );
      db.run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
          confidence, status, created_at)
         VALUES (?, ?, ?, 'category_page', 'Toys', ?, 1.0, 'accepted', ?)`,
        [`proposal-page-history-${scenario.suffix}`, runId, item.upc, JSON.stringify({ pageId: 'page-toys', pageName: 'Toys' }), now],
      );
      db.run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, revised_value_json, revised_target_id,
          has_revised_target, decision_key, created_at)
         VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?)`,
        [
          `decision-type-history-${scenario.suffix}`,
          proposalId,
          scenario.revisedValueJson,
          scenario.revisedTargetId,
          scenario.hasRevisedTarget,
          `type-history-token-${scenario.suffix}`,
          now,
        ],
      );
      db.run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, decision_key, created_at)
         VALUES (?, ?, 'accepted', ?, ?)`,
        [
          `decision-page-history-${scenario.suffix}`,
          `proposal-page-history-${scenario.suffix}`,
          `page-history-token-${scenario.suffix}`,
          now,
        ],
      );

      const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
      expect(result.failures).toHaveLength(0);
      expect(result.count).toBe(1);
      const history = db.query(
        `SELECT event_json FROM classification_history_events
         WHERE product_sku = ? AND event_type = 'promotion'
         ORDER BY created_at DESC LIMIT 1`,
      ).get(item.upc) as { event_json: string };
      expect(JSON.parse(history.event_json).acceptedProductType).toBe(scenario.expected);
    }
  });

  it('fails promotion when the persisted classification run belongs to another onboarding item', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Foreign Product Type Run',
      'TYPE-FOREIGN-001',
    );
    const [foreignItem] = insertItems(batch.id, [{
      upc: 'TYPE-FOREIGN-HOLDER',
      name: 'Foreign holder',
      rowNumber: 2,
    }]);
    const db = getDb();
    const now = new Date().toISOString();
    seedAcceptedCategoryProposal(db, item.upc, 'Toys');
    assignProductToPageId(item.upc, 'page-toys', 'Toys');
    const runId = 'run-type-foreign';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, foreignItem.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-type-foreign', ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
      [runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry' }), now],
    );

    // A present run pointer that fails ownership validation blocks promotion
    // entirely — it never downgrades to a legacy branch.
    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('Invalid classification run pointer');
  });

  it('resolves brand from product title when brandHint is missing', async () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert cached brand into classification_brands
    db.run(
      `INSERT OR REPLACE INTO classification_brands
       (id, workspace_id, name, aliases_json, created_at, updated_at)
       VALUES ('brand-greenies', ?, 'Greenies', ?, ?, ?)`,
      [wsId, JSON.stringify(['Feline Greenies']), now, now],
    );

    const batch = createBatch({
      workspaceId: wsId,
      name: 'Missing Brand Batch',
      fileName: 'missing-brand.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{
      upc: 'GREENIES-001',
      name: 'FELINE GREENIES TUNA 9.75OZ',
      price: '$12.99',
      brandHint: null,
      rowNumber: 1,
    }]);

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'FELINE GREENIES TUNA 9.75OZ',
      brand: null,
      description: 'Tasty cat treats.',
      bulletPoints: [],
      primaryImage: 'products/GREENIES-001/images/primary.jpg',
      additionalImages: [],
      price: '$12.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
    });

    db.run(
      'UPDATE onboarding_items SET stage = ?, stage_status = ?, extraction_data_json = ? WHERE id = ?',
      ['review', 'completed', JSON.stringify(extractionData), item.id],
    );

    seedAcceptedCategoryProposal(db, item.upc, 'Cat Treats');

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);

    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };

    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields.ProductField16).toBe('Greenies');
  });

  it('applies nothing when an active run has only deferred proposals', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Deferred Only',
      'DEFERRED-ONLY-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-deferred-only';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Deferred field proposal with a live deferred decision — never promoted.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-deferred-field', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'deferred', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-deferred-field', 'prop-deferred-field', 'deferred', 'deferred-token', ?)`,
      [now],
    );
    // Accepted page proposal with a live accepted decision.
    seedAcceptedCategoryProposal(db, item.upc, 'Dog Food', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    // The AI-suggested deferred field value must not be serialized.
    expect(draft.customFields['ProductField23']).toBeUndefined();
  });

  it('serializes only accepted proposals when an active run mixes accepted and deferred', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Mixed Decisions',
      'MIXED-DEC-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-mixed-dec';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Deferred flavor proposal.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-mixed-deferred', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'deferred', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-mixed-deferred', 'prop-mixed-deferred', 'deferred', 'mixed-deferred-token', ?)`,
      [now],
    );
    // Accepted flavor proposal with revised value.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-mixed-accepted', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'accepted', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, decision_key, created_at)
       VALUES ('decision-mixed-accepted', 'prop-mixed-accepted', 'accepted', '"Salmon"', 'mixed-accepted-token', ?)`,
      [now],
    );
    seedAcceptedCategoryProposal(db, item.upc, 'Cat Food', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBe('Salmon');
  });

  it('excludes an accepted-status proposal without a live accepted decision', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Spoofed Accepted',
      'SPOOF-ACC-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-spoof-accepted';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Proposal status says accepted but no decision row exists (spoofed).
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-spoof', ?, ?, 'field_assignment', 'flavor', '"Spoof"', 0.9, 'accepted', ?)`,
      [runId, item.upc, now],
    );
    // The page proposal is a genuine accepted decision so the rest of the draft proceeds.
    seedAcceptedCategoryProposal(db, item.upc, 'Dog Treats', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBeUndefined();
  });

  it('promotes legacy embedded proposals only when status is exactly accepted', async () => {
    const { batch, item } = seedPromotionReadyItem(
      'Legacy Embedded',
      'LEGACY-EMB-001',
    );
    const db = getDb();
    // No classificationRunId — a genuine legacy item. Embedded proposals in the
    // curation JSON are the only classification input.
    const legacyProposals = [
      {
        id: 'legacy-acc',
        proposalType: 'field_assignment',
        targetId: 'flavor',
        proposedValue: 'Beef',
        status: 'accepted',
      },
      {
        id: 'legacy-pending',
        proposalType: 'field_assignment',
        targetId: 'species',
        proposedValue: 'Dog',
        status: 'pending',
      },
      {
        id: 'legacy-rejected',
        proposalType: 'field_assignment',
        targetId: 'life_stage',
        proposedValue: 'Puppy',
        status: 'rejected',
      },
      {
        id: 'legacy-stale',
        proposalType: 'field_assignment',
        targetId: 'food_form',
        proposedValue: 'Kibble',
        status: 'stale',
      },
      {
        id: 'legacy-deferred',
        proposalType: 'field_assignment',
        targetId: 'health_benefits',
        proposedValue: 'Joint',
        status: 'deferred',
      },
      {
        id: 'legacy-page',
        proposalType: 'category_page',
        targetId: 'Toys',
        proposedValue: { pageId: 'page-toys', pageName: 'Toys' },
        status: 'accepted',
      },
    ];
    const curation = db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(item.id) as { curation_data_json: string };
    const parsed = JSON.parse(curation.curation_data_json);
    parsed.classificationProposals = legacyProposals;
    parsed.classificationRunId = null;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(parsed),
      item.id,
    ]);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBe('Beef');
    // None of the pending/rejected/stale/deferred embedded proposals may appear.
    expect(draft.customFields['ProductField17']).toBeUndefined();
    expect(draft.customFields['ProductField18']).toBeUndefined();
    expect(draft.customFields['ProductField22']).toBeUndefined();
    expect(draft.customFields['ProductField21']).toBeUndefined();
  });

  it('promotes an accepted category page proposal whose identity is verified in the ACTIVE import', async () => {
    // Create an ACTIVE verified import so verifiedPageIds is non-empty.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: 'a'.repeat(64),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key: 'vf', status: 'verified' }, name: 'Verified Food', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });
    const verifiedRows = listVerifiedPageOptions(wsId);
    const verifiedFood = verifiedRows.find(r => r.name === 'Verified Food');
    expect(verifiedFood).toBeDefined();

    const batch = createBatch({ workspaceId: wsId, name: 'Verified Pages', fileName: 'vp.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000001', name: 'Verified Product', price: '$5.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Verified Product',
      brand: 'Test Brand',
      description: 'Promotion verified-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000001/images/primary.jpg',
      additionalImages: [],
      price: '$5.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000001`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Verified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    // Seed a run + accepted category_page proposal referencing the REAL
    // verified page_index row id and the display name.
    const runId = 'run-verified-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Verified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-verified-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      [proposalId, runId, item.upc, verifiedFood!.id, JSON.stringify({ pageId: verifiedFood!.id, pageName: 'Verified Food' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    // The verified page must be serialized into ProductOnPages.
    expect(draft.shopsite.preserved.unknownElements.ProductOnPages).toContain('Verified Food');
  });

  it('skips (non-blocking) an accepted page proposal whose identity is NOT in the active import', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Unverified Pages', fileName: 'up.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000002', name: 'Unverified Product', price: '$6.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Unverified Product',
      brand: 'Test Brand',
      description: 'Promotion unverified-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000002/images/primary.jpg',
      additionalImages: [],
      price: '$6.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000002`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Unverified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    const runId = 'run-unverified-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Unverified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-unverified-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      // pageId 'bogus-not-in-import' is not among the active import's verified rows.
      [proposalId, runId, item.upc, 'bogus-not-in-import', JSON.stringify({ pageId: 'bogus-not-in-import', pageName: 'Bogus Page' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    // Unverified page identity is a visible, non-blocking skip.
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    const pagesXml = draft.shopsite?.preserved?.unknownElements?.ProductOnPages;
    // Bogus page must never be serialized into ProductOnPages.
    expect(pagesXml ?? '').not.toContain('Bogus Page');
  });

  it('skips (non-blocking) a verified page whose proposal has no display name — never serializes the Page ID as a name', async () => {
    // Build a verified page in the active import, then seed an accepted
    // category_page proposal whose value carries only the stable Page ID
    // (no pageName). The Page ID must never be serialized as a page name.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: 'a'.repeat(64),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key: 'nameless-1', status: 'verified' },
        name: 'Nameless Page',
        parentRef: null,
        availability: 'available',
      }],
      activatedBy: 'test',
    });
    const verifiedRows = listVerifiedPageOptions(wsId);
    const verifiedNameless = verifiedRows.find(r => r.name === 'Nameless Page');
    expect(verifiedNameless).toBeDefined();

    const batch = createBatch({ workspaceId: wsId, name: 'Nameless Pages', fileName: 'np.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000003', name: 'Nameless Product', price: '$7.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Nameless Product',
      brand: 'Test Brand',
      description: 'Promotion nameless-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000003/images/primary.jpg',
      additionalImages: [],
      price: '$7.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000003`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Nameless Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    const runId = 'run-nameless-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Nameless Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-nameless-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      // targetId is the stable Page ID; proposedValue lacks pageName on purpose.
      [proposalId, runId, item.upc, verifiedNameless!.id, JSON.stringify({ pageId: verifiedNameless!.id }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

    const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    // A nameless verified page is a visible, non-blocking skip.
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    const pagesXml = draft.shopsite?.preserved?.unknownElements?.ProductOnPages;
    // The Page ID must never be serialized as a page name.
    expect(pagesXml ?? '').not.toContain(verifiedNameless!.id);
    // And without a display name no page content is written at all.
    expect(pagesXml ?? '').toBe('');
  });
});
