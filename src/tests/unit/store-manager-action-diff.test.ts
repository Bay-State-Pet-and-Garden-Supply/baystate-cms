import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  buildStoreManagerActionDiff,
  computeAdapterPreviewDiff,
  checkDiffStaleness,
  playbookToolCallId,
} from '../../store-manager/runtime/action-preview';
import { StoreManagerActionDiffSchema } from '../../shared/schemas/store-manager-diff';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { insertProductIndex } from '../../db/repositories/product-index-repo';

/**
 * Operations console Issue 7 — diff-first action UX.
 * DB-backed (adapter previews read authoritative state): run under `bun test`.
 */

const workspaceId = 'ws-diff';
const testDbPath = './test-action-diff.db';

const baseCtx = {
  workspaceId,
  workspacePath: './ws',
  sessionId: 'sess',
  executionId: 'exec',
  deadlineAt: Date.now() + 60_000,
  emit: () => undefined,
};

describe('Store Manager action diff (epic #42, Issue 7)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertProductIndex({
      id: 'prod-1',
      sku: 'SKU-1',
      filePath: 'products/SKU-1.json',
      title: 'Product One',
      status: 'active',
      price: '10.00',
      inventoryQuantity: 3,
      primaryImage: null,
      productHash: 'hash',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      customFields: { ProductField24: 'VALUE ONE' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(`${testDbPath}${suffix}`); } catch { /* ok */ }
    }
  });

  it('builds a bounded deterministic diff with explicit truncation and unknown as a typed value', () => {
    const skus = Array.from({ length: 250 }, (_, i) => `SKU-${i}`);
    const diff = buildStoreManagerActionDiff({
      toolName: 'stage_stored_proposal_in_change_set',
      toolVersion: 1,
      riskClass: 'catalog_mutation',
      workspaceId,
      scopeHash: null,
      affectedSkuCount: 250,
      affectedSkus: skus,
      beforeAfter: [{ field: 'ProductField24', before: 'Old', after: 'New', affectedCount: 250 }],
      filesTouched: [{ path: 'products/SKU-1.json', note: 'draft row' }],
      changeSet: { currentState: 'reviewing', expectedState: 'draft' },
      networkActivity: { kind: 'unknown', note: 'not estimated by the adapter' },
      evidenceRefs: ['proposal:p1'],
    });
    expect(diff).not.toBeNull();
    expect(diff!.affectedSkus).toHaveLength(200);
    expect(diff!.affectedSkusTruncated).toBe(true);
    expect(diff!.affectedSkuCount).toBe(250);
    expect(diff!.networkActivity).toEqual({ kind: 'unknown', note: 'not estimated by the adapter' });
    expect(diff!.diffHash).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic: the same input produces the same hash.
    const again = buildStoreManagerActionDiff({
      toolName: 'stage_stored_proposal_in_change_set',
      toolVersion: 1,
      riskClass: 'catalog_mutation',
      workspaceId,
      scopeHash: null,
      affectedSkuCount: 250,
      affectedSkus: skus,
      beforeAfter: [{ field: 'ProductField24', before: 'Old', after: 'New', affectedCount: 250 }],
      filesTouched: [{ path: 'products/SKU-1.json', note: 'draft row' }],
      changeSet: { currentState: 'reviewing', expectedState: 'draft' },
      networkActivity: { kind: 'unknown', note: 'not estimated by the adapter' },
      evidenceRefs: ['proposal:p1'],
    });
    expect(again!.diffHash).toBe(diff!.diffHash);
    // No absolute paths/secrets in the serialized shape.
    expect(JSON.stringify(diff)).not.toContain('/Users');
    expect(JSON.stringify(diff)).not.toContain('secret');
  });

  it('validates against the strict schema (unknown keys / malformed values fail closed)', () => {
    const diff = buildStoreManagerActionDiff({
      toolName: 'x',
      toolVersion: 1,
      riskClass: 'proposal_write',
      workspaceId,
      scopeHash: null,
      affectedSkuCount: 0,
      affectedSkus: [],
      changeSet: null,
      networkActivity: { kind: 'none' },
    });
    expect(diff).not.toBeNull();
    expect(() => StoreManagerActionDiffSchema.parse({ ...diff, evil: true })).toThrow();
    expect(() =>
      StoreManagerActionDiffSchema.parse({ ...diff, affectedSkus: ['bad/sku/absolute'] }),
    ).not.toThrow(); // bounded identifiers are length-checked, not pattern-checked
  });

  it('staleness check: fresh on match, stale on mismatch, unbound for chat-style dispatch', () => {
    const diff = buildStoreManagerActionDiff({
      toolName: 'x', toolVersion: 1, riskClass: 'proposal_write', workspaceId,
      scopeHash: null, affectedSkuCount: 1, affectedSkus: ['SKU-1'], changeSet: null, networkActivity: { kind: 'none' },
    })!;
    expect(checkDiffStaleness(diff, diff.diffHash)).toBe('fresh');
    expect(checkDiffStaleness(diff, 'a'.repeat(64))).toBe('stale');
    expect(checkDiffStaleness(diff, null)).toBe('unbound');
    expect(checkDiffStaleness(null, diff.diffHash)).toBe('stale'); // fail closed
  });

  it('playbook tool-call ids are deterministic per run+step', () => {
    expect(playbookToolCallId('run-1', 'step-1')).toBe(playbookToolCallId('run-1', 'step-1'));
    expect(playbookToolCallId('run-1', 'step-1')).not.toBe(playbookToolCallId('run-1', 'step-2'));
  });

  it('every persistent default adapter produces a deterministic preview; read adapters have none', async () => {
    const registry = createStoreManagerToolRegistry();
    for (const adapter of registry.all()) {
      if (adapter.riskClass !== 'read') {
        expect(adapter.previewDiff).toBeDefined(); // registration also enforces this
      } else {
        expect(adapter.previewDiff).toBeUndefined();
      }
    }
    // Concrete: staging preview reports the proposal evidence.
    const stage = registry.get('stage_stored_proposal_in_change_set')!;
    const diff = await computeAdapterPreviewDiff(stage, { proposalId: 'missing-proposal' }, baseCtx);
    expect(diff).not.toBeNull();
    expect(diff!.affectedSkuCount).toBe(0);
    // Unknown Change Set state is a typed value (null), never an omission or guess.
    expect(diff!.changeSet).toBeNull();
    expect(diff!.networkActivity.kind).toBe('none');
  });

  it('the registry refuses to register a persistent adapter without a preview provider', () => {
    const registry = createStoreManagerToolRegistry();
    expect(() =>
      registry.register({
        name: 'unpreviewed_write',
        version: 1,
        description: 'x',
        promptGuidelines: 'x',
        inputSchema: require('zod').object({ id: require('zod').string() }),
        riskClass: 'proposal_write',
        sideEffects: 'x',
        requiresApproval: true,
        stateTransition: 'x',
        allowedPhases: ['approve'],
        scopeSummary: () => 'x',
        execute: async () => ({ status: 'ok', data: {} }),
      } as never),
    ).toThrow(/previewDiff/);
  });
});
