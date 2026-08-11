import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch, deleteBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  getCohortTitleOutputsByRun,
  replaceCohortTitleOutputs,
  countCohortTitleOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import * as cohortOutputRepo from '../../db/repositories/classification-cohort-output-repo';
import { CohortTitleOutputSchema } from '../../shared/schemas/cohorts';

/**
 * PR6 C1 repo primitives (issue #30): `classification_cohort_outputs`
 * (cohort schema v7).
 *
 * - `getCohortTitleOutputsByRun`: reads the run's `curated_title` rows.
 * - `replaceCohortTitleOutputs`: ONE transaction — DELETE prior `curated_title`
 *   rows for the run then INSERT every row. All-or-nothing: any throw rolls
 *   back the whole set. NO update path anywhere (immutability).
 * - `countCohortTitleOutputs`: observability convenience.
 *
 * The outputs table FKs to `classification_cohort_runs` (ON DELETE CASCADE)
 * and `workspace`; batch deletion cascades cohort → run → outputs.
 */

let workspacePath: string;

/** Seed a workspace + batch + cohort + running run the outputs FK to. */
function seedChain(groupKey: string): { wsId: string; batchId: string; cohortId: string; runId: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const wsId = randomUUID();
  insertWorkspace({
    id: wsId,
    name: 'Cohort Output WS',
    workspacePath: '/tmp/cohort-output',
    gitPath: '',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const batchId = createBatch({ workspaceId: wsId, name: 'Cohort Output Batch', fileName: 'outputs.xlsx', totalItems: 2 }).id;
  const cohortId = randomUUID();
  db.run(
    `INSERT INTO curation_cohorts
       (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
        status, blocked_reason, created_at, updated_at, superseded_at)
     VALUES (?, ?, ?, ?, 'Output Family', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
    [cohortId, wsId, batchId, groupKey, 'f'.repeat(64), now, now],
  );
  const runId = randomUUID();
  db.run(
    `INSERT INTO classification_cohort_runs
       (id, workspace_id, cohort_id, candidate_membership_hash, final_membership_hash, evidence_snapshot_hash,
        status, claimed_by, claimed_at, lease_expires_at, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 'worker-a', ?, ?, ?, ?)`,
    [runId, wsId, cohortId, 'c'.repeat(64), 'f'.repeat(64), 'e'.repeat(64), now, now, now, now],
  );
  return { wsId, batchId, cohortId, runId };
}

describe('classification-cohort-output repo — PR6 C1 (issue #30)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-output-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('insert + read round-trips curated_title rows and output_value_json through CohortTitleOutputSchema', () => {
    const { wsId, runId } = seedChain('output-key-a');

    replaceCohortTitleOutputs({
      workspaceId: wsId,
      runId,
      inputHash: 'a'.repeat(64),
      outputs: [
        { productSku: 'SKU-A', title: 'Chicken Formula 5 lb', source: 'llm_cohort', modelCallId: 'call-1' },
        { productSku: 'SKU-B', title: 'Salmon Formula 10 lb', source: 'cohort_fallback' },
      ],
    });

    const rows = getCohortTitleOutputsByRun(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      productSku: 'SKU-A',
      inputHash: 'a'.repeat(64),
      outputValueJson: JSON.stringify({ title: 'Chicken Formula 5 lb', source: 'llm_cohort' }),
      modelCallId: 'call-1',
    });
    expect(rows[1]).toEqual({
      productSku: 'SKU-B',
      inputHash: 'a'.repeat(64),
      outputValueJson: JSON.stringify({ title: 'Salmon Formula 10 lb', source: 'cohort_fallback' }),
      modelCallId: null,
    });

    // output_value_json parses through the shared title payload schema.
    for (const row of rows) {
      expect(CohortTitleOutputSchema.parse(JSON.parse(row.outputValueJson))).toBeTruthy();
    }
    expect(countCohortTitleOutputs(runId)).toBe(2);

    // No rows for other runs / kinds.
    expect(getCohortTitleOutputsByRun('no-such-run')).toEqual([]);
  });

  it('replace under a new hash atomically removes the prior set and inserts the new one', () => {
    const { wsId, runId } = seedChain('output-key-b');

    replaceCohortTitleOutputs({
      workspaceId: wsId,
      runId,
      inputHash: 'h1'.repeat(8),
      outputs: [
        { productSku: 'SKU-1', title: 'Old One', source: 'llm_cohort' },
        { productSku: 'SKU-2', title: 'Old Two', source: 'llm_cohort' },
      ],
    });
    expect(countCohortTitleOutputs(runId)).toBe(2);

    // A changed title authority (new input hash) replaces the whole set —
    // old rows are gone, every new row carries the new hash.
    replaceCohortTitleOutputs({
      workspaceId: wsId,
      runId,
      inputHash: 'h2'.repeat(8),
      outputs: [{ productSku: 'SKU-3', title: 'New Three', source: 'cohort_fallback' }],
    });

    const rows = getCohortTitleOutputsByRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].productSku).toBe('SKU-3');
    expect(rows[0].inputHash).toBe('h2'.repeat(8));
  });

  it('a UNIQUE failure inside the transaction rolls the whole set back (all-or-nothing, zero rows remain)', () => {
    const { wsId, runId } = seedChain('output-key-c');

    // Outputs batch containing the SAME (run, kind, sku) twice: the second
    // INSERT violates UNIQUE (cohort_run_id, output_kind, product_sku) MID-
    // transaction, after the DELETE of the prior set already ran.
    expect(() =>
      replaceCohortTitleOutputs({
        workspaceId: wsId,
        runId,
        inputHash: 'h3'.repeat(8),
        outputs: [
          { productSku: 'SKU-ROLLBACK', title: 'New One', source: 'llm_cohort' },
          { productSku: 'SKU-ROLLBACK', title: 'New One Duplicate', source: 'llm_cohort' },
        ],
      }),
    ).toThrow(/UNIQUE constraint failed/);

    // Zero rows remain: the DELETE rolled back AND no partial insert survived.
    expect(getCohortTitleOutputsByRun(runId)).toEqual([]);
    expect(countCohortTitleOutputs(runId)).toBe(0);
  });

  it('a workspace FK failure inside the transaction rolls back the DELETE too (prior set intact)', () => {
    const { wsId, runId } = seedChain('output-key-d');

    // A prior complete set under hash h1.
    replaceCohortTitleOutputs({
      workspaceId: wsId,
      runId,
      inputHash: 'h1'.repeat(8),
      outputs: [
        { productSku: 'SKU-FK-1', title: 'Keep One', source: 'llm_cohort' },
        { productSku: 'SKU-FK-2', title: 'Keep Two', source: 'cohort_fallback' },
      ],
    });

    // Replace with a workspace that does not exist: the first INSERT throws a
    // FOREIGN KEY failure mid-transaction — the DELETE already ran, so the
    // whole set must roll back to the prior state.
    expect(() =>
      replaceCohortTitleOutputs({
        workspaceId: 'no-such-workspace',
        runId,
        inputHash: 'h9'.repeat(8),
        outputs: [{ productSku: 'SKU-FK-3', title: 'Would-Be New', source: 'llm_cohort' }],
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);

    // The prior set is byte-identical — no partial delete, no partial insert.
    expect(getCohortTitleOutputsByRun(runId)).toEqual([
      {
        productSku: 'SKU-FK-1',
        inputHash: 'h1'.repeat(8),
        outputValueJson: JSON.stringify({ title: 'Keep One', source: 'llm_cohort' }),
        modelCallId: null,
      },
      {
        productSku: 'SKU-FK-2',
        inputHash: 'h1'.repeat(8),
        outputValueJson: JSON.stringify({ title: 'Keep Two', source: 'cohort_fallback' }),
        modelCallId: null,
      },
    ]);
  });

  it('FK CASCADE: deleting the cohort run removes its output rows; the workspace cleanup chain removes them too', () => {
    const { runId } = seedChain('output-key-e');
    const runWs = getDb().query('SELECT workspace_id FROM classification_cohort_runs WHERE id = ?').get(runId) as { workspace_id: string };
    replaceCohortTitleOutputs({
      workspaceId: runWs.workspace_id,
      runId,
      inputHash: 'e'.repeat(64),
      outputs: [{ productSku: 'SKU-CASCADE', title: 'Gone Soon', source: 'llm_cohort' }],
    });
    expect(countCohortTitleOutputs(runId)).toBe(1);

    // Direct run-row deletion cascades to its outputs (ON DELETE CASCADE).
    getDb().run('DELETE FROM classification_cohort_runs WHERE id = ?', [runId]);
    expect(countCohortTitleOutputs(runId)).toBe(0);

    // Workspace cleanup: batch deletion cascades cohort → run → outputs, and
    // the workspace row then deletes cleanly (there is no workspace-delete
    // service; the batch-delete cascade is the workspace cleanup mechanism —
    // a direct `DELETE FROM workspace` is FK-blocked while its batches exist).
    const { wsId, batchId, runId: run2 } = seedChain('output-key-f');
    replaceCohortTitleOutputs({
      workspaceId: wsId,
      runId: run2,
      inputHash: 'f'.repeat(64),
      outputs: [{ productSku: 'SKU-CASCADE-2', title: 'Gone Too', source: 'cohort_fallback' }],
    });
    expect(countCohortTitleOutputs(run2)).toBe(1);
    expect(deleteBatch(batchId)).toBe(true);
    expect(countCohortTitleOutputs(run2)).toBe(0);
    expect(() => getDb().run('DELETE FROM workspace WHERE id = ?', [wsId])).not.toThrow();
  });

  it('immutability: the repo exposes no update function', () => {
    // @ts-expect-error — immutability: the repo exposes NO update function;
    // outputs are replaced wholesale via the transaction, never updated.
    void cohortOutputRepo.updateCohortOutput;
  });
});
