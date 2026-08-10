import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  updateItemExtractionData,
  updateItemStageStatus,
  advanceItemsToNextStage,
  updateSourcingDecision,
  listItemsByBatch,
} from '../../db/repositories/onboarding-item-repo';
import { getCohortMembers } from '../../db/repositories/curation-cohort-repo';
import {
  refreshCandidateCohorts,
  evaluateCohortReadiness,
  evaluateItemReadiness,
  transitionCohortToReadyIfComplete,
  getDerivedCohortStateForItem,
  listCandidateCohortViews,
} from '../../onboarding/curation-cohort-service';
import type { CurationCohort } from '../../shared/schemas/cohorts';

let workspaceId: string;
let workspacePath: string;

const FIXED_DECIDED_AT = '2024-01-01T00:00:00.000Z';

function makeExtractionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Purina Pro Plan Dog Food Chicken',
    brand: 'Purina Pro Plan',
    ocrOutcome: { status: 'disabled' },
    ...overrides,
  };
}

/** Move an item to `extraction / completed` with complete evidence. */
function makeItemExtractionReady(itemId: string, extractionData: unknown): void {
  updateItemStageStatus(itemId, 'completed');
  advanceItemsToNextStage([itemId]);
  updateItemExtractionData(itemId, JSON.stringify(extractionData));
  updateSourcingDecision(itemId, {
    route: 'bundle_to_curation',
    origin: 'automatic_policy',
    acceptedEvidenceAttemptIds: [],
    providerIds: [],
    conflicts: [],
    warnings: [],
    decidedAt: FIXED_DECIDED_AT,
  });
  updateItemStageStatus(itemId, 'completed');
}

describe('curation cohort service (issue #30, PR2)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-service-${workspaceId.slice(0, 8)}`);
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
  });

  function newBatch(): string {
    return createBatch({ workspaceId, name: 'Family Batch', fileName: 'family.xlsx', totalItems: 3 }).id;
  }

  function insertFamilyItems(batchId: string) {
    return insertItems(batchId, [
      { upc: '100000000001', name: 'Purina Pro Plan Dog Food Chicken 5 lb', brandHint: 'Purina', rowNumber: 1 },
      { upc: '100000000002', name: 'Purina Pro Plan Dog Food Beef 10 lb', brandHint: 'Purina', rowNumber: 2 },
      { upc: '100000000003', name: 'Acme Bird Seed Sunflower 5 lb', brandHint: 'Acme', rowNumber: 3 },
    ]);
  }

  it('marks a cohort ready when every member satisfies the extraction completeness contract', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    for (const item of items) makeItemExtractionReady(item.id, makeExtractionData());

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('ready');
    expect(purina.blockedReason).toBeNull();

    const acme = cohorts.find(c => c.groupKey.includes('acme'))!;
    expect(acme.status).toBe('ready'); // singletons are one-member cohorts

    // Per-member readiness is true for every member.
    const members = getCohortMembers(purina.id);
    const itemsById = new Map(listItemsByBatch(batchId).map(i => [i.id, i]));
    for (const member of members) {
      const readiness = evaluateItemReadiness(itemsById.get(member.onboardingItemId)!);
      expect(readiness.ready).toBe(true);
      expect(readiness.sourceFinalized).toBe(true);
      expect(readiness.extractionCompleted).toBe(true);
      expect(readiness.ocrSettled).toBe(true);
      expect(readiness.extractionHashComputed).toBe(true);
    }
  });

  it('keeps a cohort waiting when a sibling is still producing evidence', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());
    // items[1] never advanced past discovery → incomplete evidence.

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('waiting');
    expect(purina.blockedReason).toContain('Waiting for 1 family member');
    expect(purina.membershipHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats failed OCR as settled but unresolved OCR as blocking', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData({ ocrOutcome: { status: 'failed' } }));
    makeItemExtractionReady(items[1].id, makeExtractionData({ ocrOutcome: null, packagingOcrData: null }));
    makeItemExtractionReady(items[2].id, makeExtractionData({ ocrOutcome: null, packagingOcrData: null }));

    const itemsByUpc = new Map(listItemsByBatch(batchId).map(i => [i.upc, i]));
    expect(evaluateItemReadiness(itemsByUpc.get('100000000001')!).ready).toBe(true); // failed OCR → settled
    expect(evaluateItemReadiness(itemsByUpc.get('100000000002')!).ready).toBe(false); // no OCR outcome → unresolved

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('waiting');
  });

  it('counts extraction as complete when an item already advanced past extraction', () => {
    const batchId = newBatch();
    const [item] = insertFamilyItems(batchId);
    // Extraction finished, then the item advanced into curation with its
    // extraction evidence still present (advancement only happens from a
    // completed extraction). The cohort refresh also runs during curation
    // polling, so readiness must stay stable after items advance.
    makeItemExtractionReady(item.id, makeExtractionData());
    advanceItemsToNextStage([item.id]); // extraction (completed) → curation (pending)

    const loaded = listItemsByBatch(batchId).find(i => i.id === item.id)!;
    expect(loaded.stage).toBe('curation');
    expect(loaded.extractionData).not.toBeNull();
    const readiness = evaluateItemReadiness(loaded);
    expect(readiness.extractionCompleted).toBe(true);
    expect(readiness.ready).toBe(true);
  });

  it('requires complete PI import evidence (runId/resultHash/importRecordId) for readiness', () => {
    const batchId = newBatch();
    const [item] = insertFamilyItems(batchId);
    // PI evidence attached but entries lack runId/resultHash/importRecordId.
    makeItemExtractionReady(item.id, makeExtractionData({
      productIntelligenceEvidence: [{ runId: 'run-1' }],
    }));

    const incomplete = listItemsByBatch(batchId).find(i => i.id === item.id)!;
    const incompleteReadiness = evaluateItemReadiness(incomplete);
    expect(incompleteReadiness.piImported).toBe(false);
    expect(incompleteReadiness.ready).toBe(false);
    expect(incompleteReadiness.blockedReason).toContain('Product Intelligence import not completed');

    // Fully-populated entries → import complete → ready.
    updateItemExtractionData(item.id, JSON.stringify(makeExtractionData({
      productIntelligenceEvidence: [{ runId: 'run-1', resultHash: 'h1', importRecordId: 'imp-1' }],
    })));
    const complete = listItemsByBatch(batchId).find(i => i.id === item.id)!;
    const completeReadiness = evaluateItemReadiness(complete);
    expect(completeReadiness.piImported).toBe(true);
    expect(completeReadiness.ready).toBe(true);
  });

  it('derives per-item family state with cohort status and waiting members', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId); // persist candidate cohorts

    const itemB = listItemsByBatch(batchId).find(i => i.id === items[1].id)!;
    const state = getDerivedCohortStateForItem(itemB);
    expect(state.cohortId).not.toBeNull();
    expect(state.groupLabel).toBe('Purina Pro Plan Dog Food Chicken 5 lb');
    expect(state.status).toBe('waiting');
    expect(state.memberCount).toBe(2);
    expect(state.readyCount).toBe(1);
    expect(state.waitingOn.length).toBe(1);
    expect(state.waitingOn[0].itemId).toBe(items[1].id); // own extraction is part of the family wait
    expect(state.blockedReason).toContain('Waiting for');

    // A ready sibling's derived state points at the same cohort with a ready status.
    const itemA = listItemsByBatch(batchId).find(i => i.id === items[0].id)!;
    const stateA = getDerivedCohortStateForItem(itemA);
    expect(stateA.cohortId).toBe(state.cohortId);
  });

  it('transitions a cohort to ready only when all members are complete', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);

    // One member ready, one waiting → cohort stays waiting; no transition.
    makeItemExtractionReady(items[0].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId);
    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(transitionCohortToReadyIfComplete(purina.id)).toBe(false);

    // Complete the sibling → cohort transitions to ready.
    makeItemExtractionReady(items[1].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId);
    const refreshed = refreshCandidateCohorts(workspaceId, batchId);
    const purinaReady = refreshed.find(c => c.groupKey.includes('purina'))!;
    expect(purinaReady.status).toBe('ready');
    // Subsequent transition attempt is a no-op.
    expect(transitionCohortToReadyIfComplete(purinaReady.id)).toBe(false);
  });

  it('builds cohort views with per-member readiness for the API', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId); // persist candidate cohorts

    const views = listCandidateCohortViews(batchId);
    const purina = views.find(v => v.cohort.groupKey.includes('purina'))!;
    expect(purina.status).toBe('waiting');
    expect(purina.memberCount).toBe(2);
    expect(purina.readyCount).toBe(1);
    expect(purina.waitingOn.length).toBe(1);
    expect(purina.waitingOn[0].itemId).toBe(items[1].id);
    expect(purina.members.length).toBe(2);

    const readyMember = purina.members.find(m => m.onboardingItemId === items[0].id)!;
    expect(readyMember.ready).toBe(true);
    expect(readyMember.blockedReason).toBeNull();
    expect(readyMember.item.upc).toBe('100000000001');

    const waitingMember = purina.members.find(m => m.onboardingItemId === items[1].id)!;
    expect(waitingMember.ready).toBe(false);
    expect(waitingMember.blockedReason).toContain('sourcing decision not finalized');
  });

  it('evaluates readiness from explicit cohort/member/items inputs', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    const members = getCohortMembers(purina.id);
    const loadedItems = listItemsByBatch(batchId);

    const evaluation = evaluateCohortReadiness(purina, members, loadedItems);
    expect(evaluation.status).toBe('waiting');
    expect(evaluation.memberCount).toBe(2);
    expect(evaluation.readyCount).toBe(1);
    expect(evaluation.waitingOn.map(w => w.itemId)).toEqual([items[1].id]);
    expect(evaluation.blockedReason).toBe('Waiting for 1 family member to finish Extraction');

    // Direct cohort input is validated even for fabricated cohorts.
    const fabricatedCohort = { ...purina } as CurationCohort;
    const empty = evaluateCohortReadiness(fabricatedCohort, [], loadedItems);
    expect(empty.status).toBe('ready');
    expect(empty.memberCount).toBe(0);
    expect(empty.readyCount).toBe(0);
  });
});
