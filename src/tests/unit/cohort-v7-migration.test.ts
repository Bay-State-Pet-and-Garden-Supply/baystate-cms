import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch, deleteBatch } from '../../db/repositories/onboarding-batch-repo';

/**
 * PR6 C1 migration (issue #30): cohort schema v6 → v7.
 *
 * v7 is additive: the durable `classification_cohort_outputs` table (+ the
 * `idx_classification_cohort_outputs_run` index). Fresh installs read the
 * FINAL v7 shape directly from cohort-migration.sql (marker '7'); pre-PR6
 * marker-'6' databases converge via the v6→v7 hop (db.exec(cohortSql) — the
 * idempotent CREATE TABLE/INDEX; the run table already exists so its CREATE
 * is a no-op) plus the marker bump.
 */

let workspacePath: string;

/** Raw-SQL helper: a real workspace + batch + cohort + run the outputs FK to. */
function insertRunFixture(groupKey: string): { wsId: string; batchId: string; cohortId: string; runId: string } {
  const db = getDb();
  const wsId = randomUUID();
  const now = new Date().toISOString();
  insertWorkspace({
    id: wsId,
    name: 'Cohort V7 Mig WS',
    workspacePath: '/tmp/cohort-v7-mig',
    gitPath: '',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const batchId = createBatch({ workspaceId: wsId, name: 'Cohort V7 Mig Batch', fileName: 'cohort-v7.xlsx', totalItems: 1 }).id;
  const cohortId = randomUUID();
  db.run(
    `INSERT INTO curation_cohorts
       (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
        status, blocked_reason, created_at, updated_at, superseded_at)
     VALUES (?, ?, ?, ?, 'V7 Family', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
    [cohortId, wsId, batchId, groupKey, 'f'.repeat(64), now, now],
  );
  const runId = randomUUID();
  db.run(
    `INSERT INTO classification_cohort_runs
       (id, workspace_id, cohort_id, candidate_membership_hash, evidence_snapshot_hash, status,
        claimed_by, claimed_at, lease_expires_at, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', 'worker-a', ?, ?, ?, ?)`,
    [runId, wsId, cohortId, 'c'.repeat(64), 'e'.repeat(64), now, now, now, now],
  );
  return { wsId, batchId, cohortId, runId };
}

describe('cohort schema v7 migration — fresh install (issue #30 PR6 C1)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-v7-fresh-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('fresh install lands on marker 7 with the outputs table, the unique index, and the run FK CASCADE', () => {
    const db = getDb();
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // The v7 outputs table + the run-lookup index exist.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_cohort_outputs'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_outputs_run'").get()).toBeTruthy();

    // The UNIQUE (cohort_run_id, output_kind, product_sku) row identity is a
    // real unique index (PRAGMA index_list / index_info — the inline UNIQUE
    // table constraint surfaces as the origin-'u' autoindex).
    const indexes = db.query("PRAGMA index_list('classification_cohort_outputs')").all() as Array<{ name: string; unique: number; origin: string }>;
    const uniqueIdx = indexes.find(i => Number(i.unique) === 1 && i.origin === 'u');
    expect(uniqueIdx).toBeTruthy();
    const uniqueCols = db.query(`PRAGMA index_info('${uniqueIdx!.name}')`).all() as Array<{ seqno: number; name: string }>;
    expect(uniqueCols.map(c => c.name)).toEqual(['cohort_run_id', 'output_kind', 'product_sku']);

    // The run FK is ON DELETE CASCADE; the workspace FK is a plain reference.
    const fks = db.query("PRAGMA foreign_key_list('classification_cohort_outputs')").all() as Array<{ from: string; table: string; on_delete: string }>;
    const runFk = fks.find(f => f.from === 'cohort_run_id');
    expect(runFk).toBeTruthy();
    expect(runFk!.table).toBe('classification_cohort_runs');
    expect(runFk!.on_delete).toBe('CASCADE');
    const wsFk = fks.find(f => f.from === 'workspace_id');
    expect(wsFk).toBeTruthy();
    expect(wsFk!.table).toBe('workspace');

    // A real run row + output row round-trip, then run deletion cascades.
    const { runId } = insertRunFixture('v7-key-fresh');
    const runWs = db.query('SELECT workspace_id FROM classification_cohort_runs WHERE id = ?').get(runId) as { workspace_id: string };
    db.run(
      `INSERT INTO classification_cohort_outputs
         (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
       VALUES (?, ?, ?, 'curated_title', 'SKU-V7', ?, ?, NULL, ?)`,
      [randomUUID(), runWs.workspace_id, runId, 'a'.repeat(64), JSON.stringify({ title: 'Fresh Title', source: 'llm_cohort' }), new Date().toISOString()],
    );
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_outputs WHERE cohort_run_id = ?').get(runId) as { c: number }).toEqual({ c: 1 });
    db.run('DELETE FROM classification_cohort_runs WHERE id = ?', [runId]);
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_outputs WHERE cohort_run_id = ?').get(runId) as { c: number }).toEqual({ c: 0 });

    // Idempotent: a second migration run keeps marker '7' and the v7 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('7');
  });
});

describe('cohort schema v7 migration — pre-PR6 marker-6 convergence (issue #30 PR6 C1)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-v7-upgrade-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('a pre-PR6 marker-6 database converges to 7 with the outputs table, preserving existing run rows', () => {
    const db = getDb();

    // 1. Real rows that must survive the convergence (v6-era tables intact).
    const { wsId, batchId, runId } = insertRunFixture('v7-key-upgrade');

    // 2. Simulate a pre-PR6 '6' database: drop the v7 outputs table and
    //    rewind the marker (everything else already has the v6 shape).
    db.exec('DROP TABLE IF EXISTS classification_cohort_outputs;');
    db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '6')");

    // Pre-convergence assertions: the pre-PR6 '6' shape is restored.
    const preVersion = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(preVersion.value).toBe('6');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_cohort_outputs'").get()).toBeFalsy();
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_runs WHERE id = ?').get(runId) as { c: number }).toEqual({ c: 1 });

    // 3. Converge.
    expect(() => runMigrations()).not.toThrow();

    // Marker advanced to '7'.
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // Outputs table + index restored by the idempotent hop; the unique row
    // identity (cohort_run_id, output_kind, product_sku) is back.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_cohort_outputs'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_outputs_run'").get()).toBeTruthy();
    const indexes = db.query("PRAGMA index_list('classification_cohort_outputs')").all() as Array<{ name: string; unique: number; origin: string }>;
    const uniqueIdx = indexes.find(i => Number(i.unique) === 1 && i.origin === 'u');
    expect(uniqueIdx).toBeTruthy();
    const uniqueCols = db.query(`PRAGMA index_info('${uniqueIdx!.name}')`).all() as Array<{ seqno: number; name: string }>;
    expect(uniqueCols.map(c => c.name)).toEqual(['cohort_run_id', 'output_kind', 'product_sku']);

    // The converged table writes + cascades like the fresh-install shape.
    db.run(
      `INSERT INTO classification_cohort_outputs
         (id, workspace_id, cohort_run_id, output_kind, product_sku, input_hash, output_value_json, model_call_id, created_at)
       VALUES (?, ?, ?, 'curated_title', 'SKU-V7-UP', ?, ?, NULL, ?)`,
      [randomUUID(), wsId, runId, 'b'.repeat(64), JSON.stringify({ title: 'Upgraded Title', source: 'cohort_fallback' }), new Date().toISOString()],
    );
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_outputs WHERE cohort_run_id = ?').get(runId) as { c: number }).toEqual({ c: 1 });

    // Rows survived the convergence (the run row never moved).
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_runs WHERE id = ?').get(runId) as { c: number }).toEqual({ c: 1 });

    // Idempotent: a second run keeps marker '7' and the v7 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('7');

    // Cleanup: batch deletion cascades cohort + run + output rows; workspace
    // deletion then succeeds.
    expect(deleteBatch(batchId)).toBe(true);
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_outputs WHERE cohort_run_id = ?').get(runId) as { c: number }).toEqual({ c: 0 });
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });
});
