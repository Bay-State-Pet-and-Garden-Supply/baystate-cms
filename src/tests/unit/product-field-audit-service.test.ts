import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import {
  getProductFieldAudit,
  boundProductFieldAuditForTransport,
  boundNormalizationProposalResultForTransport,
  proposeProductFieldNormalization,
  validateFieldName,
} from '../../server/services/product-field-audit-service';

describe('ProductField Audit Service', () => {
  const testDbPath = './test-audit.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    if (existsSync(testDbPath)) {
      try { unlinkSync(testDbPath); } catch { /* ok */ }
    }
  });

  it('should reject unsafe field names', () => {
    expect(() => getProductFieldAudit('ProductField')).toThrow();
    expect(() => getProductFieldAudit('customField24')).toThrow();
    expect(() => getProductFieldAudit('ProductFieldABC')).toThrow();
    expect(() => getProductFieldAudit('ProductField24; DROP TABLE products;')).toThrow();
  });

  it('should perform a complete audit of unique, missing, casing, whitespace, and separator values', () => {
    const now = new Date().toISOString();

    // Reset/clear any product index data if needed, but since it is a fresh DB, it is empty.

    // 1. Setup mock products
    // - SKU1: "Dog Food" (active)
    // - SKU2: "dog food" (active) -> Case duplicate of SKU1
    // - SKU3: " Dog Food" (active) -> Whitespace duplicate
    // - SKU4: "Dog - Food" (active) -> Separator duplicate
    // - SKU5: "Cat Toys" (active)
    // - SKU6: "" (active) -> Empty
    // - SKU7: null (active) -> Missing
    // - SKU8: "Bird Seeds" (archived) -> should be ignored since not active

    const productsMock = [
      { sku: 'SKU1', status: 'active', fieldVal: 'Dog Food' },
      { sku: 'SKU2', status: 'active', fieldVal: 'dog food' },
      { sku: 'SKU3', status: 'active', fieldVal: ' Dog Food' },
      { sku: 'SKU4', status: 'active', fieldVal: 'Dog - Food' },
      { sku: 'SKU5', status: 'active', fieldVal: 'Cat Toys' },
      { sku: 'SKU6', status: 'active', fieldVal: '' },
      { sku: 'SKU7', status: 'active', fieldVal: null },
      { sku: 'SKU8', status: 'archived', fieldVal: 'Bird Seeds' },
    ];

    for (const mock of productsMock) {
      insertProductIndex({
        id: randomUUID(),
        sku: mock.sku,
        filePath: `products/${mock.sku}.json`,
        title: `Product ${mock.sku}`,
        status: mock.status,
        price: '10.00',
        inventoryQuantity: 10,
        primaryImage: null,
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
        customFields: mock.fieldVal !== null ? { ProductField24: mock.fieldVal } : {},
      });
    }

    // Run audit
    const audit = getProductFieldAudit('ProductField24');

    expect(audit.field).toBe('ProductField24');
    expect(audit.totalProductsScanned).toBe(7); // SKU1-SKU7 are active
    expect(audit.missingCount).toBe(2); // SKU6 (empty string) and SKU7 (missing key)
    expect(audit.uniqueValueCount).toBe(5); // "Dog Food", "dog food", " Dog Food", "Dog - Food", "Cat Toys"

    // Check duplicate groups
    // Case duplicates should include "Dog Food" and "dog food"
    const caseGroup = audit.duplicateGroups.find(g => g.type === 'case');
    expect(caseGroup).toBeDefined();
    expect(caseGroup?.values.map(v => v.value)).toContain('Dog Food');
    expect(caseGroup?.values.map(v => v.value)).toContain('dog food');

    // Whitespace duplicates should include " Dog Food"
    const wsGroup = audit.duplicateGroups.find(g => g.type === 'whitespace');
    expect(wsGroup).toBeDefined();
    expect(wsGroup?.values.map(v => v.value)).toContain(' Dog Food');

    // Separator duplicates should include "Dog - Food" and its space-separated counter-parts
    const sepGroup = audit.duplicateGroups.find(g => g.type === 'separator');
    expect(sepGroup).toBeDefined();
    expect(sepGroup?.values.map(v => v.value)).toContain('Dog - Food');

    // Check suspicious groups
    const wsSuspicious = audit.suspiciousGroups.find(s => s.value === ' Dog Food');
    expect(wsSuspicious).toBeDefined();
    expect(wsSuspicious?.reasons).toContain('Leading or trailing whitespace');

    // Verify new total count fields
    expect(audit.totalDuplicateGroupCount).toBeGreaterThanOrEqual(audit.duplicateGroups.length);
    expect(audit.totalSuspiciousGroupCount).toBeGreaterThanOrEqual(audit.suspiciousGroups.length);
    // With this small dataset, counts should match (no truncation)
    expect(audit.totalDuplicateGroupCount).toBe(audit.duplicateGroups.length);
    expect(audit.totalSuspiciousGroupCount).toBe(audit.suspiciousGroups.length);
  });

  it('should generate proposals correctly based on strategies', () => {
    // 1. Case only proposals
    const caseProposals = proposeProductFieldNormalization('ProductField24', 'case_only');
    expect(caseProposals.proposals.length).toBeGreaterThanOrEqual(1);
    const casingProp = caseProposals.proposals[0];
    expect(casingProp.reason).toContain('casing normalization');
    expect(casingProp.safeAutoApply).toBe(true);
    expect(casingProp.id).toBeDefined();

    // 2. Trim whitespace proposals
    const trimProposals = proposeProductFieldNormalization('ProductField24', 'trim_whitespace');
    expect(trimProposals.proposals.length).toBe(1);
    const trimProp = trimProposals.proposals[0];
    expect(trimProp.oldValue).toBe(' Dog Food');
    expect(trimProp.newValue).toBe('Dog Food');
    expect(trimProp.safeAutoApply).toBe(true);

    // 3. Separator cleanup proposals (unsafe, safeAutoApply: false)
    const sepProposals = proposeProductFieldNormalization('ProductField24', 'separator_cleanup');
    expect(sepProposals.proposals.length).toBeGreaterThanOrEqual(1);
    const sepProp = sepProposals.proposals.find(p => p.oldValue === 'Dog - Food');
    expect(sepProp).toBeDefined();
    expect(sepProp?.safeAutoApply).toBe(false); // Should not auto-apply separator cleanups

    // 4. Safe duplicates combining case and trim
    const safeProposals = proposeProductFieldNormalization('ProductField24', 'safe_duplicates');
    expect(safeProposals.proposals.every(p => p.safeAutoApply)).toBe(true);
    expect(safeProposals.proposals.map(p => p.oldValue)).toContain(' Dog Food');
  });

  it('hard-bounds a single oversized multibyte normalization proposal while preserving counts', () => {
    const huge = '配送'.repeat(20_000);
    const bounded = boundNormalizationProposalResultForTransport({
      field: 'ProductField99',
      proposalCount: 1,
      affectedProductCount: 7,
      proposals: [{
        id: 'oversized',
        field: 'ProductField99',
        oldValue: huge,
        newValue: huge,
        affectedSkus: ['SKU-1'],
        affectedCount: 7,
        reason: huge,
        confidence: 0.9,
        safeAutoApply: false,
      }],
    });

    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(28 * 1024);
    expect(bounded.proposalCount).toBe(1);
    expect(bounded.affectedProductCount).toBe(7);
    expect(bounded.proposals).toEqual([]);
    expect(bounded.transportTruncated).toBe(true);
  });

  it('should cap groups and keep result under the byte budget for large datasets', () => {
    const now = new Date().toISOString();
    // Insert 500 unique singleton values into a different field to avoid
    // polluting ProductField24 used by other tests.
    for (let i = 0; i < 500; i++) {
      insertProductIndex({
        id: randomUUID(),
        sku: `BYTE-BUDGET-${i}`,
        filePath: `products/BYTE-BUDGET-${i}.json`,
        title: `Byte Budget Product ${i}`,
        status: 'active',
        price: '1.00',
        inventoryQuantity: 1,
        primaryImage: null,
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
        customFields: { ProductField99: `UniqueTestBrand_${i}_${'x'.repeat(30)}` },
      });
    }

    const fullAudit = getProductFieldAudit('ProductField99', 100);
    const audit = boundProductFieldAuditForTransport(fullAudit);

    // Transport serialization stays under the 28 KB UTF-8 byte budget; the
    // service-level audit remains complete for normalization computation.
    const serializedSize = Buffer.byteLength(JSON.stringify(audit), 'utf8');
    expect(serializedSize).toBeLessThanOrEqual(28 * 1024);

    // Total counts reflect the uncapped totals
    expect(fullAudit.totalSuspiciousGroupCount).toBeGreaterThanOrEqual(500);
    expect(fullAudit.suspiciousGroups.length).toBe(100);
    expect(audit.totalSuspiciousGroupCount).toBe(fullAudit.totalSuspiciousGroupCount);
    // Suspicious groups array should be capped (at most 100 = limit)
    expect(audit.suspiciousGroups.length).toBeLessThanOrEqual(100);
    // Top values should be capped
    expect(audit.topValues.length).toBeLessThanOrEqual(100);
    // SKU arrays should have at most 5 entries
    for (const v of audit.topValues) {
      expect(v.skus.length).toBeLessThanOrEqual(5);
    }
  });
});
