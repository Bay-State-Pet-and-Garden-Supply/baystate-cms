import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
} from '../../db/repositories/onboarding-item-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  ensureMemberRun,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  completeCohortRun,
  supersedeCohortRun,
  cancelFreezingRun,
  reclaimExpiredCohortRuns,
  getCurrentCohortRun,
  getCohortRunById,
  listCohortRunsByCohort,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { getRun } from '../../db/repositories/classification-run-repo';
import {
  DEFAULT_COHORT_CURATION_FLAGS,
  loadCohortCurationFlags,
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import type { CurationCohort } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

let workspacePath: string;

/** A fresh workspace isolates every test scenario (claims are workspace-scoped). */
function newWorkspace(): string {
  const id = randomUUID();
  insertWorkspace({
    id,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  return id;
}

/** Create a batch with two ready candidate cohorts (Purina family + Acme singleton). */
function setupFamilyBatch(wsId: string): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const batchId = createBatch({ workspaceId: wsId, name: 'Cohort Run Batch', fileName: 'cohort-runs.xlsx', totalItems: 3 }).id;
  const items = insertItems(batchId, [
    { upc: '100000000001', name: 'Purina Pro Plan Dog Food Chicken 5 lb', brandHint: 'Purina', rowNumber: 1 },
    { upc: '100000000002', name: 'Purina Pro Plan Dog Food Beef 10 lb', brandHint: 'Purina', rowNumber: 2 },
    { upc: '100000000003', name: 'Acme Bird Seed Sunflower 5 lb', brandHint: 'Acme', rowNumber: 3 },
  ]);
  const formed = refreshCandidateCohorts(wsId, batchId, listItemsByBatch(batchId));
  for (const cohort of formed) updateCohortStatus(cohort.id, 'ready');
  return { batchId, items, cohorts: formed };
}

/** Freeze the mandatory H2 hash so the run may leave `freezing` (CHECK). */
function freezeAuthorities(runId: string, workerId: string, evidenceHash = 'e'.repeat(64)): boolean {
  return freezeCohortRunAuthorities(runId, workerId, { evidenceSnapshotHash: evidenceHash });
}

describe('classification cohort run repo (issue #30, PR3 M1)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-runs-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('claimReadyCurationCohorts creates freezing rows with the claim lease and frozen candidate hash', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(runs.length).toBe(2); // Purina family + Acme singleton

    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    expect(run.status).toBe('freezing');
    expect(run.claimedBy).toBe('worker-a');
    expect(run.claimedAt).not.toBeNull();
    expect(run.leaseExpiresAt).not.toBeNull();
    expect(new Date(run.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    // H1 frozen at claim from the candidate cohort; H2+ authority hashes NULL
    // (the freeze engine captures them before freezing → running).
    expect(run.candidateMembershipHash).toBe(cohorts[0].membershipHash);
    expect(run.evidenceSnapshotHash).toBeNull();
    expect(run.configSnapshotHash).toBeNull();
    expect(run.pageImportHash).toBeNull();
    expect(run.modelPolicyDigest).toBeNull();
    expect(run.finalMembershipHash).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.supersededAt).toBeNull();
  });

  it('two workers claiming the same cohort: the second claim returns [] (unique current-run backstop)', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const first = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(first.length).toBe(2);
    const claimed = first.find(r => r.cohortId === cohorts[0].id)!;

    const second = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(second.length).toBe(0);

    // The first claim's run is still the CURRENT run (DB invariant).
    const current = getCurrentCohortRun(cohorts[0].id);
    expect(current!.id).toBe(claimed.id);
    expect(current!.claimedBy).toBe('worker-a');
  });

  it('two ready cohorts are claimed disjointly across workers', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    expect(cohorts.length).toBe(2);

    const first = claimReadyCurationCohorts(wsId, 1, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(first.length).toBe(1);
    const second = claimReadyCurationCohorts(wsId, 1, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(second.length).toBe(1);

    const claimedCohortIds = [first[0].cohortId, second[0].cohortId].sort();
    expect(claimedCohortIds).toEqual(cohorts.map(c => c.id).sort());
    expect(first[0].claimedBy).toBe('worker-a');
    expect(second[0].claimedBy).toBe('worker-b');

    // Nothing left to claim.
    expect(claimReadyCurationCohorts(wsId, 10, 'worker-c', COHORT_LEASE_TTL_MS).length).toBe(0);
  });

  it('claim is rejected while a current run exists — a completed run is NOT re-claimable', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    for (const run of runs) {
      expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
      expect(completeCohortRun(run.id, 'completed')).toBe(true);
    }

    // Both runs are completed — but a completed run REMAINS the current
    // historical decision until explicitly superseded, so no re-claim.
    const again = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(again.length).toBe(0);
    for (const cohort of cohorts) {
      const current = getCurrentCohortRun(cohort.id);
      expect(current!.status).toBe('completed');
    }
  });

  it('retry path: supersede the current run, then a new claim succeeds in the same flow', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    for (const run of runs) {
      expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
      expect(completeCohortRun(run.id, 'completed')).toBe(true);
    }
    const oldRun = runs.find(r => r.cohortId === cohorts[0].id)!;

    // Intentional retry: supersede the old completed run, then claim again.
    expect(supersedeCohortRun(oldRun.id, 'Intentional retry')).toBe(true);
    const retried = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].cohortId).toBe(cohorts[0].id);
    expect(retried[0].id).not.toBe(oldRun.id);
    expect(retried[0].claimedBy).toBe('worker-b');

    // History: two runs for the cohort, one superseded, one current.
    const history = listCohortRunsByCohort(cohorts[0].id);
    expect(history.length).toBe(2);
    expect(history.some(r => r.id === oldRun.id && r.status === 'superseded')).toBe(true);
    expect(getCurrentCohortRun(cohorts[0].id)!.id).toBe(retried[0].id);
  });

  it('ensureMemberRun is idempotent — the second call returns the same linked child run', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    const child1 = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    const child2 = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    expect(child2.id).toBe(child1.id);
    expect(child1.cohortRunId).toBe(run.id);
    expect(child1.status).toBe('running');
    expect(child1.onboardingItemId).toBe(items[0].id);
  });

  it('freezeCohortRunAuthorities is ownership-guarded (wrong worker no-op)', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Real FK targets for the authority refs (config snapshot + page import).
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO classification_config_snapshots
         (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version, source_commit, config_json, created_at)
       VALUES (?, ?, ?, 1, 1, NULL, '{}', ?)`,
      ['cfg-1', wsId, 'c'.repeat(64), now],
    );
    getDb().run(
      `INSERT INTO page_imports
         (id, workspace_id, source_hash, parser_format_version, status, counts_json, records_json, created_at)
       VALUES (?, ?, ?, '1', 'active', '{}', '{}', ?)`,
      ['page-1', wsId, 'p'.repeat(64), now],
    );

    // Wrong worker: no-op, run stays unfrozen.
    expect(freezeCohortRunAuthorities(run.id, 'worker-b', { evidenceSnapshotHash: 'x'.repeat(64) })).toBe(false);
    expect(getCohortRunById(run.id)!.evidenceSnapshotHash).toBeNull();

    // Owner writes H2–H5.
    expect(freezeCohortRunAuthorities(run.id, 'worker-a', {
      evidenceSnapshotHash: 'e'.repeat(64),
      configSnapshotId: 'cfg-1',
      configSnapshotHash: 'c'.repeat(64),
      pageImportId: 'page-1',
      pageImportHash: 'p'.repeat(64),
      modelPolicyDigest: 'm'.repeat(64),
    })).toBe(true);
    const frozen = getCohortRunById(run.id)!;
    expect(frozen.evidenceSnapshotHash).toBe('e'.repeat(64));
    expect(frozen.configSnapshotId).toBe('cfg-1');
    expect(frozen.configSnapshotHash).toBe('c'.repeat(64));
    expect(frozen.pageImportId).toBe('page-1');
    expect(frozen.pageImportHash).toBe('p'.repeat(64));
    expect(frozen.modelPolicyDigest).toBe('m'.repeat(64));
  });

  it('transitionCohortRunToRunning sets started_at (and fails closed before authorities are frozen)', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // The hash-required CHECK blocks leaving `freezing` without the mandatory
    // evidence hashes — a freeze that never completed can never start.
    expect(() => transitionCohortRunToRunning(run.id, 'worker-a')).toThrow(/CHECK constraint failed/);

    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    // Wrong worker can't transition.
    expect(transitionCohortRunToRunning(run.id, 'worker-b')).toBe(false);
    // Owner transitions; started_at records execution start.
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
    const running = getCohortRunById(run.id)!;
    expect(running.status).toBe('running');
    expect(running.startedAt).not.toBeNull();
    expect(new Date(running.startedAt!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('completeCohortRun is a terminal write-once', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);

    expect(completeCohortRun(run.id, 'completed')).toBe(true);
    const completed = getCohortRunById(run.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();

    // A terminal run is never overwritten — even by a failure.
    expect(completeCohortRun(run.id, 'failed', 'too late')).toBe(false);
    expect(getCohortRunById(run.id)!.status).toBe('completed');
    expect(getCohortRunById(run.id)!.errorMessage).toBeNull();

    // completed_with_member_failures exists NOW (D1).
    const second = setupFamilyBatch(wsId);
    const secondRuns = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run2 = secondRuns.find(r => r.cohortId === second.cohorts[0].id)!;
    expect(freezeAuthorities(run2.id, 'worker-a')).toBe(true);
    expect(completeCohortRun(run2.id, 'completed_with_member_failures', '2 members failed')).toBe(true);
    const mixed = getCohortRunById(run2.id)!;
    expect(mixed.status).toBe('completed_with_member_failures');
    expect(mixed.errorMessage).toBe('2 members failed');
  });

  it('supersedeCohortRun works from ANY state (incl. completed) and fails linked running children', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs[0]; // freezing (crash mid-freeze candidate)

    // Child SKU runs linked to the parent (freeze path creates them eagerly).
    const child1 = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    const child2 = ensureMemberRun(run.id, items[1].id, wsId, items[1].upc ?? 'SKU-2', null, 'snap-hash');
    expect(child1.cohortRunId).toBe(run.id);
    expect(child2.cohortRunId).toBe(run.id);

    // Supersede from `freezing` (crash mid-freeze): children fail, run superseded.
    expect(supersedeCohortRun(run.id, 'Authority drift during lease reclaim')).toBe(true);
    const superseded = getCohortRunById(run.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.errorMessage).toContain('Authority drift');
    // Linked running children are failed so one-running-item never blocks a retry.
    expect(getRun(child1.id)!.status).toBe('failed');
    expect(getRun(child1.id)!.errorMessage).toBe('Superseded by cohort run supersession');
    expect(getRun(child2.id)!.status).toBe('failed');
    expect(getRun(child2.id)!.completedAt).not.toBeNull();
    // No transition out of `superseded`.
    expect(supersedeCohortRun(run.id, 'again')).toBe(false);
    expect(completeCohortRun(run.id, 'failed')).toBe(false);

    // Supersede from `completed` too (batch 2).
    const second = setupFamilyBatch(wsId);
    const secondRuns = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const completedRun = secondRuns.find(r => r.cohortId === second.cohorts[0].id)!;
    expect(freezeAuthorities(completedRun.id, 'worker-a')).toBe(true);
    expect(completeCohortRun(completedRun.id, 'completed')).toBe(true);
    expect(supersedeCohortRun(completedRun.id, 'Completed-run drift')).toBe(true);
    expect(getCohortRunById(completedRun.id)!.status).toBe('superseded');
    expect(getCohortRunById(completedRun.id)!.supersededAt).not.toBeNull();
  });

  it('reclaimExpiredCohortRuns resumes the SAME run on match (reassign worker, keep id, fresh lease)', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;

    // Age the lease into the past (crashed owner).
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);

    const staleBefore = new Date().toISOString();
    const result = reclaimExpiredCohortRuns(wsId, staleBefore, () => 'match', 'worker-b', COHORT_LEASE_TTL_MS);
    expect(result.superseded.length).toBe(0);
    expect(result.resumed.length).toBe(1);

    // SAME run id resumed — never a new run.
    const resumed = result.resumed[0];
    expect(resumed.id).toBe(run.id);
    expect(resumed.claimedBy).toBe('worker-b');
    expect(new Date(resumed.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(getCohortRunById(run.id)!.status).toBe('freezing');

    // A resumed run is still CURRENT — a new claim is blocked.
    expect(claimReadyCurationCohorts(wsId, 10, 'worker-c', COHORT_LEASE_TTL_MS).length).toBe(0);
  });

  it('reclaimExpiredCohortRuns supersedes on drift and the next claim creates a NEW run', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    // Frozen authorities were captured (stale) before the lease expired —
    // authority drift means they no longer match current upstream state.
    expect(freezeAuthorities(run.id, 'worker-a', 'old-stale-h2')).toBe(true);
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);

    const staleBefore = new Date().toISOString();
    const result = reclaimExpiredCohortRuns(wsId, staleBefore, () => 'drift', 'worker-b', COHORT_LEASE_TTL_MS);
    expect(result.resumed.length).toBe(0);
    expect(result.superseded.length).toBe(1);
    expect(result.superseded[0].id).toBe(run.id);
    expect(getCohortRunById(run.id)!.status).toBe('superseded');

    // The cohort stays READY; the next claim creates a brand-new run against
    // fresh frozen authorities (epic: Cohort C1 / Run 1 → superseded; Run 2 → active).
    const retried = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].cohortId).toBe(cohorts[0].id);
    expect(retried[0].id).not.toBe(run.id);
  });

  it('cancelFreezingRun cancels a freezing run (terminal) and frees the slot only after supersede', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;

    expect(cancelFreezingRun(run.id, 'Freeze could never finalize')).toBe(true);
    const cancelled = getCohortRunById(run.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completedAt).not.toBeNull();
    expect(cancelled.errorMessage).toBe('Freeze could never finalize');

    // Write-once: a second cancel is a no-op.
    expect(cancelFreezingRun(run.id, 'again')).toBe(false);

    // A cancelled run is NOT superseded — it stays the current decision, so a
    // claim is still blocked until the retry path explicitly supersedes it.
    expect(claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS).length).toBe(0);
    expect(supersedeCohortRun(run.id, 'Retry after cancel')).toBe(true);
    const retried = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].cohortId).toBe(cohorts[0].id);
    expect(retried[0].id).not.toBe(run.id);
  });
});

describe('cohort curation flags (issue #30, PR3 M1)', () => {
  afterEach(() => resetCohortCurationFlagsOverride());

  it('defaults to everything OFF (byte-identical legacy behavior)', () => {
    expect(DEFAULT_COHORT_CURATION_FLAGS).toEqual({
      cohortCurationV2Enabled: false,
      cohortShadowOnly: true,
    });
    expect(loadCohortCurationFlags({})).toEqual(DEFAULT_COHORT_CURATION_FLAGS);
    expect(getCohortCurationFlags()).toEqual(DEFAULT_COHORT_CURATION_FLAGS);
  });

  it('parses env fail-closed (unparseable values fall back to OFF)', () => {
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2: 'true' }).cohortCurationV2Enabled).toBe(true);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2: 'TRUE' }).cohortCurationV2Enabled).toBe(true);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2: '1' }).cohortCurationV2Enabled).toBe(true);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2: 'banana' }).cohortCurationV2Enabled).toBe(false);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY: 'yes' }).cohortShadowOnly).toBe(true);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY: '0' }).cohortShadowOnly).toBe(false);
    expect(loadCohortCurationFlags({
      BAYSTATE_CMS_COHORT_CURATION_V2: 'garbage',
      BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY: 'garbage',
    })).toEqual(DEFAULT_COHORT_CURATION_FLAGS);
  });

  it('runtime override round-trips', () => {
    const flags = overrideCohortCurationFlags({ cohortCurationV2Enabled: true });
    expect(flags.cohortCurationV2Enabled).toBe(true);
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(true);

    resetCohortCurationFlagsOverride();
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);
  });
});
