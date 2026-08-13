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
  getCohortMembers,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  ensureMemberRun,
  getLatestSupersededRunForCohort,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  completeCohortRun,
  supersedeCohortRun,
  supersedeCohortRunIfUnchanged,
  cancelFreezingRun,
  reclaimExpiredCohortRuns,
  getCurrentCohortRun,
  getCohortRunById,
  listCohortRunsByCohort,
  writeExecutionProductType,
  writeFinalMembershipHash,
  writeProductTypeOutcomeOnly,
  failFrozenCohortRunForConflict,
  supersedeOwnedCohortRunForOutputDrift,
  rerunIdleCohortRevision,
  CohortRerunBusyError,
  CohortRerunStageConflictError,
  insertProposalDependency,
  listDependenciesForProposal,
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

  it('getLatestSupersededRunForCohort: the most-recently-superseded run per cohort, cohort-scoped (PR13 C2)', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(runs.length).toBe(2);
    const runA = runs.find(r => r.cohortId === cohorts[0].id)!;
    const runB = runs.find(r => r.cohortId === cohorts[1].id)!;
    expect(freezeAuthorities(runA.id, 'worker-a')).toBe(true);
    expect(freezeAuthorities(runB.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(runA.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(runB.id, 'worker-a')).toBe(true);

    // No superseded run yet → null.
    expect(getLatestSupersededRunForCohort(cohorts[0].id)).toBeNull();
    expect(getLatestSupersededRunForCohort(cohorts[1].id)).toBeNull();

    // Supersede cohort 0's run, then a NEW revision, then supersede it again
    // with a LATER superseded_at — the latest superseded run wins. The two
    // supersedes can land in the SAME millisecond, so the first is stamped
    // EARLIER explicitly to make `ORDER BY superseded_at DESC` unambiguous.
    expect(supersedeCohortRun(runA.id, 'revision 1 superseded')).toBe(true);
    getDb().run(
      'UPDATE classification_cohort_runs SET superseded_at = ? WHERE id = ?',
      ['2000-01-01T00:00:00.000Z', runA.id],
    );
    const retried = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].cohortId).toBe(cohorts[0].id);
    expect(supersedeCohortRun(retried[0].id, 'revision 2 superseded')).toBe(true);

    const latest = getLatestSupersededRunForCohort(cohorts[0].id);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(retried[0].id);
    expect(latest!.status).toBe('superseded');
    expect(latest!.supersededAt).not.toBeNull();
    // Cohort-scoped: cohort 1's run is NOT superseded and is never returned
    // for cohort 0 (nor does cohort 0's superseded run leak into cohort 1).
    expect(getLatestSupersededRunForCohort(cohorts[1].id)).toBeNull();
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

    // PR3 hardening (Commit A): expiry timestamps compare to NOW.
    const nowIso = new Date().toISOString();
    const result = reclaimExpiredCohortRuns(wsId, nowIso, () => 'match', 'worker-b', COHORT_LEASE_TTL_MS);
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

    const nowIso = new Date().toISOString();
    const result = reclaimExpiredCohortRuns(wsId, nowIso, () => 'drift', 'worker-b', COHORT_LEASE_TTL_MS);
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

  it('R1 time math: a lease is reclaimable the moment it passes its TTL — expiry timestamps compare to NOW, not now − TTL', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;

    // The lease expired 30 seconds ago (well inside one full TTL). Under the
    // pre-hardening semantics (`lease_expires_at < now - TTL`) this row would
    // only be reclaimable after ~2×TTL; with NOW semantics it is immediately
    // reclaimable.
    getDb().run(
      'UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?',
      [new Date(Date.now() - 30_000).toISOString(), run.id],
    );

    const result = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), () => 'match', 'worker-b', COHORT_LEASE_TTL_MS);
    expect(result.resumed.length).toBe(1);
    expect(result.resumed[0].id).toBe(run.id);
  });

  it('R1 reclaim CAS race (a): a second reclaim with the pre-resume observed state cannot clobber a first reclaim', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);

    // B selects the expired row. Between B's SELECT and B's CAS UPDATE, A
    // reclaims the run first — simulated by running A's reclaim inside B's
    // verifyFrozen hook, so B's observed {claimed_by, lease_expires_at} is
    // stale by the time B's resume CAS runs.
    let aRan = false;
    const resultB = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), selected => {
      if (!aRan && selected.id === run.id) {
        aRan = true;
        const resultA = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), () => 'match', 'worker-a2', COHORT_LEASE_TTL_MS);
        expect(resultA.resumed.length).toBe(1);
        expect(resultA.resumed[0].id).toBe(run.id);
      }
      return 'match';
    }, 'worker-b2', COHORT_LEASE_TTL_MS);
    expect(aRan).toBe(true);

    // B's CAS failed (row changed since selection): the run is NOT in B's
    // result and A's claim is intact — the run is never handed out twice.
    expect(resultB.resumed.length).toBe(0);
    expect(resultB.superseded.length).toBe(0);
    const after = getCohortRunById(run.id)!;
    expect(after.claimedBy).toBe('worker-a2');
    expect(after.status).toBe('freezing');
  });

  it('R1 reclaim CAS race (b): a stale drift verdict cannot supersede a run another worker already resumed', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);

    // B selects the expired row and reaches a DRIFT verdict; inside B's
    // verifyFrozen hook A resumes the run first (fresh claim under worker-a2).
    // B's drift supersede must then fail its CAS — R stays A's.
    let aRan = false;
    const resultB = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), selected => {
      if (!aRan && selected.id === run.id) {
        aRan = true;
        const resultA = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), () => 'match', 'worker-a2', COHORT_LEASE_TTL_MS);
        expect(resultA.resumed.length).toBe(1);
      }
      return 'drift'; // stale verdict against pre-A state
    }, 'worker-b2', COHORT_LEASE_TTL_MS);
    expect(aRan).toBe(true);

    expect(resultB.superseded.length).toBe(0);
    expect(resultB.resumed.length).toBe(0);
    const after = getCohortRunById(run.id)!;
    expect(after.status).toBe('freezing');
    expect(after.claimedBy).toBe('worker-a2');
    expect(after.supersededAt).toBeNull();
  });

  it('R1 reclaim CAS race (c): the resume CAS compares the OBSERVED status — a freezing→running transition between SELECT and UPDATE is never handed out', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs.find(r => r.cohortId === cohorts[0].id)!;
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);

    // B selects the expired null-hash `freezing` row (crash mid-freeze → its
    // vacuous-match verdict is stale). Between B's SELECT and B's resume CAS,
    // the ORIGINAL owner finalizes the freeze: writes the frozen authorities
    // and transitions `freezing → running` with owner/lease untouched
    // (`transitionCohortRunToRunning` requires claimed_by = worker-a). B's
    // resume must then fail its STATUS CAS — the now-running row is NOT
    // handed out and stays under worker-a.
    let aRan = false;
    const resultB = reclaimExpiredCohortRuns(wsId, new Date().toISOString(), selected => {
      if (!aRan && selected.id === run.id) {
        aRan = true;
        expect(selected.status).toBe('freezing');
        expect(selected.evidenceSnapshotHash).toBeNull();
        expect(freezeAuthorities(run.id, 'worker-a', 'e'.repeat(64))).toBe(true);
        expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
      }
      return 'match'; // stale vacuous-match verdict against the pre-transition state
    }, 'worker-b2', COHORT_LEASE_TTL_MS);
    expect(aRan).toBe(true);

    // B's resume CAS failed (status changed since selection): the run is NOT
    // in B's result, nothing was superseded, and the running row keeps its
    // original owner.
    expect(resultB.resumed.length).toBe(0);
    expect(resultB.superseded.length).toBe(0);
    const after = getCohortRunById(run.id)!;
    expect(after.status).toBe('running');
    expect(after.claimedBy).toBe('worker-a');
    expect(after.startedAt).not.toBeNull();
  });

  it('supersedeCohortRunIfUnchanged is a CAS: matching observed state supersedes + fails children; stale state is a no-op', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const runs = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const run = runs[0]; // freezing (crash mid-freeze candidate)

    // Linked running children (freeze path creates them eagerly).
    const child1 = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    expect(child1.cohortRunId).toBe(run.id);

    const observed = getCohortRunById(run.id)!;
    // Stale observed state (wrong worker) → no-op.
    expect(supersedeCohortRunIfUnchanged(run.id, {
      claimedBy: 'some-other-worker',
      leaseExpiresAt: observed.leaseExpiresAt,
      status: observed.status,
    }, 'stale verdict')).toBe(false);
    expect(getCohortRunById(run.id)!.status).toBe('freezing');
    expect(getRun(child1.id)!.status).toBe('running');

    // Matching observed state → supersedes AND fails the linked running child.
    expect(supersedeCohortRunIfUnchanged(run.id, {
      claimedBy: observed.claimedBy,
      leaseExpiresAt: observed.leaseExpiresAt,
      status: observed.status,
    }, 'Authority drift during lease reclaim')).toBe(true);
    const superseded = getCohortRunById(run.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.errorMessage).toContain('Authority drift during lease reclaim');
    expect(getRun(child1.id)!.status).toBe('failed');

    // No transition out of `superseded`.
    expect(supersedeCohortRunIfUnchanged(run.id, observed, 'again')).toBe(false);
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
      cohortProductTypeConfidenceFloor: 0.7,
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

  it('PR4 C5: parses the env confidence floor with a 0.7 default, fail-closed on garbage, clamped to 0..1', () => {
    // Explicit override.
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: '0.55' }).cohortProductTypeConfidenceFloor).toBe(0.55);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: '0.9' }).cohortProductTypeConfidenceFloor).toBe(0.9);
    // Absent / empty / unparseable fall back to the default (fail closed).
    expect(loadCohortCurationFlags({}).cohortProductTypeConfidenceFloor).toBe(0.7);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: '' }).cohortProductTypeConfidenceFloor).toBe(0.7);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: 'banana' }).cohortProductTypeConfidenceFloor).toBe(0.7);
    // Out-of-range parseable values clamp to the unit interval.
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: '1.7' }).cohortProductTypeConfidenceFloor).toBe(1);
    expect(loadCohortCurationFlags({ BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR: '-0.2' }).cohortProductTypeConfidenceFloor).toBe(0);
  });

  it('runtime override round-trips', () => {
    const flags = overrideCohortCurationFlags({ cohortCurationV2Enabled: true });
    expect(flags.cohortCurationV2Enabled).toBe(true);
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(true);

    resetCohortCurationFlagsOverride();
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);
  });
});

describe('PR4 write-once execution product type + proposal dependencies (issue #30, PR4 C2)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-runs-pr4c2-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('writeExecutionProductType is ownership-guarded and write-once, and the mapper exposes productTypeOutcome', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Wrong worker: no-op, nothing written.
    expect(writeExecutionProductType(run.id, 'worker-b', {
      executionProductTypeId: 'type-1',
      productTypeConfidence: 0.9,
      productTypeOutcome: 'coherent',
    })).toBe(false);
    expect(getCohortRunById(run.id)!.executionProductTypeId).toBeNull();
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBeNull();

    // Owner writes id + confidence + outcome once.
    expect(writeExecutionProductType(run.id, 'worker-a', {
      executionProductTypeId: 'type-1',
      productTypeConfidence: 0.9,
      productTypeOutcome: 'coherent',
    })).toBe(true);
    const written = getCohortRunById(run.id)!;
    expect(written.executionProductTypeId).toBe('type-1');
    expect(written.productTypeConfidence).toBe(0.9);
    expect(written.productTypeOutcome).toBe('coherent');
    expect(written.finalMembershipHash).toBeNull();

    // Write-once: a second write (even by the owner, even a different id) no-ops.
    expect(writeExecutionProductType(run.id, 'worker-a', {
      executionProductTypeId: 'type-2',
      productTypeConfidence: 0.95,
      productTypeOutcome: 'coherent',
    })).toBe(false);
    const after = getCohortRunById(run.id)!;
    expect(after.executionProductTypeId).toBe('type-1');
    expect(after.productTypeConfidence).toBe(0.9);
    expect(after.productTypeOutcome).toBe('coherent');
  });

  it('writeExecutionProductType is status-guarded: only `freezing` runs accept the write', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);

    // The run already left `freezing` — the freeze CAS must write the type
    // BEFORE freezing → running, so this is a no-op.
    expect(writeExecutionProductType(run.id, 'worker-a', {
      executionProductTypeId: 'type-1',
      productTypeConfidence: 0.9,
      productTypeOutcome: 'coherent',
    })).toBe(false);
    expect(getCohortRunById(run.id)!.executionProductTypeId).toBeNull();
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBeNull();
  });

  it('cross-path write-once: a coherent type write never overwrites a prior outcome-only write (abstain then type)', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Path 1: an abstention wrote ONLY the outcome marker (id/confidence stay
    // NULL by design).
    expect(writeProductTypeOutcomeOnly(run.id, 'worker-a', 'abstained')).toBe(true);
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBe('abstained');

    // Path 2: a later coherent resolution must NOT overwrite the write-once
    // outcome — the CAS requires ALL THREE semantic slots to be NULL.
    expect(writeExecutionProductType(run.id, 'worker-a', {
      executionProductTypeId: 'type-1',
      productTypeConfidence: 0.9,
      productTypeOutcome: 'coherent',
    })).toBe(false);
    const after = getCohortRunById(run.id)!;
    expect(after.productTypeOutcome).toBe('abstained');
    expect(after.executionProductTypeId).toBeNull();
    expect(after.productTypeConfidence).toBeNull();
  });

  it('cross-path write-once: an outcome-only write never overwrites a prior coherent type write (type then outcome)', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Path 1: the shared semantic commit wrote the coherent tuple.
    expect(writeExecutionProductType(run.id, 'worker-a', {
      executionProductTypeId: 'type-1',
      productTypeConfidence: 0.9,
      productTypeOutcome: 'coherent',
    })).toBe(true);
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBe('coherent');

    // Path 2: an abstain/conflict outcome-only write must no-op — the
    // outcome slot is taken by the coherent write (write-once).
    expect(writeProductTypeOutcomeOnly(run.id, 'worker-a', 'conflicted')).toBe(false);
    const after = getCohortRunById(run.id)!;
    expect(after.productTypeOutcome).toBe('coherent');
    expect(after.executionProductTypeId).toBe('type-1');
    expect(after.productTypeConfidence).toBe(0.9);
  });

  it('writeFinalMembershipHash is write-once, ownership-guarded, and status-guarded', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Wrong worker: no-op.
    expect(writeFinalMembershipHash(run.id, 'worker-b', 'm'.repeat(64))).toBe(false);
    expect(getCohortRunById(run.id)!.finalMembershipHash).toBeNull();

    // Owner writes once.
    expect(writeFinalMembershipHash(run.id, 'worker-a', 'm'.repeat(64))).toBe(true);
    expect(getCohortRunById(run.id)!.finalMembershipHash).toBe('m'.repeat(64));

    // Write-once: a different hash is never accepted.
    expect(writeFinalMembershipHash(run.id, 'worker-a', 'n'.repeat(64))).toBe(false);
    expect(getCohortRunById(run.id)!.finalMembershipHash).toBe('m'.repeat(64));

    // Status guard: no write after leaving `freezing`.
    const wsId2 = newWorkspace();
    setupFamilyBatch(wsId2);
    const [run2] = claimReadyCurationCohorts(wsId2, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run2.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run2.id, 'worker-a')).toBe(true);
    expect(writeFinalMembershipHash(run2.id, 'worker-a', 'm'.repeat(64))).toBe(false);
    expect(getCohortRunById(run2.id)!.finalMembershipHash).toBeNull();
  });

  it('writeProductTypeOutcomeOnly records abstain/conflict with the id/confidence staying NULL', () => {
    const wsId = newWorkspace();
    setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Wrong worker: no-op.
    expect(writeProductTypeOutcomeOnly(run.id, 'worker-b', 'abstained')).toBe(false);
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBeNull();

    // Owner writes the outcome; the execution id/confidence stay NULL (an
    // abstained run executes with no execution-type context).
    expect(writeProductTypeOutcomeOnly(run.id, 'worker-a', 'abstained')).toBe(true);
    const abstained = getCohortRunById(run.id)!;
    expect(abstained.productTypeOutcome).toBe('abstained');
    expect(abstained.executionProductTypeId).toBeNull();
    expect(abstained.productTypeConfidence).toBeNull();

    // Write-once: a second outcome (even a conflict upgrade) is a no-op.
    expect(writeProductTypeOutcomeOnly(run.id, 'worker-a', 'conflicted')).toBe(false);
    expect(getCohortRunById(run.id)!.productTypeOutcome).toBe('abstained');

    // Conflicted path on a fresh run (never majority-forced; nothing finalized).
    const wsId2 = newWorkspace();
    setupFamilyBatch(wsId2);
    const [run2] = claimReadyCurationCohorts(wsId2, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(writeProductTypeOutcomeOnly(run2.id, 'worker-a', 'conflicted')).toBe(true);
    const conflicted = getCohortRunById(run2.id)!;
    expect(conflicted.productTypeOutcome).toBe('conflicted');
    expect(conflicted.executionProductTypeId).toBeNull();
    expect(conflicted.productTypeConfidence).toBeNull();
    expect(conflicted.finalMembershipHash).toBeNull();

    // Status guard: only `freezing` runs accept the outcome write.
    const wsId3 = newWorkspace();
    setupFamilyBatch(wsId3);
    const [run3] = claimReadyCurationCohorts(wsId3, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run3.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run3.id, 'worker-a')).toBe(true);
    expect(writeProductTypeOutcomeOnly(run3.id, 'worker-a', 'abstained')).toBe(false);
    expect(getCohortRunById(run3.id)!.productTypeOutcome).toBeNull();
  });

  it('failFrozenCohortRunForConflict: owner-guarded freezing→failed DIRECT (started_at stays NULL) and atomically terminalizes every running child (P1-2)', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);

    // Two freeze-created child runs linked to the parent (still `running`).
    ensureMemberRun(run.id, items[0].id, wsId, items[0].upc, null, null);
    ensureMemberRun(run.id, items[1].id, wsId, items[1].upc, null, null);

    // Wrong worker: the whole transaction is a no-op — parent untouched,
    // children untouched.
    expect(failFrozenCohortRunForConflict(run.id, 'worker-b', 'cohort_product_type_conflict: stale')).toBe(false);
    expect(getCohortRunById(run.id)!.status).toBe('freezing');
    expect(getCohortRunById(run.id)!.startedAt).toBeNull();
    expect(getCohortRunById(run.id)!.errorMessage).toBeNull();
    const children = getDb().query('SELECT status FROM classification_runs WHERE cohort_run_id = ?').all(run.id) as Array<{ status: string }>;
    expect(children).toHaveLength(2);
    expect(children.every(c => c.status === 'running')).toBe(true);

    // Owner fails it DIRECTLY from `freezing`: status failed, started_at stays
    // NULL (no transition to running ever happened), completed_at + reason set.
    const reason = 'cohort_product_type_conflict: 2 distinct confident Product Types (dry-cat-food, dry-dog-food); members: ...';
    expect(failFrozenCohortRunForConflict(run.id, 'worker-a', reason)).toBe(true);
    const after = getCohortRunById(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.startedAt).toBeNull();
    expect(after.completedAt).not.toBeNull();
    expect(after.errorMessage).toBe(reason);

    // Every freeze-created child of this parent is terminal with the
    // deterministic conflict reason (same transaction).
    const childrenAfter = getDb().query('SELECT status, error_message, completed_at FROM classification_runs WHERE cohort_run_id = ?').all(run.id) as Array<{ status: string; error_message: string | null; completed_at: string | null }>;
    expect(childrenAfter).toHaveLength(2);
    for (const child of childrenAfter) {
      expect(child.status).toBe('failed');
      expect(child.error_message).toBe('Cohort Product Type conflict prevented member execution');
      expect(child.completed_at).not.toBeNull();
    }

    // A second call (run already terminal) is a no-op — never overwritten.
    expect(failFrozenCohortRunForConflict(run.id, 'worker-a', 'second reason')).toBe(false);
    expect(getCohortRunById(run.id)!.errorMessage).toBe(reason);

    // A run that already left `freezing` (running) is never failed by this
    // helper — the CAS is status-guarded so a conflicted parent can never be
    // failed through `running` (it fails while still freezing, or not at all).
    const wsId2 = newWorkspace();
    setupFamilyBatch(wsId2);
    const [run2] = claimReadyCurationCohorts(wsId2, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run2.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run2.id, 'worker-a')).toBe(true);
    expect(failFrozenCohortRunForConflict(run2.id, 'worker-a', 'cohort_product_type_conflict: late')).toBe(false);
    expect(getCohortRunById(run2.id)!.status).toBe('running');
    expect(getCohortRunById(run2.id)!.errorMessage).toBeNull();
  });

  it('supersedeOwnedCohortRunForOutputDrift: owner-guarded running→superseded DIRECT, atomically terminalizes every running child, wrong owner no-ops (PR6 hardening E)', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);

    // Two freeze-created child runs linked to the parent (still `running`).
    ensureMemberRun(run.id, items[0].id, wsId, items[0].upc, null, null);
    ensureMemberRun(run.id, items[1].id, wsId, items[1].upc, null, null);

    // Wrong owner: the whole transaction is a no-op — parent untouched,
    // children untouched.
    const reason = 'processCohort aborted: CohortTitleAuthorityDriftError: ...';
    expect(supersedeOwnedCohortRunForOutputDrift(run.id, 'worker-b', reason)).toBe(false);
    expect(getCohortRunById(run.id)!.status).toBe('running');
    expect(getCohortRunById(run.id)!.supersededAt).toBeNull();
    expect(getCohortRunById(run.id)!.errorMessage).toBeNull();
    const children = getDb().query('SELECT status FROM classification_runs WHERE cohort_run_id = ?').all(run.id) as Array<{ status: string }>;
    expect(children).toHaveLength(2);
    expect(children.every(c => c.status === 'running')).toBe(true);

    // Owner supersedes it DIRECTLY from `running`: status superseded,
    // superseded_at + reason set; every running child terminalized in the
    // same transaction with the deterministic drift message.
    expect(supersedeOwnedCohortRunForOutputDrift(run.id, 'worker-a', reason)).toBe(true);
    const after = getCohortRunById(run.id)!;
    expect(after.status).toBe('superseded');
    expect(after.supersededAt).not.toBeNull();
    expect(after.errorMessage).toBe(reason);
    const childrenAfter = getDb().query('SELECT status, error_message, completed_at FROM classification_runs WHERE cohort_run_id = ?').all(run.id) as Array<{ status: string; error_message: string | null; completed_at: string | null }>;
    expect(childrenAfter).toHaveLength(2);
    for (const child of childrenAfter) {
      expect(child.status).toBe('failed');
      expect(child.error_message).toBe('Cohort output authority drift superseded parent run');
      expect(child.completed_at).not.toBeNull();
    }

    // A second call (run already superseded) is a no-op — never overwritten.
    expect(supersedeOwnedCohortRunForOutputDrift(run.id, 'worker-a', 'second reason')).toBe(false);
    expect(getCohortRunById(run.id)!.errorMessage).toBe(reason);
  });

  it('rerunIdleCohortRevision: ONE cohort-atomic op — idle TERMINAL parent superseded + children terminalized + EXACT members reset in the same transaction; claim slot reopens (PR10 C1 + review R1)', () => {
    const wsId = newWorkspace();
    const { items, cohorts } = setupFamilyBatch(wsId);
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
    const child = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    // The parent completes with member failures (a blocked member scenario);
    // `claimed_by` is NEVER cleared at completion — the sticky owner is
    // historical ownership evidence, not an active claim.
    expect(completeCohortRun(run.id, 'completed_with_member_failures', '1 member failed', { ownerGuard: { workerId: 'worker-a' } })).toBe(true);
    const terminal = getCohortRunById(run.id)!;
    expect(terminal.claimedBy).toBe('worker-a'); // sticky historical ownership

    // Simulate the review state: every cohort member advanced to review.
    const memberIds = getCohortMembers(cohort.id).map(m => m.onboardingItemId);
    for (const id of memberIds) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = '{\"curatedTitle\":\"x\"}' WHERE id = ?", [id]);
    }

    // ONE cohort-atomic re-run: parent superseded + child terminalized +
    // EXACT members reset (curation/pending, curation_data cleared).
    const outcome = rerunIdleCohortRevision(cohort.id, run.id, 'New cohort revision requested by reviewer');
    expect(outcome.superseded).toBe(true);
    expect(outcome.resetMemberCount).toBe(memberIds.length);
    const superseded = getCohortRunById(run.id)!;
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.errorMessage).toContain('New cohort revision');
    // Children terminal (mirrors the drift primitive's child cleanup).
    expect(getRun(child.id)!.status).toBe('failed');
    expect(getRun(child.id)!.errorMessage).toBe('Cohort output authority drift superseded parent run');
    // Old rows stay intact.
    expect(getCohortRunById(run.id)!.evidenceSnapshotHash).toBe('e'.repeat(64));
    expect(getCohortRunById(run.id)!.completedAt).not.toBeNull();
    // EXACT members reset (never batch-wide, never filtered by stage).
    for (const id of memberIds) {
      const item = getDb().query('SELECT stage, stage_status, curation_data_json FROM onboarding_items WHERE id = ?').get(id) as { stage: string; stage_status: string; curation_data_json: string | null };
      expect(item.stage).toBe('curation');
      expect(item.stage_status).toBe('pending');
      expect(item.curation_data_json).toBeNull();
    }

    // Second call (already superseded) rolls back: CohortRerunBusyError, zero
    // mutation — the superseded message is never overwritten.
    expect(() => rerunIdleCohortRevision(cohort.id, run.id, 'again')).toThrow(CohortRerunBusyError);
    expect(getCohortRunById(run.id)!.errorMessage).toContain('New cohort revision');

    // The claim slot reopens: the next claim creates a NEW revision.
    const retried = claimReadyCurationCohorts(wsId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].cohortId).toBe(run.cohortId);
    expect(retried[0].id).not.toBe(run.id);
  });

  it('rerunIdleCohortRevision: a CLAIMED run (running, owner set) is NEVER matched — CohortRerunBusyError with ZERO mutation; the owner-guarded drift variant is the worker path (PR10 C1)', () => {
    const wsId = newWorkspace();
    const { items, cohorts } = setupFamilyBatch(wsId);
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
    const child = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');

    // Members in the review state (so the stage validation passes and the CAS
    // is actually reached — the CAS is the concurrency guard under test).
    for (const id of getCohortMembers(cohort.id).map(m => m.onboardingItemId)) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed' WHERE id = ?", [id]);
    }

    // A reviewer-facing re-run must never yank a live worker: the idle CAS
    // fails inside the transaction -> CohortRerunBusyError, zero mutation.
    expect(() => rerunIdleCohortRevision(cohort.id, run.id, 'New cohort revision requested by reviewer')).toThrow(CohortRerunBusyError);
    const after = getCohortRunById(run.id)!;
    expect(after.status).toBe('running');
    expect(after.supersededAt).toBeNull();
    expect(after.errorMessage).toBeNull();
    expect(getRun(child.id)!.status).toBe('running');

    // The owner-guarded drift variant (worker-side) succeeds with the owner.
    expect(supersedeOwnedCohortRunForOutputDrift(run.id, 'worker-a', 'processCohort output drift')).toBe(true);
    expect(getCohortRunById(run.id)!.status).toBe('superseded');
  });

  it('rerunIdleCohortRevision: TWO cohorts in ONE batch — re-running cohort A leaves EVERY cohort B item byte-equivalent (PR10 review R1, cross-cohort isolation)', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    // setupFamilyBatch forms TWO cohorts: the Purina group (2 items) + the
    // Acme singleton (1 item).
    const cohortA = cohorts.find(c => c.groupKey.includes('purina')) ?? cohorts[0];
    const cohortB = cohorts.find(c => c !== cohortA)!;
    const bMembers = getCohortMembers(cohortB.id).map(m => m.onboardingItemId);
    expect(bMembers.length).toBeGreaterThan(0);
    const [runA] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    // Tie the claimed run to the selected cohort explicitly — the test can
    // never mask a mismatched (cohortId, currentRunId) invocation.
    expect(runA.cohortId).toBe(cohortA.id);
    expect(freezeAuthorities(runA.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(runA.id, 'worker-a')).toBe(true);
    expect(completeCohortRun(runA.id, 'completed_with_member_failures', 'blocked', { ownerGuard: { workerId: 'worker-a' } })).toBe(true);

    // Both cohorts' members in the review state; capture B's full row first.
    for (const id of [...getCohortMembers(cohortA.id).map(m => m.onboardingItemId), ...bMembers]) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = '{\"curatedTitle\":\"x\"}' WHERE id = ?", [id]);
    }
    const bBefore = bMembers.map(id => getDb().query('SELECT stage, stage_status, curation_data_json, claimed_by, claimed_at FROM onboarding_items WHERE id = ?').get(id));

    // Re-run cohort A ONLY.
    const outcome = rerunIdleCohortRevision(cohortA.id, runA.id, 'reviewer');
    expect(outcome.superseded).toBe(true);

    // EVERY cohort B item is byte-equivalent for stage/status/curation/claims.
    bMembers.forEach((id, i) => {
      const after = getDb().query('SELECT stage, stage_status, curation_data_json, claimed_by, claimed_at FROM onboarding_items WHERE id = ?').get(id);
      expect(after).toEqual(bBefore[i]);
    });
  });

  it('rerunIdleCohortRevision: ATOMIC ROLLBACK — a failure after the parent CAS leaves parent, children, and items all unchanged (PR10 review R1)', () => {
    const wsId = newWorkspace();
    const { items, cohorts } = setupFamilyBatch(wsId);
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
    const child = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    expect(completeCohortRun(run.id, 'completed_with_member_failures', 'blocked', { ownerGuard: { workerId: 'worker-a' } })).toBe(true);
    const memberIds = getCohortMembers(cohort.id).map(m => m.onboardingItemId);
    for (const id of memberIds) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = '{\"curatedTitle\":\"x\"}' WHERE id = ?", [id]);
    }

    // Inject a failure AFTER the parent CAS (the test seam) — the whole
    // transaction must roll back.
    expect(() => rerunIdleCohortRevision(cohort.id, run.id, 'reviewer', {
      afterParentSupersede: () => { throw new Error('injected reset failure'); },
    })).toThrow('injected reset failure');

    // Parent unchanged (still the completed run, NOT superseded).
    const parent = getCohortRunById(run.id)!;
    expect(parent.status).toBe('completed_with_member_failures');
    expect(parent.supersededAt).toBeNull();
    // Children unchanged (still running).
    expect(getRun(child.id)!.status).toBe('running');
    // Items unchanged (still review/completed with curation data).
    for (const id of memberIds) {
      const item = getDb().query('SELECT stage, stage_status, curation_data_json FROM onboarding_items WHERE id = ?').get(id) as { stage: string; stage_status: string; curation_data_json: string | null };
      expect(item.stage).toBe('review');
      expect(item.stage_status).toBe('completed');
      expect(item.curation_data_json).not.toBeNull();
    }
  });

  it('rerunIdleCohortRevision: a member OUTSIDE review/curation fails the whole request closed — CohortRerunStageConflictError, ZERO mutation (PR10 review R1, exact membership)', () => {
    const wsId = newWorkspace();
    const { items, cohorts } = setupFamilyBatch(wsId);
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(freezeAuthorities(run.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(run.id, 'worker-a')).toBe(true);
    const child = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');
    expect(completeCohortRun(run.id, 'completed_with_member_failures', 'blocked', { ownerGuard: { workerId: 'worker-a' } })).toBe(true);
    const memberIds = getCohortMembers(cohort.id).map(m => m.onboardingItemId);
    for (const id of memberIds) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed', curation_data_json = '{\"curatedTitle\":\"x\"}' WHERE id = ?", [id]);
    }
    // One member advanced further (promotion) — the re-run contract never
    // silently skips it nor destroys downstream state.
    getDb().run("UPDATE onboarding_items SET stage = 'promotion', stage_status = 'completed' WHERE id = ?", [memberIds[0]]);

    expect(() => rerunIdleCohortRevision(cohort.id, run.id, 'reviewer')).toThrow(CohortRerunStageConflictError);
    // ZERO mutation: parent not superseded, child still running, items unchanged.
    expect(getCohortRunById(run.id)!.status).toBe('completed_with_member_failures');
    expect(getCohortRunById(run.id)!.supersededAt).toBeNull();
    expect(getRun(child.id)!.status).toBe('running');
    const promoted = getDb().query('SELECT stage, stage_status FROM onboarding_items WHERE id = ?').get(memberIds[0]) as { stage: string; stage_status: string };
    expect(promoted.stage).toBe('promotion');
    expect(promoted.stage_status).toBe('completed');
  });

  it('rerunIdleCohortRevision: SELF-AUTHENTICATING CAS — a mismatched (cohortId, currentRunId) pair can never supersede a run of another cohort (PR10-close P2)', () => {
    const wsId = newWorkspace();
    const { cohorts } = setupFamilyBatch(wsId);
    const cohortA = cohorts[0];
    const cohortB = cohorts.find(c => c !== cohortA)!;
    const [runA] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(runA.cohortId).toBe(cohortA.id);
    expect(freezeAuthorities(runA.id, 'worker-a')).toBe(true);
    expect(transitionCohortRunToRunning(runA.id, 'worker-a')).toBe(true);
    expect(completeCohortRun(runA.id, 'completed_with_member_failures', 'blocked', { ownerGuard: { workerId: 'worker-a' } })).toBe(true);
    // Members of BOTH cohorts in review (so the member-stage validation
    // passes and the CAS is the guard under test).
    for (const id of [...getCohortMembers(cohortA.id).map(m => m.onboardingItemId), ...getCohortMembers(cohortB.id).map(m => m.onboardingItemId)]) {
      getDb().run("UPDATE onboarding_items SET stage = 'review', stage_status = 'completed' WHERE id = ?", [id]);
    }

    // Passing cohortB's id with runA's id: the CAS must NOT match (runA
    // belongs to cohortA) — CohortRerunBusyError, ZERO mutation.
    expect(() => rerunIdleCohortRevision(cohortB.id, runA.id, 'reviewer')).toThrow(CohortRerunBusyError);
    expect(getCohortRunById(runA.id)!.status).toBe('completed_with_member_failures');
    expect(getCohortRunById(runA.id)!.supersededAt).toBeNull();

    // The correct pair still succeeds.
    const outcome = rerunIdleCohortRevision(cohortA.id, runA.id, 'reviewer');
    expect(outcome.superseded).toBe(true);
    expect(getCohortRunById(runA.id)!.status).toBe('superseded');
  });

  it('insertProposalDependency is workspace-scoped and FK fail-closed; listDependenciesForProposal round-trips', () => {
    const wsId = newWorkspace();
    const { items } = setupFamilyBatch(wsId);
    const [run] = claimReadyCurationCohorts(wsId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const child = ensureMemberRun(run.id, items[0].id, wsId, items[0].upc ?? 'SKU-1', null, 'snap-hash');

    // A real proposal row to key the dependency off (member SKU proposal).
    const proposalId = randomUUID();
    getDb().run(
      `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', '"type-1"', 0.9, 'pending', ?)`,
      [proposalId, child.id, child.productSku, new Date().toISOString()],
    );

    const dependencyId = insertProposalDependency({
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    });
    expect(dependencyId).toBeTruthy();

    const deps = listDependenciesForProposal(proposalId);
    expect(deps.length).toBe(1);
    expect(deps[0]).toMatchObject({
      id: dependencyId,
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    });
    expect(deps[0].createdAt).not.toBeNull();

    // A second row with the SAME (proposal, kind) is idempotent: the unique
    // (proposal_id, dependency_kind) index + the tuple-equality fast path make
    // an IDENTICAL re-stamp a no-op and return the EXISTING row id (the
    // member commit re-stamps proposals left over from a pre-crash attempt —
    // always with the same workspace/target/hash).
    const dependencyIdAgain = insertProposalDependency({
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    });
    expect(dependencyIdAgain).toBe(dependencyId);
    expect(listDependenciesForProposal(proposalId).length).toBe(1);
    expect(listDependenciesForProposal(proposalId)[0].dependencyValueHash).toBe('h'.repeat(64));

    // PR4 review fix (SHOULD-FIX): a re-stamp under a DIFFERENT tuple on the
    // existing-row path FAILS CLOSED — a changed target, changed hash, or
    // changed workspace is incoherent (the proposal was stamped under a
    // different execution type / workspace) and is never silently blessed as
    // the existing row. The unique (proposal_id, dependency_kind) index
    // forbids a second row, so inserting would only surface a confusing
    // UNIQUE error — throw a descriptive error instead.
    expect(() => insertProposalDependency({
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-2',
      dependencyValueHash: 'h'.repeat(64),
    })).toThrow(/different tuple/);
    expect(() => insertProposalDependency({
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'g'.repeat(64),
    })).toThrow(/different tuple/);
    expect(() => insertProposalDependency({
      workspaceId: 'some-other-workspace',
      proposalId,
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    })).toThrow(/different tuple/);
    // The failing re-stamps never created or mutated rows — the existing
    // tuple is untouched.
    expect(listDependenciesForProposal(proposalId).length).toBe(1);
    expect(listDependenciesForProposal(proposalId)[0]).toMatchObject({
      workspaceId: wsId,
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    });

    // A DIFFERENT dependency_kind is a distinct row (second row, insertion
    // order preserved).
    const dependencyId2 = insertProposalDependency({
      workspaceId: wsId,
      proposalId,
      dependencyKind: 'reviewed_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'i'.repeat(64),
    });
    expect(listDependenciesForProposal(proposalId).length).toBe(2);
    expect(listDependenciesForProposal(proposalId)[1].id).toBe(dependencyId2);

    // Unknown proposal: FK fail-closed.
    expect(() => insertProposalDependency({
      workspaceId: wsId,
      proposalId: 'no-such-proposal',
      dependencyKind: 'execution_product_type',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    })).toThrow(/FOREIGN KEY constraint failed/);

    // Unknown workspace: FK fail-closed. A NEW (proposal, kind) pair is used
    // so the check-then-insert cannot resolve to a pre-existing row — the
    // genuine INSERT path surfaces the workspace FK violation.
    expect(() => insertProposalDependency({
      workspaceId: 'no-such-workspace',
      proposalId,
      dependencyKind: 'workspace_fk_check',
      dependencyTargetId: 'type-1',
      dependencyValueHash: 'h'.repeat(64),
    })).toThrow(/FOREIGN KEY constraint failed/);

    // No dependencies for an unrelated proposal.
    expect(listDependenciesForProposal('unrelated-proposal')).toEqual([]);

    // ON DELETE CASCADE: deleting the proposal removes its dependency rows.
    getDb().run('DELETE FROM classification_proposals WHERE id = ?', [proposalId]);
    expect(listDependenciesForProposal(proposalId)).toEqual([]);
  });
});
