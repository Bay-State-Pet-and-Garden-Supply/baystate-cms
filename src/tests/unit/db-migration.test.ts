import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations, getSchemaVersion } from '../../db/migrations';

describe('SQLite Migration', () => {
  const testDbPath = '/tmp/shopsite-cms-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should create app_meta with schema_version', () => {
    const version = getSchemaVersion();
    expect(version).toBe('1');
  });

  it('should support inserting and querying workspace', () => {
    const db = getDb();

    const id = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Test Store', '/tmp/test-store', '/tmp/test-store/.git', now, now, 'complete'],
    );

    const row = db.query('SELECT * FROM workspace WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.name).toBe('Test Store');
    expect(row.bootstrap_status).toBe('complete');

    db.run('DELETE FROM workspace WHERE id = ?', [id]);
  });

  it('should support field_registry upsert', () => {
    const db2 = getDb();

    const wsId = randomUUID();
    const now = new Date().toISOString();
    const entryId = randomUUID();

    db2.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Reg Store', '/tmp/reg', '/tmp/reg/.git', now, now, 'not_started'],
    );

    db2.run(
      `INSERT INTO field_registry (id, workspace_id, xml_field, label, kind, data_type, editable, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, wsId, 'ProductField16', 'Brand', 'custom', 'string', 1, 0, now, now],
    );

    const row = db2.query('SELECT * FROM field_registry WHERE id = ?').get(entryId) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.label).toBe('Brand');

    db2.run('DELETE FROM field_registry WHERE id = ?', [entryId]);
    db2.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should create all core tables', () => {
    const db3 = getDb();

    const tables = ['app_meta', 'workspace', 'shopsite_connection', 'product_index',
      'field_registry', 'change_sets', 'change_set_items', 'validation_results',
      'sync_jobs', 'sync_job_events', 'remote_drift', 'audit_log'];

    for (const table of tables) {
      const row = db3.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }
  });
});
