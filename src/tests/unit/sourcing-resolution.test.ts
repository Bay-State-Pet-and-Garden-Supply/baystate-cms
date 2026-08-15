import { describe, test, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateSourcingDecision,
  advanceItemsToNextStage,
  fallbackSourcingItemToDiscovery,
} from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { ResolveSourcingRequestSchema, SourcingRouteEnum } from '../../shared/schemas/onboarding';

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

  test('ResolveSourcingRequestSchema accepts fallback and strict use_distributor_record; rejects provenance smuggling', () => {
    // Legacy bundle selection stays prohibited.
    const useBundleValid = ResolveSourcingRequestSchema.safeParse({
      action: 'use_selected_bundle',
      selectedAttemptIds: ['attempt-1', 'attempt-2'],
    });
    expect(useBundleValid.success).toBe(false);

    const fallbackValid = ResolveSourcingRequestSchema.safeParse({
      action: 'fallback_to_discovery',
    });
    expect(fallbackValid.success).toBe(true);

    // Amendment A manual action: strict — the server derives all provenance.
    const useRecordValid = ResolveSourcingRequestSchema.safeParse({
      action: 'use_distributor_record',
    });
    expect(useRecordValid.success).toBe(true);

    // Client-supplied provenance (ids/hash/providers) is REJECTED: the schema
    // is closed, so an attempt to smuggle authority fails validation.
    const smuggle = ResolveSourcingRequestSchema.safeParse({
      action: 'use_distributor_record',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      evidenceHash: 'a'.repeat(64),
      providerIds: ['phillips'],
    });
    expect(smuggle.success).toBe(false);

    const invalidAction = ResolveSourcingRequestSchema.safeParse({
      action: 'unknown_action',
    });
    expect(invalidAction.success).toBe(false);
  });

  test('SourcingRouteEnum adds evidence_to_discovery and keeps bundle_to_curation parseable for audit', () => {
    // evidence_to_discovery is the ADR 0014 coherent-evidence route.
    const routeParse = SourcingRouteEnum.safeParse('evidence_to_discovery');
    expect(routeParse.success).toBe(true);

    // Legacy bundle_to_curation remains a valid persisted-audit VALUE —
    // historical rows must stay readable — but is never creatable/actionable
    // through any request or transition schema (see next test).
    const legacyParse = SourcingRouteEnum.safeParse('bundle_to_curation');
    expect(legacyParse.success).toBe(true);

    // The enum is closed: unknown routes fail.
    expect(SourcingRouteEnum.safeParse('evidence_to_curation').success).toBe(false);
    expect(SourcingRouteEnum.safeParse('branding').success).toBe(false);
  });

  test('ResolveSourcingRequestSchema: use_distributor_record is the ONLY manual routing action (evidence routing stays internal)', () => {
    // Operator resolution actions are fallback or strict use-distributor.
    expect(
      ResolveSourcingRequestSchema.safeParse({ action: 'use_distributor_record' }).success,
    ).toBe(true);
    // evidence_to_discovery is an internal/worker outcome, never a
    // user-submitted resolution action.
    expect(
      ResolveSourcingRequestSchema.safeParse({ action: 'evidence_to_discovery' }).success,
    ).toBe(false);
    expect(
      ResolveSourcingRequestSchema.safeParse({ action: 'needs_input_conflict' }).success,
    ).toBe(false);
    expect(
      ResolveSourcingRequestSchema.safeParse({ action: 'distributor_record_to_extraction' }).success,
    ).toBe(false);
    expect(ResolveSourcingRequestSchema.safeParse({ action: 'fallback_to_discovery' }).success).toBe(
      true,
    );
  });

  test('updateSourcingDecision updates sourcingDecision JSON and stage_status without transitioning', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Test Batch',
      fileName: 'test.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [
      { upc: '012345678901', name: 'Test Product', rowNumber: 1, stage: 'sourcing' },
    ]);
    expect(item).toBeDefined();

    // updateSourcingDecision rejects the legacy route outright (ADR 0014:
    // audit-readable, never CREATABLE through a production helper).
    const wrote = updateSourcingDecision(item.id, {
      route: 'bundle_to_curation',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      providerIds: ['unfi'],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    });
    expect(wrote).toBe(false);
    expect(findItemById(item.id)?.sourcingDecision).toBeNull();

    // Historical audit fixture: legacy bundle decisions are persisted ONLY
    // through direct SQL (as migrated rows would be) and remain readable.
    getDb()
      .query(
        `UPDATE onboarding_items SET sourcing_decision_json = ?, stage_status = 'completed', updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          route: 'bundle_to_curation',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: ['attempt-1'],
          providerIds: ['unfi'],
          conflicts: [],
          warnings: [],
          decidedAt: new Date().toISOString(),
        }),
        new Date().toISOString(),
        item.id,
      );

    const updated = findItemById(item.id);
    expect(updated?.stageStatus).toBe('completed');
    // A legacy persisted bundle decision is a readable audit record, but it
    // NEVER moves the item out of the sourcing stage.
    expect(updated?.stage).toBe('sourcing');
    expect(updated?.sourcingDecision?.route).toEqual('bundle_to_curation');
    expect(updated?.sourcingDecision?.acceptedEvidenceAttemptIds).toEqual(['attempt-1']);

    // A non-sourcing row is refused: decision stays unset, returns false.
    const [other] = insertItems(batch.id, [
      { upc: '012345678912', name: 'Other', rowNumber: 2, stage: 'discovery' },
    ]);
    expect(
      updateSourcingDecision(other.id, {
        route: 'fallback_to_discovery',
        origin: 'operator_override',
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(findItemById(other.id)?.sourcingDecision).toBeNull();
  });

  test('fallbackSourcingItemToDiscovery moves a sourcing item to discovery with an audited decision', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Fallback Batch',
      fileName: 'fallback.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{ upc: '012345678902', name: 'Fallback Item', rowNumber: 2, stage: 'sourcing' }]);

    const res = fallbackSourcingItemToDiscovery(item.id);
    expect(res.moved).toBe(true);

    const updated = findItemById(item.id);
    expect(updated?.stage).toBe('discovery');
    expect(updated?.stageStatus).toBe('pending');
    expect(updated?.sourcingDecision?.route).toEqual('fallback_to_discovery');
    expect(updated?.sourcingDecision?.origin).toEqual('operator_override');
    expect(updated?.sourcingDecision?.acceptedEvidenceAttemptIds).toEqual([]);
  });

  test('advanceItemsToNextStage routes every completed sourcing item to discovery only', () => {
    const batch = createBatch({
      workspaceId: 'w1',
      name: 'Advance Batch',
      fileName: 'advance.csv',
      totalItems: 2,
    });
    const [bundleItem, fallbackItem] = insertItems(batch.id, [
      { upc: '012345678903', name: 'Bundle Item', rowNumber: 3, stage: 'sourcing' },
      { upc: '012345678904', name: 'Fallback Item', rowNumber: 4, stage: 'sourcing' },
    ]);

    // Legacy persisted bundle decision (direct-SQL historical fixture, per
    // ADR 0014) — ignored for routing.
    getDb()
      .query(
        `UPDATE onboarding_items SET sourcing_decision_json = ?, stage_status = 'completed', updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          route: 'bundle_to_curation',
          origin: 'operator_override',
          acceptedEvidenceAttemptIds: ['attempt-1'],
          providerIds: ['unfi'],
          conflicts: [],
          warnings: [],
          decidedAt: new Date().toISOString(),
        }),
        new Date().toISOString(),
        bundleItem.id,
      );

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
    expect(afterBundle?.stage).toBe('discovery');
    expect(afterBundle?.stageStatus).toBe('pending');

    const afterFallback = findItemById(fallbackItem.id);
    expect(afterFallback?.stage).toBe('discovery');
    expect(afterFallback?.stageStatus).toBe('pending');
  });
});
