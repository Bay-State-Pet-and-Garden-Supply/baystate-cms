/**
 * PR11 acceptance (issue #30): the Promotion gate.
 *
 * Harness: pr10-acceptance structure — fresh per-test DBs for route tests so
 * `findWorkspace` (LIMIT 1) resolves deterministically. C3 adds the
 * advance-hole suite (a PR9 blocked member cannot advance review → promotion);
 * the promotion-gate acceptance suite (C4) extends this file with the full
 * cohort harness.
 *
 * The "a blocked item that somehow reaches promotion is still refused by the
 * promotion gate" contract is asserted in the draft-promoter suite
 * (draft-promoter.test.ts, PR11 C2): a blocked member in the promotion stage
 * is refused per-item with `semantic_validation_blocked` and its first
 * finding, while siblings promote.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { Hono } from 'hono';
import onboardingRoutes from '../../server/routes/onboarding-routes';

// ─── DB harness ───────────────────────────────────────────────────────────────

let workspacePath: string;
const tempPaths: string[] = [];

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-pr11-acceptance-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  for (const tempPath of tempPaths) {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

function insertWorkspaceRow(id: string, wsPath: string): void {
  const now = new Date().toISOString();
  insertWorkspace({
    id,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

/** Fresh per-test DB with EXACTLY ONE workspace so the route's `findWorkspace`
 *  (LIMIT 1) resolves deterministically. */
function freshRouteDb(): { workspaceId: string; workspacePath: string } {
  const root = path.join(os.tmpdir(), `baystate-cms-pr11-route-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(root, { recursive: true });
  tempPaths.push(root);
  resetDb();
  initDb(path.join(root, 'app.db'));
  runMigrations();
  const workspaceId = randomUUID();
  const wsPath = path.join(root, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  insertWorkspaceRow(workspaceId, wsPath);
  return { workspaceId, workspacePath: wsPath };
}

/** Insert a REVIEW-stage item that is 'completed' (would advance without the
 *  guard). `curationOverrides` can carry a blocked semanticValidation. */
function insertReviewItem(
  batchId: string,
  upc: string,
  curationOverrides: Record<string, unknown> = {},
): { id: string; upc: string } {
  const [item] = insertItems(batchId, [{ upc, name: `Item ${upc}`, rowNumber: 1 }]);
  const curation = {
    curatedTitle: `Item ${upc}`,
    titleSource: 'web',
    suggestedPages: [],
    suggestedProductType: null,
    curatedAt: new Date().toISOString(),
    curationMethod: 'auto',
    ...curationOverrides,
  };
  getDb().run(
    "UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = ? WHERE id = ?",
    [JSON.stringify(curation), item.id],
  );
  return { id: item.id, upc: item.upc };
}

// ─── PR11 C3: the advance-hole guard (DECISION-B) ────────────────────────────

describe('PR11 C3 — a blocked member cannot advance review → promotion via the advance route (issue #30, DECISION-B)', () => {
  it('refuses the blocked member (stays in review) while healthy siblings advance; the response carries the deterministic reason', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance Hole', fileName: 'advance.xlsx', totalItems: 3 }).id;
    const blocked = insertReviewItem(batchId, '900000000001', {
      semanticValidation: {
        status: 'blocked',
        findings: [{
          code: 'family_brand',
          memberSku: '900000000001',
          message: 'Brand conflict: acme vs woof',
        }],
      },
    });
    const healthyA = insertReviewItem(batchId, '900000000002');
    const healthyB = insertReviewItem(batchId, '900000000003');

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [blocked.id, healthyA.id, healthyB.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; skipped: number; refused: Array<{ itemId: string; reason: string }> };
    expect(body.advanced).toBe(2);
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0].itemId).toBe(blocked.id);
    expect(body.refused[0].reason).toBe('semantic_validation_blocked: Brand conflict: acme vs woof');

    // The blocked member stays in review (completed — the Review drawer keeps it).
    const blockedRow = findItemById(blocked.id)!;
    expect(blockedRow.stage).toBe('review');
    expect(blockedRow.stageStatus).toBe('completed');

    // Healthy siblings advance review → promotion unchanged.
    for (const healthy of [healthyA, healthyB]) {
      const row = findItemById(healthy.id)!;
      expect(row.stage).toBe('promotion');
      expect(row.stageStatus).toBe('pending');
    }
  });

  it('healthy items advance unchanged even when no blocked member is present', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance Healthy', fileName: 'advance-healthy.xlsx', totalItems: 2 }).id;
    const a = insertReviewItem(batchId, '900000000004');
    const b = insertReviewItem(batchId, '900000000005');

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; refused: Array<{ itemId: string; reason: string }> };
    expect(body.advanced).toBe(2);
    expect(body.refused).toHaveLength(0);
    for (const item of [a, b]) {
      expect(findItemById(item.id)!.stage).toBe('promotion');
    }
  });

  it('a blocked member in the CURATION stage still advances to review (blocked-not-destroyed must reach the Review drawer)', async () => {
    const { workspaceId } = freshRouteDb();
    const batchId = createBatch({ workspaceId, name: 'Advance To Review', fileName: 'advance-review.xlsx', totalItems: 1 }).id;
    const [item] = insertItems(batchId, [{ upc: '900000000006', name: 'Blocked Curation Member', rowNumber: 1 }]);
    getDb().run(
      "UPDATE onboarding_items SET stage = 'curation', stage_status = 'completed', curation_data_json = ? WHERE id = ?",
      [JSON.stringify({
        curatedTitle: 'Blocked Curation Member',
        titleSource: 'web',
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
        semanticValidation: {
          status: 'blocked',
          findings: [{ code: 'family_brand', memberSku: '900000000006', message: 'Brand conflict: acme vs woof' }],
        },
      }), item.id],
    );

    const res = await makeApp().request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { advanced: number; refused: Array<{ itemId: string; reason: string }> };
    // The guard only covers review → promotion; curation → review proceeds so
    // the blocked member is visible in the Review drawer.
    expect(body.advanced).toBe(1);
    expect(body.refused).toHaveLength(0);
    const row = findItemById(item.id)!;
    expect(row.stage).toBe('review');
    expect(row.stageStatus).toBe('pending');
  });
});
