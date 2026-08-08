import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { findConnection } from '../../db/repositories/connection-repo';

let dbPath = '';

function seedRunAndProposal(proposalId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = randomUUID();
  db.run(
    `INSERT INTO classification_runs (id, workspace_id, product_sku, status, started_at)
     VALUES (?, 'ws-migration', 'SKU-MIG', 'completed', ?)`,
    [runId, now],
  );
  db.run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, 'SKU-MIG', 'field_assignment', '"original"', 0.8, 'pending', ?)`,
    [proposalId, runId, now],
  );
}

describe('decision revision migration compatibility', () => {
  beforeEach(() => {
    try { resetDb(); } catch { /* no active DB */ }
    dbPath = `/tmp/baystate-decision-migration-${process.pid}-${randomUUID()}.db`;
    initDb(dbPath);
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* absent */ }
  });

  it('migrates a row that exists in the true pre-revision table shape', () => {
    const db = getDb();
    const proposalId = 'legacy-shape-proposal';
    seedRunAndProposal(proposalId);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP INDEX IF EXISTS idx_classification_decisions_key');
    db.exec('ALTER TABLE classification_proposal_decisions RENAME TO classification_proposal_decisions_v2');
    db.exec(`CREATE TABLE classification_proposal_decisions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'deferred')),
      revised_from_id TEXT REFERENCES classification_proposal_decisions(id),
      reviewer_id TEXT,
      reviewer_note TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_from_id, reviewer_id, reviewer_note, created_at)
       VALUES ('legacy-row', ?, 'accepted', NULL, 'reviewer', 'kept', ?)`,
      [proposalId, new Date().toISOString()],
    );
    db.exec('DROP TABLE classification_proposal_decisions_v2');
    db.run("DELETE FROM app_meta WHERE key = 'decision_revision_schema_version'");
    db.exec('PRAGMA foreign_keys = ON');

    expect(() => runMigrations()).not.toThrow();
    const row = db.query(
      `SELECT id, proposal_id, reviewer_note, revised_value_json, revised_target_id,
              decision_key, superseded_at
       FROM classification_proposal_decisions WHERE id = 'legacy-row'`,
    ).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 'legacy-row',
      proposal_id: proposalId,
      reviewer_note: 'kept',
      revised_value_json: null,
      revised_target_id: null,
      decision_key: null,
      superseded_at: null,
    });
  });

  it('repairs duplicate partial-deployment tokens without deleting history', () => {
    const db = getDb();
    const proposalId = 'duplicate-token-proposal';
    seedRunAndProposal(proposalId);
    db.exec('DROP INDEX IF EXISTS idx_classification_decisions_key');
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, superseded_at, created_at)
       VALUES ('dup-old', ?, 'accepted', 'same-action', ?, ?)`,
      [proposalId, now, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, superseded_at, created_at)
       VALUES ('dup-new', ?, 'rejected', 'same-action', NULL, ?)`,
      [proposalId, now],
    );

    // The repair runs even though a version marker already exists.
    db.run(
      `INSERT INTO app_meta (key, value) VALUES ('decision_revision_schema_version', '2')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    expect(() => runMigrations()).not.toThrow();

    const rows = db.query(
      `SELECT id, decision_key FROM classification_proposal_decisions
       WHERE id IN ('dup-old', 'dup-new') ORDER BY rowid`,
    ).all() as Array<{ id: string; decision_key: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.decision_key === 'same-action')).toHaveLength(1);
    expect(rows.filter(row => row.decision_key === null)).toHaveLength(1);

    expect(() => db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('dup-third', ?, 'accepted', 'same-action', ?)`,
      [proposalId, now],
    )).toThrow();
  });

  it('adds has_revised_target presence column for explicit null target clears', () => {
    const db = getDb();
    const cols = db.query('PRAGMA table_info(classification_proposal_decisions)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('has_revised_target');
  });

  it('copies populated shopsite_connection rows when connection already exists', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Simulate a real upgrade DB: schema.sql already created empty `connection`,
    // while legacy data still lives in shopsite_connection.
    db.exec('DROP TABLE IF EXISTS shopsite_connection');
    db.exec(`CREATE TABLE shopsite_connection (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      cgi_base_url TEXT NOT NULL,
      auth_strategy TEXT NOT NULL DEFAULT 'basic',
      merchant_id TEXT,
      password_secret_ref TEXT,
      last_tested_at TEXT,
      last_test_status TEXT,
      last_test_error TEXT
    )`);
    db.run("DELETE FROM connection");
    db.run("DELETE FROM app_meta WHERE key = 'connection_rename_schema_version'");

    // workspace FK may be required depending on schema; seed a workspace first.
    db.run(
      `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
       VALUES ('ws-old', 'Legacy', '/tmp/ws-old', '/tmp/ws-old/.git', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO shopsite_connection
       (id, workspace_id, cgi_base_url, auth_strategy, merchant_id, password_secret_ref,
        last_tested_at, last_test_status, last_test_error)
       VALUES ('conn-old', 'ws-old', 'https://example.test/cgi', 'basic', 'merchant-1',
               'secret-ref', ?, 'ok', NULL)`,
      [now],
    );

    // Empty destination already present (schema.sql path).
    expect(
      (db.query("SELECT COUNT(*) AS c FROM connection").get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.query("SELECT COUNT(*) AS c FROM shopsite_connection").get() as { c: number }).c,
    ).toBe(1);

    expect(() => runMigrations()).not.toThrow();

    const oldStillThere = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='shopsite_connection'",
    ).all();
    expect(oldStillThere).toHaveLength(0);

    const version = db.query(
      "SELECT value FROM app_meta WHERE key = 'connection_rename_schema_version'",
    ).get() as { value: string } | undefined;
    expect(version?.value).toBe('1');

    const found = findConnection('ws-old');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('conn-old');
    expect(found?.cgiBaseUrl).toBe('https://example.test/cgi');
    expect(found?.merchantId).toBe('merchant-1');
  });
});
