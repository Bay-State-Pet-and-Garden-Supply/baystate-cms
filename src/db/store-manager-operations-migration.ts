/**
 * Store Manager operations-console schema migration (operations console,
 * Issue 1).
 *
 * Additive-only, idempotent, self-healing schema work for the operations
 * console epic. This module is a SEPARATE authority from the dirty
 * `src/db/migrations.ts`: it never edits existing migration text and only
 * adds new columns/tables. Every block is guarded by an existence check
 * (PRAGMA table_info / sqlite_master) so re-runs and fresh-vs-upgraded DBs
 * behave identically.
 *
 * New surface (v1):
 *  - store_manager_sessions: objective, entrypoint, execution_mode,
 *    actor_class, scope_json, scope_hash, policy_snapshot_json, prompt_version,
 *    lineage_json (additive columns; the policy snapshot is the immutable
 *    runtime policy and is hash-verified on read).
 *  - store_manager_events: monotonic per-workspace `sequence` for cursor
 *    pagination/SSE.
 *  - store_manager_run_artifacts: immutable content-addressed artifacts.
 */

import { getDb } from './connection';
import type { Database } from './driver';

export const STORE_MANAGER_OPERATIONS_SCHEMA_VERSION = '2';
export const STORE_MANAGER_OPERATIONS_MARKER = 'store_manager_operations_schema_version';

const SESSION_ADDITIVE_COLUMNS: ReadonlyArray<readonly [column: string, ddl: string]> = [
  ['objective', 'TEXT'],
  ['entrypoint', 'TEXT'],
  ['execution_mode', 'TEXT'],
  ['actor_class', 'TEXT'],
  ['scope_json', 'TEXT'],
  ['scope_hash', 'TEXT'],
  ['policy_snapshot_json', 'TEXT'],
  ['prompt_version', 'TEXT'],
  ['lineage_json', 'TEXT'],
];

function tableExists(db: Database, table: string): boolean {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null
  );
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Run the operations-console schema migration (idempotent). Requires the base
 * #42 tables (runMigrations / schema.sql must run first) and throws a clear
 * error otherwise — this module is additive-only and never creates the base
 * tables itself.
 */
export function runStoreManagerOperationsMigration(): void {
  const db = getDb();
  if (
    !tableExists(db, 'store_manager_sessions') ||
    !tableExists(db, 'store_manager_turns') ||
    !tableExists(db, 'store_manager_events') ||
    !tableExists(db, 'app_meta')
  ) {
    throw new Error(
      'runMigrations() must run before the Store Manager operations migration (base #42 tables missing).',
    );
  }
  const marker = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get(STORE_MANAGER_OPERATIONS_MARKER) as { value: string } | undefined;
  // Version-aware: v1 DBs (Issue 1) re-run the guarded blocks below so the
  // v2 surface (preferences) is added; all blocks are existence-guarded so
  // re-runs and fresh-vs-upgraded DBs behave identically.
  if (marker && Number(marker.value) >= Number(STORE_MANAGER_OPERATIONS_SCHEMA_VERSION)) return;

  db.exec('BEGIN');
  try {
    // Block 1: additive session columns (self-heal: only missing columns).
    for (const [column, ddl] of SESSION_ADDITIVE_COLUMNS) {
      if (!columnExists(db, 'store_manager_sessions', column)) {
        db.exec(`ALTER TABLE store_manager_sessions ADD COLUMN ${column} ${ddl}`);
      }
    }
    // Block 2: monotonic event sequence.
    if (!columnExists(db, 'store_manager_events', 'sequence')) {
      db.exec('ALTER TABLE store_manager_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
    }
    // Block 3: immutable run artifacts.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_run_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_run_artifacts_ws_run
        ON store_manager_run_artifacts(workspace_id, run_id, created_at);
    `);
    // Block 4: entrypoint/sequence indexes for run listing + cursor pagination.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_entrypoint
        ON store_manager_sessions(workspace_id, entrypoint);
      CREATE INDEX IF NOT EXISTS idx_store_manager_events_sequence
        ON store_manager_events(workspace_id, sequence);
    `);
    // Block 5 (Issue 2): explicit versioned workspace preferences. Revisions
    // are immutable (insert-only); one active revision per workspace.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_preferences (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        actor_class TEXT NOT NULL DEFAULT 'operator',
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_preferences_ws
        ON store_manager_preferences(workspace_id, version);
      CREATE TABLE IF NOT EXISTS store_manager_preference_active (
        workspace_id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        activated_at TEXT NOT NULL
      );
    `);
    db.query(
      'INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)',
    ).run(STORE_MANAGER_OPERATIONS_MARKER, STORE_MANAGER_OPERATIONS_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Lazy self-healing entry point used by the session repository. The marker
 * check is a single indexed SELECT on the hot path; the full migration runs
 * only when the marker is absent. Intentionally NOT cached in module state so
 * test suites that reset/re-init databases in one process still self-heal.
 */
export function ensureStoreManagerOperationsSchema(): void {
  const db = getDb();
  const marker = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get(STORE_MANAGER_OPERATIONS_MARKER) as { value: string } | undefined;
  if (marker) return;
  runStoreManagerOperationsMigration();
}
