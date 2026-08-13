/**
 * Cohort output repository (issue #30, PR6 C1 + PR7 C1; cohort schema v7).
 *
 * Function module (no class): snake_case row interfaces + camelCase mappers,
 * `randomUUID()` ids, ISO `now()` timestamps, positional `?` params, and
 * `db.transaction(() => {})()` for multi-table writes — following the
 * classification-cohort-run-repo / curation-cohort-repo conventions.
 *
 * WRITE-ONCE (PR6 hardening A; architecture-report §2.1, DECISION-T):
 * `classification_cohort_outputs` rows are historical truth — there is NO
 * update path anywhere in this repo (no UPDATE SQL), and the DELETE/replace
 * path has been REMOVED entirely. Once ANY shared output set is committed for
 * (cohort_run_id, output_kind), that set is write-once: the ONLY write
 * primitive is the internal `insertCohortOutputsOnce`, which inserts a fresh
 * set ONLY when ZERO rows exist for the (run, kind) and THROWS
 * `CohortOutputAlreadyCommittedError` when any rows already exist — INSIDE
 * ONE transaction (all-or-nothing — any throw rolls back the whole set). A
 * new cohort revision is a NEW run id, so superseding the parent run (which
 * leaves its outputs in place) automatically produces NEW output rows under
 * the new run.
 *
 * PR7 (issue #30, durable coordinated Category Pages): the SAME write-once
 * table carries `coordinated_page` outputs via `insertCohortPageOutputsOnce`.
 * Page outputs cover ALL members of the cohort — groups AND singletons
 * (DECISION-A: singletons are parent-owned too) — a deliberate asymmetry vs
 * the `curated_title` kind, which writes multi-item group members only
 * (DECISION-O). Both kinds are write-once per (cohort_run_id, output_kind);
 * kind isolation is enforced by the SQL predicates, so one run can hold both
 * title and page sets independently.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { CohortTitleSource, CohortPageOutput, CohortOutputKind } from '../../shared/schemas/cohorts';

const now = () => new Date().toISOString();

// ─── Read shapes ──────────────────────────────────────────────────────────────

/**
 * One persisted cohort output row for a run (camelCase), kind-agnostic. The
 * `outputValueJson` payload parses through `CohortTitleOutputSchema`
 * ({title, source}) for 'curated_title' rows or `CohortPageOutputSchema`
 * ({status:'assigned'|'abstained', ...}) for 'coordinated_page' rows.
 */
export interface CohortOutputRow {
  productSku: string;
  inputHash: string;
  outputValueJson: string;
  modelCallId: string | null;
}

/** Backward-compatible PR6 alias: the title-kind reader's row shape. */
export type CohortTitleOutputRow = CohortOutputRow;

/** PR7 page-kind row alias. */
export type CohortPageOutputRow = CohortOutputRow;

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every persisted output row of one kind for a cohort run, in `created_at`
 * order (stable insertion order). Returns [] when the run has none. The
 * completeness+hash check is a single query against these rows: every member
 * of the kind's target set has a row AND every row's `inputHash` matches the
 * freshly computed canonical input hash.
 */
function getCohortOutputsByRun(outputKind: string, runId: string): CohortOutputRow[] {
  const rows = getDb().query(
    `SELECT product_sku, input_hash, output_value_json, model_call_id
     FROM classification_cohort_outputs
     WHERE cohort_run_id = ? AND output_kind = ?
     ORDER BY created_at ASC`,
  ).all(runId, outputKind) as Record<string, any>[];
  return rows.map(row => ({
    productSku: row.product_sku,
    inputHash: row.input_hash,
    outputValueJson: row.output_value_json,
    modelCallId: row.model_call_id ?? null,
  }));
}

/** Every persisted `curated_title` output row for a cohort run. */
export function getCohortTitleOutputsByRun(runId: string): CohortOutputRow[] {
  return getCohortOutputsByRun('curated_title', runId);
}

/** Every persisted `coordinated_page` output row for a cohort run (PR7). */
export function getCohortPageOutputsByRun(runId: string): CohortOutputRow[] {
  return getCohortOutputsByRun('coordinated_page', runId);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface CohortTitleOutputInput {
  productSku: string;
  title: string;
  source: CohortTitleSource;
  /** Audited classification_model_calls id when source='llm_cohort' (soft ref). */
  modelCallId?: string | null;
}

export interface CohortPageOutputInput {
  productSku: string;
  /** The full coordinated_page payload ({status:'assigned',...} | {status:'abstained', reason}). */
  output: CohortPageOutput;
  /** Audited parent model-call id when status='assigned' (soft ref; null for abstentions). */
  modelCallId?: string | null;
}

/** Pre-serialized row the kind-parameterized write-once primitive inserts. */
interface CohortOutputWriteRow {
  productSku: string;
  outputValueJson: string;
  modelCallId: string | null;
}

/**
 * Deterministic write-once guard (PR6 hardening A). Thrown when a commit is
 * attempted for a (cohort_run_id, output_kind) that ALREADY has persisted
 * rows — the committed set is immutable and can never be replaced (the
 * DELETE/replace path no longer exists). Carries the run id, output kind, and
 * the existing set's input hash for deterministic diagnostics.
 */
export class CohortOutputAlreadyCommittedError extends Error {
  readonly runId: string;
  readonly outputKind: string;
  readonly existingInputHash: string;

  constructor(runId: string, outputKind: string, existingInputHash: string) {
    super(
      `[CohortOutputAlreadyCommitted] Durable cohort output set for run ${runId} / kind ${outputKind} is write-once: ` +
        `a set is already committed (input_hash=${existingInputHash}) — refusing to insert again. ` +
        'A committed set can never be replaced or extended; a new cohort revision must use a NEW run id.',
    );
    this.name = 'CohortOutputAlreadyCommittedError';
    this.runId = runId;
    this.outputKind = outputKind;
    this.existingInputHash = existingInputHash;
  }
}

/**
 * The ONLY write primitive for the outputs table, parameterized by kind
 * (PR7 C1 generalization, DECISION-G): the PR6 three-way write-once insert
 * with the kind carried by the SQL predicate instead of hard-coded.
 *
 * THREE-WAY SEMANTICS inside ONE `db.transaction` (PR6 hardening A):
 * - ZERO existing rows for (run, kind) → insert every row (all-or-nothing —
 *   any throw rolls back the whole set);
 * - ANY existing row → throw `CohortOutputAlreadyCommittedError` (with the
 *   run id + kind + the existing set's input hash) and NEVER delete;
 * - the reuse check stays a pure read (`getCohortTitleOutputsByRun` /
 *   `getCohortPageOutputsByRun`).
 *
 * The UNIQUE (cohort_run_id, output_kind, product_sku) index is the DB-level
 * backstop for a duplicate-sku batch inside a single insert.
 */
function insertCohortOutputsOnce(
  outputKind: CohortOutputKind,
  input: {
    workspaceId: string;
    runId: string;
    inputHash: string;
    rows: CohortOutputWriteRow[];
  },
): void {
  const db = getDb();
  db.transaction(() => {
    const existing = db.query(
      `SELECT input_hash FROM classification_cohort_outputs
       WHERE cohort_run_id = ? AND output_kind = ?
       LIMIT 1`,
    ).get(input.runId, outputKind) as { input_hash: string } | undefined;
    if (existing) {
      throw new CohortOutputAlreadyCommittedError(input.runId, outputKind, existing.input_hash);
    }
    for (const row of input.rows) {
      db.run(
        `INSERT INTO classification_cohort_outputs
           (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          input.runId,
          outputKind,
          row.productSku,
          input.inputHash,
          row.outputValueJson,
          row.modelCallId,
          now(),
        ],
      );
    }
  })();
}

/**
 * Insert a cohort run's `curated_title` outputs ONCE — thin typed wrapper
 * over `insertCohortOutputsOnce` with BYTE-IDENTICAL behavior to the PR6
 * primitive (payload `{title, source}`, kind `curated_title`).
 */
export function insertCohortTitleOutputsOnce(input: {
  workspaceId: string;
  runId: string;
  inputHash: string;
  outputs: CohortTitleOutputInput[];
}): void {
  insertCohortOutputsOnce('curated_title', {
    workspaceId: input.workspaceId,
    runId: input.runId,
    inputHash: input.inputHash,
    rows: input.outputs.map(output => ({
      productSku: output.productSku,
      outputValueJson: JSON.stringify({ title: output.title, source: output.source }),
      modelCallId: output.modelCallId ?? null,
    })),
  });
}

/**
 * Insert a cohort run's `coordinated_page` outputs ONCE (PR7 C1) — the same
 * three-way write-once primitive, kind `coordinated_page`. The full payload
 * ({status:'assigned', pages, source} | {status:'abstained', reason}) is
 * serialized per row; `model_call_id` stores the audited parent call id
 * (group members share their group call id — the titles provenance
 * precedent).
 */
export function insertCohortPageOutputsOnce(input: {
  workspaceId: string;
  runId: string;
  inputHash: string;
  outputs: CohortPageOutputInput[];
}): void {
  insertCohortOutputsOnce('coordinated_page', {
    workspaceId: input.workspaceId,
    runId: input.runId,
    inputHash: input.inputHash,
    rows: input.outputs.map(output => ({
      productSku: output.productSku,
      outputValueJson: JSON.stringify(output.output),
      modelCallId: output.modelCallId ?? null,
    })),
  });
}

// ─── Counters ─────────────────────────────────────────────────────────────────

/** Count of persisted output rows of one kind for a cohort run. */
function countCohortOutputs(outputKind: string, runId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS c FROM classification_cohort_outputs
     WHERE cohort_run_id = ? AND output_kind = ?`,
  ).get(runId, outputKind) as { c: number };
  return Number(row.c);
}

/**
 * Count of persisted `curated_title` output rows for a cohort run
 * (test/observability convenience).
 */
// fallow-ignore-next-line unused-export — used by tests
export function countCohortTitleOutputs(runId: string): number {
  return countCohortOutputs('curated_title', runId);
}

/**
 * Count of persisted `coordinated_page` output rows for a cohort run
 * (test/observability convenience; PR7 C1).
 */
// fallow-ignore-next-line unused-export — used by tests
export function countCohortPageOutputs(runId: string): number {
  return countCohortOutputs('coordinated_page', runId);
}
