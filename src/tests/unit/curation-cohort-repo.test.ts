import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
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
import {
  refreshCandidateCohorts,
  listCohortsByBatch,
  getCohortById,
  getCohortMembers,
  getActiveCohortForItem,
  updateCohortStatus,
  markCohortSuperseded,
  computeMembershipHash,
  computeExtractionHash,
} from '../../db/repositories/curation-cohort-repo';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

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

/** Move an item to `extraction / completed` with evidence satisfying the
 *  extraction completeness contract (sourcing decision + OCR settled). */
function makeItemExtractionReady(itemId: string, extractionData: unknown): void {
  updateItemStageStatus(itemId, 'completed'); // discovery → completed
  advanceItemsToNextStage([itemId]); // discovery → extraction (pending)
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

describe('curation cohort repo (issue #30, PR1+PR2)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohorts-${workspaceId.slice(0, 8)}`);
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

  it('creates candidate cohorts and members from deterministic grouping', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    const cohorts = refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));

    // Purina family (2 members) + Acme singleton (1 member).
    expect(cohorts.length).toBe(2);

    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    expect(purina.groupingVersion).toBe('product-family-v1');
    expect(purina.status).toBe('forming');
    expect(purina.membershipHash).toMatch(/^[a-f0-9]{64}$/);

    const members = getCohortMembers(purina.id);
    expect(members.length).toBe(2);
    expect(members.map(m => m.onboardingItemId).sort()).toEqual([items[0].id, items[1].id].sort());
    expect(members.every(m => m.normalizedBrand === 'purina')).toBe(true);
    expect(members.every(m => m.normalizedNameStem === 'purina pro plan dog food')).toBe(true);
    expect(members.every(m => m.membershipReasonJson?.kind === 'deterministic_grouping')).toBe(true);
    expect(members.every(m => m.extractionHash === null)).toBe(true); // no evidence yet

    const acme = cohorts.find(c => c.groupKey.includes('acme'))!;
    expect(getCohortMembers(acme.id).length).toBe(1);
  });

  it('does not create a new cohort row when membership is unchanged', () => {
    const batchId = newBatch();
    insertFamilyItems(batchId);
    const first = refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const firstPurina = first.find(c => c.groupKey.includes('purina'))!;

    const second = refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const secondPurina = second.find(c => c.groupKey.includes('purina'))!;

    expect(secondPurina.id).toBe(firstPurina.id);
    expect(listCohortsByBatch(batchId).length).toBe(2);
    expect(listCohortsByBatch(batchId, { includeSuperseded: true }).length).toBe(2);
  });

  it('supersedes the old cohort and inserts a new active row when membership changes', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const firstPurina = getActiveCohortForItem(items[0].id)!;
    expect(firstPurina).not.toBeNull();

    // New extraction evidence changes the extraction hash → membership hash.
    makeItemExtractionReady(items[0].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));

    const oldRow = getCohortById(firstPurina.id)!;
    expect(oldRow.status).toBe('superseded');
    expect(oldRow.supersededAt).not.toBeNull();

    const active = listCohortsByBatch(batchId);
    const newPurina = active.find(c => c.groupKey.includes('purina'))!;
    expect(newPurina.id).not.toBe(firstPurina.id);
    expect(newPurina.status).toBe('forming');
    expect(newPurina.membershipHash).not.toBe(firstPurina.membershipHash);
    // exactly one ACTIVE cohort per group
    expect(active.filter(c => c.groupKey.includes('purina')).length).toBe(1);
  });

  it('keeps one ACTIVE cohort per group across two consecutive membership changes', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const firstPurina = getActiveCohortForItem(items[0].id)!;
    const purinaKey = firstPurina.groupKey;

    // First membership change: items[0] completes extraction → hash changes.
    makeItemExtractionReady(items[0].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));

    const activeAfterFirst = listCohortsByBatch(batchId).filter(c => c.groupKey === purinaKey);
    expect(activeAfterFirst.length).toBe(1); // exactly one ACTIVE per group
    expect(activeAfterFirst[0].id).not.toBe(firstPurina.id);
    const supersededFirst = getCohortById(firstPurina.id)!;
    expect(supersededFirst.status).toBe('superseded');
    expect(supersededFirst.supersededAt).not.toBeNull();

    // Second membership change: items[1] completes extraction → hash changes again.
    makeItemExtractionReady(items[1].id, makeExtractionData());
    refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));

    const activeAfterSecond = listCohortsByBatch(batchId).filter(c => c.groupKey === purinaKey);
    expect(activeAfterSecond.length).toBe(1); // still exactly one ACTIVE per group
    const secondCohort = getCohortById(activeAfterFirst[0].id)!;
    expect(secondCohort.status).toBe('superseded');
    expect(secondCohort.supersededAt).not.toBeNull();

    // Full history for the group: three rows, two superseded, one ACTIVE.
    const purinaHistory = listCohortsByBatch(batchId, { includeSuperseded: true }).filter(c => c.groupKey === purinaKey);
    expect(purinaHistory.length).toBe(3);
    expect(purinaHistory.filter(c => c.status === 'superseded' && c.supersededAt != null).length).toBe(2);
    expect(purinaHistory.filter(c => c.status !== 'superseded').length).toBe(1);

    // The unchanged Acme singleton still has a single row that was never superseded.
    const acmeHistory = listCohortsByBatch(batchId, { includeSuperseded: true }).filter(c => c.groupKey.includes('acme'));
    expect(acmeHistory.length).toBe(1);
    expect(acmeHistory[0].supersededAt).toBeNull();
  });

  it('computes an order-insensitive membership hash', () => {
    const forward = computeMembershipHash([
      { itemId: 'item-b', extractionHash: 'h2' },
      { itemId: 'item-a', extractionHash: 'h1' },
    ]);
    const reverse = computeMembershipHash([
      { itemId: 'item-a', extractionHash: 'h1' },
      { itemId: 'item-b', extractionHash: 'h2' },
    ]);
    expect(forward).toBe(reverse);

    const changed = computeMembershipHash([
      { itemId: 'item-a', extractionHash: 'h1' },
      { itemId: 'item-b', extractionHash: null },
    ]);
    expect(changed).not.toBe(forward);
  });

  it('computes stable extraction hashes over the frozen evidence payload', () => {
    const batchId = newBatch();
    const items = insertFamilyItems(batchId);
    makeItemExtractionReady(items[0].id, makeExtractionData());
    makeItemExtractionReady(items[1].id, makeExtractionData());
    const loaded = listItemsByBatch(batchId);
    const loadedA = loaded.find(i => i.id === items[0].id)!;
    const loadedB = loaded.find(i => i.id === items[1].id)!;

    // Identical evidence payloads (same sourcing decision time) → identical hash.
    expect(computeExtractionHash(loadedA)).toBe(computeExtractionHash(loadedB));
    expect(computeExtractionHash(loadedA)).toMatch(/^[a-f0-9]{64}$/);

    // Changed evidence → changed hash.
    updateItemExtractionData(items[0].id, JSON.stringify(makeExtractionData({ title: 'Purina Pro Plan Dog Food Beef' })));
    const loadedA2 = listItemsByBatch(batchId).find(i => i.id === items[0].id)!;
    expect(computeExtractionHash(loadedA2)).not.toBe(computeExtractionHash(loadedA));

    // No extraction data → NULL.
    expect(computeExtractionHash(items[2])).toBeNull();
  });

  it('fails closed when a member item does not exist (FK integrity)', () => {
    const batchId = newBatch();
    const ghostItem = {
      id: randomUUID(),
      batchId,
      upc: '999999999999',
      name: 'Ghost Family Product 5 lb',
      brandHint: 'Ghost',
      rowNumber: 99,
      extractionData: null,
      sourcingDecision: null,
    } as unknown as OnboardingItem;
    expect(() => refreshCandidateCohorts(workspaceId, batchId, [ghostItem])).toThrow();
    // transaction rolled back — no orphan cohort rows remain
    expect(listCohortsByBatch(batchId, { includeSuperseded: true }).length).toBe(0);
  });

  it('enforces one ACTIVE cohort per (batch, group_key, grouping_version)', () => {
    const batchId = newBatch();
    insertFamilyItems(batchId);
    const cohorts = refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;
    const db = getDb();
    const now = new Date().toISOString();
    expect(() =>
      db.query(
        `INSERT INTO curation_cohorts
          (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
           status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, NULL, NULL, NULL)`,
      ).run(randomUUID(), workspaceId, batchId, purina.groupKey, purina.groupLabel, purina.groupingVersion, 'f'.repeat(64), now, now),
    ).toThrow(/UNIQUE/i);
  });

  it('updates cohort status and supports explicit supersession', () => {
    const batchId = newBatch();
    insertFamilyItems(batchId);
    const cohorts = refreshCandidateCohorts(workspaceId, batchId, listItemsByBatch(batchId));
    const purina = cohorts.find(c => c.groupKey.includes('purina'))!;

    updateCohortStatus(purina.id, 'waiting', { blockedReason: 'Waiting for 1 family member to finish Extraction' });
    const waiting = getCohortById(purina.id)!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.blockedReason).toContain('Waiting for');

    markCohortSuperseded(purina.id);
    const superseded = getCohortById(purina.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).not.toBeNull();
    // Only the Acme singleton cohort remains active.
    const activeAfter = listCohortsByBatch(batchId);
    expect(activeAfter.length).toBe(1);
    expect(activeAfter[0].groupKey).not.toContain('purina');
  });
});
