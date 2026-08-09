import { describe, test, expect, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById, updateSourcingDecision, advanceItemsToNextStage } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { ResolveSourcingRequestSchema } from '../../shared/schemas/onboarding';

describe('Sourcing Resolution Logic & Repositories', () => {
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: 'w1',
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  test('validates ResolveSourcingRequestSchema for both actions', () => {
    const useBundleValid = ResolveSourcingRequestSchema.safeParse({
      action: 'use_selected_bundle',
      selectedAttemptIds: ['attempt-1', 'attempt-2'],
    });
    expect(useBundleValid.success).toBe(true);

    const fallbackValid = ResolveSourcingRequestSchema.safeParse({
      action: 'fallback_to_discovery',
    });
    expect(fallbackValid.success).toBe(true);

    const invalidAction = ResolveSourcingRequestSchema.safeParse({
      action: 'unknown_action',
    });
    expect(invalidAction.success).toBe(false);
  });

  test('updateSourcingDecision updates sourcingDecision JSON and stage_status', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Test Batch',
      fileName: 'test.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{ upc: '012345678901', name: 'Test Product', rowNumber: 1 }]);
    expect(item).toBeDefined();

    updateSourcingDecision(item.id, {
      route: 'bundle_to_curation',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      providerIds: ['unfi'],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    });

    const updated = findItemById(item.id);
    expect(updated?.stageStatus).toBe('completed');
    expect(updated?.sourcingDecision?.route).toEqual('bundle_to_curation');
    expect(updated?.sourcingDecision?.acceptedEvidenceAttemptIds).toEqual(['attempt-1']);
  });

  test('updateSourcingDecision can transition item stage when fallback_to_discovery', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Fallback Batch',
      fileName: 'fallback.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{ upc: '012345678902', name: 'Fallback Item', rowNumber: 2 }]);

    updateSourcingDecision(item.id, {
      route: 'fallback_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    }, 'discovery');

    const updated = findItemById(item.id);
    expect(updated?.stage).toBe('discovery');
    expect(updated?.stageStatus).toBe('pending');
    expect(updated?.sourcingDecision?.route).toEqual('fallback_to_discovery');
  });

  test('advanceItemsToNextStage routes bundle_to_curation to curation and others to discovery', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Advance Batch',
      fileName: 'advance.csv',
      totalItems: 2,
    });
    const [bundleItem, fallbackItem] = insertItems(batch.id, [
      { upc: '012345678903', name: 'Bundle Item', rowNumber: 3 },
      { upc: '012345678904', name: 'Fallback Item', rowNumber: 4 },
    ]);

    updateSourcingDecision(bundleItem.id, {
      route: 'bundle_to_curation',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      providerIds: ['unfi'],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    });

    updateSourcingDecision(fallbackItem.id, {
      route: 'fallback_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    });

    // Advance both completed items from sourcing stage
    const res = advanceItemsToNextStage([bundleItem.id, fallbackItem.id]);
    expect(res.advanced).toBe(2);

    const afterBundle = findItemById(bundleItem.id);
    expect(afterBundle?.stage).toBe('curation');
    expect(afterBundle?.stageStatus).toBe('pending');

    const afterFallback = findItemById(fallbackItem.id);
    expect(afterFallback?.stage).toBe('discovery');
    expect(afterFallback?.stageStatus).toBe('pending');
  });
});
