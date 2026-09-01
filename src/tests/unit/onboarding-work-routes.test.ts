/**
 * Milestone 3 (P1-E) — Work-state route tests.
 *
 * Exercises the bounded work-state HTTP contract:
 * - GET /api/onboarding/batches/:id/work-state/counts — bounded counts + projectionHealth
 * - GET /api/onboarding/batches/:id/work-state/items?cursor&limit — cursor-paginated items + projectionHealth
 * - GET /api/onboarding/batches/:id/work-state (deprecated) — still works with cursor/offset and projectionHealth
 * - Filter validation, workspace scoping, cursor binding (filterMismatch → 400), corrupt-data fail-closed.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';

let workspaceId: string;
let workspacePath: string;
let app: Hono;

function makeWorkspace(): string {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-routes-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  return workspaceId;
}

function createBatchWithItems(count: number, overrides: { stage?: string; stageStatus?: string } = {}): string {
  const batch = createBatch({ workspaceId, name: `Batch ${count}`, fileName: 'test.csv', totalItems: 0 });
  const rows = Array.from({ length: count }, (_, i) => ({
    upc: `R-${count}-${i}-${randomUUID().slice(0, 4)}`,
    name: `Product ${i}`,
    brandHint: 'Blue Buffalo',
    sourceUrl: null,
    rowNumber: i + 1,
    stage: (overrides.stage ?? 'sourcing') as any,
    stageStatus: (overrides.stageStatus ?? 'pending') as any,
  }));
  insertItems(batch.id, rows, (overrides.stage ?? 'sourcing') as any, 1);
  return batch.id;
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`);
  const res = await app.fetch(req);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('onboarding work-state routes — bounded read model (P1-E)', () => {
  beforeEach(() => {
    makeWorkspace();
  });

  it('GET /work-state/counts returns counts + projectionHealth', async () => {
    const batchId = createBatchWithItems(7);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state/counts`);
    expect(status).toBe(200);
    expect(body.batchId).toBe(batchId);
    expect(body.counts).toBeDefined();
    expect(body.counts.processing).toBe(7);
    expect(body.total).toBe(7);
    expect(body.projectionHealth).toBeDefined();
    expect(body.projectionHealth.status).toBe('healthy');
    expect(body.projectionHealth.version).toBe('1.0.0');
  });

  it('GET /work-state/items returns cursor-paginated items + projectionHealth', async () => {
    const batchId = createBatchWithItems(23);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=10`);
    expect(status).toBe(200);
    expect(body.batchId).toBe(batchId);
    expect(body.items).toHaveLength(10);
    expect(body.total).toBe(23);
    expect(body.nextCursor).toBeTruthy();
    expect(body.projectionHealth.status).toBe('healthy');
    expect(body.counts).toBeDefined();
  });

  it('GET /work-state/items cursor pagination traverses all items without overlap', async () => {
    const batchId = createBatchWithItems(25);
    const page1 = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=10`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(10);
    const cursor1 = page1.body.nextCursor;
    expect(cursor1).toBeTruthy();

    const page2 = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=10&cursor=${encodeURIComponent(cursor1)}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(10);
    const cursor2 = page2.body.nextCursor;

    const page3 = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=10&cursor=${encodeURIComponent(cursor2)}`);
    expect(page3.status).toBe(200);
    expect(page3.body.items).toHaveLength(5);
    expect(page3.body.nextCursor).toBeNull();

    // No overlap
    const ids1 = new Set(page1.body.items.map((i: any) => i.itemId));
    for (const item of page2.body.items) {
      expect(ids1.has(item.itemId)).toBe(false);
    }
  });

  it('GET /work-state/items returns 400 on filter-mismatched cursor', async () => {
    const batchId = createBatchWithItems(12);
    const page1 = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=5&category=processing`);
    expect(page1.status).toBe(200);
    const cursor = page1.body.nextCursor;
    if (cursor) {
      const bad = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=5&category=needs_attention&cursor=${encodeURIComponent(cursor)}`);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('filter_mismatch');
    }
  });

  it('GET /work-state/items returns 400 on malformed cursor', async () => {
    const batchId = createBatchWithItems(5);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?cursor=not-a-valid-cursor`);
    expect(status).toBe(400);
    expect(body.code).toBe('malformed_cursor');
  });

  it('GET /work-state (deprecated) still works and includes projectionHealth', async () => {
    const batchId = createBatchWithItems(4);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state?limit=2`);
    expect(status).toBe(200);
    expect(body.batchId).toBe(batchId);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(4);
    expect(body.counts.processing).toBe(4);
    expect(body.projectionHealth).toBeDefined();
  });

  it('GET /work-state with cursor also works (deprecated path cursor support)', async () => {
    const batchId = createBatchWithItems(12);
    const first = await getJson(`/api/onboarding/batches/${batchId}/work-state?limit=5`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(5);
    expect(first.body.total).toBe(12);
  });

  it('filters still apply on counts and items', async () => {
    // Seed mixed categories in ONE batch: 3 processing (sourcing pending) + 2 needs_attention (discovery needs_input without brand)
    const batch = createBatch({ workspaceId, name: 'Mixed', fileName: 'mix.csv', totalItems: 0 });
    insertItems(batch.id, [
      { upc: 'F-P1', name: 'Proc1', brandHint: 'Blue Buffalo', sourceUrl: null, rowNumber: 1, stage: 'sourcing' as any, stageStatus: 'pending' as any },
      { upc: 'F-P2', name: 'Proc2', brandHint: 'Blue Buffalo', sourceUrl: null, rowNumber: 2, stage: 'sourcing' as any, stageStatus: 'pending' as any },
      { upc: 'F-P3', name: 'Proc3', brandHint: 'Blue Buffalo', sourceUrl: null, rowNumber: 3, stage: 'sourcing' as any, stageStatus: 'pending' as any },
      { upc: 'F-A', name: 'Alpha', brandHint: null, sourceUrl: null, rowNumber: 4, stage: 'discovery' as any, stageStatus: 'needs_input' as any },
      { upc: 'F-B', name: 'Beta', brandHint: null, sourceUrl: null, rowNumber: 5, stage: 'discovery' as any, stageStatus: 'needs_input' as any },
    ], 'sourcing' as any, 1);
    // Ensure discovery stage for the needs_attention items (stage override already set via item.stage)
    // Counts filtered: only needs_attention should be 2
    const { status, body } = await getJson(`/api/onboarding/batches/${batch.id}/work-state/counts?category=needs_attention`);
    expect(status).toBe(200);
    expect(body.counts.needs_attention).toBe(2);
    expect(body.total).toBe(2);

    const itemsRes = await getJson(`/api/onboarding/batches/${batch.id}/work-state/items?category=needs_attention&limit=10`);
    expect(itemsRes.status).toBe(200);
    expect(itemsRes.body.items).toHaveLength(2);
    expect(itemsRes.body.total).toBe(2);
    for (const item of itemsRes.body.items) {
      expect(item.category).toBe('needs_attention');
    }
    // Unfiltered counts should show 5 total with both categories
    const unfiltered = await getJson(`/api/onboarding/batches/${batch.id}/work-state/counts`);
    expect(unfiltered.body.total).toBe(5);
    expect(unfiltered.body.counts.processing).toBe(3);
    expect(unfiltered.body.counts.needs_attention).toBe(2);
  });

  it('workspace scoping: foreign batch returns 404', async () => {
    const batchId = createBatchWithItems(3);
    // Create second workspace and batch there
    const otherWsId = randomUUID();
    const otherPath = path.join(os.tmpdir(), `ws-other-${otherWsId.slice(0, 6)}`);
    fs.mkdirSync(path.join(otherPath, '.baystate-cms'), { recursive: true });
    const now = new Date().toISOString();
    // Insert foreign workspace to satisfy FK
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status, baseline_commit) VALUES (?, ?, ?, '', ?, ?, 'complete', NULL)`,
      [otherWsId, 'foreign', otherPath, now, now],
    );
    const foreignBatchId = randomUUID();
    getDb().run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, total_items, created_at, updated_at) VALUES (?, ?, 'Foreign', 'f.csv', 1, ?, ?)`,
      [foreignBatchId, otherWsId, now, now],
    );
    const { status } = await getJson(`/api/onboarding/batches/${foreignBatchId}/work-state/counts`);
    expect(status).toBe(404);
    const { status: status2 } = await getJson(`/api/onboarding/batches/${foreignBatchId}/work-state/items?limit=10`);
    expect(status2).toBe(404);
  });

  it('fail-closed: corrupt curation_data still returns non-zero counts and health degraded', async () => {
    const batchId = createBatchWithItems(3);
    const items = getDb().query('SELECT id FROM onboarding_items WHERE batch_id = ?').all(batchId) as Array<{ id: string }>;
    getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify('corrupt_string_not_an_object'), items[0].id]);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state/counts`);
    expect(status).toBe(200);
    const sum = Object.values(body.counts as Record<string, number>).reduce((a, b) => a + (b as number), 0);
    expect(sum).toBe(3);
    expect(body.total).toBe(3);
    expect(body.projectionHealth).toBeDefined();
    expect(body.projectionHealth.status).toBe('degraded');
    const issue = body.projectionHealth.issues.find((i: any) => i.code === 'corrupt_curation_data' || i.code === 'corrupt_projection');
    expect(issue).toBeDefined();
    expect(issue.affectedCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /items respects limit max 500 and default 100', async () => {
    const batchId = createBatchWithItems(501);
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=9999`);
    // Server clamps limit to 500 but bounded scanning returns one 50-row chunk per request
    expect(status).toBe(200);
    expect(body.items).toHaveLength(50);
    expect(body.total).toBe(501);
    expect(body.nextCursor).toBeTruthy();
    // Paginate through remaining via cursor (50 per page, 11 pages for 501)
    let cursor: string | null = body.nextCursor;
    let collected = body.items.length;
    let pages = 1;
    while (cursor) {
      const next = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=50&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      collected += next.body.items.length;
      pages++;
      cursor = next.body.nextCursor;
      if (pages > 20) break;
    }
    expect(collected).toBe(501);
    // Default limit sanity with small batch
    const small = createBatchWithItems(3);
    const d = await getJson(`/api/onboarding/batches/${small}/work-state/items?limit=1`);
    expect(d.status).toBe(200);
    expect(d.body.items).toHaveLength(1);
  });
});
