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
 * PR4 C1 migration (issue #30): cohort schema v5 → v6.
 *
 * v6 is additive: the nullable `product_type_outcome` CHECK column on
 * `classification_cohort_runs` + the `classification_proposal_dependencies`
 * table (+ 2 indexes). Fresh installs read the FINAL v6 shape directly from
 * cohort-migration.sql (marker '6'); pre-C1 marker-'5' databases converge via
 * the v5→v6 hop (db.exec(cohortSql) — creates the dependency table) plus the
 * PRAGMA-guarded `product_type_outcome` ALTER OUTSIDE the version gate.
 *
 * The v5 run-table shape (pre-C1, PR3) is the git-HEAD DDL: the three PR4
 * placeholder columns (final_membership_hash, execution_product_type_id,
 * product_type_confidence) already exist and must be preserved untouched.
 */

let workspacePath: string;

/** Raw-SQL helper: a real workspace + batch + cohort triple the run rows FK to. */
function insertCohortFixture(groupKey: string): { wsId: string; batchId: string; cohortId: string } {
  const db = getDb();
  const wsId = randomUUID();
  const now = new Date().toISOString();
  insertWorkspace({
    id: wsId,
    name: 'Cohort V6 Mig WS',
    workspacePath: '/tmp/cohort-v6-mig',
    gitPath: '',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const batchId = createBatch({ workspaceId: wsId, name: 'Cohort V6 Mig Batch', fileName: 'cohort-v6.xlsx', totalItems: 1 }).id;
  const cohortId = randomUUID();
  db.run(
    `INSERT INTO curation_cohorts
       (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
        status, blocked_reason, created_at, updated_at, superseded_at)
     VALUES (?, ?, ?, ?, 'V6 Family', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
    [cohortId, wsId, batchId, groupKey, 'f'.repeat(64), now, now],
  );
  return { wsId, batchId, cohortId };
}

/** Insert a freezing run row (NULL PR4 placeholders). */
function insertFreezingRun(cohortId: string, wsId: string): string {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO classification_cohort_runs
       (id, workspace_id, cohort_id, candidate_membership_hash, status, claimed_by, claimed_at,
        lease_expires_at, created_at)
     VALUES (?, ?, ?, ?, 'freezing', 'worker-a', ?, ?, ?)`,
    [id, wsId, cohortId, 'f'.repeat(64), now, now, now],
  );
  return id;
}

/** Insert a completed run row (mandatory hashes set, NULL PR4 placeholders). */
function insertCompletedRun(cohortId: string, wsId: string): string {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO classification_cohort_runs
       (id, workspace_id, cohort_id, candidate_membership_hash, evidence_snapshot_hash,
        execution_product_type_id, product_type_confidence, final_membership_hash,
        status, claimed_by, claimed_at, lease_expires_at, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'completed', 'worker-a', ?, ?, ?, ?, ?)`,
    [id, wsId, cohortId, 'f'.repeat(64), 'e'.repeat(64), now, now, now, now, now],
  );
  return id;
}

describe('cohort schema v6 migration — fresh install (issue #30 PR4 C1)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-v6-fresh-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('fresh install lands on marker 6 with the dependency table, indexes, and product_type_outcome column', () => {
    const db = getDb();
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('6');

    // The v6 dependency table + both supporting indexes exist.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_proposal_dependencies'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_proposal'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_target'").get()).toBeTruthy();

    // PR4 review NOTE: the UNIQUE (proposal_id, dependency_kind) index — the
    // DB-level race backstop for the dependency stamping — exists after a
    // fresh install and is introspectable via PRAGMA index_list / index_info.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_unique'").get()).toBeTruthy();
    const depIndexes = db.query("PRAGMA index_list('classification_proposal_dependencies')").all() as Array<{ name: string; unique: number }>;
    const uniqueIdx = depIndexes.find(i => i.name === 'idx_classification_proposal_dependencies_unique');
    expect(uniqueIdx).toBeTruthy();
    expect(Number(uniqueIdx!.unique)).toBe(1);
    const uniqueCols = db.query("PRAGMA index_info('idx_classification_proposal_dependencies_unique')").all() as Array<{ seqno: number; name: string }>;
    expect(uniqueCols.map(c => c.name)).toEqual(['proposal_id', 'dependency_kind']);

    // The run table carries product_type_outcome with the PR4 CHECK and keeps
    // the PR4 placeholder columns.
    const runTable = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='classification_cohort_runs'").get() as { sql: string } | undefined;
    expect(runTable).toBeTruthy();
    const runSql = runTable!.sql;
    expect(runSql).toContain('product_type_outcome');
    expect(runSql).toContain("product_type_outcome IN ('coherent','coherent_with_abstentions','conflicted','abstained')");
    expect(runSql).toContain('final_membership_hash');
    expect(runSql).toContain('execution_product_type_id');
    expect(runSql).toContain('product_type_confidence');

    // Real CHECK behavior on a real run row: valid outcomes accepted, invalid rejected.
    const { wsId, cohortId } = insertCohortFixture('v6-key-fresh');
    const freezingId = insertFreezingRun(cohortId, wsId);
    expect(() => {
      getDb().run(
        "UPDATE classification_cohort_runs SET product_type_outcome = 'coherent' WHERE id = ?",
        [freezingId],
      );
    }).not.toThrow();
    expect(() => {
      getDb().run(
        "UPDATE classification_cohort_runs SET product_type_outcome = 'bogus' WHERE id = ?",
        [freezingId],
      );
    }).toThrow(/CHECK constraint failed/);

    // The dependency table enforces the proposal FK.
    expect(() => {
      getDb().run(
        `INSERT INTO classification_proposal_dependencies
           (id, workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
         VALUES (?, ?, 'no-such-proposal', 'execution_product_type', 'type-1', ?, ?)`,
        [randomUUID(), wsId, 'h'.repeat(64), new Date().toISOString()],
      );
    }).toThrow(/FOREIGN KEY constraint failed/);

    // PR4 review NOTE: the unique index is the race backstop — a direct
    // duplicate (proposal_id, dependency_kind) INSERT is rejected (UNIQUE),
    // never a second row.
    const runId = randomUUID();
    getDb().run(
      `INSERT INTO classification_runs (id, workspace_id, product_sku, started_at)
       VALUES (?, ?, 'SKU-UNIQ', ?)`,
      [runId, wsId, new Date().toISOString()],
    );
    const proposalId = randomUUID();
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-UNIQ', 'primary_product_type', '"type-1"', 0.9, 'pending', ?)`,
      [proposalId, runId, new Date().toISOString()],
    );
    getDb().run(
      `INSERT INTO classification_proposal_dependencies
         (id, workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
       VALUES (?, ?, ?, 'execution_product_type', 'type-1', ?, ?)`,
      [randomUUID(), wsId, proposalId, 'h'.repeat(64), new Date().toISOString()],
    );
    expect(() => {
      getDb().run(
        `INSERT INTO classification_proposal_dependencies
           (id, workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
         VALUES (?, ?, ?, 'execution_product_type', 'type-1', ?, ?)`,
        [randomUUID(), wsId, proposalId, 'h'.repeat(64), new Date().toISOString()],
      );
    }).toThrow(/UNIQUE constraint failed: classification_proposal_dependencies.proposal_id, classification_proposal_dependencies.dependency_kind/);

    // Idempotent: a second migration run keeps marker '6' and the v6 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('6');
  });
});

describe('cohort schema v6 migration — pre-C1 marker-5 convergence (issue #30 PR4 C1)', () => {
  beforeAll(() => {
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-v6-upgrade-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('a pre-C1 marker-5 database converges to 6 without losing run rows, and existing rows keep NULL outcome', () => {
    const db = getDb();

    // 1. Real rows that must survive the convergence (freezing + completed runs,
    //    each on its OWN cohort — the unique current-run index allows only one
    //    non-superseded run per cohort).
    const { wsId, batchId, cohortId } = insertCohortFixture('v6-key-a');
    const { batchId: batchIdB, cohortId: cohortIdB } = insertCohortFixture('v6-key-b');
    const freezingId = insertFreezingRun(cohortId, wsId);
    const completedId = insertCompletedRun(cohortIdB, wsId);

    // 2. Simulate a pre-C1 '5' database: drop the v6 dependency table, rebuild
    //    the run table to the v5 shape (no product_type_outcome), rewind the marker.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS classification_proposal_dependencies;');
        db.exec('ALTER TABLE classification_cohort_runs RENAME TO classification_cohort_runs_v6;');
        db.exec(`
          CREATE TABLE classification_cohort_runs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
            candidate_membership_hash TEXT NOT NULL,
            final_membership_hash TEXT,
            evidence_snapshot_hash TEXT,
            evidence_snapshot_id TEXT REFERENCES classification_cohort_snapshots(id),
            config_snapshot_id TEXT REFERENCES classification_config_snapshots(id),
            config_snapshot_hash TEXT,
            page_import_id TEXT REFERENCES page_imports(id),
            page_import_hash TEXT,
            model_policy_digest TEXT,
            execution_product_type_id TEXT,
            product_type_confidence REAL CHECK (product_type_confidence IS NULL OR (product_type_confidence >= 0 AND product_type_confidence <= 1)),
            status TEXT NOT NULL DEFAULT 'freezing' CHECK (status IN
              ('freezing','running','completed','completed_with_abstentions','completed_with_member_failures','failed','cancelled','superseded')),
            claimed_by TEXT,
            claimed_at TEXT,
            lease_expires_at TEXT,
            started_at TEXT,
            completed_at TEXT,
            error_message TEXT,
            superseded_at TEXT,
            created_at TEXT NOT NULL,
            CHECK (status IN ('freezing','superseded','cancelled') OR (candidate_membership_hash IS NOT NULL AND evidence_snapshot_hash IS NOT NULL))
          )
        `);
        db.exec(`INSERT INTO classification_cohort_runs
          (id, workspace_id, cohort_id, candidate_membership_hash, final_membership_hash,
           evidence_snapshot_hash, evidence_snapshot_id, config_snapshot_id, config_snapshot_hash,
           page_import_id, page_import_hash, model_policy_digest, execution_product_type_id,
           product_type_confidence, status, claimed_by, claimed_at, lease_expires_at,
           started_at, completed_at, error_message, superseded_at, created_at)
          SELECT id, workspace_id, cohort_id, candidate_membership_hash, final_membership_hash,
           evidence_snapshot_hash, evidence_snapshot_id, config_snapshot_id, config_snapshot_hash,
           page_import_id, page_import_hash, model_policy_digest, execution_product_type_id,
           product_type_confidence, status, claimed_by, claimed_at, lease_expires_at,
           started_at, completed_at, error_message, superseded_at, created_at
          FROM classification_cohort_runs_v6;`);
        db.exec('DROP TABLE classification_cohort_runs_v6;');
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
    db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '5')");

    // Pre-convergence assertions: the pre-C1 '5' shape is restored.
    const preVersion = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(preVersion.value).toBe('5');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_proposal_dependencies'").get()).toBeFalsy();
    const preCols = db.query('PRAGMA table_info(classification_cohort_runs)').all() as Array<{ name: string }>;
    expect(preCols.map(c => c.name)).not.toContain('product_type_outcome');
    expect(preCols.map(c => c.name)).toContain('execution_product_type_id');
    // Rows survived the rebuild intact.
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_runs WHERE id = ?').get(freezingId) as { c: number }).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) as c FROM classification_cohort_runs WHERE id = ?').get(completedId) as { c: number }).toEqual({ c: 1 });

    // 3. Converge.
    expect(() => runMigrations()).not.toThrow();

    // Marker advanced to '6'.
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('6');

    // Dependency table + indexes restored by the idempotent hop.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_proposal_dependencies'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_proposal'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_target'").get()).toBeTruthy();

    // PR4 review NOTE: the UNIQUE (proposal_id, dependency_kind) index — the
    // race backstop — exists after the '5'->'6' convergence too, with the same
    // unique column pair (PRAGMA index_list / index_info).
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_proposal_dependencies_unique'").get()).toBeTruthy();
    const depIndexes = db.query("PRAGMA index_list('classification_proposal_dependencies')").all() as Array<{ name: string; unique: number }>;
    const uniqueIdx = depIndexes.find(i => i.name === 'idx_classification_proposal_dependencies_unique');
    expect(uniqueIdx).toBeTruthy();
    expect(Number(uniqueIdx!.unique)).toBe(1);
    const uniqueCols = db.query("PRAGMA index_info('idx_classification_proposal_dependencies_unique')").all() as Array<{ seqno: number; name: string }>;
    expect(uniqueCols.map(c => c.name)).toEqual(['proposal_id', 'dependency_kind']);

    // product_type_outcome column added by the OUTSIDE-the-gate ALTER, and the
    // v5 run-row indexes recreated by the hop.
    const cols = db.query('PRAGMA table_info(classification_cohort_runs)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('product_type_outcome');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_current'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_lease'").get()).toBeTruthy();

    // Rows survived with NULL outcome (historical runs predate execution types).
    const freezing = db.query('SELECT product_type_outcome, final_membership_hash FROM classification_cohort_runs WHERE id = ?').get(freezingId) as { product_type_outcome: string | null; final_membership_hash: string | null };
    expect(freezing.product_type_outcome).toBeNull();
    expect(freezing.final_membership_hash).toBeNull();
    const completed = db.query('SELECT product_type_outcome, status FROM classification_cohort_runs WHERE id = ?').get(completedId) as { product_type_outcome: string | null; status: string };
    expect(completed.product_type_outcome).toBeNull();
    expect(completed.status).toBe('completed');

    // The converged column enforces the PR4 CHECK.
    expect(() => db.run("UPDATE classification_cohort_runs SET product_type_outcome = 'abstained' WHERE id = ?", [freezingId])).not.toThrow();
    expect(() => db.run("UPDATE classification_cohort_runs SET product_type_outcome = 'bogus' WHERE id = ?", [freezingId])).toThrow(/CHECK constraint failed/);

    // Idempotent: a second run keeps marker '6' and the v6 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('6');

    // Cleanup: batch deletion cascades cohort + run rows; workspace deletion
    // then succeeds (each fixture creates its own batch).
    expect(deleteBatch(batchId)).toBe(true);
    expect(deleteBatch(batchIdB)).toBe(true);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });
});
