import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createBatch,
  findBatchById,
  setBatchArchived,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  listItemsByBatchStaged,
  findItemById,
  updateItemStageStatus,
  advanceItemsToNextStage,
  getPendingItemsByStage,
  getStageCounts,
  skipItems,
  resetItemsToPending,
  completeReviewStage,
  completePromotionStage,
  setDiscoverySourceUrl,
  sendItemsToPreviousStage,
} from '../../db/repositories/onboarding-item-repo';
import {
  insertSources,
  listSourcesByItem,
  selectSource,
  getSelectedSource,
  listValidationSamplesByDomain,
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
  findBrandSites,
  updateBrandSiteDomain
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
    expect(batch.status).toBe('active');

    const items = insertItems(batch.id, [
      { upc: '111111111111', name: 'Product 1', price: '9.99', rowNumber: 2 },
      { upc: '222222222222', name: 'Product 2', price: '19.99', rowNumber: 3 }
    ]);

    expect(items.length).toBe(2);
    expect(items[0].upc).toBe('111111111111');
    // New items start in discovery stage with pending status
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');

    const batchItems = listItemsByBatch(batch.id);
    expect(batchItems.length).toBe(2);

    // Use new stage-based status updates
    updateItemStageStatus(items[0].id, 'in_progress');
    const updatedItem = findItemById(items[0].id);
    expect(updatedItem?.stageStatus).toBe('in_progress');
    expect(updatedItem?.stage).toBe('discovery');

    const batchDetails = findBatchById(batch.id);
    expect(batchDetails).toBeDefined();

    // Batch lifecycle is now active/archived only
    setBatchArchived(batch.id, true);
    const archivedBatch = findBatchById(batch.id);
    expect(archivedBatch?.status).toBe('archived');
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

  it('should implement stage-based listing (listItemsByBatchStaged)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Stage Batch', fileName: 'stage.xlsx', totalItems: 3 });
    const items = insertItems(batch.id, [
      { upc: '555555555555', name: 'Stage A', rowNumber: 1 },
      { upc: '666666666666', name: 'Stage B', rowNumber: 2 },
      { upc: '777777777777', name: 'Stage C', rowNumber: 3 },
    ]);

    // Try to advance item B to extraction — should be skipped (not completed yet)
    const r1 = advanceItemsToNextStage([items[1].id]);
    expect(r1.advanced).toBe(0);
    expect(r1.skipped).toBe(1);

    const staged = listItemsByBatchStaged(batch.id);
    expect(staged.discovery.length).toBe(3); // All still in discovery since none advanced
    expect(staged.extraction.length).toBe(0);

    // Now mark item A as completed and advance it
    updateItemStageStatus(items[0].id, 'completed');
    const r2 = advanceItemsToNextStage([items[0].id]);
    expect(r2.advanced).toBe(1);
    const staged2 = listItemsByBatchStaged(batch.id);
    expect(staged2.discovery.length).toBe(2); // B and C still in discovery
    expect(staged2.extraction.length).toBe(1); // A advanced to extraction with pending
    expect(staged2.extraction[0].id).toBe(items[0].id);
    expect(staged2.extraction[0].stageStatus).toBe('pending');
    expect(staged2.curation.length).toBe(0);
    expect(staged2.review.length).toBe(0);
    expect(staged2.promotion.length).toBe(0);
  });

  it('should enforce advancement eligibility (only completed items advance)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Advance Test', fileName: 'advance.xlsx', totalItems: 2 });
    const items = insertItems(batch.id, [
      { upc: '888888888888', name: 'Advance A', rowNumber: 1 },
      { upc: '999999999999', name: 'Advance B', rowNumber: 2 },
    ]);

    // Both start at discovery/pending — neither is completed, so advance should skip both
    const result = advanceItemsToNextStage(items.map(i => i.id));
    expect(result.advanced).toBe(0);
    expect(result.skipped).toBe(2);

    // Complete item A, then advance should move only it
    updateItemStageStatus(items[0].id, 'completed');
    const result2 = advanceItemsToNextStage(items.map(i => i.id));
    expect(result2.advanced).toBe(1);
    expect(result2.skipped).toBe(1);

    const a = findItemById(items[0].id);
    expect(a?.stage).toBe('extraction');
    expect(a?.stageStatus).toBe('pending');

    const b = findItemById(items[1].id);
    expect(b?.stage).toBe('discovery');
    expect(b?.stageStatus).toBe('pending');
  });

  it('should prevent advancement from curation to review if there are pending AI proposals', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Proposal Test', fileName: 'proposal.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '123456789012', name: 'Proposal Product', rowNumber: 1 },
    ]);
    const item = items[0];

    const curationData = {
      curatedTitle: 'Proposal Product',
      curatedWeight: '12 oz',
      suggestedPages: ['Test Page'],
      classificationProposals: [
        {
          id: 'proposal-1',
          runId: 'run-1',
          productSku: '123456789012',
          proposalType: 'field_assignment',
          targetId: 'brand',
          proposedValue: 'My Brand',
          confidence: 0.9,
          evidenceIds: [],
          status: 'pending',
          createdAt: new Date().toISOString(),
        }
      ],
      classificationEvidence: [],
    };

    const db = getDb();
    db.query(
      "UPDATE onboarding_items SET stage = 'curation', stage_status = 'completed', curation_data_json = ? WHERE id = ?"
    ).run(JSON.stringify(curationData), item.id);

    // Try to advance — should be skipped due to pending proposal
    const res1 = advanceItemsToNextStage([item.id]);
    expect(res1.advanced).toBe(0);
    expect(res1.skipped).toBe(1);

    // Mark proposal as accepted and try again
    curationData.classificationProposals[0].status = 'accepted';
    db.query(
      "UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?"
    ).run(JSON.stringify(curationData), item.id);

    const res2 = advanceItemsToNextStage([item.id]);
    expect(res2.advanced).toBe(1);
    expect(res2.skipped).toBe(0);

    const advancedItem = findItemById(item.id);
    expect(advancedItem?.stage).toBe('review');
    expect(advancedItem?.stageStatus).toBe('pending');
  });

  it('should implement skip and reset operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Skip Test', fileName: 'skip.xlsx', totalItems: 2 });
    const items = insertItems(batch.id, [
      { upc: '111111111112', name: 'Skip A', rowNumber: 1 },
      { upc: '222222222223', name: 'Skip B', rowNumber: 2 },
    ]);

    skipItems([items[0].id]);
    const a = findItemById(items[0].id);
    expect(a?.stageStatus).toBe('skipped');

    // Reset the skipped item
    resetItemsToPending([items[0].id]);
    const a2 = findItemById(items[0].id);
    expect(a2?.stageStatus).toBe('pending');
    expect(a2?.errorMessage).toBeNull();
  });

  it('should report correct stage counts', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Counts Test', fileName: 'counts.xlsx', totalItems: 4 });
    insertItems(batch.id, [
      { upc: '111111111113', name: 'Count A', rowNumber: 1 },
      { upc: '222222222224', name: 'Count B', rowNumber: 2 },
      { upc: '333333333335', name: 'Count C', rowNumber: 3 },
      { upc: '444444444446', name: 'Count D', rowNumber: 4 },
    ]);

    const counts = getStageCounts(batch.id);
    expect(counts.discovery).toBe(4);
    expect(counts.extraction).toBe(0);
    expect(counts.curation).toBe(0);
    expect(counts.review).toBe(0);
    expect(counts.promotion).toBe(0);
  });

  it('should support getPendingItemsByStage with workspace filtering', () => {
    const pendingWsId = 'ws-pending-test-' + Date.now();
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [pendingWsId, 'Pending Test WS', '/tmp/pending-ws', '/tmp/pending-ws/.git', now, now, 'complete']
    );

    const batch = createBatch({ workspaceId: pendingWsId, name: 'Pending Test', fileName: 'pending.xlsx', totalItems: 2 });
    insertItems(batch.id, [
      { upc: '555555555556', name: 'Pending A', rowNumber: 1 },
      { upc: '666666666667', name: 'Pending B', rowNumber: 2 },
    ]);

    // Items are discovery/pending by default
    const pending = getPendingItemsByStage('discovery', 10, pendingWsId);
    expect(pending.length).toBe(2);
    expect(pending[0].stage).toBe('discovery');
    expect(pending[0].stageStatus).toBe('pending');

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
    db.run('DELETE FROM workspace WHERE id = ?', [pendingWsId]);
  });

  it('should support completeReviewStage and completePromotionStage', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Completion Test', fileName: 'complete.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '777777777778', name: 'Complete A', rowNumber: 1 },
    ]);
    const item = items[0];

    // Manually advance through stages (bypass eligibility for test simplicity)
    const db = getDb();
    db.query("UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);

    // Complete review
    completeReviewStage(item.id);
    const reviewed = findItemById(item.id);
    expect(reviewed?.stage).toBe('review');
    expect(reviewed?.stageStatus).toBe('completed');

    // Advance to promotion
    advanceItemsToNextStage([item.id]);

    // Complete promotion
    completePromotionStage(item.id, true);
    const promoted = findItemById(item.id);
    expect(promoted?.stage).toBe('promotion');
    expect(promoted?.stageStatus).toBe('completed');
  });

  it('should support setDiscoverySourceUrl', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Source URL Test', fileName: 'source.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '888888888889', name: 'Source A', rowNumber: 1 },
    ]);
    const item = items[0];

    setDiscoverySourceUrl(item.id, 'https://example.com/product');
    const updated = findItemById(item.id);
    expect(updated?.sourceUrl).toBe('https://example.com/product');
    expect(updated?.stageStatus).toBe('completed');
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
    
    let brandMatches = findBrandSites('Nike');
    expect(brandMatches.length).toBe(1);
    expect(brandMatches[0].domain).toBe('nike.com');

    // Test updating brand domain
    updateBrandSiteDomain('Nike', 'nike-new.com');
    brandMatches = findBrandSites('Nike');
    expect(brandMatches.length).toBe(1);
    expect(brandMatches[0].domain).toBe('nike-new.com');
  });

  it('should support sendItemsToPreviousStage and undo results appropriately per stage', () => {
    const db = getDb();
    const batch = createBatch({ workspaceId: wsId, name: 'Previous Stage Test', fileName: 'prev.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '999999999999', name: 'Previous Test A', rowNumber: 1 },
    ]);
    const item = items[0];

    // --- 1. Test going back from extraction to discovery ---
    db.query("UPDATE onboarding_items SET stage = 'extraction', stage_status = 'pending', extraction_data_json = ? WHERE id = ?").run(
      JSON.stringify({ title: 'Extracted' }),
      item.id
    );
    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://example.com/source',
      extractionDataJson: JSON.stringify({ title: 'Extracted' }),
      extractionMethod: 'test',
      confidence: 1.0,
    });

    const res1 = sendItemsToPreviousStage([item.id]);
    expect(res1.moved).toBe(1);

    const afterRes1 = findItemById(item.id);
    expect(afterRes1?.stage).toBe('discovery');
    expect(afterRes1?.stageStatus).toBe('completed');
    expect(afterRes1?.extractionData).toBeNull();
    expect(afterRes1?.status).toBe('source_confirmed');
    expect(getLatestExtraction(item.id)).toBeFalsy();

    // --- 2. Test going back from curation to extraction ---
    db.query("UPDATE onboarding_items SET stage = 'curation', stage_status = 'pending', curation_data_json = ? WHERE id = ?").run(
      JSON.stringify({ curatedTitle: 'Curated' }),
      item.id
    );

    const res2 = sendItemsToPreviousStage([item.id]);
    expect(res2.moved).toBe(1);

    const afterRes2 = findItemById(item.id);
    expect(afterRes2?.stage).toBe('extraction');
    expect(afterRes2?.stageStatus).toBe('completed');
    expect(afterRes2?.curationData).toBeNull();

    // --- 3. Test going back from review to curation ---
    db.query("UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);
    
    // Simulate classification run, proposals, decisions
    const runId = 'test-run-id';
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, new Date().toISOString()]
    );
    const proposalId = 'test-prop-id';
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'attr-id', '"val"', 1.0, 'accepted', 1, 0, ?)`,
      [proposalId, runId, item.upc, new Date().toISOString()]
    );
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
       VALUES (?, ?, 'accepted', ?)`,
      ['dec-id', proposalId, new Date().toISOString()]
    );

    const res3 = sendItemsToPreviousStage([item.id]);
    expect(res3.moved).toBe(1);

    const afterRes3 = findItemById(item.id);
    expect(afterRes3?.stage).toBe('curation');
    expect(afterRes3?.stageStatus).toBe('completed');
    expect(afterRes3?.status).toBe('curated');

    // Verify proposals status reverted to pending and decisions deleted
    const prop = db.query('SELECT status FROM classification_proposals WHERE id = ?').get(proposalId) as { status: string };
    expect(prop.status).toBe('pending');
    const decCount = db.query('SELECT COUNT(*) as count FROM classification_proposal_decisions WHERE proposal_id = ?').get(proposalId) as { count: number };
    expect(decCount.count).toBe(0);

    // --- 4. Test going back from promotion to review ---
    db.query("UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);
    
    // Simulate draft change set and change set items, and product page assignment
    const changeSetId = 'test-cs-id';
    db.run(
      `INSERT INTO change_sets (id, workspace_id, title, status, base_commit, created_at, updated_at)
       VALUES (?, ?, 'Test CS', 'draft', 'base', ?, ?)`,
      [changeSetId, wsId, new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, draft_hash, validation_status, created_at, updated_at)
       VALUES (?, ?, ?, 'create', '{}', 'hash', 'unknown', ?, ?)`,
      ['cs-item-id', changeSetId, item.upc, new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO product_pages (product_sku, page_name, created_at)
       VALUES (?, 'page-name', ?)`,
      [item.upc, new Date().toISOString()]
    );

    const res4 = sendItemsToPreviousStage([item.id]);
    expect(res4.moved).toBe(1);

    const afterRes4 = findItemById(item.id);
    expect(afterRes4?.stage).toBe('review');
    expect(afterRes4?.stageStatus).toBe('completed');
    expect(afterRes4?.status).toBe('ready');

    // Verify change set item deleted and pages cleared
    const csItemCount = db.query('SELECT COUNT(*) as count FROM change_set_items WHERE change_set_id = ?').get(changeSetId) as { count: number };
    expect(csItemCount.count).toBe(0);
    const pagesCount = db.query('SELECT COUNT(*) as count FROM product_pages WHERE product_sku = ?').get(item.upc) as { count: number };
    expect(pagesCount.count).toBe(0);

    // Clean up
    db.run('DELETE FROM product_pages WHERE product_sku = ?', [item.upc]);
    db.run('DELETE FROM change_set_items WHERE change_set_id = ?', [changeSetId]);
    db.run('DELETE FROM change_sets WHERE id = ?', [changeSetId]);
    db.run('DELETE FROM classification_proposals WHERE run_id = ?', [runId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
  });
});

describe('listValidationSamplesByDomain (Phase 3, task 16)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'onboarding-validation-samples-test.db');
  const wsId = 'workspace-validation-samples-test-id';

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
      [wsId, 'Test Workspace', '/tmp/ws-validation', '/tmp/ws-validation/.git', now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('returns no rows for an unknown domain', () => {
    const samples = listValidationSamplesByDomain('nonexistent-domain-xyz.com');
    expect(samples).toEqual([]);
  });

  it('returns URL + expected name + brand hint for matching items', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Sample Test Batch',
      fileName: 'sample.xlsx',
      totalItems: 2,
    });
    const items = insertItems(batch.id, [
      { upc: '111', name: 'Test Product A', rowNumber: 1 },
      { upc: '222', name: 'Test Product B', rowNumber: 2 },
    ]);
    const sourcesA = insertSources(items[0].id, [
      { url: 'https://acmepet.com/a', domain: 'acmepet.com', title: 'A title', confidence: 0.9 },
    ]);
    const sourcesB = insertSources(items[1].id, [
      { url: 'https://acmepet.com/b', domain: 'acmepet.com', title: 'B title', confidence: 0.8 },
    ]);
    // Policy: only selected/confirmed sources. Both must be selected for this test.
    selectSource(sourcesA[0].id);
    selectSource(sourcesB[0].id);
    const samples = listValidationSamplesByDomain('acmepet.com', 10);
    expect(samples.length).toBe(2);
    const urls = samples.map((s) => s.url).sort();
    expect(urls).toEqual(['https://acmepet.com/a', 'https://acmepet.com/b']);
    // expectedName falls back to the parent item's name when no
    // expected_name column is set (Phase 3 task 14 policy).
    expect(samples.find((s) => s.url === 'https://acmepet.com/a')?.expectedName).toBe('Test Product A');
    expect(samples.find((s) => s.url === 'https://acmepet.com/b')?.expectedName).toBe('Test Product B');
  });

  it('prefers is_selected sources first, then by confidence', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Sort Test Batch',
      fileName: 'sort.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '333', name: 'Sort Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://sort-test.com/low', domain: 'sort-test.com', title: 'low', confidence: 0.3 },
      { url: 'https://sort-test.com/high', domain: 'sort-test.com', title: 'high', confidence: 0.9 },
    ]);
    // Select the high-confidence one; it should be returned first.
    selectSource(sources[1].id);
    const samples = listValidationSamplesByDomain('sort-test.com', 10);
    expect(samples.length).toBe(1);
    expect(samples[0].url).toBe('https://sort-test.com/high');
  });

  it('respects the limit parameter', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Limit Test Batch',
      fileName: 'limit.xlsx',
      totalItems: 3,
    });
    const items = insertItems(batch.id, [
      { upc: '444-a', name: 'Limit A', rowNumber: 1 },
      { upc: '444-b', name: 'Limit B', rowNumber: 2 },
      { upc: '444-c', name: 'Limit C', rowNumber: 3 },
    ]);
    // Each source belongs to a different item so that selectSource
    // can mark each one as is_selected independently. A single item
    // only has one is_selected source at a time.
    const sourcesA = insertSources(items[0].id, [
      { url: 'https://limit-test.com/a', domain: 'limit-test.com', confidence: 0.1 },
    ]);
    const sourcesB = insertSources(items[1].id, [
      { url: 'https://limit-test.com/b', domain: 'limit-test.com', confidence: 0.2 },
    ]);
    const sourcesC = insertSources(items[2].id, [
      { url: 'https://limit-test.com/c', domain: 'limit-test.com', confidence: 0.3 },
    ]);
    selectSource(sourcesA[0].id);
    selectSource(sourcesB[0].id);
    selectSource(sourcesC[0].id);
    const samples = listValidationSamplesByDomain('limit-test.com', 2);
    expect(samples.length).toBe(2);
  });

  it('matches subdomains of the requested domain', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Subdomain Batch',
      fileName: 'sub.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '555', name: 'Sub Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://shop.subbrand.com/x', domain: 'shop.subbrand.com', confidence: 0.5 },
    ]);
    selectSource(sources[0].id);
    const samples = listValidationSamplesByDomain('subbrand.com');
    expect(samples.length).toBe(1);
    expect(samples[0].url).toBe('https://shop.subbrand.com/x');
  });

  it('excludes sources from unrelated domains (notmywoof.com vs mywoof.com)', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Negative Match Batch',
      fileName: 'neg.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '666', name: 'Negative Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://notmywoof.com/x', domain: 'notmywoof.com', confidence: 0.9 },
    ]);
    selectSource(sources[0].id);
    const samples = listValidationSamplesByDomain('mywoof.com');
    expect(samples.length).toBe(0);
  });
});
