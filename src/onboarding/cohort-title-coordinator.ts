/**
 * Parent cohort title coordinator (issue #30, PR6 C4) — the durable
 * exactly-once parent op.
 *
 * `ensureCohortTitlesCoordinated` runs at `processCohort` start (the single
 * re-entrant parent entry — resume-on-match keeps the same run id, so
 * kill/restart/reclaim and member retries all funnel through here):
 *
 * 1. **Input hash** — `computeCohortTitleInputHash` over FROZEN TITLE
 *    AUTHORITY ONLY (PR6 C2, DECISION-P/Q): the final membership hash, the
 *    per-member frozen title slice, the Execution Product Type resolution,
 *    the FORMAT_RULES digest, and the H5 title slice (policy digest + the
 *    frozen `cohort_title_consolidation` plan entry). Never live item rows,
 *    never the old cache fingerprint, never OCR provenance hashes.
 *
 * 2. **Reuse** — when `classification_cohort_outputs` already hold a
 *    COMPLETE `curated_title` set for this run (every member of every
 *    multi-item group per `groupByProductLine` over the FROZEN sibling views
 *    — DECISION-O: singletons are never coordinated and have no row) AND
 *    every row's `input_hash` equals the freshly computed T-hash, the op
 *    returns the parsed map with ZERO LLM calls.
 *
 * 3. **Drift fails closed (PR6 hardening A)** — when a NONEMPTY committed set
 *    does NOT match the freshly computed T-hash (or is incomplete), the set
 *    is WRITE-ONCE and can never be replaced: the op throws
 *    `CohortTitleAuthorityDriftError` (run id + expected hash + stored
 *    hash(es) + row count) — it NEVER re-coordinates and NEVER replaces.
 *
 * 4. **Coordinate ONCE — only when the set is EMPTY** — under a scoped
 *    `CohortLeaseKeeper`: groups the frozen sibling views, calls the
 *    coordinator's UNCACHED `coordinateCohortItems` with the audited
 *    `cohort_title_consolidation` call bound to the ORDINAL-0 MEMBER CHILD
 *    RUN (DECISION-N, mirroring PR4 DECISION-A) and the keeper's
 *    `assertHeld` as the ownership assertion; then re-asserts ownership
 *    (`keeper.assertHeld()`); then persists every group member's
 *    `{title, source}` (+ the audited `model_call_id` when the call returned
 *    one) via `insertCohortTitleOutputsOnce` — ONE transaction, all-or-
 *    nothing, and any `CohortOutputAlreadyCommittedError` from a commit race
 *    is converted to `CohortTitleAuthorityDriftError` (a race can never
 *    silently split the set). `HeartbeatLostError` propagates unchanged (never
 *    converted into an 'LLM unavailable → fallback' outcome): a stale owner
 *    aborts with NO output rows and the run is left to the reclaiming
 *    sibling, which re-enters and reuses-or-coordinates.
 *
 * 5. Returns the freshly persisted map.
 *
 * Never consults `cohortCache` / `coordinateCohortItemsOnce` — active cohort
 * mode treats the DB outputs as the sole "already coordinated" authority.
 *
 * PR6 review round 1 hardening: the op performs ZERO writes before the lease
 * is asserted (the ordinal-0 child run + its immutable snapshot refs are PURE
 * READ; the reuse path is read-only), the T-hash uses the frozen UNBOUND H5
 * policy digest (H3/H4/evidence changes never re-coordinate titles), and a
 * missing frozen snapshot / plan entry / model-call context FAILS CLOSED
 * before any transport — a non-audited live title call is never made.
 */
import {
  getCohortTitleOutputsByRun,
  insertCohortTitleOutputsOnce,
  CohortOutputAlreadyCommittedError,
} from '../db/repositories/classification-cohort-output-repo';
import type { CohortTitleOutputRow } from '../db/repositories/classification-cohort-output-repo';
import {
  getRuntimeSnapshotByHash,
  requireModelCallContext,
  getModelExecutionPlanEntry,
} from '../classification/runtime-snapshot';
import { getCohortMemberRunForTitleAudit } from '../db/repositories/classification-cohort-run-repo';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { computeCohortTitleInputHash } from './cohort-title-hash';
import { coordinateCohortItems, groupByProductLine } from './cohort-name-coordinator';
import { CohortLeaseKeeper } from './cohort-lease-keeper';
import { COHORT_LEASE_TTL_MS } from '../db/repositories/classification-cohort-run-repo';
import { CohortTitleOutputSchema } from '../shared/schemas/cohorts';
import type { CohortTitleOutput } from '../shared/schemas/cohorts';
import type { FrozenProductLineContext } from './cohort-curator';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionV1,
} from '../shared/schemas/cohorts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse one persisted output row's payload through the shared title schema
 *  (fail-closed on corrupt stored JSON — a corrupt row never yields a title). */
function parseTitleRow(row: CohortTitleOutputRow): CohortTitleOutput {
  return CohortTitleOutputSchema.parse(JSON.parse(row.outputValueJson));
}

/**
 * Deterministic authority-drift signal (PR6 hardening A). Thrown when a
 * NONEMPTY committed `curated_title` set for a run does not match the freshly
 * computed canonical title input hash (or is incomplete). The set is
 * WRITE-ONCE — it can never be replaced, so the op FAILS CLOSED instead of
 * re-coordinating. Carries the run id, the expected (current) hash, the
 * stored hash(es), and the persisted row count. Also thrown when an
 * `insertCohortTitleOutputsOnce` commit-race reports an already-committed set.
 */
export class CohortTitleAuthorityDriftError extends Error {
  readonly runId: string;
  readonly expectedHash: string;
  readonly storedHashes: string[];
  readonly rowCount: number;

  constructor(runId: string, expectedHash: string, storedHashes: string[], rowCount: number) {
    super(
      `[CohortTitleAuthorityDrift] Durable title outputs for run ${runId} are write-once but no longer match the ` +
        `frozen title authority: expected input_hash ${expectedHash}, stored hash(es) [${storedHashes.join(', ')}], ` +
        `${rowCount} row(s). A committed output set can never be replaced — this is corruption or an illegal ` +
        'mutation; failing the run closed without re-coordination.',
    );
    this.name = 'CohortTitleAuthorityDriftError';
    this.runId = runId;
    this.expectedHash = expectedHash;
    this.storedHashes = storedHashes;
    this.rowCount = rowCount;
  }
}

// ─── Parent op ────────────────────────────────────────────────────────────────

export interface EnsureCohortTitlesCoordinatedParams {
  /** The frozen `running` cohort run (final membership + execution type + claim). */
  run: CohortRun;
  workspaceId: string;
  workspacePath: string;
  /** The frozen execution-evidence projection (execution contract). */
  projection: ExecutionEvidenceProjectionV1;
  cohort: CurationCohort;
  members: CurationCohortMember[];
  /** Frozen product-line sibling context (PR3 hardening Commit B / R2). */
  frozenLineContext: FrozenProductLineContext;
}

/**
 * The durable, exactly-once parent title coordination op (PR6 C4). See the
 * module JSDoc for the reuse rule, the lease-wrapped coordinate step, the
 * all-or-nothing persistence, and the `HeartbeatLostError` propagation
 * contract.
 */
export async function ensureCohortTitlesCoordinated(
  params: EnsureCohortTitlesCoordinatedParams,
): Promise<Map<string, CohortTitleOutput>> {
  const { run, workspaceId, projection, frozenLineContext } = params;
  // `workspacePath`, `cohort`, and `members` are accepted for contract
  // symmetry with `processCohort` (which holds all three) but are not title
  // inputs: the frozen sibling views + the run row are the entire authority.

  const frozenItems = frozenLineContext.frozenBatchItems;

  // DECISION-O: singletons are never coordinated and never get an output row.
  // Compute the exact multi-item-group member set with the SAME grouping the
  // coordinator uses (single source of truth).
  const multiMemberSkus = new Set<string>();
  for (const groupItems of groupByProductLine(frozenItems).values()) {
    if (groupItems.length <= 1) continue;
    for (const item of groupItems) {
      if (item.upc) multiMemberSkus.add(item.upc);
    }
  }
  if (multiMemberSkus.size === 0) {
    return new Map();
  }

  // Step 1 — T-hash from FROZEN title authority. The ordinal-0 member child
  // run (DECISION-N audit binding) was created at freeze with the immutable
  // member runtime snapshot refs. PURE READ ONLY (PR6 review BLOCKER 2): the
  // parent op never creates a child and never updates refs before the lease is
  // asserted — a stale pre-reclaim worker can therefore never write. The
  // latest refs-bearing child (running OR terminal — crash-recovery resume may
  // find the ordinal-0 child committed by a prior processCohort entry) is the
  // frozen audit authority; the reuse path performs ZERO writes.
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const member0 = orderedMembers[0];
  const childRun0 = getCohortMemberRunForTitleAudit(run.id, member0.onboardingItemId);
  if (!childRun0 || !childRun0.configSnapshotId || !childRun0.configSnapshotHash) {
    throw new Error(
      `[CohortTitleCoordinator] Ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) has no child run ` +
        'with freeze-persisted snapshot refs — refusing to coordinate titles without the frozen audit authority.',
    );
  }
  // PR6 review BLOCKER 3: the frozen ordinal-0 runtime snapshot is REQUIRED —
  // a missing/corrupt ref fails the parent op closed BEFORE any transport. The
  // title call is ALWAYS audited (`cohort_title_consolidation` bound to the
  // ordinal-0 child run); a non-audited live call is never made.
  const memberSnapshot0 = getRuntimeSnapshotByHash(workspaceId, childRun0.configSnapshotHash);
  if (!memberSnapshot0) {
    throw new Error(
      `[CohortTitleCoordinator] Frozen member runtime snapshot ${childRun0.configSnapshotHash} not found for ` +
        `ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) — refusing to coordinate titles without ` +
        'the frozen audit authority.',
    );
  }
  // PR6 review BLOCKER 1: the T-hash must use the frozen UNBOUND H5 policy
  // digest (routing authority only — NO snapshotHash binding, so H3 config /
  // H4 Pages / evidence changes never change the title hash). The snapshot-
  // bound view is retained ONLY for transport enforcement
  // (`assertModelPolicyIntact` inside the audited call).
  const unboundPolicyView = modelPolicyViewFromConfig(memberSnapshot0.modelPolicy as never);
  const boundPolicyView = modelPolicyViewFromConfig(
    memberSnapshot0.modelPolicy as never,
    memberSnapshot0.snapshotHash,
  );
  const titlePlanEntry = getModelExecutionPlanEntry(memberSnapshot0, 'cohort_title_consolidation');
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    modelPolicyDigest: unboundPolicyView?.policyDigest ?? null,
    titlePlanEntry: titlePlanEntry ?? undefined,
  });

  // Step 2 — REUSE when the persisted set is complete AND every row's hash
  // matches the freshly computed T-hash. Pure reads: no keeper, no LLM, no
  // writes.
  const existingRows = getCohortTitleOutputsByRun(run.id);
  const rowBySku = new Map(existingRows.map(row => [row.productSku, row]));
  const complete = existingRows.length > 0 && [...multiMemberSkus].every(sku => rowBySku.has(sku));
  const hashMatch = existingRows.every(row => row.inputHash === inputHash);
  if (complete && hashMatch) {
    const map = new Map<string, CohortTitleOutput>();
    for (const sku of multiMemberSkus) {
      const row = rowBySku.get(sku)!;
      map.set(sku, parseTitleRow(row));
    }
    console.log(
      `[CohortTitleCoordinator] Reusing ${map.size} durable title outputs for run ${run.id} (complete set + hash match, zero LLM calls).`,
    );
    return map;
  }

  // Step 3 (PR6 hardening A) — WRITE-ONCE: any NONEMPTY committed set that is
  // incomplete or whose rows do not match the freshly computed T-hash is
  // authority drift. The set can never be replaced (the DELETE/replace path
  // is gone), so the op FAILS CLOSED — it NEVER re-coordinates and NEVER
  // deletes. An incomplete nonempty set can only be corruption: the insert is
  // all-or-nothing, so a partial set is never produced by any writer.
  if (existingRows.length > 0) {
    const storedHashes = [...new Set(existingRows.map(row => row.inputHash))];
    throw new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, existingRows.length);
  }

  // Step 4 — coordinate ONCE under a scoped lease keeper + persist
  // all-or-nothing. The keeper renews the parent lease on a TTL/3 cadence
  // while the audited call is in flight; `assertHeld` (forwarded into the
  // transport AND re-asserted after the await) aborts with `HeartbeatLostError`
  // the moment the claim is lost — no output rows are ever written by a stale
  // owner. The coordinate path is reached ONLY when the set is EMPTY (zero
  // rows — see the drift guard above).
  const workerId = run.claimedBy;
  if (!workerId) {
    throw new Error(`ensureCohortTitlesCoordinated: run ${run.id} has no claim owner.`);
  }
  const keeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
  try {
    // PR6 review BLOCKER 3: REQUIRE the frozen plan + model-call context
    // before any transport — a schema-v1 snapshot (no frozen plan), a missing
    // `cohort_title_consolidation` plan entry, or plan/registry version drift
    // fails the op closed here (never a non-audited live call). A configured
    // route that is policy-denied/unavailable still flows through the AUDITED
    // terminal path (`policy_denied`/`unavailable` classification_model_calls
    // rows) and then deterministically falls back to persisted
    // `cohort_fallback` outputs — the audit binding is never dropped.
    const modelCallContext = requireModelCallContext(
      memberSnapshot0,
      childRun0.id,
      'cohort_title_consolidation',
      1,
    );
    if (!modelCallContext) {
      throw new Error(
        `[CohortTitleCoordinator] No audited model-call context for ${member0.onboardingItemId} (run ${run.id}) ` +
          '— refusing to make a non-audited title call.',
      );
    }
    // PR6 review SHOULD-FIX 1: per-group model-call provenance — each group's
    // producing call id is captured for ITS member SKUs, so every persisted
    // `llm_cohort` row carries the call that actually produced it.
    const coordinatedCallIdBySku = new Map<string, string>();
    const coordinated = await coordinateCohortItems(
      frozenItems,
      boundPolicyView,
      {
        // DECISION-N: the audited title call binds to the ordinal-0 member
        // child run + its persisted runtime snapshot (mirrors PR4
        // DECISION-A); the returned callId becomes the durable output-row
        // `model_call_id`. The call is ALWAYS audited — the snapshot, plan
        // entry, and model-call context are all required above.
        modelCall: modelCallContext,
        snapshot: memberSnapshot0,
        assertHeld: () => keeper.assertHeld(),
        onCoordinatedCallId: (callId: string, skus: string[]) => {
          for (const sku of skus) {
            coordinatedCallIdBySku.set(sku, callId);
          }
        },
      },
    );
    // Post-await ownership guard BEFORE ANY write.
    keeper.assertHeld();

    const outputs = [...coordinated.entries()].map(([productSku, ct]) => ({
      productSku,
      title: ct.title,
      source: ct.source,
      // Durable provenance: only LLM-coordinated titles carry the call id of
      // the group that produced them; deterministic fallback rows keep NULL.
      modelCallId:
        ct.source === 'llm_cohort' ? (coordinatedCallIdBySku.get(productSku) ?? null) : null,
    }));
    // ONE transaction — all members persist or NONE (architecture-report §5).
    // WRITE-ONCE (PR6 hardening A): the insert is guarded by
    // `insertCohortTitleOutputsOnce`'s three-way semantics — zero rows ⇒
    // insert; any rows ⇒ `CohortOutputAlreadyCommittedError` (never delete).
    // A commit race (a sibling committed between our pure-read reuse check and
    // this insert) is converted to `CohortTitleAuthorityDriftError` so the
    // set can never be silently split.
    try {
      insertCohortTitleOutputsOnce({
        workspaceId,
        runId: run.id,
        inputHash,
        outputs,
      });
    } catch (err) {
      if (err instanceof CohortOutputAlreadyCommittedError) {
        const committed = getCohortTitleOutputsByRun(run.id);
        const storedHashes = [...new Set(committed.map(row => row.inputHash))];
        throw new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, committed.length);
      }
      throw err;
    }

    const map = new Map<string, CohortTitleOutput>();
    for (const output of outputs) {
      map.set(output.productSku, { title: output.title, source: output.source });
    }
    console.log(
      `[CohortTitleCoordinator] Persisted ${map.size} title outputs for run ${run.id} ` +
        `(${[...map.values()].filter(v => v.source === 'llm_cohort').length} llm_cohort, ` +
        `${[...map.values()].filter(v => v.source === 'cohort_fallback').length} cohort_fallback).`,
    );
    return map;
  } finally {
    keeper.stop();
  }
}
