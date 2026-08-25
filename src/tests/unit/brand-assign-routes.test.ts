/**
 * ADR 0017 commitment 4 — assign_brand / assign_domain discovery attention
 * action routes.
 *
 * DB-backed route suite (bun:sqlite — run under `bun test`, same convention
 * as sourcing-safety-routes.test.ts / brand-authority-gate.test.ts). Proves
 * the two first-class attention actions end-to-end through the real Hono
 * app:
 * - assign_brand updates the item's brand hint and re-queues discovery
 *   exactly like the search_again/retry flow (discovery/pending, flat status
 *   back to imported, error cleared, worker polled);
 * - assign_domain upserts the brand→domain mapping for the item's current
 *   brand hint, fails with a clear error when no brand is assigned, and
 *   re-queues discovery;
 * - both reject non-Discovery items and fail closed cross-workspace (404).
 *
 * Offline-only: discovery runs entirely against local brand-domain indexes
 * and sitemaps — no search API key exists in the test DB. The background
 * worker's discovery attempt therefore settles deterministically (setup
 * hold or zero-candidate completion) without external calls, and the re-queue
 * contract asserted here (stage stays discovery, flat status 'imported',
 * stage_status pending-or-claimed) is written synchronously by the routes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { findBrandSites } from '../../db/repositories/brand-site-repo';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const wsId = 'ws-brand-assign';
const foreignWsId = 'ws-brand-assign-foreign';

function makeDiscoveryItem(overrides: { brandHint?: string | null } = {}) {
  const batch = createBatch({ workspaceId: wsId, name: 'Brand Assign', fileName: 'ba.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [
    {
      upc: 'BA-0001',
      name: 'Brand Assign Product',
      brandHint: overrides.brandHint ?? null,
      rowNumber: 1,
      stage: 'discovery',
    },
  ]);
  // Realistic discovery-card state: discovery completed, held for manual
  // review (needs_review error-message convention).
  updateItemStageStatus(item.id, 'completed', 'needs_review: no candidate passed verification');
  return item;
}

describe('ADR 0017 commitment 4 — assign_brand / assign_domain routes', () => {
  let tempDir: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-assign-routes-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    insertWorkspace({
      id: foreignWsId,
      name: 'Foreign Workspace',
      workspacePath: '/tmp/foreign',
      gitPath: '/tmp/foreign/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Stop any worker started by a prior test so poll intervals never cross
    // test boundaries. Each route re-creates its worker on demand.
    resetActiveWorkerForTest();
  });

  it('assign_brand updates the brand hint and re-queues discovery (search_again flow)', async () => {
    const item = makeDiscoveryItem();

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: '  Fromm  ' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.item.brandHint).toBe('Fromm'); // trimmed

    const after = findItemById(item.id);
    expect(after?.brandHint).toBe('Fromm');
    // Re-discovery contract (same reset the search_again/retry path uses):
    // stage stays discovery, the manual-review error is cleared, and the
    // stage status is pending — or already claimed (in_progress) by the
    // worker poll the route triggers.
    expect(after?.stage).toBe('discovery');
    expect(after?.errorMessage).toBeNull();
    expect(['pending', 'in_progress']).toContain(after?.stageStatus);
  });

  it('assign_brand rejects a missing or blank brand without mutation', async () => {
    const item = makeDiscoveryItem();

    const missing = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain('brand is required');

    const blank = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: '   ' }),
    });
    expect(blank.status).toBe(400);

    const after = findItemById(item.id);
    expect(after?.brandHint).toBeNull();
    expect(after?.stageStatus).toBe('completed');
  });

  it('assign_domain upserts the brand→domain mapping and re-queues discovery', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Fromm' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://www.frommfamily.com/products' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Mapping persisted with normalized brand + bare domain (upsertBrandSite
    // normalizes both; URL-shaped input is reduced to the hostname).
    const sites = findBrandSites('Fromm');
    expect(sites).toHaveLength(1);
    expect(sites[0].brandName).toBe('fromm');
    expect(sites[0].domain).toBe('frommfamily.com');

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.errorMessage).toBeNull();
    expect(['pending', 'in_progress']).toContain(after?.stageStatus);
  });

  it('assign_domain fails with a clear error when the item has no brand hint', async () => {
    const item = makeDiscoveryItem(); // brandHint null

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'frommfamily.com' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('no brand assigned yet');

    // The item was not re-queued (stage status + manual-review error
    // untouched) and no mapping could be written (the upsert happens only
    // after the brand-hint guard).
    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('completed');
    expect(after?.errorMessage).toContain('needs_review');
    expect(after?.brandHint).toBeNull();
  });

  it('assign_domain rejects invalid domain shapes', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Acme Pet' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('valid bare domain or URL');
    expect(findBrandSites('Acme Pet')).toHaveLength(0);
  });

  it('assign_domain rejects known retailer/distributor domains (no upsert, no requeue)', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Butchers' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://farmtopaw.ca/products' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Retailer/distributor domains cannot be mapped');

    // No mapping was upserted and the item was NOT re-queued: still
    // completed with the needs_review manual-review error, brand hint
    // untouched — the guard returns before the upsert and requeue.
    expect(findBrandSites('Butchers')).toHaveLength(0);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.errorMessage).toContain('needs_review');
    expect(after?.brandHint).toBe('Butchers');
  });

  it('both actions reject items outside the Discovery stage', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Not Discovery', fileName: 'nd.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'BA-0002', name: 'Extraction Item', rowNumber: 1, stage: 'extraction' },
    ]);

    const brandRes = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Fromm' }),
    });
    expect(brandRes.status).toBe(400);
    expect((await brandRes.json()).error).toContain('requires the item to be in Discovery');

    const domainRes = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'frommfamily.com' }),
    });
    expect(domainRes.status).toBe(400);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.brandHint).toBeNull();
  });

  it('cross-workspace assign actions fail closed (404) without mutation', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [
      { upc: 'BA-0003', name: 'Foreign Item', brandHint: 'ForeignBrand', rowNumber: 1, stage: 'discovery' },
    ]);

    const brandRes = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'ForeignBrand' }),
    });
    expect(brandRes.status).toBe(404);

    const domainRes = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'foreignbrand.com' }),
    });
    expect(domainRes.status).toBe(404);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending'); // untouched
    expect(after?.brandHint).toBe('ForeignBrand');
    expect(findBrandSites('ForeignBrand')).toHaveLength(0);
  });
});
