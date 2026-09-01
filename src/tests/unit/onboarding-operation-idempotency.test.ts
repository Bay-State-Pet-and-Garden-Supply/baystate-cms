import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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
import { markReviewed } from '../../db/repositories/onboarding-review-repo';
import { findByIdempotencyKey, findByScopedIdempotencyKey, computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';

let workspaceId: string;
let workspacePath: string;
let app: Hono;
let origToken: string | undefined;

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-idem-${workspaceId.slice(0, 8)}`);
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
}

function makeReviewBatch(itemCount = 2): { batchId: string; itemIds: string[] } {
  const batch = createBatch({ workspaceId, name: 'Idem', fileName: 'f.csv', totalItems: 0 });
  const rows = Array.from({ length: itemCount }, (_, i) => ({
    upc: `IDEM-${randomUUID().slice(0, 6)}-${i}`,
    name: `Product ${i}`,
    brandHint: 'Blue Buffalo',
    sourceUrl: null,
    rowNumber: i + 1,
    stage: 'review' as const,
    stageStatus: 'completed' as const,
  }));
  const inserted = insertItems(batch.id, rows, 'review' as any, 1);
  const ids = inserted.map(r => r.id);
  for (const id of ids) {
    markReviewed({ itemId: id, batchId: batch.id, reviewedBy: 'tester' });
  }
  return { batchId: batch.id, itemIds: ids };
}

async function postApprove(batchId: string, itemIds: string[], headers: Record<string, string> = {}, bodyExtra: any = {}) {
  const body = { itemIds, reviewerId: 'evil-operator', ...bodyExtra };
  const req = new Request(`http://localhost/api/onboarding/batches/${batchId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe('approval idempotency and server-derived principal', () => {
  beforeEach(() => {
    origToken = process.env.BAYSTATE_CMS_API_TOKEN;
    makeWorkspace();
  });
  afterEach(() => {
    if (origToken === undefined) delete process.env.BAYSTATE_CMS_API_TOKEN;
    else process.env.BAYSTATE_CMS_API_TOKEN = origToken;
  });

  it('same Idempotency-Key returns same receipt without double-advancing', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batchId, itemIds, headers);
    expect(first.status).toBe(200);
    expect(first.json.approvedCount).toBe(2);
    expect(first.json.receiptId).toBeTruthy();
    const firstReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(firstReceipt?.id).toBe(first.json.receiptId);
    expect(firstReceipt?.requestHash).toBe(computeRequestHash(itemIds));

    // Second call with same key — should be idempotent, replay identical response with same receiptId
    const second = await postApprove(batchId, itemIds, headers);
    expect(second.status).toBe(200);
    expect(second.json.approvedCount).toBe(2);
    expect(second.json.receiptId).toBe(first.json.receiptId);
    expect(second.json.receiptId).toBeTruthy();
    // Identical replay: second response should equal first (except maybe timing)
    expect(second.json.results).toEqual(first.json.results);
    expect(second.json.approvedCount).toBe(first.json.approvedCount);
    expect(second.json.rejectedCount).toBe(first.json.rejectedCount);
    // Items should still be in promotion, not re-advancing to error
    const db = getDb();
    const rows = db.query('SELECT stage FROM onboarding_items WHERE id IN (?,?)').all(itemIds[0], itemIds[1]) as Array<{ stage: string }>;
    for (const r of rows) expect(r.stage).toBe('promotion');

    const secondReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(secondReceipt?.id).toBe(firstReceipt?.id);
    expect(secondReceipt?.requestHash).toBe(firstReceipt?.requestHash);
  });

  it('payload mismatch with same Idempotency-Key returns 409', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(3);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batchId, itemIds.slice(0, 2), headers);
    expect(first.status).toBe(200);
    const firstReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(firstReceipt).toBeTruthy();
    // Second call with same key but different itemIds (payload mismatch) should 409
    const second = await postApprove(batchId, itemIds.slice(1, 3), headers);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('payload_mismatch');
    expect(second.json.receiptId).toBe(firstReceipt?.id);
    // Original receipt unchanged
    const still = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(still?.requestHash).toBe(firstReceipt?.requestHash);
  });

  it('missing or invalid Authorization returns 401', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(1);
    const key = 'idem-' + randomUUID();
    // No Authorization header
    const noAuth = await postApprove(batchId, itemIds, { 'Idempotency-Key': key });
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.code).toBe('unauthorized');
    // Wrong token
    const wrong = await postApprove(batchId, itemIds, { Authorization: 'Bearer wrong-token', 'Idempotency-Key': key + '-2' });
    expect(wrong.status).toBe(401);
  });

  it('server-derived principal beats client reviewerId', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-xyz';
    const { batchId, itemIds } = makeReviewBatch(1);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-xyz', 'Idempotency-Key': key };
    const res = await postApprove(batchId, itemIds, headers);
    expect(res.status).toBe(200);
    expect(res.json.principal).toBeTruthy();
    expect(res.json.principal).not.toBe('evil-operator');
    expect(res.json.principal).toContain('catalog_approver:');
    const receipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(receipt?.principal).not.toBe('evil-operator');
    expect(receipt?.principal).toBe(res.json.principal);
    expect(receipt?.role).toBe('catalog_approver');
  });

  it('without token, principal is system (dev mode) and still succeeds', async () => {
    delete process.env.BAYSTATE_CMS_API_TOKEN;
    const { batchId, itemIds } = makeReviewBatch(1);
    const res = await postApprove(batchId, itemIds, {});
    expect(res.status).toBe(200);
    expect(res.json.principal).toBe('system');
  });

  it('different idempotency keys create separate receipts', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId: batch1, itemIds: ids1 } = makeReviewBatch(1);
    const { batchId: batch2, itemIds: ids2 } = (() => {
      const b = createBatch({ workspaceId, name: 'B2', fileName: 'b2.csv', totalItems: 0 });
      const rows = [{ upc: `IDEM2-${randomUUID().slice(0, 6)}`, name: 'P2', brandHint: 'Blue', sourceUrl: null, rowNumber: 1, stage: 'review' as const, stageStatus: 'completed' as const }];
      const ins = insertItems(b.id, rows, 'review' as any, 1);
      markReviewed({ itemId: ins[0].id, batchId: b.id, reviewedBy: 'tester' });
      return { batchId: b.id, itemIds: [ins[0].id] };
    })();
    const key1 = 'idem-' + randomUUID();
    const key2 = 'idem-' + randomUUID();
    const headers1 = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key1 };
    const headers2 = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key2 };
    const r1 = await postApprove(batch1, ids1, headers1);
    const r2 = await postApprove(batch2, ids2, headers2);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.receiptId).not.toBe(r2.json.receiptId);
  });

  it('mixed eligible/ineligible exact retry replays identical envelope with same receiptId', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const batch = createBatch({ workspaceId, name: 'Mixed', fileName: 'mix.csv', totalItems: 0 });
    const eligible = insertItems(batch.id, [{ upc: `MIX-E-${randomUUID().slice(0,4)}`, name: 'Eligible', brandHint: 'Blue', sourceUrl: null, rowNumber: 1, stage: 'review' as const, stageStatus: 'completed' as const }], 'review' as any, 1)[0];
    const ineligible = insertItems(batch.id, [{ upc: `MIX-I-${randomUUID().slice(0,4)}`, name: 'Ineligible', brandHint: 'Blue', sourceUrl: null, rowNumber: 2, stage: 'review' as const, stageStatus: 'completed' as const }], 'review' as any, 1)[0];
    markReviewed({ itemId: eligible.id, batchId: batch.id, reviewedBy: 'tester' });
    // do NOT markReviewed for ineligible -> not_reviewed
    const itemIds = [eligible.id, ineligible.id];
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batch.id, itemIds, headers);
    expect(first.status).toBe(200);
    expect(first.json.approvedCount).toBe(1);
    expect(first.json.rejectedCount).toBe(1);
    expect(first.json.receiptId).toBeTruthy();
    // Ensure no item appears in both approved and rejected
    const approvedSet = new Set(first.json.results.filter((r:any)=>r.status==='approved').map((r:any)=>r.itemId));
    const rejectedSet = new Set(first.json.results.filter((r:any)=>r.status==='rejected').map((r:any)=>r.itemId));
    for (const id of approvedSet) expect(rejectedSet.has(id)).toBe(false);
    expect(approvedSet.has(eligible.id)).toBe(true);
    expect(rejectedSet.has(ineligible.id)).toBe(true);

    const second = await postApprove(batch.id, itemIds, headers);
    expect(second.status).toBe(200);
    expect(second.json.receiptId).toBe(first.json.receiptId);
    // Deep JSON equality - whole envelope must be identical
    expect(second.json).toEqual(first.json);
    expect(second.json.principal).toBe(first.json.principal);
    expect(second.json.results).toEqual(first.json.results);
    expect(second.json.approvedCount).toBe(first.json.approvedCount);
    expect(second.json.rejectedCount).toBe(first.json.rejectedCount);
    expect(second.json.rejected).toEqual(first.json.rejected);
    expect(second.json.audited).toBe(first.json.audited);
    // No duplicate side effects - details_json must equal first response
    const receipt = findByScopedIdempotencyKey(workspaceId, batch.id, 'approve', key);
    expect(receipt?.id).toBe(first.json.receiptId);
    expect(JSON.parse(receipt!.detailsJson!)).toEqual(first.json);
    // All items still correct stage
    const db = getDb();
    const row = db.query('SELECT stage FROM onboarding_items WHERE id = ?').get(eligible.id) as { stage: string };
    expect(row.stage).toBe('promotion');
  });
});
