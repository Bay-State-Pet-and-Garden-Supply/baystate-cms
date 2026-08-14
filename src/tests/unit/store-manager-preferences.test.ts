import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import {
  saveStoreManagerPreference,
  getActivePreferenceRevisionRow,
  listStoreManagerPreferenceRevisions,
  resolveActivePreferenceContentHash,
  getActiveStoreManagerPreferenceContent,
} from '../../server/services/store-manager-preference-service';
import { StoreManagerPreferenceValidationError } from '../../shared/schemas/store-manager-preferences';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';

/**
 * Operations console, Issue 2 — explicit versioned workspace preferences.
 * DB-backed: run under `bun test` (excluded from Vitest collection).
 */

const nowIso = () => new Date().toISOString();

describe('Store Manager preferences (Issue 2)', () => {
  const testDbPath = './test-preferences.db';
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const workspacePath = './test-preferences-workspace';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    if (!existsSync(workspacePath)) mkdirSync(workspacePath);

    for (const ws of [workspaceId, otherWorkspaceId]) {
      insertWorkspace({
        id: ws,
        name: 'Prefs Workspace',
        workspacePath,
        gitPath: workspacePath,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        bootstrapStatus: 'complete',
        baselineCommit: null,
      });
    }
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    insertProductIndex({
      id: randomUUID(),
      sku: 'SKU-1',
      filePath: 'products/SKU-1.json',
      title: 'One',
      status: 'active',
      price: '10.00',
      inventoryQuantity: 1,
      primaryImage: null,
      productHash: 'h',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      customFields: {},
    });
  });

  afterAll(() => {
    closeDb();
    for (const p of [testDbPath, `${testDbPath}-shm`, `${testDbPath}-wal`]) {
      if (existsSync(p)) { try { unlinkSync(p); } catch { /* ok */ } }
    }
  });

  it('saves immutable revisions with incrementing versions and one active pointer', () => {
    const first = saveStoreManagerPreference(workspaceId, {
      product_field_labels: { ProductField24: 'Category' },
      vendor_identifier_convention: 'upc_a',
    });
    expect(first.revision.version).toBe(1);
    expect(first.revision.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const second = saveStoreManagerPreference(workspaceId, {
      health_exclusions: ['SKU-1'],
      vendor_identifier_convention: 'ean_13',
    });
    expect(second.revision.version).toBe(2);
    expect(second.unknownSkus).toEqual([]); // SKU-1 exists

    // Immutability: revision 1's content is unchanged.
    const db = getDb();
    const rev1Row = db.query("SELECT content_json FROM store_manager_preferences WHERE workspace_id = ? AND version = 1").get(workspaceId) as { content_json: string };
    expect(rev1Row.content_json).toContain('"upc_a"');

    // Active pointer moved to v2.
    const active = getActivePreferenceRevisionRow(workspaceId);
    expect(active?.version).toBe(2);
    expect(resolveActivePreferenceContentHash(workspaceId)).toBe(second.revision.contentHash);
    expect(resolveActivePreferenceContentHash(workspaceId)).not.toBe(first.revision.contentHash);
  });

  it('replay/run capture uses the CURRENT active revision hash (old/new lineage)', () => {
    const before = resolveActivePreferenceContentHash(workspaceId);
    const next = saveStoreManagerPreference(workspaceId, { vendor_identifier_convention: 'sku' });
    // A replay against current state sees the NEW hash; a run recorded under
    // the OLD hash is still readable because revisions are immutable.
    expect(next.revision.contentHash).not.toBe(before);
    expect(getActiveStoreManagerPreferenceContent(workspaceId)).toMatchObject({
      vendor_identifier_convention: 'sku',
    });
    const revisions = listStoreManagerPreferenceRevisions(workspaceId);
    expect(revisions.map((r) => r.version)).toEqual([3, 2, 1]);
  });

  it('rejects unregistered ProductFields in product_field_labels (identity validation)', () => {
    try {
      saveStoreManagerPreference(workspaceId, { product_field_labels: { ProductField999: 'Nope' } });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(StoreManagerPreferenceValidationError);
      expect((err as StoreManagerPreferenceValidationError).code).toBe('invalid_product_field');
    }
  });

  it('rejects invalid values and unknown keys at the schema boundary', () => {
    try {
      saveStoreManagerPreference(workspaceId, { vendor_identifier_convention: 'qr_code' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerPreferenceValidationError).code).toBe('invalid_preferences');
    }
    try {
      saveStoreManagerPreference(workspaceId, { hidden_memory: 'trust me' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerPreferenceValidationError).code).toBe('invalid_preferences');
    }
    try {
      saveStoreManagerPreference(workspaceId, {});
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerPreferenceValidationError).code).toBe('invalid_preferences');
    }
  });

  it('isolates revisions across workspaces (no cross-workspace reads)', () => {
    expect(getActivePreferenceRevisionRow(otherWorkspaceId)).toBeNull();
    expect(resolveActivePreferenceContentHash(otherWorkspaceId)).toBeNull();
    expect(listStoreManagerPreferenceRevisions(otherWorkspaceId)).toEqual([]);
    saveStoreManagerPreference(otherWorkspaceId, { vendor_identifier_convention: 'upc_e' });
    // Workspace A still sees exactly its own revisions.
    expect(getActivePreferenceRevisionRow(workspaceId)?.version).toBe(3);
    expect(getActivePreferenceRevisionRow(otherWorkspaceId)?.version).toBe(1);
  });

  it('reports health-exclusion SKUs that do not exist (informative, non-blocking)', () => {
    const result = saveStoreManagerPreference(workspaceId, { health_exclusions: ['SKU-1', 'GHOST-9'] });
    expect(result.unknownSkus).toEqual(['GHOST-9']);
  });

  it('the model has no preference-write tool (no chat-write API exists)', () => {
    const registry = createStoreManagerToolRegistry();
    const names = registry.names();
    expect(names.some((n) => /preference|setting|memory/i.test(n))).toBe(false);
  });
});
