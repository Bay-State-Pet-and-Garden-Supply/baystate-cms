import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  listItemsByBatchStaged,
  advanceItemsToNextStage,
  updateSourcingDecision,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { upsertBrandSite, findBrandSites } from '../../db/repositories/brand-site-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import type { Workspace } from '../../shared/types';

describe('Sourcing Stage Order & Mandatory Review (Issue #44)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-order-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();

    workspaceId = 'ws-test-sourcing';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: tempDir,
      gitPath: path.join(tempDir, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults newly imported spreadsheet items to stage=sourcing and stageStatus=pending', () => {
    const batch = createBatch({
      workspaceId,
      name: 'New Import Batch',
      fileName: 'products.xlsx',
      totalItems: 2,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678901', name: 'Pet Kibble Small 5lb', brandHint: 'Acme Pet', rowNumber: 1 },
      { upc: '012345678902', name: 'Pet Kibble Large 20lb', brandHint: 'Acme Pet', rowNumber: 2 },
    ]);

    expect(items.length).toBe(2);
    expect(items[0].stage).toBe('sourcing');
    expect(items[0].stageStatus).toBe('pending');
    expect(items[1].stage).toBe('sourcing');
    expect(items[1].stageStatus).toBe('pending');
  });

  it('keeps items with known official Brand domain in Sourcing and prevents worker from claiming them', async () => {
    // 1. Seed brand site (known official domain)
    upsertBrandSite('Acme Pet', 'acmepet.com');
    const sites = findBrandSites('Acme Pet');
    expect(sites.length).toBe(1);
    expect(sites[0].domain).toBe('acmepet.com');

    // 2. Upload/import batch where brand is recognized
    const batch = createBatch({
      workspaceId,
      name: 'Recognized Brand Import',
      fileName: 'known-brand.xlsx',
      totalItems: 1,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678903', name: 'Acme Dog Treats', brandHint: 'Acme Pet', rowNumber: 1 },
    ]);

    // Item must be in Sourcing, NOT Discovery
    expect(items[0].stage).toBe('sourcing');
    expect(items[0].stageStatus).toBe('pending');

    // 3. Run worker polling loop
    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    // Verify item remains unclaimed and untouched in Sourcing
    const itemAfterPoll = findItemById(items[0].id);
    expect(itemAfterPoll?.stage).toBe('sourcing');
    expect(itemAfterPoll?.stageStatus).toBe('pending');
    expect(itemAfterPoll?.sourceUrl).toBeNull();
  });

  it('keeps items without known Brand domain in Sourcing', async () => {
    const batch = createBatch({
      workspaceId,
      name: 'Unknown Brand Import',
      fileName: 'unknown-brand.xlsx',
      totalItems: 1,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678904', name: 'Mystery Widget', brandHint: 'Unknown Brand', rowNumber: 1 },
    ]);

    expect(items[0].stage).toBe('sourcing');
    expect(items[0].stageStatus).toBe('pending');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const itemAfterPoll = findItemById(items[0].id);
    expect(itemAfterPoll?.stage).toBe('sourcing');
    expect(itemAfterPoll?.stageStatus).toBe('pending');
  });

  it('allows explicit stage transition from Sourcing to Discovery or Curation', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Stage Advancement Test',
      fileName: 'test.xlsx',
      totalItems: 2,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678905', name: 'Item 1 Fallback', rowNumber: 1 },
      { upc: '012345678906', name: 'Item 2 Bundle', rowNumber: 2 },
    ]);

    // Complete sourcing stage for Item 1 (fallback to discovery)
    updateItemStageStatus(items[0].id, 'completed');
    const advResult1 = advanceItemsToNextStage([items[0].id]);
    expect(advResult1.advanced).toBe(1);

    const item1After = findItemById(items[0].id);
    expect(item1After?.stage).toBe('discovery');
    expect(item1After?.stageStatus).toBe('pending');

    // Resolve sourcing with accepted bundle for Item 2 (bundle to curation)
    updateSourcingDecision(items[1].id, {
      route: 'bundle_to_curation',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    }, 'curation');

    const item2After = findItemById(items[1].id);
    expect(item2After?.stage).toBe('curation');
    expect(item2After?.stageStatus).toBe('pending');
  });

  it('groups items under sourcing in listItemsByBatchStaged without triggering auto discovery', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Batch Staged Test',
      fileName: 'staged.xlsx',
      totalItems: 1,
    });

    insertItems(batch.id, [
      { upc: '012345678907', name: 'Staged Item', rowNumber: 1 },
    ]);

    const staged = listItemsByBatchStaged(batch.id);
    expect(staged.sourcing.length).toBe(1);
    expect(staged.discovery.length).toBe(0);
    expect(staged.sourcing[0].stage).toBe('sourcing');
  });
});
