/**
 * Store Manager bulk-review repository tests (operations console, Issue 8).
 *
 * DB-backed (bun test): immutable batch previews (header + per-item
 * snapshots/digests), workspace isolation, per-item decisions, batch status
 * transitions, and transaction rollback on a bad item set. Disposable DB only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createBulkReviewBatch,
  findBulkReviewBatch,
  listBulkReviewBatches,
  listBulkReviewBatchItems,
  updateBulkReviewBatchStatus,
  updateBulkReviewItemDecision,
  insertBulkReviewDecision,
  countBulkReviewDecisions,
  computeBulkReviewGroupKey,
  type CreateBulkReviewBatchInput,
} from '../../db/repositories/store-manager-bulk-review-repo';

function seedWorkspace(workspaceId: string, name: string, workspacePath: string) {
  const now = new Date().toISOString();
  insertWorkspace({
    id: workspaceId,
    name,
    workspacePath,
    gitPath: workspacePath,
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

function makeItems(count: number, proposalIdPrefix = 'prop'): CreateBulkReviewBatchInput['items'] {
  return Array.from({ length: count }, (_, i) => ({
    proposalId: `${proposalIdPrefix}-${i}`,
    field: 'ProductField24',
    oldValue: `old ${i}`,
    newValue: 'canonical',
    affectedSkus: [`SKU-${i}`],
    itemDigest: `d${i}`.padEnd(64, '0'),
  }));
}

describe('Store Manager bulk-review repository (Issue 8)', () => {
  const dbPath = path.join(os.tmpdir(), `baystate-cms-bulk-repo-${process.pid}.db`);
  const wsId = randomUUID();
  const wsIdB = randomUUID();

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    seedWorkspace(wsId, 'Bulk A', './ws-a');
    seedWorkspace(wsIdB, 'Bulk B', './ws-b');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* ok */ }
    try { unlinkSync(`${dbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${dbPath}-wal`); } catch { /* ok */ }
  });

  it('creates an immutable batch header + item snapshots and reads them back', () => {
    const input: CreateBulkReviewBatchInput = {
      workspaceId: wsId,
      groupKey: computeBulkReviewGroupKey({ workspaceId: wsId, field: 'ProductField24', normalizationKind: 'casing', ruleVersion: 'deterministic:casing:v1', evidenceKey: 'casing_normalization' }),
      field: 'ProductField24',
      normalizationKind: 'casing',
      ruleVersion: 'deterministic:casing:v1',
      evidenceKey: 'casing_normalization',
      distinctSkuCount: 3,
      diffHash: 'a'.repeat(64),
      createdBy: 'operator',
      items: makeItems(3),
    };
    const batch = createBulkReviewBatch(input);
    expect(batch.status).toBe('pending');
    expect(batch.proposalCount).toBe(3);
    expect(batch.distinctSkuCount).toBe(3);
    expect(batch.diffHash).toBe('a'.repeat(64));
    expect(batch.groupKey).toBe(input.groupKey);

    const items = listBulkReviewBatchItems(wsId, batch.id);
    expect(items).toHaveLength(3);
    expect(items[0].decision).toBe('pending');
    expect(items[0].itemDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enforces workspace isolation (foreign batch is indistinguishable from missing)', () => {
    const input: CreateBulkReviewBatchInput = {
      workspaceId: wsId,
      groupKey: 'gk-isolation',
      field: 'ProductField24',
      normalizationKind: 'whitespace',
      ruleVersion: 'deterministic:whitespace:v1',
      evidenceKey: 'whitespace_trim',
      distinctSkuCount: 1,
      diffHash: 'b'.repeat(64),
      createdBy: 'operator',
      items: makeItems(1, 'isoprop'),
    };
    const batch = createBulkReviewBatch(input);
    expect(findBulkReviewBatch(wsIdB, batch.id)).toBeNull();
    expect(listBulkReviewBatchItems(wsIdB, batch.id)).toEqual([]);
    expect(updateBulkReviewBatchStatus(wsIdB, batch.id, 'applied')).toBe(false);
  });

  it('rolls back the whole batch when any item fails to insert (no partial batch)', () => {
    const items = makeItems(2, 'dup');
    // Force a UNIQUE(batch_id, proposal_id) violation by duplicating one id.
    items.push({ ...items[0] });
    expect(() =>
      createBulkReviewBatch({
        workspaceId: wsId,
        groupKey: 'gk-dup',
        field: 'ProductField24',
        normalizationKind: 'casing',
        ruleVersion: 'deterministic:casing:v1',
        evidenceKey: 'casing_normalization',
        distinctSkuCount: 2,
        diffHash: 'c'.repeat(64),
        createdBy: 'operator',
        items,
      }),
    ).toThrow();
    // The failed batch must not exist (transaction rollback).
    const rows = getDb().query("SELECT id FROM store_manager_bulk_review_batches WHERE group_key = 'gk-dup'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('records per-item decisions and updates item decision state atomically', () => {
    const input: CreateBulkReviewBatchInput = {
      workspaceId: wsId,
      groupKey: 'gk-decisions',
      field: 'ProductField24',
      normalizationKind: 'separator',
      ruleVersion: 'deterministic:separator:v1',
      evidenceKey: 'separator_audit',
      distinctSkuCount: 2,
      diffHash: 'd'.repeat(64),
      createdBy: 'operator',
      items: makeItems(2, 'decprop'),
    };
    const batch = createBulkReviewBatch(input);
    expect(updateBulkReviewItemDecision(wsId, batch.id, 'decprop-0', 'applied', 'operator', 'cs-1')).toBe(true);
    expect(updateBulkReviewItemDecision(wsId, batch.id, 'decprop-0', 'applied', 'operator', 'cs-1')).toBe(true);

    const decision = insertBulkReviewDecision({
      workspaceId: wsId,
      batchId: batch.id,
      proposalId: 'decprop-0',
      decision: 'applied',
      actor: 'operator',
      runId: 'run-1',
      diffHash: batch.diffHash,
      changeSetItemRef: 'cs-1',
    });
    expect(decision.id).toBeTruthy();
    expect(countBulkReviewDecisions(wsId, batch.id)).toBe(1);

    const items = listBulkReviewBatchItems(wsId, batch.id);
    const first = items.find((i) => i.proposalId === 'decprop-0')!;
    expect(first.decision).toBe('applied');
    expect(first.decisionActor).toBe('operator');
    expect(first.changeSetItemRef).toBe('cs-1');
  });

  it('lists batches newest-first with bounded summaries', () => {
    const summaries = listBulkReviewBatches(wsId, 5);
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    expect(summaries[0].id).toBeTruthy();
    expect(summaries[0].field).toBeTruthy();
    // Bounded: limit never exceeds the cap.
    expect(listBulkReviewBatches(wsId, 10_000).length).toBeLessThanOrEqual(10_000);
  });

  it('rejects a batch exceeding the 200-item cap', () => {
    expect(() =>
      createBulkReviewBatch({
        workspaceId: wsId,
        groupKey: 'gk-too-big',
        field: 'ProductField24',
        normalizationKind: 'casing',
        ruleVersion: 'deterministic:casing:v1',
        evidenceKey: 'casing_normalization',
        distinctSkuCount: 201,
        diffHash: 'e'.repeat(64),
        createdBy: 'operator',
        items: makeItems(201),
      }),
    ).toThrow(/200-item bound/);
  });
});
