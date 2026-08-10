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
  setDiscoverySourceUrl,
  listItemsByBatch,
} from '../../db/repositories/onboarding-item-repo';
import { getCohortMembers, getCohortById, updateCohortStatus } from '../../db/repositories/curation-cohort-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  evaluateCohortReadiness,
  evaluateItemReadiness,
  sourceProvenanceConsistent,
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

/** Move an item to `extraction / failed` (deterministic blocked member state). */
function makeItemExtractionFailed(itemId: string): void {
  updateItemStageStatus(itemId, 'completed');
  advanceItemsToNextStage([itemId]);
  updateItemExtractionData(itemId, JSON.stringify(makeExtractionData()));
  updateItemStageStatus(itemId, 'failed', 'simulated extraction failure');
}

/** Simulate Discovery completion the way the worker/routes do it: persist the
 *  source URL and mark `discovery/completed` — no sourcingDecision is written. */
function completeDiscoveryRealPath(itemId: string): void {
  setDiscoverySourceUrl(itemId, `https://brand.example.com/products/${itemId}`);
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

  it('readies a cohort through the ordinary onboarding path (no sourcingDecision/OCR fabricated)', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);

    // Spreadsheet imports land in Discovery with sourcingDecision: null.
    expect(listItemsByBatch(batchId).every(i => i.sourcingDecision == null)).toBe(true);

    // 1. Discovery completion the way the worker does it: persist source_url
    //    and mark discovery/completed (setDiscoverySourceUrl does both), then
    //    advance to extraction.
    for (const item of items) completeDiscoveryRealPath(item.id);
    advanceItemsToNextStage(items.map(i => i.id));

    // 2. Extraction completion: extraction data + extraction/completed. No
    //    OCR outcome is written — OCR is lazy/informational in this round.
    for (const item of items) {
      updateItemExtractionData(item.id, JSON.stringify({ title: `Product ${item.upc}`, brand: 'Purina' }));
      updateItemStageStatus(item.id, 'completed');
    }

    const readyItems = listItemsByBatch(batchId);
    const readiness = evaluateItemReadiness(readyItems[0]);
    expect(readiness.sourceFinalized).toBe(true);
    expect(readiness.extractionCompleted).toBe(true);
    expect(readiness.ocrSettled).toBe(false); // informational only — nothing written
    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.blockedReason).toBeNull();

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('ready');
    expect(purina.blockedReason).toBeNull();
    const acme = cohorts.find(c => c.groupKey.includes('acme'))!;
    expect(acme.status).toBe('ready'); // singletons are one-member cohorts
  });

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
      expect(readiness.state).toBe('ready');
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

    // The still-processing member derives `waiting` (not blocked).
    const view = listCandidateCohortViews(batchId).find(v => v.cohort.groupKey.includes('purina'))!;
    expect(view.state).toBe('waiting');
    const waitingMember = view.members.find(m => m.onboardingItemId === items[1].id)!;
    expect(waitingMember.state).toBe('waiting');
    expect(waitingMember.ready).toBe(false);
    expect(waitingMember.waitingOn.length).toBe(0); // self excluded — this member IS the blocker
  });

  it('treats no_image as a settled OCR outcome and keeps OCR informational (non-blocking)', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData({ ocrOutcome: { status: 'no_image' } }));
    makeItemExtractionReady(items[1].id, makeExtractionData({ ocrOutcome: null, packagingOcrData: null }));
    makeItemExtractionReady(items[2].id, makeExtractionData({ ocrOutcome: null, packagingOcrData: null }));

    const itemsByUpc = new Map(listItemsByBatch(batchId).map(i => [i.upc, i]));
    const noImage = evaluateItemReadiness(itemsByUpc.get('100000000001')!);
    expect(noImage.ocrSettled).toBe(true); // no_image is a terminal OCR outcome
    expect(noImage.ready).toBe(true);

    // Null OCR is informational only — it no longer blocks readiness.
    const nullOcr = evaluateItemReadiness(itemsByUpc.get('100000000002')!);
    expect(nullOcr.ocrSettled).toBe(false);
    expect(nullOcr.ready).toBe(true);

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('ready'); // unresolved OCR no longer waits
  });

  it('marks a cohort blocked when a member failed in a pipeline stage', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());
    makeItemExtractionFailed(items[1].id);

    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('waiting'); // persisted status stays waiting
    expect(purina.blockedReason).toContain('Member failed');

    const view = listCandidateCohortViews(batchId).find(v => v.cohort.groupKey.includes('purina'))!;
    expect(view.state).toBe('blocked');
    expect(view.blockedReason).toContain('Member failed');
    expect(view.blockedReason).toContain('100000000002');

    const failedMember = view.members.find(m => m.onboardingItemId === items[1].id)!;
    expect(failedMember.state).toBe('blocked');
    expect(failedMember.ready).toBe(false);
    expect(failedMember.blockedReason).toContain('Member failed');
    expect(failedMember.waitingOn.length).toBe(0); // self excluded

    const readyMember = view.members.find(m => m.onboardingItemId === items[0].id)!;
    expect(readyMember.state).toBe('ready');
    // A failed sibling is not ordinary "waiting": the sibling card surfaces the
    // family block via cohort state, and waitingOn lists only in-progress members.
    expect(readyMember.waitingOn.length).toBe(0);
    expect(view.state).toBe('blocked');
  });

  it('never transitions non-forming/waiting cohorts back to ready', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    for (const item of items) makeItemExtractionReady(item.id, makeExtractionData());
    const cohorts = refreshCandidateCohorts(workspaceId, batchId);
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.status).toBe('ready');

    // Cohort schema v3 (D7) narrowed the lifecycle to
    // forming|waiting|ready|superseded — execution states (running/completed/
    // failed/conflicted) are no longer writable. The remaining non-forming/
    // waiting states are never moved back to `ready`.
    for (const status of ['superseded', 'ready'] as const) {
      updateCohortStatus(purina.id, status);
      expect(transitionCohortToReadyIfComplete(purina.id)).toBe(false);
      expect(getCohortById(purina.id)!.status).toBe(status);
    }
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
    expect(state.state).toBe('waiting');

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
    expect(waitingMember.state).toBe('waiting');
    expect(waitingMember.blockedReason).toContain('selected source not finalized');
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
    expect(evaluation.state).toBe('waiting');
    expect(evaluation.memberCount).toBe(2);
    expect(evaluation.readyCount).toBe(1);
    expect(evaluation.waitingOn.map(w => w.itemId)).toEqual([items[1].id]);
    expect(evaluation.blockedReason).toBe('Waiting for 1 family member to finish Extraction');

    // Direct cohort input is validated even for fabricated cohorts.
    const fabricatedCohort = { ...purina } as CurationCohort;
    const empty = evaluateCohortReadiness(fabricatedCohort, [], loadedItems);
    expect(empty.status).toBe('ready');
    expect(empty.state).toBe('ready');
    expect(empty.memberCount).toBe(0);
    expect(empty.readyCount).toBe(0);
  });

  it('blocks pre-Curation barrier failures and never blocks on a Curation failure (round-3 R1)', () => {
    const batchId = newBatch();
    const items = insertItems(batchId, [
      { upc: '200000000001', name: 'Sourcing Failed Product', brandHint: 'Alpha', rowNumber: 1, stage: 'sourcing' },
      { upc: '200000000002', name: 'Discovery Failed Product', brandHint: 'Alpha', rowNumber: 2 },
      { upc: '200000000003', name: 'Extraction Failed Product', brandHint: 'Alpha', rowNumber: 3 },
      { upc: '200000000004', name: 'Curation Failed Product', brandHint: 'Alpha', rowNumber: 4 },
    ]);
    const [sourcingItem, discoveryItem, extractionItem, curationItem] = items;

    // sourcing / failed — pre-Curation barrier.
    updateItemStageStatus(sourcingItem.id, 'failed', 'simulated sourcing failure');

    // discovery / failed — pre-Curation barrier.
    updateItemStageStatus(discoveryItem.id, 'failed', 'simulated discovery failure');

    // extraction / failed — evidence complete; the failure is the only blocker.
    makeItemExtractionFailed(extractionItem.id);

    // curation / failed — source + extraction data finalized, failed IN curation
    // (past the barrier → NOT a readiness blocker).
    makeItemExtractionReady(curationItem.id, makeExtractionData());
    advanceItemsToNextStage([curationItem.id]); // extraction → curation
    updateItemStageStatus(curationItem.id, 'failed', 'simulated curation failure');

    const byUpc = new Map(listItemsByBatch(batchId).map(i => [i.upc, i]));

    const sourcingReadiness = evaluateItemReadiness(byUpc.get('200000000001')!);
    expect(sourcingReadiness.state).toBe('blocked');
    expect(sourcingReadiness.ready).toBe(false);
    expect(sourcingReadiness.blockedReason).toContain('Sourcing');
    expect(sourcingReadiness.blockedReason).toContain('200000000001');

    const discoveryReadiness = evaluateItemReadiness(byUpc.get('200000000002')!);
    expect(discoveryReadiness.state).toBe('blocked');
    expect(discoveryReadiness.ready).toBe(false);
    expect(discoveryReadiness.blockedReason).toContain('Discovery');
    expect(discoveryReadiness.blockedReason).toContain('200000000002');

    const extractionReadiness = evaluateItemReadiness(byUpc.get('200000000003')!);
    expect(extractionReadiness.state).toBe('blocked');
    expect(extractionReadiness.ready).toBe(false);
    expect(extractionReadiness.blockedReason).toContain('Extraction');
    expect(extractionReadiness.blockedReason).toContain('200000000003');

    // A downstream Curation failure is NOT reinterpreted as an Extraction-readiness failure.
    const curationReadiness = evaluateItemReadiness(byUpc.get('200000000004')!);
    expect(curationReadiness.state).toBe('ready');
    expect(curationReadiness.ready).toBe(true);
    expect(curationReadiness.blockedReason).toBeNull();

    // Invariant regression: no constructed case yields ready === true && state === 'blocked'.
    for (const r of [sourcingReadiness, discoveryReadiness, extractionReadiness, curationReadiness]) {
      expect(r.ready === true && r.state === 'blocked').toBe(false);
    }
  });

  it('binds the selected source to the extraction evidence (round-3 R4)', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    const [itemA, itemB] = items;
    for (const item of items) makeItemExtractionReady(item.id, makeExtractionData());

    // No extraction row → cannot prove a mismatch → consistent + ready.
    const noRow = listItemsByBatch(batchId).find(i => i.id === itemA.id)!;
    expect(noRow.sourceUrl).toBeNull();
    expect(sourceProvenanceConsistent(noRow, undefined)).toBe(true);
    const noRowReadiness = evaluateItemReadiness(noRow);
    expect(noRowReadiness.sourceProvenanceConsistent).toBe(true);
    expect(noRowReadiness.ready).toBe(true);
    expect(noRowReadiness.state).toBe('ready');

    // Extraction row source matches the item's selected source → consistent + ready.
    // (Trailing '/' is normalized on both sides.)
    setDiscoverySourceUrl(itemB.id, 'https://brand.example.com/products/beef');
    insertExtraction({
      itemId: itemB.id,
      sourceUrl: 'https://brand.example.com/products/beef/',
      extractionDataJson: JSON.stringify(makeExtractionData()),
      extractionMethod: 'test',
      confidence: 0.9,
    });
    const matching = listItemsByBatch(batchId).find(i => i.id === itemB.id)!;
    expect(sourceProvenanceConsistent(matching, 'https://brand.example.com/products/beef/')).toBe(true);
    expect(sourceProvenanceConsistent(matching, 'https://brand.example.com/products/beef')).toBe(true);
    const matchingReadiness = evaluateItemReadiness(matching);
    expect(matchingReadiness.sourceProvenanceConsistent).toBe(true);
    expect(matchingReadiness.ready).toBe(true);
    expect(matchingReadiness.state).toBe('ready');

    // Extraction row source A + item source B (changed after extraction) →
    // inconsistent → NOT ready, blocked, deterministic re-extraction reason.
    insertExtraction({
      itemId: itemA.id,
      sourceUrl: 'https://brand.example.com/products/original',
      extractionDataJson: JSON.stringify(makeExtractionData()),
      extractionMethod: 'test',
      confidence: 0.9,
    });
    setDiscoverySourceUrl(itemA.id, 'https://brand.example.com/products/changed');
    const changed = listItemsByBatch(batchId).find(i => i.id === itemA.id)!;
    expect(sourceProvenanceConsistent(changed, 'https://brand.example.com/products/original')).toBe(false);
    const changedReadiness = evaluateItemReadiness(changed);
    expect(changedReadiness.sourceProvenanceConsistent).toBe(false);
    expect(changedReadiness.ready).toBe(false);
    expect(changedReadiness.state).toBe('blocked');
    expect(changedReadiness.blockedReason).toContain('Selected source changed since extraction');
    expect(changedReadiness.blockedReason).toContain('re-extraction');
  });
});
