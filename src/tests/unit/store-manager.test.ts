import { randomUUID } from 'node:crypto';
import { unlinkSync, rmSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { writeProductFile, createWorkspaceDirs } from '../../git/workspace-files';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { getLevenshteinDistance, generateProductFieldAuditReport } from '../../server/services/catalog-insight-service';
import {
  generateDeterministicProposals,
  listProposals,
  getProposalById,
  applyProposal,
  dismissProposal,
} from '../../server/services/product-field-refactor-service';
import { getProductWithDraft } from '../../server/services/product-service';
import type { Product } from '../../shared/types';

describe('Store Manager AI Assistant & Cleanup Tool', () => {
  const testDbPath = '/tmp/shopsite-cms-store-manager-test.db';
  const testWorkspacePath = '/tmp/shopsite-cms-store-manager-workspace';
  const workspaceId = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create workspace structure
    createWorkspaceDirs(testWorkspacePath);

    // Insert workspace into DB
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Store Manager Test Store', testWorkspacePath, `${testWorkspacePath}/.git`, now, now, 'complete'],
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(testWorkspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should calculate Levenshtein distance correctly', () => {
    expect(getLevenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(getLevenshteinDistance('cat supplies', 'cat supplies')).toBe(0);
    expect(getLevenshteinDistance('cat supplies', 'cat-supplies')).toBe(1);
    expect(getLevenshteinDistance('brand', 'brandy')).toBe(1);
  });

  it('should audit custom ProductFields and generate deterministic proposals', () => {
    const now = new Date().toISOString();

    // Create products with casing duplicates and typos in ProductField24 (Category)
    // "Cat Supplies" (freq 3), "cat supplies" (freq 1), "Cat Suplies" (freq 1, typo)
    const p1: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-001',
      status: 'active',
      core: { name: 'Cat Toy A', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'a.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: 'Cat Supplies' },
      shopsite: { productId: '1', productGuid: 'g1', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p2: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-002',
      status: 'active',
      core: { name: 'Cat Toy B', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'b.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: 'Cat Supplies' },
      shopsite: { productId: '2', productGuid: 'g2', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p3: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-003',
      status: 'active',
      core: { name: 'Cat Toy C', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'c.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: 'cat supplies' }, // casing duplicate
      shopsite: { productId: '3', productGuid: 'g3', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p4: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-004',
      status: 'active',
      core: { name: 'Cat Toy D', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'd.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: 'Cat Suplies' }, // typo
      shopsite: { productId: '4', productGuid: 'g4', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p5: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-005',
      status: 'active',
      core: { name: 'Cat Toy E', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'e.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: ' Cat Supplies ' }, // leading/trailing whitespace
      shopsite: { productId: '5', productGuid: 'g5', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    const p6: Product = {
      schemaVersion: 1,
      id: randomUUID(),
      sku: 'SKU-999',
      status: 'active',
      core: { name: 'Dog Toy A', price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: 'f.html', searchKeywords: null, googleProductCategory: '' } },
      customFields: { ProductField24: 'Dog Supplies ' }, // trailing whitespace, no casing duplicates
      shopsite: { productId: '6', productGuid: 'g6', xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };

    // Add extra active products with 'Cat Supplies' so that total catalog > 10 (singleton checks)
    // and 'Cat Supplies' frequency becomes high enough (casing / typo consensus rules)
    const extraProducts: Product[] = [];
    for (let i = 6; i <= 15; i++) {
      extraProducts.push({
        schemaVersion: 1,
        id: randomUUID(),
        sku: `SKU-0${i}`,
        status: 'active',
        core: { name: `Cat Toy ${i}`, price: '10.00', salePrice: null, description: 'Toy', inventory: { quantityOnHand: 10, lowStockThreshold: 1, outOfStockLimit: 0 }, availability: 'in-stock', weight: '0.5', taxable: true, media: { primary: null, additional: [] }, seo: { fileName: `${i}.html`, searchKeywords: null, googleProductCategory: '' } },
        customFields: { ProductField24: 'Cat Supplies' },
        shopsite: { productId: String(i), productGuid: `g${i}`, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
        metadata: { createdAt: now, updatedAt: now, archivedAt: null },
      });
    }

    // Write files and insert index rows
    for (const p of [p1, p2, p3, p4, p5, p6, ...extraProducts]) {
      writeProductFile(testWorkspacePath, p);
      insertProductIndex({
        id: p.id,
        sku: p.sku,
        filePath: `${testWorkspacePath}/products/${p.sku}.json`,
        title: p.core.name,
        status: p.status,
        price: p.core.price,
        inventoryQuantity: p.core.inventory.quantityOnHand,
        primaryImage: p.core.media.primary,
        productHash: 'hash',
        lastApprovedCommit: null,
        lastPulledRemoteHash: null,
        lastSyncedRemoteHash: null,
        lastSyncedAt: null,
        syncStatus: 'not_synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: p.core.description,
        searchKeywords: p.core.seo.searchKeywords,
        customFields: p.customFields,
      });
    }

    // 1. Check Audit Report
    const report = generateProductFieldAuditReport(workspaceId, 'ProductField24');
    expect(report.uniqueValueCount).toBe(5); // 'Cat Supplies', 'cat supplies', 'Cat Suplies', ' Cat Supplies ', 'Dog Supplies '
    expect(report.casingDuplicates.length).toBe(1); // 'Cat Supplies' vs 'cat supplies' (trimmed check)
    expect(report.suspiciousValues.length).toBe(4); // ' Cat Supplies ', 'Cat Suplies', 'cat supplies', 'Dog Supplies '

    // 2. Generate Proposals
    const createdProposals = generateDeterministicProposals(workspaceId, 'ProductField24');
    expect(createdProposals.length).toBe(4);

    const casingProp = createdProposals.find(p => p.reason === 'casing normalization');
    expect(casingProp).toBeDefined();
    expect(casingProp?.oldValue).toBe('cat supplies');
    expect(casingProp?.newValue).toBe('Cat Supplies');
    expect(casingProp?.affectedSkus).toEqual(['SKU-003']);

    const trimProp = createdProposals.find(p => p.reason === 'trim whitespace');
    expect(trimProp).toBeDefined();
    expect(trimProp?.oldValue).toBe('Dog Supplies ');
    expect(trimProp?.newValue).toBe('Dog Supplies');
    expect(trimProp?.affectedSkus).toEqual(['SKU-999']);

    // 3. Apply casing normalization proposal
    const result = applyProposal(workspaceId, testWorkspacePath, casingProp!.id);
    expect(result.changeSetId).toBeDefined();

    // Verify the proposal status was updated in DB
    const updatedProp = getProposalById(casingProp!.id);
    expect(updatedProp?.status).toBe('applied');
    expect(updatedProp?.changeSetId).toBe(result.changeSetId);

    // Verify the product draft overlay has the new value
    const productWithDraft = getProductWithDraft(workspaceId, testWorkspacePath, 'SKU-003');
    expect(productWithDraft.draft).toBeDefined();
    expect(productWithDraft.merged?.customFields?.ProductField24).toBe('Cat Supplies');

    // 4. Dismiss trim whitespace proposal
    dismissProposal(trimProp!.id);
    const dismissedProp = getProposalById(trimProp!.id);
    expect(dismissedProp?.status).toBe('dismissed');
  });
});
