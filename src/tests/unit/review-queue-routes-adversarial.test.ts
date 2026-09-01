import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import {
  ReviewQueuePageSchema,
  encodeReviewQueueCursor,
  computeReviewQueueFilterHash,
  type ReviewQueueFilters,
} from '../../shared/schemas/onboarding-review-queue';

let workspaceId: string;
let workspacePath: string;
let dbPath: string;
let testBatchId: string;
let foreignBatchId: string;
const TOTAL_ITEMS = 105;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  return app;
}

beforeAll(async () => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-review-queue-adv-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');

  initDb(dbPath);
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'Review Queue Adversarial Workspace',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  // Create active workspace batch with 105 items having identical names and brands
  const batch = createBatch({
    workspaceId,
    name: 'Review Queue Stress Batch',
    fileName: 'stress.csv',
    totalItems: TOTAL_ITEMS,
  });
  testBatchId = batch.id;

  const itemSeeds = [];
  for (let i = 1; i <= TOTAL_ITEMS; i++) {
    const idStr = String(i).padStart(3, '0');
    itemSeeds.push({
      upc: `111111111${idStr}`,
      name: 'Identical Adversarial Product 30lb',
      rowNumber: i,
    });
  }
  const inserted = insertItems(testBatchId, itemSeeds);

  // Set items to review / completed stage with curation and extraction data
  const db = getDb();
  for (let i = 0; i < inserted.length; i++) {
    const item = inserted[i];
    const hasCuration = i % 2 === 0;
    const curationJson = JSON.stringify({
      curatedTitle: 'Identical Adversarial Product 30lb',
      brandHint: 'Blue Buffalo',
      suggestedPages: ['cat-dog-food'],
      reviewedMedia: { primaryImage: `https://images.example.com/img-${i}.jpg` },
      description: 'PROHIBITED IN SERVER PROJECTION',
      curationData: 'PROHIBITED IN SERVER PROJECTION',
    });
    const extractionJson = JSON.stringify({
      title: 'Identical Adversarial Product 30lb',
      price: '$49.99',
      primaryImage: `https://images.example.com/ext-${i}.jpg`,
      extractionData: 'PROHIBITED IN SERVER PROJECTION',
    });

    db.run(
      `UPDATE onboarding_items
       SET stage = 'review',
           stage_status = 'completed',
           brand_hint = 'Blue Buffalo',
           price = '$49.99',
           curation_data_json = ?,
           extraction_data_json = ?
       WHERE id = ?`,
      [hasCuration ? curationJson : null, extractionJson, item.id],
    );
  }

  // Create foreign workspace batch
  const foreignWorkspaceId = 'ws-foreign-workspace';
  insertWorkspace({
    id: foreignWorkspaceId,
    name: 'Foreign Workspace',
    workspacePath: path.join(workspacePath, 'foreign'),
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const foreignBatch = createBatch({
    workspaceId: foreignWorkspaceId,
    name: 'Foreign Batch',
    fileName: 'foreign.csv',
    totalItems: 5,
  });
  foreignBatchId = foreignBatch.id;
});

afterAll(() => {
  closeDb();
  if (workspacePath && fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

describe('GET /api/onboarding/batches/:id/review-queue Adversarial Route Tests', () => {
  const app = makeApp();

  it('serves valid review queue with 200 and schema-compliant projection payload', async () => {
    const res = await app.request(`/api/onboarding/batches/${testBatchId}/review-queue?limit=25`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = ReviewQueuePageSchema.parse(body);

    expect(parsed.batchId).toBe(testBatchId);
    expect(parsed.rows.length).toBe(25);
    expect(parsed.counts.total).toBe(TOTAL_ITEMS);
    expect(parsed.nextCursor).not.toBeNull();
    expect(parsed.projectionHealth.status).toBe('healthy');

    // Verify PROHIBITED detail fields were stripped in server projection
    for (const row of parsed.rows) {
      expect((row as any).description).toBeUndefined();
      expect((row as any).curatedDescription).toBeUndefined();
      expect((row as any).curationData).toBeUndefined();
      expect((row as any).extractionData).toBeUndefined();
      expect((row as any).packagingOcrData).toBeUndefined();
      expect((row as any).sourceHtml).toBeUndefined();
    }
  });

  describe('Adversarial Cursor Injection and Tampering over HTTP', () => {
    it('returns HTTP 400 with malformed_cursor for unparseable cursor string (NO silent page 1 restart)', async () => {
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?cursor=invalid!base64url!string`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
      expect(body.error).toContain('Malformed review queue cursor');
    });

    it('returns HTTP 400 with malformed_cursor for valid base64url non-JSON payload', async () => {
      const badCursor = Buffer.from('this is not json {', 'utf8').toString('base64url');
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?cursor=${badCursor}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
    });

    it('returns HTTP 400 with malformed_cursor for tampered version (v: 2)', async () => {
      const filters: ReviewQueueFilters = { brand: 'Blue Buffalo' };
      const filterHash = computeReviewQueueFilterHash(filters);
      const tamperedV2 = encodeReviewQueueCursor({
        v: 2 as any,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash,
      });

      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?brand=Blue Buffalo&cursor=${tamperedV2}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
    });

    it('returns HTTP 400 with filter_mismatch when cursor is used with altered query filters', async () => {
      // Cursor generated with warningsOnly: true
      const filters1: ReviewQueueFilters = { warningsOnly: true };
      const filterHash1 = computeReviewQueueFilterHash(filters1);
      const cursor = encodeReviewQueueCursor({
        v: 1,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash: filterHash1,
      });

      // Request sent with warningsOnly: false
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?warningsOnly=false&cursor=${cursor}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('filter_mismatch');
      expect(body.error).toContain('Cursor filter hash does not match');
    });

    it('returns HTTP 400 when query parameter validation fails', async () => {
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?gateStatus=unsupported_status`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Invalid query filters');
    });
  });

  describe('Workspace Scoping and 404 Guards', () => {
    it('returns HTTP 404 for non-existent batch ID', async () => {
      const res = await app.request('/api/onboarding/batches/batch-nonexistent-12345/review-queue');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Batch not found');
    });

    it('returns HTTP 404 for batch belonging to another workspace', async () => {
      const res = await app.request(`/api/onboarding/batches/${foreignBatchId}/review-queue`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Batch not found');
    });
  });

  describe('End-to-End Multi-Page HTTP Traversal with Tie-Breakers', () => {
    it('traverses 105 identical-title items across 4 HTTP requests with 0 duplicates and 0 missed items', async () => {
      const pageSize = 30;
      const collectedRows: any[] = [];
      let currentCursor: string | null = null;
      let pageNumber = 0;

      while (true) {
        pageNumber++;
        const url = currentCursor
          ? `/api/onboarding/batches/${testBatchId}/review-queue?limit=${pageSize}&cursor=${encodeURIComponent(currentCursor)}`
          : `/api/onboarding/batches/${testBatchId}/review-queue?limit=${pageSize}`;

        const res = await app.request(url);
        expect(res.status).toBe(200);

        const page = await res.json();
        expect(page.counts.total).toBe(TOTAL_ITEMS);

        collectedRows.push(...page.rows);
        currentCursor = page.nextCursor;

        if (!currentCursor) break;
        if (pageNumber > 10) throw new Error('Infinite loop detected in HTTP traversal');
      }

      // 105 items with pageSize 30 -> 4 pages (30, 30, 30, 15)
      expect(pageNumber).toBe(4);
      expect(collectedRows.length).toBe(TOTAL_ITEMS);

      // Verify ZERO duplicate items across all pages
      const collectedIds = collectedRows.map(r => r.itemId);
      const uniqueIds = new Set(collectedIds);
      expect(uniqueIds.size).toBe(TOTAL_ITEMS);

      // Verify sort ordering is strictly monotonic across all pages
      for (let i = 0; i < collectedRows.length - 1; i++) {
        const curr = collectedRows[i];
        const next = collectedRows[i + 1];
        if (curr.sortKey === next.sortKey) {
          expect(curr.itemId.localeCompare(next.itemId)).toBeLessThan(0);
        } else {
          expect(curr.sortKey.localeCompare(next.sortKey)).toBeLessThan(0);
        }
      }
    });
  });
});
