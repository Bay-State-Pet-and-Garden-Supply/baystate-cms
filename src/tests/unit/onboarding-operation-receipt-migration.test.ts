import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createReceipt, findByIdempotencyKey, listByBatch, computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';

let workspaceId: string;

function makeWorkspace() {
  workspaceId = randomUUID();
  const wsPath = path.join(os.tmpdir(), `ws-op-receipt-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

describe('onboarding operation receipt migration', () => {
  beforeEach(() => {
    makeWorkspace();
  });

  it('creates onboarding_operation_receipts table', () => {
    const db = getDb();
    const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_operation_receipts'").get() as { name: string } | undefined;
    expect(tbl?.name).toBe('onboarding_operation_receipts');
    const cols = db.query('PRAGMA table_info(onboarding_operation_receipts)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('workspace_id');
    expect(names).toContain('batch_id');
    expect(names).toContain('operation');
    expect(names).toContain('principal');
    expect(names).toContain('role');
    expect(names).toContain('idempotency_key');
    expect(names).toContain('details_json');
  });

  it('enforces composite unique (workspace_id, batch_id, operation, idempotency_key) and request_hash column', () => {
    const batch = createBatch({ workspaceId, name: 'B', fileName: 'f.csv', totalItems: 0 });
    const key = 'idem-' + randomUUID();
    const hash = 'abc123';
    createReceipt({ workspaceId, batchId: batch.id, operation: 'approve', principal: 'catalog_approver:abc', role: 'catalog_approver', idempotencyKey: key, requestHash: hash, detailsJson: JSON.stringify({ approved: [] }) });
    // Same composite should throw
    expect(() => {
      createReceipt({ workspaceId, batchId: batch.id, operation: 'approve', principal: 'catalog_approver:abc', role: 'catalog_approver', idempotencyKey: key, requestHash: hash, detailsJson: JSON.stringify({ approved: [] }) });
    }).toThrow();
    // Different workspace with same key should succeed (composite)
    const ws2 = randomUUID();
    const wsPath2 = path.join(os.tmpdir(), `ws-op-receipt2-${ws2.slice(0, 8)}`);
    fs.mkdirSync(path.join(wsPath2, '.baystate-cms'), { recursive: true });
    // Need to insert workspace row for FK
    getDb().run(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status, baseline_commit) VALUES (?, ?, ?, '', ?, ?, 'complete', NULL)`, [ws2, 'ws2', wsPath2, new Date().toISOString(), new Date().toISOString()]);
    const batch2 = createBatch({ workspaceId: ws2, name: 'B-other', fileName: 'f2.csv', totalItems: 0 });
    expect(() => {
      createReceipt({ workspaceId: ws2, batchId: batch2.id, operation: 'approve', principal: 'catalog_approver:abc', role: 'catalog_approver', idempotencyKey: key, requestHash: hash, detailsJson: JSON.stringify({ approved: [] }) });
    }).not.toThrow();
    // Verify request_hash column exists and is not null default
    const cols = getDb().query('PRAGMA table_info(onboarding_operation_receipts)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('request_hash');
    // Different operation with same key should succeed (composite includes operation)
    expect(() => {
      createReceipt({ workspaceId, batchId: batch.id, operation: 'export', principal: 'catalog_exporter:abc', role: 'catalog_exporter', idempotencyKey: key, requestHash: hash, detailsJson: JSON.stringify({ approved: [] }) });
    }).not.toThrow();
  });

  it('persists and lists receipt by batch', () => {
    const batch = createBatch({ workspaceId, name: 'B2', fileName: 'f2.csv', totalItems: 0 });
    const key = 'idem-' + randomUUID();
    const r = createReceipt({ workspaceId, batchId: batch.id, operation: 'approve', principal: 'operator:xyz', role: 'operator', idempotencyKey: key, requestHash: computeRequestHash(['a']), detailsJson: JSON.stringify({ approved: ['a'] }) });
    expect(r.id).toBeTruthy();
    expect(r.principal).toBe('operator:xyz');
    const found = findByIdempotencyKey(key);
    expect(found?.id).toBe(r.id);
    const listed = listByBatch(batch.id);
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(r.id);
  });

  it('migration is idempotent', () => {
    // Run again should not throw
    expect(() => runMigrations()).not.toThrow();
    const db = getDb();
    const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_operation_receipts'").get() as { name: string } | undefined;
    expect(tbl?.name).toBe('onboarding_operation_receipts');
  });
});
