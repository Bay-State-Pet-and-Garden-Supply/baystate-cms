/**
 * Parent cohort title coordinator (issue #30, PR6 C4) — the durable parent
 * title op.
 *
 * `ensureCohortTitlesCoordinated` runs at `processCohort` start (the single
 * re-entrant parent entry — resume-on-match keeps the same run id, so
 * kill/restart/reclaim and member retries all funnel through here):
 *
 * 1. **Input hash** — `computeCohortTitleInputHash` over FROZEN TITLE
 *    AUTHORITY ONLY (PR6 C2, DECISION-P/Q): the final membership hash, the
 *    per-member frozen title slice, the Execution Product Type resolution,
 *    the FORMAT_RULES digest, and the operation-specific H5 title slice (the
 *    frozen `cohort_title_consolidation` plan entry — provider/model/versions;
 *    the broad policy digest is deliberately NOT hashed, PR13 DECISION-C;
 *    PR13 review R2: the EXECUTED `OPERATION_PARAMETERS.cohort_title_consolidation`
 *    tuple — temperature/maxTokens — also participates, so a parameter-only
 *    registry release changes the hash and cross-parent reuse fails closed).
 *    Never live item rows, never the old cache fingerprint, never OCR
 *    provenance hashes.
 *
 * 2. **Reuse** — when `classification_cohort_outputs` already hold a
 *    COMPLETE `curated_title` set for this run (every member of every
 *    multi-item group per `groupByProductLine` over the FROZEN sibling views
 *    — DECISION-O: singletons are never coordinated and have no row) AND
 *    every row's `input_hash` equals the freshly computed T-hash, the op
 *    returns the parsed map with ZERO LLM calls.
 *
 * 3. **Drift fails closed (PR6 hardening A)** — when a NONEMPTY committed set
 *    does NOT EXACTLY equal the expected multi-item-group member set (missing
 *    rows, EXTRA rows, or rows whose `input_hash` does not match the freshly
 *    computed T-hash), the set is WRITE-ONCE and can never be replaced: the
 *    op throws `CohortTitleAuthorityDriftError` (run id + expected hash +
 *    stored hash(es) + row count) — it NEVER re-coordinates and NEVER
 *    replaces.
 *
 * 4. **Cross-parent same-T-hash reuse (PR13 C2, DECISION-A/B)** — when the
 *    CURRENT run's set is EMPTY (the drift guard above passed), the LATEST
 *    SUPERSEDED parent revision's committed title set is inspected: it is
 *    reused when it is EXACTLY the expected multi-item-member set AND every
 *    row's `input_hash` equals the freshly computed T-hash — the rows are
 *    COPIED into the current run in ONE transaction via the SAME
 *    `insertCohortTitleOutputsOnce` three-way semantics (write-once
 *    preserved; the copy-race — a sibling committing under the current run
 *    between our read and the insert — converts to
 *    `CohortTitleAuthorityDriftError` exactly like the coordinate path), and
 *    the op returns the parsed map with ZERO LLM calls. DECISION-A: TITLES
 *    ONLY (the named economics item; Pages can adopt the same pattern later —
 *    ADR 0013 PR13 forward note). DECISION-B: the copied rows PRESERVE the
 *    original `model_call_id` — the C6b linkage exemption resolves the old
 *    call (terminal-success + a durable output row under the new cohort run +
 *    SKU), so proposal provenance stays truthful. SAFETY: only SUPERSEDED
 *    parents qualify (a current non-superseded run means the cohort is
 *    already processed); exact-set + hash equality are required; the copy
 *    NEVER touches the old run's rows; a source row that fails to parse
 *    through `CohortTitleOutputSchema` makes the source set unusable — the
 *    copy is SKIPPED and the op falls through to fresh coordination
 *    (deterministic; never a supersede loop on a corrupt OLD row).
 *
 * 5. **Coordinate — only when the set is EMPTY (and no reusable superseded
 *    set)** — under a scoped `CohortLeaseKeeper`: groups the frozen sibling
 *    views, calls the coordinator's UNCACHED `coordinateCohortItems` with the
 *    audited `cohort_title_consolidation` call bound to the ORDINAL-0 MEMBER
 *    CHILD RUN (DECISION-N, mirroring PR4 DECISION-A) and the keeper's
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
 * 6. Returns the freshly persisted map.
 *
 * Never consults `cohortCache` / `coordinateCohortItemsOnce` — active cohort
 * mode treats the DB outputs as the sole "already coordinated" authority.
 *
 * ## HONEST DELIVERY CONTRACT (PR6 hardening B, issue #30 P1-1)
 *
 * The durable guarantee is NOT "one LLM call per cohort revision forever".
 * A crash between transport success and the outputs transaction leaves the
 * AUDITED call durable but NO committed set — a reclaim re-enters and
 * re-coordinates (each invocation is independently audited). Transport-level
 * exactly-once would require provider idempotency keys (out of scope). The
 * precise contract:
 *
 * - at most one ACTIVE coordination call at a time (the lease keeper scopes
 *   every in-flight call to the claim owner; a lost claim aborts with
 *   `HeartbeatLostError` and NO rows);
 * - zero FURTHER coordination calls once the durable output set commits —
 *   the reuse path (complete set + T-hash match) is read-only;
 * - replay-safe after commit: any retry, reclaim, or member re-execution
 *   consumes the committed set with zero calls and byte-identical titles;
 * - each pre-commit crash MAY cause another independently audited
 *   invocation — there is NO retry cap and no provider idempotency, so
 *   repeated crashes in the same pre-commit window can produce more than
 *   two audited calls; ONLY a successful commit makes later entries
 *   call-free (every subsequent entry reuses with zero calls). The
 *   test-only `afterCoordinatedCall` seam (PR6 hardening B) deterministically
 *   simulates a single such window.
 *
 * PR6 review round 1 hardening: the op performs ZERO writes before the lease
 * is asserted (the ordinal-0 child run + its immutable snapshot refs are PURE
 * READ; the reuse path is read-only), the T-hash uses the frozen
 * OPERATION-SPECIFIC title authority (PR13 C1: the plan entry's
 * provider/model/versions — the broad unbound policy digest is no longer
 * hashed, so H3/H4/evidence AND non-title route changes never re-coordinate
 * titles), and a missing frozen snapshot / plan entry / model-call context
 * FAILS CLOSED before any transport — a non-audited live title call is never
 * made.
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
import {
  getCohortMemberRunForTitleAudit,
  getLatestSupersededRunForCohort,
} from '../db/repositories/classification-cohort-run-repo';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { computeCohortTitleInputHash, titleExecutionTypeAuthorityFromRun } from './cohort-title-hash';
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
 * Deterministic per-SKU parse-failure signal (PR8 review R1, BLOCKER 1):
 * thrown by the REUSE path when one or more persisted `curated_title` rows
 * for a run fail to parse through `CohortTitleOutputSchema` (corrupt stored
 * JSON, or a schema violation such as an empty title). Carries the parent
 * run id, the affected product SKUs with their original causes, and the
 * USABLE parsed outputs for the unaffected rows so `processCohort` can
 * Supersession diagnostic (PR8 review R1 + review round 2 P1): a persisted
 * `curated_title` row that fails to parse is corruption of the WRITE-ONCE
 * PARENT-OWNED shared semantic artifact — the parent is SUPERSEDED via
 * `supersedeOwnedCohortRunForOutputDrift` (never a member failure: a member
 * failure would strand the revision — write-once rows stay immutable under a
 * terminal-current parent, and no new revision could be claimed). The class
 * retains per-SKU failures + the usable parsed map as DIAGNOSTICS only.
 */
export class CohortTitleOutputCorruptError extends Error {
  readonly runId: string;
  readonly failures: Array<{ sku: string; cause: string }>;
  readonly usableOutputs: Map<string, CohortTitleOutput>;

  constructor(
    runId: string,
    failures: Array<{ sku: string; cause: string }>,
    usableOutputs: Map<string, CohortTitleOutput>,
  ) {
    super(
      `[CohortTitleOutputCorrupt] Persisted curated_title outputs for run ${runId} failed to parse: ` +
        failures.map(f => `${f.sku} (${f.cause})`).join('; ') +
        ' — the shared title set is no longer coherent; the parent run must be superseded so a NEW revision can commit a fresh set.',
    );
    this.name = 'CohortTitleOutputCorruptError';
    this.runId = runId;
    this.failures = failures;
    this.usableOutputs = usableOutputs;
  }
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
  /**
   * Test-only crash seam (PR6 hardening B, issue #30 P1-1): fires AFTER the
   * coordinated title call resolves (its audited `classification_model_calls`
   * rows are durable) and AFTER the post-await ownership guard, but BEFORE
   * the outputs transaction commits — deterministically simulating a worker
   * crash exactly between transport success and the durable output-set
   * commit. Mirrors `processCohort`'s `afterMemberPipeline` precedent
   * (`MemberCommitCrashSimulationError`). Production callers never pass it.
   */
  afterCoordinatedCall?: () => void | Promise<void>;
  /**
   * Test-only race seam (PR13 C2 review R1): fires INSIDE the cross-parent
   * copy path, after the lease-ownership assertion but BEFORE the copy
   * `insertCohortTitleOutputsOnce` — deterministically simulating the
   * sibling-commit race that converts the insert's
   * `CohortOutputAlreadyCommittedError` into the drift error. Production
   * callers never pass it.
   */
  beforeTitleCopyInsert?: () => void | Promise<void>;
  /**
   * Test-only title-parameter override (PR13 review R2): models a DEPLOYMENT
   * whose `OPERATION_PARAMETERS.cohort_title_consolidation` tuple differs
   * (a parameter-only registry release) — the T-hash then differs and the
   * cross-parent reuse key fails closed to fresh coordination. Production
   * callers never pass it: the registry tuple is the executed authority.
   */
  titleOperationParameters?: { temperature: number; maxTokens: number | null };
}

/**
 * The durable parent title coordination op (PR6 C4). See the module JSDoc
 * for the reuse rule, the lease-wrapped coordinate step, the all-or-nothing
 * persistence, the `HeartbeatLostError` propagation contract, and the HONEST
 * DELIVERY CONTRACT (PR6 hardening B): at most one ACTIVE coordination call
 * at a time, zero FURTHER calls once the durable set commits, replay-safe
 * after commit, and a crash between transport success and output commit may
 * re-invoke coordination (each invocation audited).
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

  // Step 1 — T-hash from FROZEN title authority. The ordinal-0 member child
  // run (DECISION-N audit binding) was created at freeze with the immutable
  // member runtime snapshot refs. PURE READ ONLY (PR6 review BLOCKER 2): the
  // parent op never creates a child and never updates refs before the lease is
  // asserted — a stale pre-reclaim worker can therefore never write. The
  // latest refs-bearing child (running OR terminal — crash-recovery resume may
  // find the ordinal-0 child committed by a prior processCohort entry) is the
  // frozen audit authority; the reuse path performs ZERO writes.
  // PR13 (issue #30, DECISION-C): the hashed model-execution authority is the
  // OPERATION-SPECIFIC title slice (the frozen plan entry's provider/model/
  // versions) — the broad UNBOUND H5 policy digest is no longer computed or
  // hashed. The snapshot-bound view is retained ONLY for transport
  // enforcement (`assertModelPolicyIntact` inside the audited call).
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
  // PR6 review BLOCKER 1 (superseded by PR13 C1): the T-hash must use the
  // frozen operation-specific title authority (plan entry provider/model/
  // versions — NO broad policy digest, NO snapshotHash binding), so H3
  // config / H4 Pages / evidence / non-title route changes never change the
  // title hash. The snapshot-bound view is retained ONLY for transport
  // enforcement (`assertModelPolicyIntact` inside the audited call).
  const boundPolicyView = modelPolicyViewFromConfig(
    memberSnapshot0.modelPolicy as never,
    memberSnapshot0.snapshotHash,
  );
  const titlePlanEntry = getModelExecutionPlanEntry(memberSnapshot0, 'cohort_title_consolidation');
  // PR6 hardening C (P1-3): ONE canonical Execution Product Type title
  // authority {id, label, confidence, outcome} — the SAME object feeds the
  // T-hash (label participates) and the prompted context (id + label render).
  // A label change therefore changes BOTH the hash and the prompt; a null run
  // type (abstained/conflicted) yields all-null fields for both.
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, memberSnapshot0);
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    titlePlanEntry: titlePlanEntry ?? undefined,
    executionTypeAuthority,
    // PR13 review R2 (test-only): production passes nothing → the registry
    // tuple (the executed authority) participates via the hash's default.
    ...(params.titleOperationParameters
      ? { titleOperationParameters: params.titleOperationParameters }
      : {}),
  });

  // Step 2 — persisted rows are read BEFORE any early return so the
  // no-multi-member case can also fail closed on unexpected rows
  // (PR6 hardening C SHOULD-FIX 1). Pure read: no keeper, no LLM, no writes.
  const existingRows = getCohortTitleOutputsByRun(run.id);

  // DECISION-O + SHOULD-FIX 1 (PR6 hardening C): no multi-item groups ⇒ NO
  // output rows are expected. Any persisted rows for this run are write-once
  // corruption — FAIL CLOSED with the deterministic drift error (never a
  // silent empty-map return).
  if (multiMemberSkus.size === 0) {
    if (existingRows.length > 0) {
      const storedHashes = [...new Set(existingRows.map(row => row.inputHash))];
      throw new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, existingRows.length);
    }
    return new Map();
  }

  // Step 3 — REUSE when the persisted set is EXACTLY the expected set AND
  // every row's hash matches the freshly computed T-hash. Pure reads.
  const rowBySku = new Map(existingRows.map(row => [row.productSku, row]));
  // PR6 hardening C (SHOULD-FIX 1): EXACT-SET EQUALITY — the persisted row
  // count must equal the expected multi-member SKU count AND every expected
  // SKU must be present. A same-hash set carrying UNEXPECTED EXTRA rows is
  // write-once corruption — drift, never reuse.
  const complete =
    existingRows.length === multiMemberSkus.size &&
    [...multiMemberSkus].every(sku => rowBySku.has(sku));
  const hashMatch = existingRows.every(row => row.inputHash === inputHash);
  if (complete && hashMatch) {
    const map = new Map<string, CohortTitleOutput>();
    // PR8 review R1 (BLOCKER 1): per-SKU parse failures are collected, never
    // escaped. Each corrupt row (bad JSON or a schema violation — e.g. an
    // empty title persisted before the schema tightening) becomes a member
    // failure; the successfully parsed rows stay usable so the parent
    // completes the unaffected members.
    const failures: Array<{ sku: string; cause: string }> = [];
    for (const sku of multiMemberSkus) {
      const row = rowBySku.get(sku)!;
      try {
        map.set(sku, parseTitleRow(row));
      } catch (err) {
        failures.push({ sku, cause: err instanceof Error ? err.message : String(err) });
      }
    }
    if (failures.length > 0) {
      console.error(
        `[CohortTitleCoordinator] ${failures.length} persisted curated_title row(s) for run ${run.id} failed to parse: ` +
          failures.map(f => `${f.sku} (${f.cause})`).join('; '),
      );
      throw new CohortTitleOutputCorruptError(run.id, failures, map);
    }
    console.log(
      `[CohortTitleCoordinator] Reusing ${map.size} durable title outputs for run ${run.id} (complete set + hash match, zero LLM calls).`,
    );
    return map;
  }

  // Step 4 (PR6 hardening A) — WRITE-ONCE: any NONEMPTY committed set that is
  // incomplete or over-complete (extra rows) or whose rows do not match the
  // freshly computed T-hash is authority drift. The set can never be replaced
  // (the DELETE/replace path is gone), so the op FAILS CLOSED — it NEVER
  // re-coordinates and NEVER deletes. An incomplete/over-complete nonempty
  // set can only be corruption: the insert is all-or-nothing, so a partial or
  // extra-row set is never produced by any writer.
  if (existingRows.length > 0) {
    const storedHashes = [...new Set(existingRows.map(row => row.inputHash))];
    throw new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, existingRows.length);
  }

  // Step 4.5 (PR13 C2, DECISION-A/B) — cross-parent same-T-hash reuse: the
  // CURRENT run's set is EMPTY here (the drift guard passed). A SUPERSEDED
  // parent revision's committed title set is the SAME frozen-authority
  // decision when it is EXACTLY the expected multi-item-member set AND every
  // row's input_hash equals the freshly computed T-hash — COPY its rows into
  // the current run in ONE transaction (write-once preserved, `model_call_id`
  // PRESERVED — DECISION-B) and return the parsed map with ZERO LLM calls.
  // Titles only (DECISION-A). See the module JSDoc for the full safety
  // contract (superseded-only, exact-set, old rows untouched).
  const reusableRun = getLatestSupersededRunForCohort(params.cohort.id);
  if (reusableRun) {
    const reusableRows = getCohortTitleOutputsByRun(reusableRun.id);
    const reusableBySku = new Map(reusableRows.map(row => [row.productSku, row]));
    // EXACT-SET completeness: count equality AND membership equality (a
    // same-hash superseded set carrying EXTRA rows is never a source — the
    // same write-once corruption rule as the current-run reuse path).
    const reusableComplete =
      reusableRows.length === multiMemberSkus.size &&
      [...multiMemberSkus].every(sku => reusableBySku.has(sku));
    const reusableHashMatch = reusableRows.every(row => row.inputHash === inputHash);
    if (reusableComplete && reusableHashMatch) {
      // Parse every source row through the shared schema; a row that fails to
      // parse makes the source set unusable → skip the copy and fall through
      // to fresh coordination (deterministic — never a supersede loop on a
      // corrupt OLD row; the current run's set is still empty).
      const copyRows: Array<{
        productSku: string;
        title: string;
        source: CohortTitleOutput['source'];
        modelCallId: string | null;
      }> = [];
      let sourceCorrupt = false;
      for (const sku of multiMemberSkus) {
        const row = reusableBySku.get(sku)!;
        try {
          const parsed = parseTitleRow(row);
          copyRows.push({
            productSku: sku,
            title: parsed.title,
            source: parsed.source,
            // DECISION-B: the ORIGINAL producing call id is preserved as
            // ROW-LEVEL AUDIT PROVENANCE. No title proposal ever references
            // it — title proposals carry the MEMBER's own name-consolidation
            // call ids (the C6b linkage exemption is category_page +
            // coordinated_page ONLY and must never be extended to titles;
            // the preserved id keeps the copied row's provenance truthful).
            modelCallId: row.modelCallId,
          });
        } catch {
          sourceCorrupt = true;
          break;
        }
      }
      if (!sourceCorrupt) {
        // PR13 review S1 (P1): the copy WRITES — a stale pre-reclaim worker
        // must never commit rows into a run it no longer owns. The lease
        // keeper asserts ownership exactly like the coordinate path (Step 5)
        // does before its insert; a lost claim aborts here with NO copied rows.
        const copyWorkerId = run.claimedBy;
        if (!copyWorkerId) {
          throw new Error(`ensureCohortTitlesCoordinated: run ${run.id} has no claim owner (cross-parent reuse).`);
        }
        const copyKeeper = new CohortLeaseKeeper(run.id, copyWorkerId, COHORT_LEASE_TTL_MS).start();
        try {
          try {
            copyKeeper.assertHeld();
            // Test-only race seam (PR13 C2 review R1): fires after the
            // ownership assertion but before the copy insert — the racing
            // sibling's rows become visible HERE, converting the insert's
            // write-once throw into the deterministic drift error below.
            await params.beforeTitleCopyInsert?.();
            insertCohortTitleOutputsOnce({
              workspaceId,
              runId: run.id,
              inputHash,
              outputs: copyRows,
            });
          } catch (err) {
            if (err instanceof CohortOutputAlreadyCommittedError) {
              // Copy-race: a sibling committed a set for this run between our
              // pure-read check and this insert — the set is write-once and can
              // never be silently split or double-written; convert to the same
              // deterministic drift error the coordinate path uses.
              const committed = getCohortTitleOutputsByRun(run.id);
              const storedHashes = [...new Set(committed.map(row => row.inputHash))];
              throw new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, committed.length);
            }
            throw err;
          }
        } finally {
          copyKeeper.stop();
        }
        const map = new Map<string, CohortTitleOutput>();
        for (const copy of copyRows) {
          map.set(copy.productSku, { title: copy.title, source: copy.source });
        }
        console.log(
          `[CohortTitleCoordinator] Reused ${map.size} durable title outputs from superseded run ${reusableRun.id} (same T-hash, zero LLM calls).`,
        );
        return map;
      }
    }
  }

  // Step 5 — coordinate ONCE under a scoped lease keeper + persist
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
    // PR6 hardening C (P1-3): thread the frozen Execution Product Type as
    // title context via the SAME canonical authority the T-hash covers
    // (`titleExecutionTypeAuthorityFromRun` built in step 1 — id + label +
    // confidence + outcome). With signals ON the prompt renders BOTH the id
    // and the frozen label (`"dog-food-dry (Dry Dog Food)"`); a null run type
    // (abstained/conflicted) passes null → no context line, mirroring the
    // hash's `executionProductType.id: null` state. The SAME
    // `ExecutionTypeTitleAuthority` object feeds the T-hash and the prompt.
    const executionTypeContext = executionTypeAuthority.id
      ? executionTypeAuthority
      : null;
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
        // PR6 hardening C (P1-3): the ACTIVE parent op is the ONLY caller that
        // opts into the T-hash-only prompt signals (webBrand/ocrWeight/
        // ocrFlavor + Execution Product Type context) — legacy/shadow calls
        // never pass this and stay byte-identical.
        includeTitleHashSignals: true,
        executionTypeContext,
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

    // Test-only crash seam (PR6 hardening B, P1-1): a crash EXACTLY here —
    // after the audited call resolved (its audit rows durable) and after the
    // ownership guard, but BEFORE the outputs transaction — leaves ZERO
    // committed rows. A reclaim re-enters; the set is still empty, so it
    // coordinates again (each invocation independently audited). Production
    // callers never pass `afterCoordinatedCall`, so this is a no-op in
    // production.
    await params.afterCoordinatedCall?.();

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
