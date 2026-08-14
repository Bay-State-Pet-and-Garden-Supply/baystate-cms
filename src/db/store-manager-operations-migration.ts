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
 * New surface (v3, Issue 3):
 *  - store_manager_inbox_items: durable triage lifecycle rows with stable
 *    per-workspace dedupe keys and content fingerprints.
 *  - store_manager_notification_rules: deterministic threshold rules with
 *    per-rule last-seen snapshots (edge-triggered emission).
 *  - store_manager_notifications: durable in-app threshold facts with a
 *    per-workspace monotonic sequence for cursor SSE + polling fallback.
 */

import { getDb } from './connection';
import type { Database } from './driver';

export const STORE_MANAGER_OPERATIONS_SCHEMA_VERSION = '4';
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
    // Block 6 (Issue 3): Manager Inbox + deterministic in-app notifications.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_inbox_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        source_refs_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'open',
        source_updated_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT,
        superseded_at TEXT,
        resolved_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_inbox_ws_lifecycle
        ON store_manager_inbox_items(workspace_id, lifecycle, severity);
      CREATE INDEX IF NOT EXISTS idx_store_manager_inbox_ws_updated
        ON store_manager_inbox_items(workspace_id, last_seen_at);
      CREATE TABLE IF NOT EXISTS store_manager_notification_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        last_seen_snapshot_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, kind)
      );
      CREATE TABLE IF NOT EXISTS store_manager_notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_kind TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        inbox_item_id TEXT,
        source_run_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_notifications_ws_seq
        ON store_manager_notifications(workspace_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_store_manager_notifications_ws_created
        ON store_manager_notifications(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_notifications_ws_unread
        ON store_manager_notifications(workspace_id, read_at);
    `);
    // Self-heal: resolved_reason distinguishes collector-disappearance from
    // operator resolve (drives re-open semantics for reappeared findings).
    if (!columnExists(db, 'store_manager_inbox_items', 'resolved_reason')) {
      db.exec('ALTER TABLE store_manager_inbox_items ADD COLUMN resolved_reason TEXT');
    }
    // Block 7 (Issue 4): leased scheduled read-only runs. Definitions are
    // versioned (immutable version rows; the schedule row holds the current
    // pointer), occurrences are restart-safe via a unique per-workspace
    // occurrence key, and leases drive atomic claim/heartbeat/expiry.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_schedules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        template_kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL,
        recurrence_preset TEXT NOT NULL,
        time_of_day TEXT NOT NULL,
        day_of_week INTEGER,
        scope_json TEXT,
        selected_model TEXT,
        objective TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        policy_profile_json TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        last_run_id TEXT,
        enable_audit_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_schedules_ws_enabled
        ON store_manager_schedules(workspace_id, enabled);
      CREATE TABLE IF NOT EXISTS store_manager_schedule_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, schedule_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_schedule_versions_sched
        ON store_manager_schedule_versions(workspace_id, schedule_id, version);
      CREATE TABLE IF NOT EXISTS store_manager_schedule_occurrences (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        schedule_version INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        run_id TEXT,
        error_code TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, occurrence_key)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_occurrences_due
        ON store_manager_schedule_occurrences(workspace_id, status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_occurrences_sched
        ON store_manager_schedule_occurrences(workspace_id, schedule_id, scheduled_at);
      CREATE TABLE IF NOT EXISTS store_manager_schedule_leases (
        occurrence_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_leases_expiry
        ON store_manager_schedule_leases(workspace_id, lease_expires_at);
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
  if (marker && Number(marker.value) >= Number(STORE_MANAGER_OPERATIONS_SCHEMA_VERSION)) return;
  runStoreManagerOperationsMigration();
}
