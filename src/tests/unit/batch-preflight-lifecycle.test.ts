import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createBatch,
  findBatchById,
  updateBatchExecutionState,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  claimItemsForProcessing,
  releaseBatchItems,
  holdBatchItems,
  bulkAssignBrandToItems,
  findItemById,
} from '../../db/repositories/onboarding-item-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
  upsertBrandAdvisoryProfile,
} from '../../db/repositories/distributor-repo';
import { analyzeBatchPreflight } from '../../onboarding/preflight-service';

describe('Batch Preflight & Controlled Release Lifecycle', () => {
  const workspaceId = 'ws-preflight-test';

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  it('defaults new batch to draft executionState and blocks worker claims', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Weekly Catalog Upload',
      fileName: 'upload.xlsx',
      totalItems: 2,
      executionState: 'draft',
    });

    expect(batch.executionState).toBe('draft');

    insertItems(
      batch.id,
      [
        { upc: '011111111111', name: 'Acana Wild Prairie Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '022222222222', name: 'Orijen Six Fish Cat 12lb', brandHint: 'ORIJEN', rowNumber: 2 },
      ],
      'sourcing',
      1,
    );

    // Worker attempts to claim items from 'sourcing' stage
    const claimedInDraft = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInDraft).toHaveLength(0); // Worker CANNOT claim while batch is draft

    // Pause batch state also blocks claims
    updateBatchExecutionState(batch.id, 'paused');
    const claimedInPaused = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInPaused).toHaveLength(0);

    // Starting the batch allows worker claims
    updateBatchExecutionState(batch.id, 'running');
    const claimedInRunning = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInRunning).toHaveLength(2);
  });

  it('respects item hold flags when batch is running', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Partial Release Batch',
      fileName: 'upload.xlsx',
      totalItems: 3,
    });

    const items = insertItems(
      batch.id,
      [
        { upc: '011111111111', name: 'Acana Lamb & Apple 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '022222222222', name: 'Mystery Kibble 5lb', brandHint: null, rowNumber: 2 },
        { upc: '033333333333', name: 'Redbarn Bully Sticks 3pk', brandHint: 'REDBARN', rowNumber: 3 },
      ],
      'sourcing',
      1,
    );

    // Put mystery kibble on hold
    holdBatchItems(batch.id, [items[1].id], 'unresolved_brand');
    updateBatchExecutionState(batch.id, 'running');

    // Worker claims only unheld items
    const claimed = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimed).toHaveLength(2);
    expect(claimed.map((i) => i.upc)).toEqual(['011111111111', '033333333333']);

    // Release mystery kibble and claim again with a distinct worker
    releaseBatchItems(batch.id, [items[1].id]);
    const claimedAfterRelease = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test-2');
    expect(claimedAfterRelease).toHaveLength(1);
    expect(claimedAfterRelease[0].upc).toBe('022222222222');
  });

  it('analyzes preflight metrics and structures grouped exceptions', () => {
    // 1. Setup brand sites and distributor connections
    upsertBrandSite('ACANA', 'acana.com');
    createDistributor({ id: 'dist_phillips', name: 'Phillips Pet Food' });
    const conn = createConnection({
      id: 'conn_phillips',
      workspaceId,
      distributorId: 'dist_phillips',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(conn.id, workspaceId, { enabled: true });

    upsertBrandAdvisoryProfile({
      workspaceId,
      brand: 'ACANA',
      preferredDistributorIds: ['dist_phillips'],
      sourcingPolicy: 'preferred_then_fallback',
    });

    const batch = createBatch({
      workspaceId,
      name: 'Mixed Readiness Batch',
      fileName: 'mixed.csv',
      totalItems: 4,
    });

    const inserted = insertItems(
      batch.id,
      [
        { upc: '111111111111', name: 'Acana Singles Lamb 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '222222222222', name: 'CustomBrandX Chew Stick', brandHint: 'CustomBrandX', rowNumber: 2 }, // has brand, missing domain & routing
        { upc: '333333333333', name: 'Fromm Four-Star Duck 15lb', brandHint: null, rowNumber: 3 }, // missing brand, suggest Fromm
        { upc: '444444444444', name: 'Fromm Four-Star Salmon 15lb', brandHint: null, rowNumber: 4 }, // missing brand, suggest Fromm
      ],
      'sourcing',
      1,
    );

    const preflight = analyzeBatchPreflight(workspaceId, batch.id);

    expect(preflight.totalItems).toBe(4);
    expect(preflight.readyCount).toBe(2); // ACANA & CustomBrandX have brands
    expect(preflight.heldCount).toBe(2); // 2 Fromm items missing brand

    // Metrics verification
    expect(preflight.metrics.brandResolvedCount).toBe(2);
    expect(preflight.metrics.brandResolvedPercent).toBe(50);
    expect(preflight.metrics.domainMappedCount).toBe(1); // Only ACANA has domain
    expect(preflight.metrics.missingDomainBrandCount).toBe(1); // CustomBrandX is missing domain
    expect(preflight.metrics.distributorRoutedCount).toBe(1); // Only ACANA is routed
    expect(preflight.metrics.unroutedBrandCount).toBe(1); // CustomBrandX is unrouted

    // Blockers verification
    expect(preflight.blockers.needsBrandGroups).toHaveLength(1);
    expect(preflight.blockers.needsBrandGroups[0].suggestedBrand?.toLowerCase()).toBe('fromm');
    expect(preflight.blockers.needsBrandGroups[0].itemCount).toBe(2);
    expect(preflight.blockers.needsBrandGroups[0].itemIds).toEqual([inserted[2].id, inserted[3].id]);

    expect(preflight.blockers.missingDomainBrands).toHaveLength(1);
    expect(preflight.blockers.missingDomainBrands[0].brand).toBe('CustomBrandX');

    expect(preflight.blockers.unroutedBrands).toHaveLength(1);
    expect(preflight.blockers.unroutedBrands[0].brand).toBe('CustomBrandX');

    // Bulk assign brand to Fromm group
    const frommItemIds = preflight.blockers.needsBrandGroups[0].itemIds;
    bulkAssignBrandToItems(batch.id, frommItemIds, 'Fromm Family');

    // Re-analyze preflight after brand assignment
    const updatedPreflight = analyzeBatchPreflight(workspaceId, batch.id);
    expect(updatedPreflight.readyCount).toBe(4);
    expect(updatedPreflight.heldCount).toBe(0);
    expect(updatedPreflight.blockers.needsBrandGroups).toHaveLength(0);
    expect(updatedPreflight.metrics.brandResolvedCount).toBe(4);
  });
});
