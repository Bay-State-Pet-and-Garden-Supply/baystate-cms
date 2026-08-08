import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';

const workspaceId = 'ws-page-migration-test';

function freshDb(): void {
  const wsPath = path.join(os.tmpdir(), `page-migration-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  const dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({ id: workspaceId, name: 'test', workspacePath: wsPath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
}

/** Seed legacy-like Page rows, page_id assignments, and a reviewed proposal. */
function seedLegacyState(): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Legacy page rows (name-only, no verified identity).
  db.run(
    `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, created_at, updated_at)
     VALUES ('page-legacy-1', 'Dog Food', 'dog-food.html', NULL, 'hash-dog', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, created_at, updated_at)
     VALUES ('page-legacy-2', 'Cat Food', NULL, 'page-legacy-1', 'hash-cat', ?, ?)`,
    [now, now],
  );

  // Inferred product_pages.page_id references.
  db.run(
    `INSERT INTO product_pages (product_sku, page_name, page_id, created_at) VALUES ('SKU-P1', 'Dog Food', 'page-legacy-1', ?)`,
    [now],
  );

  // A reviewed category_page proposal with decision history.
  db.run(
    `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
     VALUES ('run-page-legacy', ?, NULL, 'SKU-P1', 'completed', ?)`,
    [workspaceId, now],
  );
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
     VALUES ('prop-page-legacy', 'run-page-legacy', 'SKU-P1', 'category_page', '{"pageId":"page-legacy-1","pageName":"Dog Food"}', 0.8, 'accepted', ?)`,
    [now],
  );
  db.run(
    `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
     VALUES ('dec-page-legacy', 'prop-page-legacy', 'accepted', ?)`,
    [now],
  );
}

describe('page identity migration — demote synthetic Pages, preserve history', () => {
  beforeEach(() => {
    freshDb();
  });

  it('marks existing rows unverified_name_only and clears inferred page_id references', () => {
    seedLegacyState();
    // Re-run migrations to apply the page identity migration over seeded rows.
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    runMigrations();

    const db = getDb();
    const rows = db.query('SELECT * FROM page_index ORDER BY name ASC').all() as Array<Record<string, any>>;

    for (const row of rows) {
      expect(row.identity_kind).toBe('unverified_name_only');
      expect(row.identity_status).toBe('unverified');
      expect(row.availability).toBe('unavailable');
      expect(row.review_status).toBe('pending');
      expect(row.identity_key).toBe(row.name);
      expect(row.source_hash).toBe(row.page_hash);
    }

    // Names and page rows are preserved.
    expect(rows.map(r => r.name)).toEqual(['Cat Food', 'Dog Food']);

    // product_pages rows survive with page_id cleared.
    const assignment = db.query(
      'SELECT product_sku, page_name, page_id FROM product_pages WHERE product_sku = ?',
    ).get('SKU-P1') as { product_sku: string; page_name: string; page_id: string | null };
    expect(assignment.page_name).toBe('Dog Food');
    expect(assignment.page_id).toBeNull();
  });

  it('marks category_page proposals stale without deleting decision history', () => {
    seedLegacyState();
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    runMigrations();

    const db = getDb();
    const proposal = db.query(
      'SELECT status, is_stale, staleness_reason FROM classification_proposals WHERE id = ?',
    ).get('prop-page-legacy') as { status: string; is_stale: number; staleness_reason: string | null };
    expect(proposal.status).toBe('stale');
    expect(proposal.is_stale).toBe(1);
    expect(proposal.staleness_reason).toBe('page_identity_unverified');

    // Decision history survives.
    const decision = db.query(
      'SELECT id, proposal_id, decision FROM classification_proposal_decisions WHERE id = ?',
    ).get('dec-page-legacy') as { id: string; proposal_id: string; decision: string };
    expect(decision.proposal_id).toBe('prop-page-legacy');
    expect(decision.decision).toBe('accepted');
  });

  it('creates page_imports and drops the UNIQUE(name) constraint so duplicates are representable', () => {
    seedLegacyState();
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    runMigrations();

    const db = getDb();
    const table = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_imports'",
    ).get() as { sql: string } | undefined;
    expect(table).toBeDefined();

    const pageIndexSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_index'",
    ).get() as { sql: string } | undefined;
    expect(pageIndexSql?.sql ?? '').not.toContain('name TEXT NOT NULL UNIQUE');

    // Duplicate names are now insertable.
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, created_at, updated_at)
       VALUES ('page-dup-1', 'Dog Food', NULL, NULL, 'hash-dup', ?, ?)`,
      [now, now],
    );
    const dup = db.query("SELECT COUNT(*) AS c FROM page_index WHERE name = 'Dog Food'").get() as { c: number };
    expect(dup.c).toBe(2);
  });

  it('is idempotent: re-running migrations does not double-apply or fail', () => {
    seedLegacyState();
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
    const marker = getDb().query(
      "SELECT value FROM app_meta WHERE key = 'page_identity_schema_version'",
    ).get() as { value: string };
    expect(marker.value).toBe('1');
  });

  it('upgrades a pre-migration old-shape page_index (UNIQUE name) without schema.sql errors', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Simulate a real upgrade DB: old page_index shape with UNIQUE(name) and
    // no identity columns, plus product_pages with an inferred page_id.
    db.exec('DROP TABLE page_index');
    db.exec(`
      CREATE TABLE page_index (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        file_name TEXT,
        parent_id TEXT REFERENCES page_index(id),
        page_hash TEXT NOT NULL,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec('DROP TABLE product_pages');
    db.exec(`
      CREATE TABLE product_pages (
        product_sku TEXT NOT NULL,
        page_name TEXT NOT NULL,
        page_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (product_sku, page_name)
      )
    `);
    db.run(
      `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, created_at, updated_at)
       VALUES ('pg-old-1', 'Dog Food', NULL, NULL, 'h-old', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO product_pages (product_sku, page_name, page_id, created_at)
       VALUES ('SKU-OLD-1', 'Dog Food', 'pg-old-1', ?)`,
      [now],
    );

    // schema.sql + migration must both tolerate the old shape.
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    expect(() => runMigrations()).not.toThrow();

    const rows = db.query('SELECT * FROM page_index').all() as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Dog Food');
    expect(rows[0].identity_kind).toBe('unverified_name_only');
    expect(rows[0].identity_status).toBe('unverified');
    expect(rows[0].availability).toBe('unavailable');
    expect(rows[0].identity_key).toBe('Dog Food');
    expect(rows[0].source_hash).toBe('h-old');

    const pageIndexSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_index'",
    ).get() as { sql: string };
    expect(pageIndexSql.sql).not.toContain('name TEXT NOT NULL UNIQUE');

    const assignment = db.query(
      'SELECT page_id, page_name FROM product_pages WHERE product_sku = ?',
    ).get('SKU-OLD-1') as { page_id: string | null; page_name: string };
    expect(assignment.page_name).toBe('Dog Food');
    expect(assignment.page_id).toBeNull();

    // Identity indexes exist after the migration.
    for (const indexName of ['idx_page_index_identity', 'idx_page_index_import']) {
      const idx = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(indexName);
      expect(idx).toBeDefined();
    }
  });

  it('runs the page-identity migration with PRAGMA foreign_keys=ON without failure and preserves data', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Simulate an upgrade DB whose product_pages.page_id carries a real FK to
    // page_index(id) and whose page_index carries the legacy UNIQUE(name).
    db.exec('DROP TABLE page_index');
    db.exec(`
      CREATE TABLE page_index (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        file_name TEXT,
        parent_id TEXT REFERENCES page_index(id),
        page_hash TEXT NOT NULL,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec('DROP TABLE product_pages');
    db.exec(`
      CREATE TABLE product_pages (
        product_sku TEXT NOT NULL,
        page_name TEXT NOT NULL,
        page_id TEXT REFERENCES page_index(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (product_sku, page_name)
      )
    `);
    db.run(
      `INSERT INTO page_index (id, name, file_name, parent_id, page_hash, created_at, updated_at)
       VALUES ('pg-fk-1', 'Dog Food', NULL, NULL, 'h-fk', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO product_pages (product_sku, page_name, page_id, created_at)
       VALUES ('SKU-FK-1', 'Dog Food', 'pg-fk-1', ?)`,
      [now],
    );

    // Enable FK enforcement, then re-run the migration (marker removed). With
    // FK enforcement ON, the historical in-transaction PRAGMA toggle was a
    // silent no-op and DROP TABLE page_index would have failed; the fixed
    // migration toggles OFF before the rebuild transaction and restores ON.
    db.exec('PRAGMA foreign_keys = ON');
    expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    getDb().run("DELETE FROM app_meta WHERE key = 'page_identity_schema_version'");
    expect(() => runMigrations()).not.toThrow();

    const rows = db.query('SELECT * FROM page_index').all() as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Dog Food');
    expect(rows[0].identity_kind).toBe('unverified_name_only');
    expect(rows[0].identity_status).toBe('unverified');
    expect(rows[0].identity_key).toBe('Dog Food');

    // The inferred page_id reference was cleared; the name/history row survived.
    const assignment = db.query(
      'SELECT page_id, page_name FROM product_pages WHERE product_sku = ?',
    ).get('SKU-FK-1') as { page_id: string | null; page_name: string };
    expect(assignment.page_name).toBe('Dog Food');
    expect(assignment.page_id).toBeNull();

    // The page_index table was rebuilt (UNIQUE(name) gone) and the restored FK
    // state matches what the connection had before the migration.
    const pageIndexSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_index'",
    ).get() as { sql: string };
    expect(pageIndexSql.sql).not.toContain('name TEXT NOT NULL UNIQUE');
    expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);

    // Marker set, so a subsequent run is a no-op and FK state remains ON.
    expect(() => runMigrations()).not.toThrow();
    expect((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });
});
