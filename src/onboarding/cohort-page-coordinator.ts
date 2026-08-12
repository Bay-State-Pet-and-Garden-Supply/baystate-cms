/**
 * Parent cohort page coordinator (issue #30, PR7 C4) — the durable parent
 * page op.
 *
 * `ensureCohortPagesCoordinated` runs at `processCohort` start (right after
 * `ensureCohortTitlesCoordinated`, before the member loop) — the single
 * re-entrant parent page entry:
 *
 * 1. **Input hash** — `computeCohortPageInputHash` over FROZEN PAGE AUTHORITY
 *    ONLY (PR7 C2, DECISION-B): the finalized P-set member SKUs (ALL members —
 *    groups AND singletons, DECISION-A), the per-member frozen page authority
 *    slice (`pageAuthorityFromProjectionMember` — the exact slice the v2
 *    prompt renders), the Execution Product Type resolution (the SAME
 *    `ExecutionTypeTitleAuthority` the v2 prompt's type context renders),
 *    the frozen page list `{id,name,parentName}` + `{selectionMode,maxPages}`
 *    from the frozen page target config, the prompt/rule version
 *    `cohort-pages-v2` (DECISION-F), and the operation-specific Page model
 *    authority `{provider, model}` (never the broad `policyDigest` the T-hash
 *    carries). Never live item rows, never the old cache fingerprint, never
 *    OCR provenance hashes.
 *
 * 2. **Reuse** — when `classification_cohort_outputs` already hold a COMPLETE
 *    `coordinated_page` set for this run (a row for EVERY member of the P-set
 *    — membership equality AND exact row count) AND every row's `input_hash`
 *    equals the freshly computed P-hash, the op returns the parsed map with
 *    ZERO LLM calls.
 *
 * 3. **Expected-empty (DECISION-C)** — when the page target is DISABLED or no
 *    verified pages exist (config-level absence), the op writes NO rows and
 *    returns an empty map; ANY persisted rows for the run are write-once
 *    corruption and fail closed with `CohortPageAuthorityDriftError` (mirrors
 *    titles' no-multi-member fail-closed). Config-level absence is NOT an
 *    output.
 *
 * 4. **Drift fails closed (PR6 hardening A, applied to pages)** — when a
 *    NONEMPTY committed set does NOT EXACTLY equal the expected P-set (missing
 *    rows, EXTRA rows, or rows whose `input_hash` does not match the freshly
 *    computed P-hash), the set is WRITE-ONCE and can never be replaced: the
 *    op throws `CohortPageAuthorityDriftError` (run id + expected hash +
 *    stored hash(es) + row count) — it NEVER re-coordinates and NEVER deletes.
 *
 * 5. **Coordinate — only when the set is EMPTY** — under a scoped
 *    `CohortLeaseKeeper`: EVERY group (multi-item AND singleton — per
 *    `groupByProductLine` over the FROZEN sibling views, DECISION-A) goes
 *    through the UNCACHED page core (`coordinateCohortPagesCore` from
 *    `src/classification/cohort-page-coordinator.ts` — the ONE
 *    prompt/validation authority, DECISION-H) with the keeper's `assertHeld`
 *    threaded into the audited transport, the `afterCoordinatedCall` crash
 *    seam, and the frozen Execution Type context (v2 prompt). Singletons are
 *    ONE-MEMBER core invocations (`allowSingleProduct`) — the SAME v2 prompt
 *    family, the SAME audited `cohort_page_assignment_parent` operation, and
 *    the SAME lease/crash seams as groups (PR7 review R2, F2 — the legacy
 *    `llmAssignCategoryPages` singleton path is gone from the parent op; the
 *    operation mismatch and prompt-parity gap collapse). All members render
 *    from the SAME canonical bundle the P-hash consumed — never from mutable
 *    data, so the P-hash covers every decision by construction. The audited
 *    calls bind to the ordinal-0 member child run (mirrors the title op's
 *    DECISION-N audit binding) under the NEW `cohort_page_assignment_parent`
 *    operation and FAIL CLOSED before any transport when the frozen plan has
 *    no compatible entry. Abstentions are DURABLE: every member gets a row —
 *    `{status:'assigned', pages, source:'llm_cohort'}` (model_call_id = the
 *    producing group/singleton call id) or `{status:'abstained', reason}`
 *    (model_call_id NULL for deterministic abstentions). All rows persist via
 *    `insertCohortPageOutputsOnce` in ONE transaction (all-or-nothing), and
 *    any `CohortOutputAlreadyCommittedError` from a commit race is converted
 *    to `CohortPageAuthorityDriftError`. `HeartbeatLostError` propagates
 *    unchanged (never converted into an 'LLM unavailable → fallback' outcome):
 *    a stale owner aborts with NO output rows and the run is left to the
 *    reclaiming sibling, which re-enters and reuses-or-coordinates.
 *
 * 6. Returns the freshly persisted map (sku → parsed payload + model_call_id).
 *
 * Never consults `cohortCache` / `coordinateCohortPagesOnce` — active cohort
 * mode treats the DB outputs as the sole "already coordinated" authority.
 *
 * ## HONEST DELIVERY CONTRACT (PR6 hardening B, issue #30 P1-1)
 *
 * The durable guarantee is NOT "one Page LLM call per cohort revision
 * forever". A crash between transport success and the outputs transaction
 * leaves the AUDITED call durable but NO committed set — a reclaim re-enters
 * and re-coordinates (each invocation is independently audited). Provider
 * idempotency is out of scope (no provider idempotency keys), so a
 * pre-commit crash MAY re-invoke the audited transport. The precise contract:
 *
 * - at most one ACTIVE page coordination call at a time (the lease keeper
 *   scopes every in-flight call to the claim owner; a lost claim aborts with
 *   `HeartbeatLostError` and NO rows);
 * - zero FURTHER coordination calls once the durable output set commits —
 *   the reuse path (complete set + P-hash match) is read-only;
 * - replay-safe after commit: any retry, reclaim, or member re-execution
 *   consumes the committed set with zero calls and byte-identical page
 *   outputs;
 * - each pre-commit crash MAY cause another independently audited invocation
 *   — there is NO retry cap and no provider idempotency, so repeated crashes
 *   in the same pre-commit window can produce more than two audited calls;
 *   ONLY a successful commit makes later entries call-free (every subsequent
 *   entry reuses with zero calls). The test-only `afterCoordinatedCall` seam
 *   (PR6 hardening B) deterministically simulates a single such window.
 *
 * PR7 review discipline (mirrors PR6): the op performs ZERO writes before the
 * lease is asserted (the ordinal-0 child run + its immutable snapshot refs are
 * PURE READ; the reuse and expected-empty paths are read-only), and a missing
 * frozen snapshot / model-call context FAILS CLOSED before any transport — a
 * non-audited live page call is never made.
 */
import {
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
  CohortOutputAlreadyCommittedError,
} from '../db/repositories/classification-cohort-output-repo';
import type { CohortPageOutputRow } from '../db/repositories/classification-cohort-output-repo';
import { getRuntimeSnapshotByHash, requireModelCallContext } from '../classification/runtime-snapshot';
import { getCohortMemberRunForTitleAudit, COHORT_LEASE_TTL_MS } from '../db/repositories/classification-cohort-run-repo';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { titleExecutionTypeAuthorityFromRun } from './cohort-title-hash';
import {
  buildCohortPageAuthorityBundle,
  computeCohortPageInputHash,
  pageAuthorityMemberToSnapshot,
} from './cohort-page-hash';
import type { CohortPagePlanAuthority } from './cohort-page-hash';
import { coordinateCohortPagesCore } from '../classification/cohort-page-coordinator';
import type { CohortPageMemberResult } from '../classification/cohort-page-coordinator';
import { buildPageHierarchy } from '../classification/page-assignment-llm';
import { resolveTargetsFromSnapshot } from '../classification/curation-target-resolver';
import { groupByProductLine } from './cohort-name-coordinator';
import { CohortLeaseKeeper } from './cohort-lease-keeper';
import { CohortPageOutputSchema } from '../shared/schemas/cohorts';
import type { CohortPageOutput } from '../shared/schemas/cohorts';
import type { CoordinatedPageMemberValue, ProductLineItemSnapshot } from '../classification/types';
import type { FrozenProductLineContext } from './cohort-curator';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionV1,
} from '../shared/schemas/cohorts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse one persisted output row's payload through the shared page schema
 *  (fail-closed on corrupt stored JSON — a corrupt row never yields a page
 *  output). */
function parsePageRow(row: CohortPageOutputRow): CohortPageOutput {
  return CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson));
}

/** Wrap a coordinator/LLM member result into the durable payload + provenance
 *  shape the parent op returns and persists. Assigned rows carry the producing
 *  call id; abstained rows always carry NULL model_call_id (deterministic
 *  abstentions — 'No configured Category Pages are available', policy denied,
 *  invalid responses — produce no call). */
function toMemberValue(result: CohortPageMemberResult): CoordinatedPageMemberValue {
  if (result.status === 'assigned') {
    return {
      output: {
        status: 'assigned',
        pages: result.pages.map(page => ({
          pageId: page.pageId,
          pageName: page.pageName,
          confidence: page.confidence,
        })),
        source: 'llm_cohort',
      },
      modelCallId: result.modelCallIds?.[0] ?? null,
    };
  }
  return { output: { status: 'abstained', reason: result.reason }, modelCallId: null };
}

/**
 * Deterministic authority-drift signal (PR6 hardening A, applied to pages).
 * Thrown when a NONEMPTY committed `coordinated_page` set for a run does not
 * match the freshly computed canonical page input hash (or is incomplete /
 * over-complete). The set is WRITE-ONCE — it can never be replaced, so the op
 * FAILS CLOSED instead of re-coordinating. Carries the run id, the expected
 * (current) hash, the stored hash(es), and the persisted row count. Also
 * thrown when an `insertCohortPageOutputsOnce` commit-race reports an
 * already-committed set.
 */
export class CohortPageAuthorityDriftError extends Error {
  readonly runId: string;
  readonly expectedHash: string;
  readonly storedHashes: string[];
  readonly rowCount: number;

  constructor(runId: string, expectedHash: string, storedHashes: string[], rowCount: number) {
    super(
      `[CohortPageAuthorityDrift] Durable page outputs for run ${runId} are write-once but no longer match the ` +
        `frozen page authority: expected input_hash ${expectedHash}, stored hash(es) [${storedHashes.join(', ')}], ` +
        `${rowCount} row(s). A committed output set can never be replaced — this is corruption or an illegal ` +
        'mutation; failing the run closed without re-coordination.',
    );
    this.name = 'CohortPageAuthorityDriftError';
    this.runId = runId;
    this.expectedHash = expectedHash;
    this.storedHashes = storedHashes;
    this.rowCount = rowCount;
  }
}

// ─── Parent op ────────────────────────────────────────────────────────────────

export interface EnsureCohortPagesCoordinatedParams {
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
   * Test-only crash seam (PR6 hardening B, issue #30 P1-1): fires AFTER a
   * page coordination call resolves (its audited `classification_model_calls`
   * rows are durable) but BEFORE the outputs transaction commits —
   * deterministically simulating a worker crash exactly between transport
   * success and the durable output-set commit. The uncached page core fires
   * it internally after each group transport; the parent op fires it after
   * each singleton transport. Mirrors `processCohort`'s `afterMemberPipeline`
   * precedent (`MemberCommitCrashSimulationError`). Production callers never
   * pass it.
   */
  afterCoordinatedCall?: () => void | Promise<void>;
}

/**
 * The durable parent page coordination op (PR7 C4). See the module JSDoc for
 * the expected-empty rule (DECISION-C), the reuse rule, the lease-wrapped
 * coordinate step, the all-or-nothing persistence, the `HeartbeatLostError`
 * propagation contract, and the HONEST DELIVERY CONTRACT (PR6 hardening B):
 * at most one ACTIVE page coordination call at a time, zero FURTHER calls
 * once the durable set commits, replay-safe after commit, and a crash between
 * transport success and output commit may re-invoke coordination (each
 * invocation audited).
 */
export async function ensureCohortPagesCoordinated(
  params: EnsureCohortPagesCoordinatedParams,
): Promise<Map<string, CoordinatedPageMemberValue>> {
  const { run, workspaceId, workspacePath: _workspacePath, projection, frozenLineContext } = params;
  // `cohort` and `members` are accepted for contract symmetry with
  // `processCohort` (which holds all three) but are not page inputs: the
  // frozen projection + the frozen line context + the run row are the entire
  // authority.

  // The frozen ordinal-0 member runtime snapshot is the page authority (the
  // SAME audit-authority seam the title op uses): the frozen page target
  // config, the frozen verified page catalog, the Execution Product Type
  // label, the bound model-policy view, and the model-call audit binding all
  // come from here. PURE READ — the parent op never creates a child and never
  // updates refs before the lease is asserted.
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const member0 = orderedMembers[0];
  const childRun0 = getCohortMemberRunForTitleAudit(run.id, member0.onboardingItemId);
  if (!childRun0 || !childRun0.configSnapshotId || !childRun0.configSnapshotHash) {
    throw new Error(
      `[CohortPageCoordinator] Ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) has no child run ` +
        'with freeze-persisted snapshot refs — refusing to coordinate pages without the frozen audit authority.',
    );
  }
  const memberSnapshot0 = getRuntimeSnapshotByHash(workspaceId, childRun0.configSnapshotHash);
  if (!memberSnapshot0) {
    throw new Error(
      `[CohortPageCoordinator] Frozen member runtime snapshot ${childRun0.configSnapshotHash} not found for ` +
        `ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) — refusing to coordinate pages without ` +
        'the frozen audit authority.',
    );
  }

  // Step 1 — the canonical page authority (DECISION-B/DECISION-F + PR7 review
  // R2 F2c): Execution Product Type (the SAME object the v2 prompt's type
  // context renders), the FROZEN-PLAN Page model authority + rule version
  // (derived inside `buildCohortPageAuthorityBundle` from THIS snapshot's
  // `cohort_page_assignment_parent` plan entry — never live credentials), and
  // the frozen page target config + verified page catalog (the SAME
  // derivation the child's `processPageTarget` uses:
  // `targetConfig.selectionMode ?? 'single'`, `maxPages = multiple ? 5 : 1`,
  // `buildPageHierarchy` over the frozen verified records).
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, memberSnapshot0);
  const boundPolicyView = modelPolicyViewFromConfig(
    memberSnapshot0.modelPolicy as never,
    memberSnapshot0.snapshotHash,
  );
  const resolved = resolveTargetsFromSnapshot(memberSnapshot0);
  const pageTarget = resolved.pages[0];
  // Config-level absence (DECISION-C): target disabled OR enabled without a
  // verified page catalog.
  const verifiedPagesAvailable = resolved.pages.length > 0 && pageTarget.options.length > 0;
  const selectionMode = (pageTarget?.config.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;
  const pagePlan: CohortPagePlanAuthority = {
    pages: verifiedPagesAvailable
      ? buildPageHierarchy(
          pageTarget.options,
          memberSnapshot0.pages.state === 'verified' ? memberSnapshot0.pages.records : [],
        )
      : [],
    selectionMode,
    maxPages,
  };
  // PR7 review R1 (B2): ONE canonical authority bundle — the SAME normalized
  // members, pages, selection, Execution Type authority, model authority, and
  // rule version feed BOTH the P-hash and the v2 parent prompt. The parent
  // prompt path builds its products/pages/selection from THIS bundle (never
  // re-deriving from the raw frozen line context), so hashed authority ==
  // prompted authority by construction (no duplicated truncation literals, no
  // order dependence). PR7 review R2 (F2c): the bundle derives modelAuthority
  // + ruleVersion from the frozen plan entry via `snapshot` — the parent op
  // loads memberSnapshot0 BEFORE building the bundle.
  const authorityBundle = buildCohortPageAuthorityBundle({
    run,
    projection,
    frozenLineContext,
    pageCatalog: pagePlan.pages,
    pagePlan,
    executionTypeAuthority,
    snapshot: memberSnapshot0,
  });
  // The P-set (DECISION-A): ALL members — groups AND singletons — unlike the
  // title kind's multi-item-group-only DECISION-O. Matches the bundle's sorted
  // membership exactly.
  const pSetSkus = authorityBundle.members.map(member => member.sku);
  const inputHash = computeCohortPageInputHash(authorityBundle);

  // Step 2 — persisted rows are read BEFORE any early return so the
  // expected-empty case can also fail closed on unexpected rows (PR6
  // hardening C SHOULD-FIX 1 pattern). Pure read: no keeper, no LLM, no
  // writes.
  const existingRows = getCohortPageOutputsByRun(run.id);

  // DECISION-C: config-level absence (page target disabled / no verified
  // pages) is NOT an output — the op writes NO rows and returns an empty map.
  // Any persisted rows for this run are write-once corruption — FAIL CLOSED
  // with the deterministic drift error (never a silent empty-map return).
  if (!verifiedPagesAvailable) {
    if (existingRows.length > 0) {
      const storedHashes = [...new Set(existingRows.map(row => row.inputHash))];
      throw new CohortPageAuthorityDriftError(run.id, inputHash, storedHashes, existingRows.length);
    }
    console.log(
      `[CohortPageCoordinator] Page target disabled / no verified pages for run ${run.id} — expected-empty, zero rows written.`,
    );
    return new Map();
  }

  // Step 3 — REUSE when the persisted set is EXACTLY the expected P-set AND
  // every row's hash matches the freshly computed P-hash. Pure reads.
  const rowBySku = new Map(existingRows.map(row => [row.productSku, row]));
  // PR6 hardening C (SHOULD-FIX 1): EXACT-SET EQUALITY — the persisted row
  // count must equal the expected P-set size AND every expected SKU must be
  // present. A same-hash set carrying UNEXPECTED EXTRA rows is write-once
  // corruption — drift, never reuse.
  const complete =
    existingRows.length === pSetSkus.length &&
    pSetSkus.every(sku => rowBySku.has(sku));
  const hashMatch = existingRows.every(row => row.inputHash === inputHash);
  if (complete && hashMatch) {
    const map = new Map<string, CoordinatedPageMemberValue>();
    for (const sku of pSetSkus) {
      const row = rowBySku.get(sku)!;
      map.set(sku, { output: parsePageRow(row), modelCallId: row.modelCallId });
    }
    console.log(
      `[CohortPageCoordinator] Reusing ${map.size} durable page outputs for run ${run.id} (complete set + hash match, zero LLM calls).`,
    );
    return map;
  }

  // Step 4 (PR6 hardening A) — WRITE-ONCE: any NONEMPTY committed set that is
  // incomplete or over-complete (extra rows) or whose rows do not match the
  // freshly computed P-hash is authority drift. The set can never be replaced
  // (the DELETE/replace path is gone), so the op FAILS CLOSED — it NEVER
  // re-coordinates and NEVER deletes. An incomplete/over-complete nonempty set
  // can only be corruption: the insert is all-or-nothing, so a partial or
  // extra-row set is never produced by any writer.
  if (existingRows.length > 0) {
    const storedHashes = [...new Set(existingRows.map(row => row.inputHash))];
    throw new CohortPageAuthorityDriftError(run.id, inputHash, storedHashes, existingRows.length);
  }

  // Step 5 — coordinate ONCE under a scoped lease keeper + persist
  // all-or-nothing. The keeper renews the parent lease on a TTL/3 cadence
  // while the audited calls are in flight; `assertHeld` (forwarded into the
  // group transport AND re-asserted after every await) aborts with
  // `HeartbeatLostError` the moment the claim is lost — no output rows are
  // ever written by a stale owner. The coordinate path is reached ONLY when
  // the set is EMPTY (zero rows — see the drift guard above).
  const workerId = run.claimedBy;
  if (!workerId) {
    throw new Error(`ensureCohortPagesCoordinated: run ${run.id} has no claim owner.`);
  }
  const keeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
  try {
    // FROZEN AUDIT AUTHORITY (PR7 review R2, F2): ONE audited model-call
    // context for the NEW parent operation `cohort_page_assignment_parent` —
    // shared by every parent page call (groups AND singletons — a singleton
    // is a one-member invocation of the SAME core, so there is exactly ONE
    // operation and ONE prompt family on the whole parent path). The audit
    // rows therefore carry the operation + the v2 prompt/rule versions from
    // the frozen plan (truthful provenance). FAIL CLOSED before any transport
    // when the frozen plan has no compatible entry (schema-v1 snapshot,
    // pre-change registry-v1 snapshot with no entry, version drift) — a
    // non-audited live page call is never made.
    const parentModelCallContext = requireModelCallContext(
      memberSnapshot0,
      childRun0.id,
      'cohort_page_assignment_parent',
      1,
    );
    if (!parentModelCallContext) {
      throw new Error(
        `[CohortPageCoordinator] No audited model-call context for ${member0.onboardingItemId} (run ${run.id}) ` +
          '— refusing to make a non-audited page call.',
      );
    }

    const pageHierarchy = authorityBundle.pages;
    const selectionMode = authorityBundle.selection.selectionMode;
    const maxPages = authorityBundle.selection.maxPages;
    // PR7 review R1 (B2): the parent prompt renders the SAME normalized
    // member slices the P-hash consumed (bundle members — sorted, shared
    // truncation) converted to the `ProductLineItemSnapshot` shape
    // `buildPrompt` renders. NEVER re-derives from the mutable/raw frozen
    // line context.
    const snapshotBySku = new Map(
      authorityBundle.members.map(member => [member.sku, pageAuthorityMemberToSnapshot(member)]),
    );
    const memberValues = new Map<string, CoordinatedPageMemberValue>();

    // EVERY group — multi-item AND singleton (DECISION-A) — goes through the
    // UNCACHED page core (the ONE prompt/validation authority shared with the
    // legacy wrapper, DECISION-H). The audited call id is shared by every
    // member of the group (the titles provenance precedent). Singletons are
    // ONE-MEMBER invocations with `allowSingleProduct` — the SAME v2 prompt
    // family, the SAME `cohort_page_assignment_parent` operation, and the
    // SAME ownership/crash seams as groups (PR7 review R2, F2: the legacy
    // `llmAssignCategoryPages` singleton path is gone from the parent op).
    // `afterCoordinatedCall` is threaded so the pre-commit crash seam fires
    // after each successful transport.
    for (const [groupKey, groupItems] of groupByProductLine(frozenLineContext.frozenBatchItems).entries()) {
      const skus = groupItems
        .map(item => item.upc)
        .filter((sku): sku is string => Boolean(sku));
      if (skus.length === 0) continue;
      const products = skus
        .map(sku => snapshotBySku.get(sku))
        .filter((snapshot): snapshot is ProductLineItemSnapshot => Boolean(snapshot));
      if (products.length !== skus.length) {
        throw new Error(
          `[CohortPageCoordinator] Frozen product-line snapshot missing for a member of group ${groupKey} ` +
            `(run ${run.id}) — refusing to coordinate pages from partial frozen authority.`,
        );
      }
      const coordinated = await coordinateCohortPagesCore(
        {
          groupId: groupKey,
          products,
          pages: pageHierarchy,
          selectionMode,
          maxPages,
          modelPolicy: boundPolicyView,
          modelCall: parentModelCallContext,
          snapshot: memberSnapshot0,
        },
        {
          assertHeld: () => keeper.assertHeld(),
          afterCoordinatedCall: params.afterCoordinatedCall,
          // PR7 review R1 (B1): the parent path ALWAYS renders the v2
          // Execution Type context block (the SAME full authority object the
          // P-hash consumed). The legacy wrapper passes no opts → v1
          // byte-identical.
          executionTypeContext: authorityBundle.executionTypeAuthority,
          // PR7 review R2 (F2): a singleton group is a ONE-MEMBER core
          // invocation — skip the >=2 products guard so the v2 prompt family
          // renders (prompt-parity with groups).
          allowSingleProduct: skus.length === 1,
          // PR7 review round 3 (P1): the parent transport/preflight routes as
          // ITS OWN frozen operation ('cohort_page_assignment_parent' with v2
          // prompt/rule versions) — never the legacy 'cohort_page_assignment'
          // v1 identity. The core also fail-closes when the modelCall
          // context's operation diverges.
          protectedOperation: 'cohort_page_assignment_parent',
        },
      );
      for (const sku of skus) {
        const result = coordinated.get(sku);
        if (!result) {
          throw new Error(
            `[CohortPageCoordinator] Group coordination returned no result for member ${sku} (run ${run.id}).`,
          );
        }
        memberValues.set(sku, toMemberValue(result));
      }
    }

    // EXACT-SET completeness: every P-set member (groups AND singletons) has
    // exactly one output value before anything is persisted.
    const missing = pSetSkus.filter(sku => !memberValues.has(sku));
    if (missing.length > 0) {
      throw new Error(
        `[CohortPageCoordinator] Coordinate step produced no output for members [${missing.join(', ')}] (run ${run.id}).`,
      );
    }

    // Post-await ownership guard BEFORE ANY write.
    keeper.assertHeld();

    const outputs = pSetSkus.map(sku => {
      const value = memberValues.get(sku)!;
      return { productSku: sku, output: value.output, modelCallId: value.modelCallId };
    });

    // ONE transaction — all members persist or NONE (architecture-report §5).
    // WRITE-ONCE (PR6 hardening A): the insert is guarded by
    // `insertCohortPageOutputsOnce`'s three-way semantics — zero rows ⇒
    // insert; any rows ⇒ `CohortOutputAlreadyCommittedError` (never delete).
    // A commit race (a sibling committed between our pure-read reuse check and
    // this insert) is converted to `CohortPageAuthorityDriftError` so the set
    // can never be silently split.
    try {
      insertCohortPageOutputsOnce({
        workspaceId,
        runId: run.id,
        inputHash,
        outputs,
      });
    } catch (err) {
      if (err instanceof CohortOutputAlreadyCommittedError) {
        const committed = getCohortPageOutputsByRun(run.id);
        const storedHashes = [...new Set(committed.map(row => row.inputHash))];
        throw new CohortPageAuthorityDriftError(run.id, inputHash, storedHashes, committed.length);
      }
      throw err;
    }

    const map = new Map<string, CoordinatedPageMemberValue>();
    for (const output of outputs) {
      map.set(output.productSku, { output: output.output, modelCallId: output.modelCallId });
    }
    const assignedCount = [...map.values()].filter(value => value.output.status === 'assigned').length;
    console.log(
      `[CohortPageCoordinator] Persisted ${map.size} page outputs for run ${run.id} ` +
        `(${assignedCount} assigned, ${map.size - assignedCount} abstained).`,
    );
    return map;
  } finally {
    keeper.stop();
  }
}
