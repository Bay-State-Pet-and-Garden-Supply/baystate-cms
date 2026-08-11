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
 * 3. **Coordinate ONCE under a scoped `CohortLeaseKeeper`** — groups the
 *    frozen sibling views, calls the coordinator's UNCACHED
 *    `coordinateCohortItems` with the audited `cohort_title_consolidation`
 *    call bound to the ORDINAL-0 MEMBER CHILD RUN (DECISION-N, mirroring PR4
 *    DECISION-A) and the keeper's `assertHeld` as the ownership assertion;
 *    then re-asserts ownership (`keeper.assertHeld()`); then persists every
 *    group member's `{title, source}` (+ the audited `model_call_id` when the
 *    call returned one) via `replaceCohortTitleOutputs` — ONE transaction,
 *    all-or-nothing. `HeartbeatLostError` propagates unchanged (never
 *    converted into an 'LLM unavailable → fallback' outcome): a stale owner
 *    aborts with NO output rows and the run is left to the reclaiming
 *    sibling, which re-enters and reuses-or-coordinates.
 *
 * 4. Returns the freshly persisted map.
 *
 * Never consults `cohortCache` / `coordinateCohortItemsOnce` — active cohort
 * mode treats the DB outputs as the sole "already coordinated" authority.
 */
import { getDb } from '../db/connection';
import {
  getCohortTitleOutputsByRun,
  replaceCohortTitleOutputs,
} from '../db/repositories/classification-cohort-output-repo';
import type { CohortTitleOutputRow } from '../db/repositories/classification-cohort-output-repo';
import {
  getRuntimeSnapshotByHash,
  buildModelCallContext,
  getModelExecutionPlanEntry,
} from '../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { computeCohortTitleInputHash } from './cohort-title-hash';
import { coordinateCohortItems, groupByProductLine } from './cohort-name-coordinator';
import { CohortLeaseKeeper } from './cohort-lease-keeper';
import {
  ensureMemberRun,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
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
  // run (DECISION-N audit binding) exists from freeze via `ensureMemberRun`
  // (idempotent lookup). Crash-recovery resume may find that child TERMINAL
  // (committed by a prior processCohort entry): ensureMemberRun then creates
  // a fresh running child, which inherits the freeze-persisted member
  // snapshot refs from the prior child EXACTLY like the member loop does
  // (the member runtime snapshot is immutable, so the refs are identical).
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const member0 = orderedMembers[0];
  const childRun0 = ensureMemberRun(
    run.id,
    member0.onboardingItemId,
    workspaceId,
    member0.productSku ?? '',
    null,
    null,
  );
  if (!childRun0.configSnapshotId || !childRun0.configSnapshotHash) {
    const prior = getDb().query(
      `SELECT config_snapshot_id, config_snapshot_hash FROM classification_runs
       WHERE cohort_run_id = ? AND onboarding_item_id = ?
         AND config_snapshot_id IS NOT NULL AND config_snapshot_hash IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    ).get(run.id, member0.onboardingItemId) as
      | { config_snapshot_id: string; config_snapshot_hash: string }
      | undefined;
    if (prior) {
      getDb().run(
        'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
        [prior.config_snapshot_id, prior.config_snapshot_hash, childRun0.id],
      );
      childRun0.configSnapshotId = prior.config_snapshot_id;
      childRun0.configSnapshotHash = prior.config_snapshot_hash;
    }
  }
  // The ordinal-0 member runtime snapshot. When it is genuinely unavailable
  // (corrupt ref / missing row), the parent op DEGRADES to a non-audited
  // coordinate call (registry-const authority) instead of aborting the whole
  // cohort — mirroring the established member-level semantic (a broken member
  // snapshot fails that member, never the cohort). The affected member's own
  // pipeline fails closed as today; survivors still get durable titles.
  const memberSnapshot0 = childRun0.configSnapshotHash
    ? getRuntimeSnapshotByHash(workspaceId, childRun0.configSnapshotHash)
    : null;
  if (!memberSnapshot0) {
    console.warn(
      `[CohortTitleCoordinator] Frozen member runtime snapshot unavailable for ordinal-0 member ` +
        `${member0.onboardingItemId} (run ${run.id}) — coordinating titles WITHOUT the audited call ` +
        `(model_call_id stays NULL); the member pipeline fails closed per-member as before.`,
    );
  }
  const modelPolicyView = memberSnapshot0?.modelPolicy
    ? modelPolicyViewFromConfig(memberSnapshot0.modelPolicy as never, memberSnapshot0.snapshotHash)
    : null;
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    modelPolicyDigest: modelPolicyView?.policyDigest ?? null,
    titlePlanEntry: memberSnapshot0
      ? (getModelExecutionPlanEntry(memberSnapshot0, 'cohort_title_consolidation') ?? undefined)
      : undefined,
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

  // Step 3 — coordinate ONCE under a scoped lease keeper + persist
  // all-or-nothing. The keeper renews the parent lease on a TTL/3 cadence
  // while the audited call is in flight; `assertHeld` (forwarded into the
  // transport AND re-asserted after the await) aborts with `HeartbeatLostError`
  // the moment the claim is lost — no output rows are ever written by a stale
  // owner.
  const workerId = run.claimedBy;
  if (!workerId) {
    throw new Error(`ensureCohortTitlesCoordinated: run ${run.id} has no claim owner.`);
  }
  const keeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
  try {
    let coordinatedCallId: string | null = null;
    const coordinated = await coordinateCohortItems(
      frozenItems,
      modelPolicyView,
      memberSnapshot0
        ? {
            // DECISION-N: the audited title call binds to the ordinal-0 member
            // child run + its persisted runtime snapshot (mirrors PR4
            // DECISION-A); the returned callId becomes the durable output-row
            // `model_call_id`. When the ordinal-0 snapshot is unavailable the
            // call degrades to the legacy non-audited path (see step 1).
            modelCall:
              buildModelCallContext(memberSnapshot0, childRun0.id, 'cohort_title_consolidation', 1) ??
              undefined,
            snapshot: memberSnapshot0,
            assertHeld: () => keeper.assertHeld(),
            onCoordinatedCallId: (callId: string) => {
              coordinatedCallId = callId;
            },
          }
        : undefined,
    );
    // Post-await ownership guard BEFORE ANY write.
    keeper.assertHeld();

    const outputs = [...coordinated.entries()].map(([productSku, ct]) => ({
      productSku,
      title: ct.title,
      source: ct.source,
      // Durable provenance: only LLM-coordinated titles carry the audited
      // call id; deterministic fallback rows keep NULL.
      modelCallId: ct.source === 'llm_cohort' ? coordinatedCallId : null,
    }));
    // ONE transaction — all members persist or NONE (architecture-report §5).
    replaceCohortTitleOutputs({
      workspaceId,
      runId: run.id,
      inputHash,
      outputs,
    });

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
