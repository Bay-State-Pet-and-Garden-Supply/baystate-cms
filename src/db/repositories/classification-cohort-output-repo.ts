/**
 * Cohort output repository (issue #30, PR6 C1; cohort schema v7).
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
 * primitive is `insertCohortTitleOutputsOnce`, which inserts a fresh set ONLY
 * when ZERO rows exist for the (run, kind) and THROWS
 * `CohortOutputAlreadyCommittedError` when any rows already exist — INSIDE
 * ONE transaction (all-or-nothing — any throw rolls back the whole set). A
 * new cohort revision is a NEW run id, so superseding the parent run (which
 * leaves its outputs in place) automatically produces NEW output rows under
 * the new run. Outputs cover multi-item group members only (DECISION-O);
 * singletons are never written.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { CohortTitleSource } from '../../shared/schemas/cohorts';

const now = () => new Date().toISOString();

// ─── Read shapes ──────────────────────────────────────────────────────────────

/**
 * One persisted `curated_title` output row for a run (camelCase). The
 * `outputValueJson` payload parses through `CohortTitleOutputSchema`
 * ({title, source}).
 */
export interface CohortTitleOutputRow {
  productSku: string;
  inputHash: string;
  outputValueJson: string;
  modelCallId: string | null;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every persisted `curated_title` output row for a cohort run, in
 * `created_at` order (stable insertion order). Returns [] when the run has
 * none. The completeness+hash check is a single query against these rows:
 * every multi-item group member has a row AND every row's `inputHash` matches
 * the freshly computed canonical title input hash.
 */
export function getCohortTitleOutputsByRun(runId: string): CohortTitleOutputRow[] {
  const rows = getDb().query(
    `SELECT product_sku, input_hash, output_value_json, model_call_id
     FROM classification_cohort_outputs
     WHERE cohort_run_id = ? AND output_kind = 'curated_title'
     ORDER BY created_at ASC`,
  ).all(runId) as Record<string, any>[];
  return rows.map(row => ({
    productSku: row.product_sku,
    inputHash: row.input_hash,
    outputValueJson: row.output_value_json,
    modelCallId: row.model_call_id ?? null,
  }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface CohortTitleOutputInput {
  productSku: string;
  title: string;
  source: CohortTitleSource;
  /** Audited classification_model_calls id when source='llm_cohort' (soft ref). */
  modelCallId?: string | null;
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
 * Insert a cohort run's `curated_title` outputs ONCE — the ONLY write path
 * for the outputs table (immutability: no UPDATE anywhere; the DELETE/replace
 * path is GONE).
 *
 * THREE-WAY SEMANTICS inside ONE `db.transaction` (PR6 hardening A):
 * - ZERO existing rows for (run, 'curated_title') → insert every row
 *   (all-or-nothing — any throw rolls back the whole set);
 * - ANY existing row → throw `CohortOutputAlreadyCommittedError` (with the
 *   run id + kind + the existing set's input hash) and NEVER delete;
 * - the reuse check stays a pure read (`getCohortTitleOutputsByRun`).
 *
 * The UNIQUE (cohort_run_id, output_kind, product_sku) index is the DB-level
 * backstop for a duplicate-sku batch inside a single insert.
 */
export function insertCohortTitleOutputsOnce(input: {
  workspaceId: string;
  runId: string;
  inputHash: string;
  outputs: CohortTitleOutputInput[];
}): void {
  const db = getDb();
  db.transaction(() => {
    const existing = db.query(
      `SELECT input_hash FROM classification_cohort_outputs
       WHERE cohort_run_id = ? AND output_kind = 'curated_title'
       LIMIT 1`,
    ).get(input.runId) as { input_hash: string } | undefined;
    if (existing) {
      throw new CohortOutputAlreadyCommittedError(input.runId, 'curated_title', existing.input_hash);
    }
    for (const output of input.outputs) {
      db.run(
        `INSERT INTO classification_cohort_outputs
           (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
         VALUES (?, ?, ?, 'curated_title', ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.workspaceId,
          input.runId,
          output.productSku,
          input.inputHash,
          JSON.stringify({ title: output.title, source: output.source }),
          output.modelCallId ?? null,
          now(),
        ],
      );
    }
  })();
}

/**
 * Count of persisted `curated_title` output rows for a cohort run
 * (test/observability convenience).
 */
// fallow-ignore-next-line unused-export — used by tests
export function countCohortTitleOutputs(runId: string): number {
  const row = getDb().query(
    `SELECT COUNT(*) AS c FROM classification_cohort_outputs
     WHERE cohort_run_id = ? AND output_kind = 'curated_title'`,
  ).get(runId) as { c: number };
  return Number(row.c);
}
