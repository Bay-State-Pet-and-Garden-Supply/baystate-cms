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
  insertCohortTitleOutputsOnce,
  countCohortTitleOutputs,
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
  countCohortPageOutputs,
  CohortOutputAlreadyCommittedError,
} from '../../db/repositories/classification-cohort-output-repo';
import * as cohortOutputRepo from '../../db/repositories/classification-cohort-output-repo';
import { CohortTitleOutputSchema, CohortPageOutputSchema } from '../../shared/schemas/cohorts';

/**
 * PR6 C1 repo primitives (issue #30): `classification_cohort_outputs`
 * (cohort schema v7).
 *
 * - `getCohortTitleOutputsByRun`: reads the run's `curated_title` rows.
 * - `insertCohortTitleOutputsOnce` (PR6 hardening A): the ONLY write path —
 *   ONE transaction inserting a fresh set ONLY when ZERO rows exist for the
 *   (run, kind); ANY existing row throws `CohortOutputAlreadyCommittedError`
 *   (write-once — the DELETE/replace path is gone). All-or-nothing: any throw
 *   rolls back the whole set. NO update path anywhere (immutability).
 * - `countCohortTitleOutputs`: observability convenience.
 *
 * PR7 C1 (issue #30): the same write-once primitive is generalized per kind
 * (DECISION-G) — `insertCohortPageOutputsOnce` / `getCohortPageOutputsByRun` /
 * `countCohortPageOutputs` for `coordinated_page` rows (assigned OR
 * abstained payloads; ALL cohort members incl. singletons). Kind isolation:
 * one run holds title and page sets independently; a second insert of EITHER
 * kind throws with the kind carried on the error.
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

    insertCohortTitleOutputsOnce({
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

  it('write-once: a second insert (any rows) throws CohortOutputAlreadyCommittedError and the committed set is untouched', () => {
    const { wsId, runId } = seedChain('output-key-b');

    insertCohortTitleOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'h1'.repeat(8),
      outputs: [
        { productSku: 'SKU-1', title: 'Old One', source: 'llm_cohort' },
        { productSku: 'SKU-2', title: 'Old Two', source: 'llm_cohort' },
      ],
    });
    expect(countCohortTitleOutputs(runId)).toBe(2);

    // A changed title authority (new input hash) can NEVER replace the
    // committed set — even with a different SKU set, the second insert throws
    // the deterministic write-once guard (with the run id + kind + existing
    // input hash) and the DELETE/replace path no longer exists.
    let thrown: unknown;
    try {
      insertCohortTitleOutputsOnce({
        workspaceId: wsId,
        runId,
        inputHash: 'h2'.repeat(8),
        outputs: [{ productSku: 'SKU-3', title: 'New Three', source: 'cohort_fallback' }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortOutputAlreadyCommittedError);
    const err = thrown as CohortOutputAlreadyCommittedError;
    expect(err.runId).toBe(runId);
    expect(err.outputKind).toBe('curated_title');
    expect(err.existingInputHash).toBe('h1'.repeat(8));
    expect(err.message).toContain(runId);
    expect(err.message).toContain('h1'.repeat(8));

    // The committed set is byte-identical — nothing was deleted or rewritten.
    const rows = getCohortTitleOutputsByRun(runId);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.inputHash === 'h1'.repeat(8))).toBe(true);
    expect(rows.map(r => r.productSku).sort()).toEqual(['SKU-1', 'SKU-2']);
  });

  it('inserting an empty output list commits nothing and does not throw', () => {
    const { wsId, runId } = seedChain('output-key-g');
    // Zero rows before; the write-once guard only fires on an EXISTING set.
    expect(() =>
      insertCohortTitleOutputsOnce({
        workspaceId: wsId,
        runId,
        inputHash: 'e'.repeat(64),
        outputs: [],
      }),
    ).not.toThrow();
    expect(countCohortTitleOutputs(runId)).toBe(0);
    // A later real insert still succeeds (no sentinel row was written).
    insertCohortTitleOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'e'.repeat(64),
      outputs: [{ productSku: 'SKU-EMPTY-AFTER', title: 'Later Title', source: 'cohort_fallback' }],
    });
    expect(countCohortTitleOutputs(runId)).toBe(1);
  });

  it('a UNIQUE failure inside the transaction rolls the whole insert back (all-or-nothing, zero rows remain)', () => {
    const { wsId, runId } = seedChain('output-key-c');

    // Outputs batch containing the SAME (run, kind, sku) twice: the second
    // INSERT violates UNIQUE (cohort_run_id, output_kind, product_sku) MID-
    // transaction (the fresh-insert path has no prior set to delete).
    expect(() =>
      insertCohortTitleOutputsOnce({
        workspaceId: wsId,
        runId,
        inputHash: 'h3'.repeat(8),
        outputs: [
          { productSku: 'SKU-ROLLBACK', title: 'New One', source: 'llm_cohort' },
          { productSku: 'SKU-ROLLBACK', title: 'New One Duplicate', source: 'llm_cohort' },
        ],
      }),
    ).toThrow(/UNIQUE constraint failed/);

    // Zero rows remain: no partial insert survived the rollback.
    expect(getCohortTitleOutputsByRun(runId)).toEqual([]);
    expect(countCohortTitleOutputs(runId)).toBe(0);
  });

  it('a workspace FK failure inside the transaction rolls the whole fresh insert back (zero rows remain)', () => {
    const { wsId, runId } = seedChain('output-key-d');

    // Insert with a workspace that does not exist: the first INSERT throws a
    // FOREIGN KEY failure mid-transaction — the whole fresh set rolls back.
    expect(() =>
      insertCohortTitleOutputsOnce({
        workspaceId: 'no-such-workspace',
        runId,
        inputHash: 'h9'.repeat(8),
        outputs: [{ productSku: 'SKU-FK-3', title: 'Would-Be New', source: 'llm_cohort' }],
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);

    // Zero rows remain — no partial insert survived the rollback, and the run
    // is still free for a legitimate later commit.
    expect(getCohortTitleOutputsByRun(runId)).toEqual([]);
    expect(countCohortTitleOutputs(runId)).toBe(0);
    insertCohortTitleOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'h9'.repeat(8),
      outputs: [{ productSku: 'SKU-FK-4', title: 'Later Committed', source: 'cohort_fallback' }],
    });
    expect(countCohortTitleOutputs(runId)).toBe(1);
  });

  it('FK CASCADE: deleting the cohort run removes its output rows; the workspace cleanup chain removes them too', () => {
    const { runId } = seedChain('output-key-e');
    const runWs = getDb().query('SELECT workspace_id FROM classification_cohort_runs WHERE id = ?').get(runId) as { workspace_id: string };
    insertCohortTitleOutputsOnce({
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
    insertCohortTitleOutputsOnce({
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

  it('PR7 C1: insert + read round-trips coordinated_page rows (assigned + abstained) through CohortPageOutputSchema', () => {
    const { wsId, runId } = seedChain('page-output-key-a');

    insertCohortPageOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'p'.repeat(64),
      outputs: [
        {
          productSku: 'SKU-A',
          output: {
            status: 'assigned',
            pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
            source: 'llm_cohort',
          },
          modelCallId: 'page-call-1',
        },
        {
          productSku: 'SKU-B',
          output: { status: 'abstained', reason: 'No configured Category Pages are available.' },
        },
      ],
    });

    const rows = getCohortPageOutputsByRun(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      productSku: 'SKU-A',
      inputHash: 'p'.repeat(64),
      outputValueJson: JSON.stringify({
        status: 'assigned',
        pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.8 }],
        source: 'llm_cohort',
      }),
      modelCallId: 'page-call-1',
    });
    expect(rows[1]).toEqual({
      productSku: 'SKU-B',
      inputHash: 'p'.repeat(64),
      outputValueJson: JSON.stringify({ status: 'abstained', reason: 'No configured Category Pages are available.' }),
      modelCallId: null,
    });

    // output_value_json parses through the shared page payload schema.
    const parsed = rows.map(row => CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson)));
    expect(parsed[0].status).toBe('assigned');
    if (parsed[0].status === 'assigned') expect(parsed[0].pages[0].pageId).toBe('cat-wet');
    expect(parsed[1].status).toBe('abstained');
    expect(countCohortPageOutputs(runId)).toBe(2);

    // Kind isolation: the page set never leaks into the title reads.
    expect(getCohortTitleOutputsByRun(runId)).toEqual([]);
    expect(getCohortPageOutputsByRun('no-such-run')).toEqual([]);
  });

  it('PR7 C1: write-once — a second coordinated_page insert throws CohortOutputAlreadyCommittedError carrying kind coordinated_page', () => {
    const { wsId, runId } = seedChain('page-output-key-b');

    insertCohortPageOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'p1'.repeat(8),
      outputs: [
        {
          productSku: 'SKU-1',
          output: {
            status: 'assigned',
            pages: [{ pageId: 'dog-food', pageName: 'Dog Food Dry', confidence: 0.9 }],
            source: 'llm_cohort',
          },
        },
        {
          productSku: 'SKU-2',
          output: { status: 'abstained', reason: 'Cohort page LLM policy denied.' },
        },
      ],
    });
    expect(countCohortPageOutputs(runId)).toBe(2);

    let thrown: unknown;
    try {
      insertCohortPageOutputsOnce({
        workspaceId: wsId,
        runId,
        inputHash: 'p2'.repeat(8),
        outputs: [{ productSku: 'SKU-3', output: { status: 'abstained', reason: 'Never inserted.' } }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortOutputAlreadyCommittedError);
    const err = thrown as CohortOutputAlreadyCommittedError;
    expect(err.runId).toBe(runId);
    expect(err.outputKind).toBe('coordinated_page');
    expect(err.existingInputHash).toBe('p1'.repeat(8));
    expect(err.message).toContain(runId);
    expect(err.message).toContain('coordinated_page');

    // The committed set is byte-identical — nothing was deleted or rewritten.
    const rows = getCohortPageOutputsByRun(runId);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.inputHash === 'p1'.repeat(8))).toBe(true);
    expect(rows.map(r => r.productSku).sort()).toEqual(['SKU-1', 'SKU-2']);
  });

  it('PR7 C1: both kinds coexist on one run — title and page sets are independent (write-once per kind)', () => {
    const { wsId, runId } = seedChain('page-output-key-c');

    // Title set committed first.
    insertCohortTitleOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 't'.repeat(64),
      outputs: [{ productSku: 'SKU-T', title: 'Chicken Formula', source: 'cohort_fallback' }],
    });
    expect(countCohortTitleOutputs(runId)).toBe(1);

    // The page set is committed INDEPENDENTLY (same run, different kind).
    insertCohortPageOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'p'.repeat(64),
      outputs: [
        {
          productSku: 'SKU-T',
          output: {
            status: 'assigned',
            pages: [{ pageId: 'cat-wet', pageName: 'Cat Food Wet', confidence: 0.7 }],
            source: 'llm_cohort',
          },
        },
      ],
    });
    expect(countCohortPageOutputs(runId)).toBe(1);
    expect(countCohortTitleOutputs(runId)).toBe(1);

    // …and a second PAGE insert still throws (write-once per kind).
    let thrown: unknown;
    try {
      insertCohortPageOutputsOnce({
        workspaceId: wsId,
        runId,
        inputHash: 'p2'.repeat(8),
        outputs: [{ productSku: 'SKU-X', output: { status: 'abstained', reason: 'R' } }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CohortOutputAlreadyCommittedError);
    expect((thrown as CohortOutputAlreadyCommittedError).outputKind).toBe('coordinated_page');
  });

  it('PR7 C1: inserting an empty page output list commits nothing and does not throw', () => {
    const { wsId, runId } = seedChain('page-output-key-g');
    expect(() =>
      insertCohortPageOutputsOnce({ workspaceId: wsId, runId, inputHash: 'e'.repeat(64), outputs: [] }),
    ).not.toThrow();
    expect(countCohortPageOutputs(runId)).toBe(0);
    // A later real insert still succeeds (no sentinel row was written).
    insertCohortPageOutputsOnce({
      workspaceId: wsId,
      runId,
      inputHash: 'e'.repeat(64),
      outputs: [{ productSku: 'SKU-EMPTY-AFTER', output: { status: 'abstained', reason: 'Later' } }],
    });
    expect(countCohortPageOutputs(runId)).toBe(1);
  });

  it('immutability: the repo exposes no update function and no replace/delete write path', () => {
    // @ts-expect-error — immutability: the repo exposes NO update function;
    // outputs are committed once via the transaction, never updated.
    void cohortOutputRepo.updateCohortOutput;
    // PR6 hardening A: the replace/delete write path is GONE from the repo.
    // @ts-expect-error — write-once: `replaceCohortTitleOutputs` no longer exists.
    void cohortOutputRepo.replaceCohortTitleOutputs;
  });
});
