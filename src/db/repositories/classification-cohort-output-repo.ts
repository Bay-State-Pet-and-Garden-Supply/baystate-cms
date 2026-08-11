/**
 * Cohort output repository (issue #30, PR6 C1; cohort schema v7).
 *
 * Function module (no class): snake_case row interfaces + camelCase mappers,
 * `randomUUID()` ids, ISO `now()` timestamps, positional `?` params, and
 * `db.transaction(() => {})()` for multi-table writes — following the
 * classification-cohort-run-repo / curation-cohort-repo conventions.
 *
 * IMMUTABILITY (architecture-report §2.1, DECISION-T): `classification_cohort_outputs`
 * rows are historical truth — there is NO update path anywhere in this repo
 * (and no UPDATE SQL anywhere in the codebase for this table). A new cohort
 * revision is a NEW run id, so superseding the parent run (which leaves its
 * outputs in place) automatically produces NEW output rows under the new run.
 * The only write primitive is `replaceCohortTitleOutputs`: DELETE the prior
 * `curated_title` rows for the run + INSERT every row INSIDE ONE transaction
 * (all-or-nothing — any throw rolls back the whole set). Outputs cover
 * multi-item group members only (DECISION-O); singletons are never written.
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
 * Replace a cohort run's `curated_title` outputs — the ONLY write path for
 * the outputs table (immutability: no UPDATE anywhere; the unique
 * (cohort_run_id, output_kind, product_sku) index makes an insert-after-
 * delete inside one transaction the canonical replacement).
 *
 * ALL-OR-NOTHING (architecture-report §5.1): the DELETE of the prior
 * `curated_title` rows for the run and every INSERT run inside ONE
 * `db.transaction`. Any throw (FK failure, UNIQUE collision) rolls back the
 * whole set — the old rows are never partially deleted and new rows are never
 * partially inserted. Every row shares the same `inputHash` (the canonical
 * title input hash computed at the parent op) so the reuse check is a single
 * per-row comparison.
 */
export function replaceCohortTitleOutputs(input: {
  workspaceId: string;
  runId: string;
  inputHash: string;
  outputs: CohortTitleOutputInput[];
}): void {
  const db = getDb();
  db.transaction(() => {
    db.run(
      `DELETE FROM classification_cohort_outputs
       WHERE cohort_run_id = ? AND output_kind = 'curated_title'`,
      [input.runId],
    );
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
