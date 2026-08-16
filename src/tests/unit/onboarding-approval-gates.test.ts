/**
 * Epic #46 audit fixes (fix 3/fix 5) — route-level approval gates.
 *
 * Proves the durable-release-decision contract at the HTTP layer:
 * - POST /api/onboarding/batches/:id/promote rejects items WITHOUT durable
 *   approval (or with an invalidated approval) before any draft side effect;
 * - POST /api/onboarding/items/advance (diagnostics) refuses
 *   review/completed items that never passed a durable review — bulk approval
 *   is the ONLY release decision;
 * - PUT /api/onboarding/items/:id on an approved promotion item invalidates
 *   the approval AND returns the item to review/pending (reapproval required)
 *   — an unapproved promotion edit stays in promotion but is never exportable.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  markReviewed,
  markApproved,
  markReviewInvalidated,
  getReviewState,
} from '../../db/repositories/onboarding-review-repo';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import { setWorkerPollTriggerForTest } from '../../server/routes/onboarding-work-routes';

let workspaceId: string;
let workspacePath: string;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

function makeBatch(name = 'Gate Batch'): string {
  return createBatch({ workspaceId, name, fileName: 'test.csv', totalItems: 0 }).id;
}

function createItem(
  batchId: string,
  overrides: { upc: string; name: string; stage: string; stageStatus: string },
): string {
  return insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name,
    rowNumber: 1,
    stage: overrides.stage as never,
    stageStatus: overrides.stageStatus as never,
  }], overrides.stage as never, 1)[0].id;
}

beforeAll(() => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-approvalgates-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
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
  // Never start the real background worker during unit tests (work-routes
  // trigger seam; onboarding-routes' advance route polls once, which is safe
  // on an idle DB).
  setWorkerPollTriggerForTest(null);
});

describe('promotion gate (epic #46 audit fix 3)', () => {
  it('rejects promotion-stage items without durable approval (400, none mutated)', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P1', name: 'X', stage: 'promotion', stageStatus: 'pending' });

    const res = await makeApp().request(`/api/onboarding/batches/${batchId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failures[0]?.reason).toBe('approval_required');
    expect(findItemById(id)!.stageStatus).toBe('pending');
  });

  it('rejects items whose approval was invalidated by a later edit', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P2', name: 'X', stage: 'promotion', stageStatus: 'pending' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });
    markReviewInvalidated(id, 'consequential_edit');

    const res = await makeApp().request(`/api/onboarding/batches/${batchId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failures[0]?.reason).toBe('approval_invalidated');
  });
});

describe('diagnostics advance gate (epic #46 audit fix 3)', () => {
  it('refuses review/completed items without durable review (bulk approval is the only release decision)', async () => {
    const batchId = makeBatch();
    // Legacy-shaped row: review/completed with NO durable review record — but
    // review-complete always writes one now; this is the defense-in-depth case.
    const id = createItem(batchId, { upc: 'P3', name: 'X', stage: 'review', stageStatus: 'completed' });

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refused[0]?.reason).toBe('durable_review_required');
    expect(findItemById(id)!.stage).toBe('review');
    expect(findItemById(id)!.stageStatus).toBe('completed');
  });

  it('refuses review/completed items whose durable review was invalidated', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P4', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markReviewInvalidated(id, 'consequential_edit');

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });

    const body = await res.json();
    expect(body.refused[0]?.reason).toBe('durable_review_required');
    expect(findItemById(id)!.stage).toBe('review');
  });

  it('allows a genuinely reviewed review/completed item to advance to promotion', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P5', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.advanced).toBe(1);
    expect(findItemById(id)!.stage).toBe('promotion');
    expect(findItemById(id)!.stageStatus).toBe('pending');
  });
});

describe('consequential edit reopens approved promotion items (epic #46 audit fix 3)', () => {
  it('returns an approved promotion item to review/pending for reapproval', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P6', name: 'X', stage: 'promotion', stageStatus: 'pending' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });
    expect(getReviewState(id)!.approvedAt).not.toBeNull();

    const res = await makeApp().request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Changed Name' }),
    });

    expect(res.status).toBe(200);
    const after = findItemById(id)!;
    expect(after.stage).toBe('review');
    expect(after.stageStatus).toBe('pending');
    const state = getReviewState(id)!;
    expect(state.reviewInvalidatedAt).not.toBeNull();
    expect(state.approvedAt).toBeNull();
  });

  it('invalidates review on an unapproved promotion edit but does not move it (promote still refuses)', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'P7', name: 'X', stage: 'promotion', stageStatus: 'pending' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const res = await makeApp().request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: '19.99' }),
    });

    expect(res.status).toBe(200);
    const after = findItemById(id)!;
    expect(after.stage).toBe('promotion');
    expect(getReviewState(id)!.reviewInvalidatedAt).not.toBeNull();

    // And the export path refuses it.
    const batch = getBatchIdOf(findItemById(id)!);
    const promoteRes = await makeApp().request(`/api/onboarding/batches/${batch}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(promoteRes.status).toBe(400);
    const promoteBody = await promoteRes.json();
    expect(promoteBody.failures[0]?.reason).toBe('approval_invalidated');
  });
});

function getBatchIdOf(item: { batchId: string }): string {
  return item.batchId;
}
describe('epic #46 review remediation — fix 4: batch routes are workspace-scoped', () => {
  it('cohorts, staged, and events all 404 for a foreign-workspace batch', async () => {
    const app = makeApp();

    // Workspace B batch (active workspace via findWorkspace is workspace A —
    // the FIRST inserted row).
    const wsB = randomUUID();
    const wsBPath = path.join(os.tmpdir(), `baystate-wsb-${wsB.slice(0, 8)}`);
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
       VALUES (?, 'ws-b', ?, '', ?, ?)`,
      [wsB, wsBPath, now, now],
    );
    const batchB = createBatch({ workspaceId: wsB, name: 'Foreign Batch', fileName: 'f.csv', totalItems: 0 });

    const cohorts = await app.request(`/api/onboarding/batches/${batchB.id}/cohorts`);
    expect(cohorts.status).toBe(404);
    const staged = await app.request(`/api/onboarding/batches/${batchB.id}/staged`);
    expect(staged.status).toBe(404);
    const events = await app.request(`/api/onboarding/batches/${batchB.id}/events`);
    expect(events.status).toBe(404);
  });

  it('cohorts and staged return 200 for the active workspace batch', async () => {
    const app = makeApp();
    const batchId = makeBatch();
    const cohorts = await app.request(`/api/onboarding/batches/${batchId}/cohorts`);
    expect(cohorts.status).toBe(200);
    const staged = await app.request(`/api/onboarding/batches/${batchId}/staged`);
    expect(staged.status).toBe(200);
  });
});
