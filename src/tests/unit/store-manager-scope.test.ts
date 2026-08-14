import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { createChangeSet } from '../../db/repositories/change-set-repo';
import {
  resolveStoreManagerPinnedScope,
  StoreManagerScopeError,
} from '../../server/services/store-manager-scope-service';
import { hashCanonicalJson } from '../../shared/stable-id';

/**
 * Operations console, Issue 2 — pinned-scope resolution. DB-backed: run under
 * `bun test` (excluded from Vitest collection).
 */

describe('Store Manager pinned scope (Issue 2)', () => {
  const testDbPath = './test-scope.db';
  const workspaceId = randomUUID();
  const workspacePath = './test-scope-workspace';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    if (!existsSync(workspacePath)) mkdirSync(workspacePath);

    const now = new Date().toISOString();
    insertWorkspace({
      id: workspaceId,
      name: 'Scope Test Workspace',
      workspacePath,
      gitPath: workspacePath,
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: 'ProductField24',
      label: 'Category',
      kind: 'custom',
      dataType: 'text',
      editable: true,
      required: false,
      uiGroup: null,
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });
    insertProductIndex({
      id: randomUUID(),
      sku: 'SKU-1',
      filePath: 'products/SKU-1.json',
      title: 'Product One',
      status: 'active',
      price: '10.00',
      inventoryQuantity: 1,
      primaryImage: null,
      productHash: 'hash-1',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
      customFields: { ProductField24: 'One' },
    });
  });

  afterAll(() => {
    closeDb();
    for (const p of [testDbPath, `${testDbPath}-shm`, `${testDbPath}-wal`]) {
      if (existsSync(p)) { try { unlinkSync(p); } catch { /* ok */ } }
    }
  });

  it('resolves all four supported scope kinds with a 64-hex snapshot hash', () => {
    const batch = createBatch({ workspaceId, name: 'Import A', fileName: 'a.csv', totalItems: 3 });
    const changeSet = createChangeSet({ workspaceId, title: 'CS One', baseCommit: 'base' });

    const batchScope = resolveStoreManagerPinnedScope(workspaceId, { kind: 'onboarding_batch', batchId: batch.id });
    expect(batchScope.resolved.kind).toBe('onboarding_batch');
    expect(batchScope.resolved.displayName).toBe('Import A');
    expect(batchScope.scopeHash).toMatch(/^[a-f0-9]{64}$/);

    const csScope = resolveStoreManagerPinnedScope(workspaceId, { kind: 'change_set', changeSetId: changeSet.id });
    expect(csScope.resolved.kind).toBe('change_set');
    expect(csScope.resolved.displayName).toBe('CS One');

    const fieldScope = resolveStoreManagerPinnedScope(workspaceId, { kind: 'product_field', field: 'ProductField24' });
    expect(fieldScope.resolved.kind).toBe('product_field');
    expect(fieldScope.resolved.displayName).toBe('Category');

    const skuScope = resolveStoreManagerPinnedScope(workspaceId, { kind: 'sku_set', skus: ['SKU-1'] });
    expect(skuScope.resolved.kind).toBe('sku_set');
    expect(skuScope.resolved.itemCount).toBe(1);

    // Deterministic hash: same scope → same hash.
    const again = resolveStoreManagerPinnedScope(workspaceId, { kind: 'product_field', field: 'ProductField24' });
    expect(again.scopeHash).toBe(fieldScope.scopeHash);
    expect(again.scopeHash).toBe(hashCanonicalJson({ kind: 'product_field', field: 'ProductField24' }));
  });

  it('deduplicates sku_set preserving order and bounds the resolved snapshot', () => {
    const scope = resolveStoreManagerPinnedScope(workspaceId, { kind: 'sku_set', skus: ['SKU-1', 'SKU-1', 'SKU-MISSING'] });
    expect(scope.pinnedScope).toEqual({ kind: 'sku_set', skus: ['SKU-1', 'SKU-MISSING'] });
    expect(scope.resolved.itemCount).toBe(1); // only the existing SKU counts
  });

  it('fails closed for foreign/unknown identifiers (ownership, no disclosure)', () => {
    for (const [label, fn] of [
      ['batch', () => resolveStoreManagerPinnedScope(workspaceId, { kind: 'onboarding_batch', batchId: 'foreign-batch' })],
      ['change set', () => resolveStoreManagerPinnedScope(workspaceId, { kind: 'change_set', changeSetId: 'foreign-cs' })],
      ['product field', () => resolveStoreManagerPinnedScope(workspaceId, { kind: 'product_field', field: 'ProductField99' })],
      ['sku set (none exist)', () => resolveStoreManagerPinnedScope(workspaceId, { kind: 'sku_set', skus: ['NOPE-1', 'NOPE-2'] })],
    ] as const) {
      try {
        fn();
        throw new Error(`expected ${label} failure`);
      } catch (err) {
        expect(err).toBeInstanceOf(StoreManagerScopeError);
        expect((err as StoreManagerScopeError).code).toBe('not_found');
      }
    }
  });

  it('rejects an empty/oversized sku_set and malformed scopes (bounds + schema)', () => {
    try {
      resolveStoreManagerPinnedScope(workspaceId, { kind: 'sku_set', skus: [] });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerScopeError).code).toBe('scope_invalid');
    }
    try {
      resolveStoreManagerPinnedScope(workspaceId, { kind: 'product_field', field: 'x'.repeat(300) });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerScopeError).code).toBe('scope_invalid');
    }
    try {
      resolveStoreManagerPinnedScope(workspaceId, { kind: 'magic', value: 1 } as never);
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerScopeError).code).toBe('scope_invalid');
    }
  });

  it('vendor scope fails closed when no workspace-owned vendor identity source exists', () => {
    try {
      resolveStoreManagerPinnedScope(workspaceId, { kind: 'vendor', vendorId: 'vendor-x' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerScopeError).code).toBe('vendor_unresolved');
      expect((err as StoreManagerScopeError).message).toMatch(/cannot be pinned/i);
    }
  });

  it('never accepts a whole-catalog widening: the pinned scope is always explicit and bounded', () => {
    // The schema has no "catalog" kind; unknown keys fail.
    expect(() =>
      resolveStoreManagerPinnedScope(workspaceId, { kind: 'product_field', field: 'ProductField24', extra: 1 } as never),
    ).toThrowError(StoreManagerScopeError);
  });
});
