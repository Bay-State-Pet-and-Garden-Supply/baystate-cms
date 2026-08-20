/**
 * ADR 0017 — batch-level 'Resolve Brand Domains' setup surface.
 *
 * DB-backed route + aggregation + service suite (bun:sqlite — run under
 * `bun test`, same convention as brand-assign-routes.test.ts /
 * brand-authority-gate.test.ts). Proves:
 * - `getBrandDomainBlockers` groups the batch's unmapped-brand discovery
 *   parks by brand, sorts by blocked-product count desc then brand asc, caps
 *   samples at 3, surfaces the best-known `brand_sites` mapping (or null),
 *   and never throws;
 * - `assignOfficialDomainForBrand` (shared guarded service) rejects blank/
 *   invalid and known retailer/distributor domains with typed errors, and
 *   normalizes URL-shaped input before upserting the mapping;
 * - the batch endpoints (GET blockers, POST assign + requeue) enforce
 *   workspace ownership (404 cross-workspace) and re-queue EVERY item in the
 *   brand's blocker group on success.
 *
 * Offline-only: no Serper key exists in the test DB, so the background
 * worker's discovery attempt after re-queue fails fast and deterministically
 * — the re-queue contract asserted here (stage stays discovery, flat status
 * 'imported', stage_status pending-or-claimed) is written synchronously by
 * the routes.
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
import { findBrandSites, upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import { getBrandDomainBlockers } from '../../onboarding/brand-domain-blockers';
import {
  assignOfficialDomainForBrand,
  cleanAssignedDomain,
} from '../../onboarding/brand-domain-service';
import app from '../../server/app';

const wsId = 'ws-brand-domain-setup';
const foreignWsId = 'ws-brand-domain-setup-foreign';

let tempDir: string;

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-domain-setup-test-'));
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
  resetActiveWorkerForTest();
});

/** Insert + park discovery items for a brand with the worker's park reason. */
function parkBrandItems(batchId: string, brand: string, count: number, prefix: string) {
  const items = insertItems(batchId, Array.from({ length: count }, (_, i) => ({
    upc: `${prefix}-${i + 1}`,
    name: `${brand} Product ${i + 1}`,
    brandHint: brand,
    rowNumber: i + 1,
    stage: 'discovery',
  })));
  for (const item of items) {
    updateItemStageStatus(
      item.id,
      'completed',
      `needs_review: no domain mapped for brand "${brand}" — map a domain in Settings to complete discovery`,
    );
  }
  return items;
}

describe('ADR 0017 — brand-domain blockers aggregation', () => {
  it('groups unmapped-brand discovery parks by brand, sorted by blocked count desc then brand asc', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Agg', fileName: 'agg.csv', totalItems: 13 });
    const zebra = parkBrandItems(batch.id, 'Zebra Pets', 2, 'ZP');
    const acme = parkBrandItems(batch.id, 'Acme Pet', 5, 'AC');
    parkBrandItems(batch.id, 'Butchers', 3, 'BC');
    parkBrandItems(batch.id, 'Delta Co', 3, 'DC');

    const blockers = getBrandDomainBlockers(batch.id);
    // Highest impact first; 3-way tie (Butchers/Delta) breaks alphabetically.
    expect(blockers.map(b => b.brand)).toEqual(['Acme Pet', 'Butchers', 'Delta Co', 'Zebra Pets']);
    expect(blockers[0].blockedItemCount).toBe(5);
    expect(blockers[0].batchId).toBe(batch.id);
    expect(blockers[0].itemIds.sort()).toEqual(acme.map(i => i.id).sort());
    // Sample cap at 3 (5 blocked → 3 samples; 3 blocked → 3 samples).
    expect(blockers[0].sampleItems.length).toBe(3);
    expect(blockers[0].sampleItems[0].name).toBe('Acme Pet Product 1');
    expect(blockers[1].sampleItems.length).toBe(3);
    // Under the cap, every parked item is a sample.
    expect(blockers[3].sampleItems.length).toBe(2);
    expect(blockers[3].itemIds.sort()).toEqual(zebra.map(i => i.id).sort());
    expect(blockers[3].sampleItems.map(s => s.itemId).sort()).toEqual(zebra.map(i => i.id).sort());
  });

  it('reports existingMapping from brand_sites and excludes non-park reasons', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Map', fileName: 'map.csv', totalItems: 3 });
    parkBrandItems(batch.id, 'Unmapped Brand', 1, 'UM');
    parkBrandItems(batch.id, 'Mapped Brand', 1, 'MB');
    // A mapped brand's items would not be parked in reality, but the read
    // model reflects the current brand_sites state regardless.
    upsertBrandSite('Mapped Brand', 'mappedbrand.com');
    // A completed discovery item parked for a DIFFERENT reason must not appear.
    const [other] = insertItems(batch.id, [
      { upc: 'OT-1', name: 'Other Product', brandHint: 'Other Brand', rowNumber: 99, stage: 'discovery' },
    ]);
    updateItemStageStatus(other.id, 'completed', 'needs_review: no candidate passed verification');

    const blockers = getBrandDomainBlockers(batch.id);
    expect(blockers.length).toBe(2);
    const unmapped = blockers.find(b => b.brand === 'Unmapped Brand');
    expect(unmapped?.existingMapping).toBeNull();
    expect(unmapped?.itemIds).toHaveLength(1);
    expect(unmapped?.sampleItems[0].upc).toBe('UM-1');
    expect(unmapped?.sampleItems[0].sourceUrl).toBeNull();
    const mapped = blockers.find(b => b.brand === 'Mapped Brand');
    expect(mapped?.existingMapping).toBe('mappedbrand.com');
    expect(blockers.some(b => b.brand === 'Other Brand')).toBe(false);
  });

  it('returns [] for empty/unknown batches and never throws', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Empty', fileName: 'e.csv', totalItems: 0 });
    expect(getBrandDomainBlockers(batch.id)).toEqual([]);
    expect(getBrandDomainBlockers('missing-batch')).toEqual([]);
  });
});

describe('assignOfficialDomainForBrand (guarded shared service)', () => {
  it('rejects blank/invalid domains with a typed error', () => {
    const blank = assignOfficialDomainForBrand({ brand: 'UnseededBrand', domain: '   ' });
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.code).toBe('invalid_domain');
      expect(blank.message).toContain('valid bare domain or URL');
    }
    const invalid = assignOfficialDomainForBrand({ brand: 'UnseededBrand', domain: 'not a domain' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe('invalid_domain');
    expect(findBrandSites('UnseededBrand')).toHaveLength(0);
  });

  it('rejects known retailer/distributor domains with a typed error (no upsert)', () => {
    const res = assignOfficialDomainForBrand({ brand: 'Butchers', domain: 'https://farmtopaw.ca/products' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('retailer_domain');
      expect(res.message).toContain('Retailer/distributor domains cannot be mapped');
    }
    expect(findBrandSites('Butchers')).toHaveLength(0);
  });

  it('normalizes URL-shaped input and upserts the mapping on success', () => {
    const res = assignOfficialDomainForBrand({ brand: 'Fromm', domain: 'https://www.frommfamily.com/products' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.domain).toBe('frommfamily.com');
      expect(res.site.domain).toBe('frommfamily.com');
    }
    const sites = findBrandSites('Fromm');
    expect(sites).toHaveLength(1);
    expect(sites[0].brandName).toBe('fromm'); // upsert normalizes the brand
    expect(sites[0].domain).toBe('frommfamily.com');
  });

  it('cleanAssignedDomain strips scheme/path/port/www and fails closed on garbage', () => {
    expect(cleanAssignedDomain('https://www.FrommFamily.com/products/x')).toBe('frommfamily.com');
    expect(cleanAssignedDomain('  FrommFamily.com:8443/path  ')).toBe('frommfamily.com');
    expect(cleanAssignedDomain('   ')).toBe('');
    expect(cleanAssignedDomain('https://')).toBe('');
  });
});

describe('batch brand-domain-setup endpoints', () => {
  it('GET returns the aggregated blockers for the batch', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Get', fileName: 'g.csv', totalItems: 2 });
    parkBrandItems(batch.id, 'Butchers', 2, 'GB');

    const res = await app.request(`/api/onboarding/batches/${batch.id}/brand-domain-setup`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0].brand).toBe('Butchers');
    expect(body.blockers[0].blockedItemCount).toBe(2);
  });

  it('POST assigns the domain and re-queues EVERY blocked item for the brand', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Post', fileName: 'p.csv', totalItems: 4 });
    const fromm = parkBrandItems(batch.id, 'Fromm', 3, 'PF');
    const primal = parkBrandItems(batch.id, 'Primal', 1, 'PR');

    const res = await app.request(`/api/onboarding/batches/${batch.id}/brand-domain-setup/Fromm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://www.frommfamily.com/products' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      requeued: number;
      blockers: Array<{ brand: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.requeued).toBe(3);

    // Mapping persisted (normalized bare domain).
    const sites = findBrandSites('Fromm');
    expect(sites).toHaveLength(1);
    expect(sites[0].domain).toBe('frommfamily.com');

    // Every Fromm item re-queued (same contract as assign_domain); the
    // Primal item is untouched.
    for (const item of fromm) {
      const after = findItemById(item.id);
      expect(after?.stage).toBe('discovery');
      expect(after?.errorMessage).toBeNull();
      expect(['pending', 'in_progress']).toContain(after?.stageStatus);
    }
    const primalAfter = findItemById(primal[0].id);
    expect(primalAfter?.stage).toBe('discovery');
    expect(primalAfter?.stageStatus).toBe('completed');
    expect(primalAfter?.errorMessage).toContain('no domain mapped');

    // Refreshed blockers: the mapped brand's row disappears, Primal remains.
    expect(body.blockers.some(b => b.brand === 'Fromm')).toBe(false);
    expect(body.blockers.map(b => b.brand)).toEqual(['Primal']);
  });

  it('rejects known retailer domains (400, no upsert, no requeue)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Ret', fileName: 'r.csv', totalItems: 1 });
    const items = parkBrandItems(batch.id, 'Butchers', 1, 'RB');

    const res = await app.request(`/api/onboarding/batches/${batch.id}/brand-domain-setup/Butchers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'farmtopaw.ca' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Retailer/distributor domains cannot be mapped');

    expect(findBrandSites('Butchers')).toHaveLength(0);
    const after = findItemById(items[0].id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed'); // not re-queued
    expect(after?.errorMessage).toContain('no domain mapped');
  });

  it('rejects a blank brand param and a blank domain body (400)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Blank', fileName: 'b.csv', totalItems: 1 });
    parkBrandItems(batch.id, 'Acme', 1, 'AB');

    const blankBrand = await app.request(`/api/onboarding/batches/${batch.id}/brand-domain-setup/%20%20`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.com' }),
    });
    expect(blankBrand.status).toBe(400);
    expect((await blankBrand.json()).error).toContain('brand is required');

    const blankDomain = await app.request(`/api/onboarding/batches/${batch.id}/brand-domain-setup/Acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: '   ' }),
    });
    expect(blankDomain.status).toBe(400);
    expect((await blankDomain.json()).error).toContain('domain is required');

    // No mutation from either rejection.
    expect(findBrandSites('Acme')).toHaveLength(0);
  });

  it('cross-workspace GET/POST fail closed (404) without mutation', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
    const items = parkBrandItems(foreignBatch.id, 'ForeignBrand', 1, 'FB');

    const getRes = await app.request(`/api/onboarding/batches/${foreignBatch.id}/brand-domain-setup`);
    expect(getRes.status).toBe(404);

    const postRes = await app.request(`/api/onboarding/batches/${foreignBatch.id}/brand-domain-setup/ForeignBrand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'foreignbrand.com' }),
    });
    expect(postRes.status).toBe(404);

    const after = findItemById(items[0].id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed'); // untouched
    expect(after?.errorMessage).toContain('no domain mapped');
    expect(findBrandSites('ForeignBrand')).toHaveLength(0);
  });
});
