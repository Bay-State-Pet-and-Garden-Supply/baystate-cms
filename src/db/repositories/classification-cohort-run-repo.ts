/**
 * Cohort run repository (issue #30, PR3 M1).
 *
 * Function module (no class): snake_case row interfaces + camelCase mappers,
 * `randomUUID()` ids, ISO `now()` timestamps, positional `?` params, and
 * `db.transaction(() => {})()` for multi-table writes — following the
 * curation-cohort-repo / classification-run-repo conventions.
 *
 * Lifecycle (PR3 M1 contract): `claimReadyCurationCohorts` atomically inserts
 * a `freezing` run row with the claim lease and the frozen candidate
 * membership hash (H1 = cohort.membership_hash at claim). `freezing → running`
 * happens only after the freeze engine's final CAS transaction commits
 * (M2); the M1 primitives are `freezeCohortRunAuthorities` (ownership-guarded
 * authority write) + `transitionCohortRunToRunning`. Terminal writes are
 * `completeCohortRun` (write-once) and `supersedeCohortRun` (settable from
 * ANY state including terminal ones; also fails linked running children so
 * `idx_classification_runs_one_running_item` never blocks a member retry).
 *
 * The unique partial index `idx_classification_cohort_runs_current`
 * (`cohort_id WHERE status != 'superseded'`) is the DB-level race backstop:
 * at most one current run per cohort, and superseding frees the slot for a
 * legitimate retry. `getCurrentCohortRun` reads that invariant directly.
 *
 * Reclaim (PR3 hardening, Commit A): `reclaimExpiredCohortRuns` compares
 * `lease_expires_at < :nowIso` (expiry timestamps compare to NOW — callers pass
 * `new Date().toISOString()`, never `now - TTL`). RESUME is a CAS on the
 * observed `{claimed_by, lease_expires_at, status}` (the EXACT observed status
 * — Commit A2): `changes === 0` means the row changed since selection
 * (another worker resumed it, it left the observed status, or it was
 * finalized/transitioned in place) and the run is NEVER handed out. The drift
 * branch supersedes via `supersedeCohortRunIfUnchanged` — a stale drift
 * verdict can never supersede a run another worker already resumed.
 */
import { getDb } from '../connection';
import { createRun, getRun } from './classification-run-repo';
import { randomUUID } from 'node:crypto';
import type { ClassificationRunRow } from './classification-run-repo';
import type { CohortRun } from '../../shared/schemas/cohorts';

const now = () => new Date().toISOString();

// ─── Row interface (snake_case) ───────────────────────────────────────────────

export interface CohortRunRow {
  id: string;
  workspace_id: string;
  cohort_id: string;
  candidate_membership_hash: string;
  final_membership_hash: string | null;
  evidence_snapshot_hash: string | null;
  evidence_snapshot_id: string | null;
  config_snapshot_id: string | null;
  config_snapshot_hash: string | null;
  page_import_id: string | null;
  page_import_hash: string | null;
  model_policy_digest: string | null;
  execution_product_type_id: string | null;
  product_type_confidence: number | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  superseded_at: string | null;
  created_at: string;
}

// ─── Mapper (snake → camel) ───────────────────────────────────────────────────

export function mapCohortRunRow(row: Record<string, any>): CohortRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cohortId: row.cohort_id,
    candidateMembershipHash: row.candidate_membership_hash,
    finalMembershipHash: row.final_membership_hash ?? null,
    evidenceSnapshotHash: row.evidence_snapshot_hash ?? null,
    evidenceSnapshotId: row.evidence_snapshot_id ?? null,
    configSnapshotId: row.config_snapshot_id ?? null,
    configSnapshotHash: row.config_snapshot_hash ?? null,
    pageImportId: row.page_import_id ?? null,
    pageImportHash: row.page_import_hash ?? null,
    modelPolicyDigest: row.model_policy_digest ?? null,
    executionProductTypeId: row.execution_product_type_id ?? null,
    productTypeConfidence: row.product_type_confidence === null || row.product_type_confidence === undefined ? null : Number(row.product_type_confidence),
    status: row.status,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    errorMessage: row.error_message ?? null,
    supersededAt: row.superseded_at ?? null,
    createdAt: row.created_at,
  };
}

// ─── Claim / lease ────────────────────────────────────────────────────────────

/**
 * Default cohort claim lease TTL. A multi-SKU cohort curation (freeze + N
 * pipeline runs + OCR + model calls) exceeds the item-claim window, so the
 * cohort lease gets its own tunable TTL (heartbeat piggybacks on member
 * boundaries in M3).
 */
export const COHORT_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Atomically claim up to `limit` ready curation cohorts for `workerId`.
 *
 * One INSERT...SELECT: creates a `freezing` run row per claimed cohort with
 * the claim lease (`claimed_by`/`claimed_at`/`lease_expires_at`), the frozen
 * `candidate_membership_hash` copied from the candidate cohort, and all frozen
 * authority hashes NULL (they are captured by the freeze engine before the
 * `freezing → running` transition).
 *
 * Guards: the cohort must be `ready` AND have no current (non-superseded)
 * run. The unique partial index `idx_classification_cohort_runs_current` is
 * the DB backstop — a simultaneous second writer either matches 0 rows or
 * throws UNIQUE; both resolve to `[]` (lose the race, claim nothing).
 *
 * The run row is the claim: nothing on `curation_cohorts` changes when a
 * cohort is claimed ("Curation running" is derived from run rows).
 */
export function claimReadyCurationCohorts(
  workspaceId: string,
  limit: number,
  workerId: string,
  leaseTtlMs: number,
): CohortRun[] {
  const db = getDb();
  const nowIso = now();
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

  try {
    // Single atomic INSERT...SELECT (autocommit, one statement) claiming up to
    // `limit` ready cohorts that have no current (non-superseded) run.
    // RETURNING captures the exact inserted rows — unlike the item-claim
    // (workerId, claimed_at) read-back, an INSERT can return its own rows, so
    // two claims from the same worker within one millisecond can never be
    // confused. Guards: the cohort must be `ready` AND have no current run
    // (duplicated outer guards mirror the claimItemsForProcessing idiom); the
    // unique partial index idx_classification_cohort_runs_current is the DB
    // backstop.
    const rows = db.query(
      `INSERT INTO classification_cohort_runs
        (id, workspace_id, cohort_id, candidate_membership_hash, status,
         claimed_by, claimed_at, lease_expires_at, created_at)
       SELECT lower(hex(randomblob(16))), c.workspace_id, c.id, c.membership_hash, 'freezing',
              ?, ?, ?, ?
       FROM curation_cohorts c
       WHERE c.id IN (
         SELECT c2.id FROM curation_cohorts c2
         WHERE c2.workspace_id = ? AND c2.status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM classification_cohort_runs r
             WHERE r.cohort_id = c2.id AND r.status != 'superseded'
           )
         ORDER BY c2.updated_at ASC
         LIMIT ?
       )
       AND c.status = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM classification_cohort_runs r
         WHERE r.cohort_id = c.id AND r.status != 'superseded'
       )
       RETURNING *`,
    ).all(workerId, nowIso, leaseExpiresAt, nowIso, workspaceId, limit) as Record<string, any>[];
    return rows.map(mapCohortRunRow);
  } catch (err) {
    // Race loser against idx_classification_cohort_runs_current: resolve to
    // an empty claim (refreshCandidateCohorts precedent).
    const isUniqueRace = err instanceof Error && err.message.includes('UNIQUE constraint failed');
    if (isUniqueRace) return [];
    throw err;
  }
}

// ─── Child member runs (freeze path) ──────────────────────────────────────────

/**
 * Idempotent child-run create/lookup for a cohort member (PR3 M1). Returns
 * the existing RUNNING child run linked to this parent cohort run for the
 * item when one exists; otherwise creates it via `createRun` with the
 * `cohortRunId` linkage. Crash recovery reuses this instead of blindly
 * creating duplicate running rows (which the one-running-item index would
 * reject anyway).
 */
export function ensureMemberRun(
  parentRunId: string,
  itemId: string,
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
): ClassificationRunRow {
  const existing = getDb().query(
    `SELECT * FROM classification_runs
     WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
  ).get(parentRunId, itemId) as Record<string, any> | undefined;
  if (existing) return createRunLookup(existing.id);
  return createRun(workspaceId, sku, configSnapshotId, configSnapshotHash, {
    onboardingItemId: itemId,
    cohortRunId: parentRunId,
  });
}

function createRunLookup(runId: string): ClassificationRunRow {
  const row = getRun(runId);
  if (!row) throw new Error(`Member classification run ${runId} disappeared`);
  return row;
}

// ─── Freeze authorities (ownership-guarded) ───────────────────────────────────

export interface FreezeAuthorityFields {
  /** H2 — canonical hash over the frozen member evidence (mandatory). */
  evidenceSnapshotHash: string | null;
  /** Reference to the persisted classification_cohort_snapshots row (PR3 M2). */
  evidenceSnapshotId?: string | null;
  /** H3 — pure bundleHash authority (nullable mirror). */
  configSnapshotId?: string | null;
  configSnapshotHash?: string | null;
  /** H4 — Page catalog identity (nullable mirror). */
  pageImportId?: string | null;
  pageImportHash?: string | null;
  /** H5 — unbound model-execution digest (nullable mirror). */
  modelPolicyDigest?: string | null;
}

/**
 * Write the frozen authority hashes onto a `freezing` run. Ownership-guarded:
 * the UPDATE matches only when the run is still `freezing` AND claimed by
 * `workerId` — a stale owner can never freeze, a new owner can never freeze
 * another's run. No-op (false) otherwise.
 */
export function freezeCohortRunAuthorities(
  runId: string,
  workerId: string,
  fields: FreezeAuthorityFields,
): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET evidence_snapshot_hash = ?, evidence_snapshot_id = ?, config_snapshot_id = ?, config_snapshot_hash = ?,
         page_import_id = ?, page_import_hash = ?, model_policy_digest = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing'`,
    [
      fields.evidenceSnapshotHash,
      fields.evidenceSnapshotId ?? null,
      fields.configSnapshotId ?? null,
      fields.configSnapshotHash ?? null,
      fields.pageImportId ?? null,
      fields.pageImportHash ?? null,
      fields.modelPolicyDigest ?? null,
      runId,
      workerId,
    ],
  );
  return result.changes > 0;
}

// ─── Lifecycle transitions ────────────────────────────────────────────────────

/**
 * `freezing → running`: the ONLY path to execution. Ownership-guarded. Sets
 * `started_at` (execution start; NULL while freezing). Fails closed via the
 * schema CHECK if the two mandatory evidence hashes are still NULL.
 */
export function transitionCohortRunToRunning(runId: string, workerId: string): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = 'running', started_at = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing'`,
    [now(), runId, workerId],
  );
  return result.changes > 0;
}

const COHORT_RUN_TERMINAL = [
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
  'superseded',
];

/**
 * Terminal write-once completion. A run already in a terminal state (or
 * superseded) is never overwritten. Sets `completed_at` and the optional
 * `error_message`.
 *
 * Owner-guard option (PR3 hardening, Commit A2): when `options.ownerGuard` is
 * provided the UPDATE is additionally CAS'd on `claimed_by = workerId` while
 * the run is still actively held (`status IN ('freezing','running')`) — a
 * stale worker can never write a terminal state onto a run another worker
 * reclaimed. The heartbeat-lost abort path never even attempts a terminal
 * write (the run already belongs to the reclaiming worker); this guard is the
 * defense-in-depth for every other terminal completion.
 */
export function completeCohortRun(
  runId: string,
  status: 'completed' | 'completed_with_abstentions' | 'completed_with_member_failures' | 'failed' | 'cancelled',
  errorMessage?: string,
  options?: { ownerGuard?: { workerId: string } },
): boolean {
  const placeholders = COHORT_RUN_TERMINAL.map(() => '?').join(', ');
  const where: string[] = ['id = ?', `status NOT IN (${placeholders})`];
  const params: (string | number | null)[] = [status, now(), errorMessage ?? null, runId, ...COHORT_RUN_TERMINAL];
  if (options?.ownerGuard) {
    where.push('claimed_by = ?', "status IN ('freezing','running')");
    params.push(options.ownerGuard.workerId);
  }
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = ?, completed_at = ?, error_message = ?
     WHERE ${where.join(' AND ')}`,
    params,
  );
  return result.changes > 0;
}

/**
 * Supersede a run — settable from ANY state (including terminal ones), no
 * transition out of it. Historical rows keep their frozen values. Also fails
 * any linked RUNNING child classification_runs so
 * `idx_classification_runs_one_running_item` never blocks a member retry
 * under a new run (mirrors the stale-requeue / stale-run-cleanup contract).
 * The `reason` is recorded in `error_message` for traceability.
 */
export function supersedeCohortRun(runId: string, reason: string): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND status != 'superseded'`,
      [now(), reason ?? null, runId],
    );
    changes = result.changes;
    db.run(
      `UPDATE classification_runs
       SET status = 'failed', completed_at = ?, error_message = 'Superseded by cohort run supersession'
       WHERE cohort_run_id = ? AND status = 'running'`,
      [now(), runId],
    );
  })();
  return changes > 0;
}

/**
 * Cancel a run still in `freezing` (e.g. a freeze that can never finalize).
 * Terminal `cancelled` + `completed_at` + reason. No-op (false) once the run
 * has left `freezing`.
 */
export function cancelFreezingRun(runId: string, reason?: string): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = 'cancelled', completed_at = ?, error_message = ?
     WHERE id = ? AND status = 'freezing'`,
    [now(), reason ?? null, runId],
  );
  return result.changes > 0;
}

// ─── Heartbeat (lease renewal) ──────────────────────────────────────────────────

/**
 * Renew a cohort run's claim lease. Ownership-guarded: only the run's current
 * `claimed_by` worker may heartbeat, and only while the run is still
 * `freezing` or `running` — a terminal run is never heartbeated. PR3 M3
 * `processCohort` piggybacks the heartbeat on member boundaries (before/after
 * each member, contract A), so a multi-SKU execution stays inside its TTL.
 * Returns false when the run is no longer ours to renew (a sibling worker
 * reclaimed it, or it went terminal/superseded).
 */
export function heartbeatCohortRun(runId: string, workerId: string, leaseTtlMs: number): boolean {
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET lease_expires_at = ?
     WHERE id = ? AND claimed_by = ? AND status IN ('freezing','running')`,
    [leaseExpiresAt, runId, workerId],
  );
  return result.changes > 0;
}

// ─── Reclaim (lease expiry) ───────────────────────────────────────────────────

export interface CohortRunReclaimResult {
  /** Runs whose expired lease was resumed: same run id, new worker, fresh lease. */
  resumed: CohortRun[];
  /** Runs superseded because their frozen authorities no longer match current state. */
  superseded: CohortRun[];
}

/**
 * Reclaim cohort runs whose lease has expired.
 *
 * - `verifyFrozen(run) === 'match'` → RESUME the same run: reassign to
 *   `workerId`, refresh `claimed_at`/`lease_expires_at`, keep the run id
 *   (re-freeze allowed — a crash mid-freeze leaves NULL hashes, which the
 *   production verifier treats as a vacuous match).
 * - `verifyFrozen(run) === 'drift'` → SUPERSEDE the run (and fail its linked
 *   running children); the cohort stays `ready` and the next claim creates a
 *   NEW run against fresh frozen authorities.
 *
 * `verifyFrozen` is injected so the repo stays pure SQL and tests can
 * deterministically force match/drift verdicts.
 *
 * `nowIso` is the caller's NOW (`new Date().toISOString()`): expiry timestamps
 * compare to now, so a lease is reclaimable the moment `lease_expires_at`
 * passes `now` — never only after a full extra TTL has elapsed.
 */
export function reclaimExpiredCohortRuns(
  workspaceId: string,
  nowIso: string,
  verifyFrozen: (run: CohortRun) => 'match' | 'drift',
  workerId: string,
  leaseTtlMs: number,
): CohortRunReclaimResult {
  const db = getDb();
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  const expired = db.query(
    `SELECT * FROM classification_cohort_runs
     WHERE workspace_id = ? AND status IN ('freezing','running')
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)
     ORDER BY created_at ASC`,
  ).all(workspaceId, nowIso) as Record<string, any>[];

  const resumed: CohortRun[] = [];
  const superseded: CohortRun[] = [];
  for (const row of expired) {
    const run = mapCohortRunRow(row);
    if (verifyFrozen(run) === 'match') {
      // RESUME is a CAS on the state observed at SELECT time: reassign the
      // worker and refresh the lease ONLY when the row is unchanged since
      // selection — including its EXACT observed status (Commit A2). changes
      // === 0 ⇒ a sibling worker already resumed (or the run left the
      // observed state, e.g. it was finalized freezing → running in place)
      // ⇒ this run is NEVER handed out twice.
      const updated = db.run(
        `UPDATE classification_cohort_runs
         SET claimed_by = ?, claimed_at = ?, lease_expires_at = ?
         WHERE id = ? AND status = ?
           AND claimed_by IS ? AND lease_expires_at IS ?`,
        [workerId, nowIso, leaseExpiresAt, run.id, run.status, run.claimedBy, run.leaseExpiresAt],
      );
      if (updated.changes > 0) {
        const resumedRow = getCohortRunById(run.id);
        if (resumedRow) resumed.push(resumedRow);
      }
    } else {
      // Drift verdict is ONLY applied via the observed-state CAS: a stale
      // drift verdict (row already resumed by another worker) must never
      // supersede that worker's fresh claim.
      const supersededOk = supersedeCohortRunIfUnchanged(
        run.id,
        { claimedBy: run.claimedBy, leaseExpiresAt: run.leaseExpiresAt, status: run.status },
        'Authority drift during lease reclaim',
      );
      if (supersededOk) {
        const supersededRow = getCohortRunById(run.id);
        if (supersededRow) superseded.push(supersededRow);
      }
    }
  }
  return { resumed, superseded };
}

/**
 * CAS-guarded supersession. Supersedes the run ONLY when it still matches the
 * `observed` state (owner, lease expiry, status) captured at selection time —
 * `changes > 0` only then. On success the linked RUNNING child classification
 * runs are failed so `idx_classification_runs_one_running_item` never blocks a
 * member retry under a new run (mirrors `supersedeCohortRun`). Returns false
 * when the row changed since selection (never hand out / never supersede).
 * The reclaim drift branch uses ONLY this function.
 */
export function supersedeCohortRunIfUnchanged(
  runId: string,
  observed: { claimedBy: string | null; leaseExpiresAt: string | null; status: string },
  reason: string,
): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND claimed_by IS ? AND lease_expires_at IS ? AND status = ?`,
      [now(), reason ?? null, runId, observed.claimedBy, observed.leaseExpiresAt, observed.status],
    );
    changes = result.changes;
    if (changes > 0) {
      db.run(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Superseded by cohort run supersession'
         WHERE cohort_run_id = ? AND status = 'running'`,
        [now(), runId],
      );
    }
  })();
  return changes > 0;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * The CURRENT run for a cohort — the DB invariant: at most one row with
 * `status != 'superseded'` (enforced by
 * `idx_classification_cohort_runs_current`). A completed/failed run REMAINS
 * the current historical decision until something explicitly supersedes it.
 */
export function getCurrentCohortRun(cohortId: string): CohortRun | null {
  const row = getDb().query(
    `SELECT * FROM classification_cohort_runs
     WHERE cohort_id = ? AND status != 'superseded'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(cohortId) as Record<string, any> | undefined;
  return row ? mapCohortRunRow(row) : null;
}

export function getCohortRunById(id: string): CohortRun | null {
  const row = getDb().query(
    'SELECT * FROM classification_cohort_runs WHERE id = ?',
  ).get(id) as Record<string, any> | undefined;
  return row ? mapCohortRunRow(row) : null;
}

export function listCohortRunsByCohort(cohortId: string): CohortRun[] {
  const rows = getDb().query(
    `SELECT * FROM classification_cohort_runs
     WHERE cohort_id = ? ORDER BY created_at ASC`,
  ).all(cohortId) as Record<string, any>[];
  return rows.map(mapCohortRunRow);
}

// ─── Execution-evidence snapshots (PR3 M2) ────────────────────────────────────

/**
 * Persist a content-addressed execution-evidence snapshot. `UNIQUE
 * (workspace_id, snapshot_hash)` dedupes identical payloads to the same row
 * (an INSERT race loser retries the lookup). Returns the row id + hash.
 */
export function persistCohortSnapshot(input: {
  workspaceId: string;
  /** H2 digest over the payload (content-addressed identity). */
  snapshotHash: string;
  projectionVersion: string;
  payloadJson: string;
}): { id: string; hash: string } {
  const db = getDb();
  const existing = db.query(
    'SELECT id FROM classification_cohort_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(input.workspaceId, input.snapshotHash) as { id: string } | undefined;
  if (existing) return { id: existing.id, hash: input.snapshotHash };

  const id = randomUUID();
  try {
    db.run(
      `INSERT INTO classification_cohort_snapshots
       (id, workspace_id, snapshot_hash, snapshot_kind, projection_version, payload_json, created_at)
       VALUES (?, ?, ?, 'evidence', ?, ?, ?)`,
      [id, input.workspaceId, input.snapshotHash, input.projectionVersion, input.payloadJson, now()],
    );
  } catch (err) {
    // UNIQUE race loser against (workspace_id, snapshot_hash): the row exists.
    const isUniqueRace = err instanceof Error && err.message.includes('UNIQUE constraint failed');
    if (!isUniqueRace) throw err;
  }
  const stored = getCohortSnapshotByHash(input.workspaceId, input.snapshotHash);
  if (!stored) {
    throw new Error('Execution-evidence snapshot persistence failed: no stored row.');
  }
  return { id: stored.id, hash: stored.snapshotHash };
}

/** Look up a persisted execution-evidence snapshot by its content hash. */
export function getCohortSnapshotByHash(
  workspaceId: string,
  snapshotHash: string,
): { id: string; snapshotHash: string; payloadJson: string } | null {
  const row = getDb().query(
    'SELECT id, snapshot_hash, payload_json FROM classification_cohort_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(workspaceId, snapshotHash) as { id: string; snapshot_hash: string; payload_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, snapshotHash: row.snapshot_hash, payloadJson: row.payload_json };
}
