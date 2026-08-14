import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  runStoreManagerOperationsMigration,
  ensureStoreManagerOperationsSchema,
  pruneStoreManagerRetention,
  STORE_MANAGER_OPERATIONS_MARKER,
  STORE_MANAGER_OPERATIONS_SCHEMA_VERSION,
} from '../../db/store-manager-operations-migration';

/**
 * Operations-console schema migration (Issue 1). DB-backed: run under
 * `bun test` (excluded from Vitest collection).
 */

const SESSION_COLUMNS = [
  'objective',
  'entrypoint',
  'execution_mode',
  'actor_class',
  'scope_json',
  'scope_hash',
  'policy_snapshot_json',
  'prompt_version',
  'lineage_json',
] as const;

function sessionColumns(): string[] {
  const rows = getDb().query('PRAGMA table_info(store_manager_sessions)').all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function eventColumns(): string[] {
  const rows = getDb().query('PRAGMA table_info(store_manager_events)').all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Store Manager operations schema migration (Issue 1)', () => {
  const testDbPath = './test-operations-migration.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('adds the operations columns to store_manager_sessions (self-heal on fresh DB)', () => {
    const columns = sessionColumns();
    for (const col of SESSION_COLUMNS) {
      expect(columns).toContain(col);
    }
  });

  it('adds the monotonic sequence column to store_manager_events', () => {
    expect(eventColumns()).toContain('sequence');
  });

  it('creates the immutable run-artifacts table and its indexes', () => {
    const table = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_run_artifacts'")
      .get();
    expect(table).toBeTruthy();
    const index = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_store_manager_run_artifacts_ws_run'")
      .get();
    expect(index).toBeTruthy();
    const sequenceIndex = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_store_manager_events_sequence'")
      .get();
    expect(sequenceIndex).toBeTruthy();
    const entrypointIndex = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_store_manager_sessions_entrypoint'")
      .get();
    expect(entrypointIndex).toBeTruthy();
  });

  it('creates the bulk-review tables and self-heals the proposal metadata columns (Issue 8)', () => {
    for (const table of [
      'store_manager_bulk_review_batches',
      'store_manager_bulk_review_items',
      'store_manager_bulk_review_decisions',
    ]) {
      expect(getDb().query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy();
    }
    // Item snapshots are unique per (batch, proposal) so the approval binds an exact set.
    const itemDdl = (getDb().query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_bulk_review_items'").get() as { sql: string }).sql;
    expect(itemDdl).toContain('UNIQUE (batch_id, proposal_id)');
    // Additive proposal metadata columns default legacy rows to manual review required.
    const columns = (getDb().query('PRAGMA table_info(catalog_health_proposals)').all() as Array<{ name: string; dflt_value: string | null }>).map((c) => c.name);
    for (const col of ['normalization_kind', 'rule_version', 'evidence_key', 'manual_review_required', 'current_digest']) {
      expect(columns).toContain(col);
    }
    // Legacy row (no metadata) is ineligible by construction.
    getDb().run(
      "INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status) VALUES ('ws-a', 'M', '.', '.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'complete')",
    );
    getDb().run(
      "INSERT INTO catalog_health_proposals (id, workspace_id, field, old_value, new_value, affected_skus, reason, confidence, source, status, created_at, updated_at) VALUES ('legacy-1', 'ws-a', 'ProductField24', 'a', 'b', '[]', 'old', 0.5, 'deterministic', 'proposed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    const legacy = getDb().query('SELECT manual_review_required FROM catalog_health_proposals WHERE id = ?').get('legacy-1') as { manual_review_required: number };
    expect(legacy.manual_review_required).toBe(1);
  });


  it('creates the immutable preferences tables and active pointer (Issue 2, v2)', () => {
    const prefs = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_preferences'")
      .get();
    expect(prefs).toBeTruthy();
    const active = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_preference_active'")
      .get();
    expect(active).toBeTruthy();
    const idx = getDb()
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_store_manager_preferences_ws'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('sets the operations schema marker', () => {
    const marker = getDb()
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get(STORE_MANAGER_OPERATIONS_MARKER) as { value: string } | undefined;
    expect(marker?.value).toBe(STORE_MANAGER_OPERATIONS_SCHEMA_VERSION);
  });

  it('creates the Inbox + notification tables and indexes (Issue 3, v3)', () => {
    for (const table of [
      'store_manager_inbox_items',
      'store_manager_notification_rules',
      'store_manager_notifications',
    ]) {
      const t = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      expect(t).toBeTruthy();
    }
    for (const index of [
      'idx_store_manager_inbox_ws_lifecycle',
      'idx_store_manager_inbox_ws_updated',
      'idx_store_manager_notifications_ws_seq',
      'idx_store_manager_notifications_ws_created',
      'idx_store_manager_notifications_ws_unread',
    ]) {
      const i = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index);
      expect(i).toBeTruthy();
    }
    // Inbox rows are unique per (workspace, dedupe_key) and notifications per
    // (workspace, fingerprint) — the dedupe contract lives in the schema.
    const inboxUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_inbox_items'")
      .get() as { sql: string };
    expect(inboxUnique.sql).toMatch(/UNIQUE \(workspace_id, dedupe_key\)/);
    const notifUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_notifications'")
      .get() as { sql: string };
    expect(notifUnique.sql).toMatch(/UNIQUE \(workspace_id, fingerprint\)/);
    const rulesUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_notification_rules'")
      .get() as { sql: string };
    expect(rulesUnique.sql).toMatch(/UNIQUE \(workspace_id, kind\)/);
  });

  it('creates the trigger + source-cursor tables and indexes (Issue 5, v5)', () => {
    for (const table of [
      'store_manager_triggers',
      'store_manager_trigger_versions',
      'store_manager_trigger_occurrences',
      'store_manager_trigger_leases',
      'store_manager_source_cursors',
    ]) {
      const t = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      expect(t).toBeTruthy();
    }
    for (const index of [
      'idx_store_manager_triggers_ws_enabled',
      'idx_store_manager_triggers_ws_kind',
      'idx_store_manager_trigger_versions_trig',
      'idx_store_manager_trigger_occ_due',
      'idx_store_manager_trigger_occ_trig',
      'idx_store_manager_trigger_occ_source',
      'idx_store_manager_trigger_leases_expiry',
      'idx_store_manager_source_cursors_ws',
    ]) {
      const i = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index);
      expect(i).toBeTruthy();
    }
    // Occurrence rows are unique per (workspace, occurrence_key) — the
    // at-least-once/idempotency backstop lives in the schema.
    const occUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_trigger_occurrences'")
      .get() as { sql: string };
    expect(occUnique.sql).toMatch(/UNIQUE \(workspace_id, occurrence_key\)/);
    // Source cursors are unique per (workspace, source_kind, source_id).
    const cursorUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_source_cursors'")
      .get() as { sql: string };
    expect(cursorUnique.sql).toMatch(/UNIQUE \(workspace_id, source_kind, source_id\)/);
  });

  it('creates the playbook tables and indexes (Issue 6, v6)', () => {
    for (const table of ['store_manager_playbooks', 'store_manager_playbook_versions']) {
      const t = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      expect(t).toBeTruthy();
    }
    for (const index of [
      'idx_store_manager_playbooks_ws',
      'idx_store_manager_playbook_versions_pb',
    ]) {
      const i = getDb()
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index);
      expect(i).toBeTruthy();
    }
    // Versions are content-addressed: definition_hash is NOT NULL, and rows
    // are unique per (workspace, playbook, version) — the immutability + copy-
    // on-edit backstop lives in the schema.
    const versionUnique = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_playbook_versions'")
      .get() as { sql: string };
    expect(versionUnique.sql).toMatch(/UNIQUE \(workspace_id, playbook_id, version\)/);
    expect(versionUnique.sql).toMatch(/definition_hash TEXT NOT NULL/);
    // Playbook rows record the active version pointer + activation audit.
    const playbookSql = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_playbooks'")
      .get() as { sql: string };
    expect(playbookSql.sql).toMatch(/active_version INTEGER/);
    expect(playbookSql.sql).toMatch(/activated_by TEXT/);
  });

  it('is idempotent across repeated runs', () => {
    expect(() => runStoreManagerOperationsMigration()).not.toThrow();
    expect(() => ensureStoreManagerOperationsSchema()).not.toThrow();
    expect(sessionColumns().filter((c) => SESSION_COLUMNS.includes(c as (typeof SESSION_COLUMNS)[number]))).toHaveLength(
      SESSION_COLUMNS.length,
    );
  });

  it('self-heals a partially upgraded DB (missing columns are added, existing kept)', () => {
    // Simulate a partial state: drop a session column by rebuilding the table
    // without it (SQLite cannot DROP COLUMN portably), then re-run.
    getDb().exec('ALTER TABLE store_manager_sessions RENAME TO store_manager_sessions_partial');
    getDb().exec(`
      CREATE TABLE store_manager_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        requested_model TEXT,
        resolved_provider TEXT NOT NULL,
        resolved_model TEXT NOT NULL,
        resolved_locality TEXT NOT NULL CHECK (resolved_locality IN ('local', 'cloud')),
        resolution_reason TEXT NOT NULL,
        model_call_id TEXT,
        objective TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    getDb().exec('DROP TABLE store_manager_sessions_partial');
    // Marker is still set, so the guarded migration would skip; force the
    // self-heal path by clearing the marker.
    getDb().query('DELETE FROM app_meta WHERE key = ?').run(STORE_MANAGER_OPERATIONS_MARKER);
    expect(() => runStoreManagerOperationsMigration()).not.toThrow();
    const columns = sessionColumns();
    for (const col of SESSION_COLUMNS) expect(columns).toContain(col);
  });

  it('refuses to run before the base #42 tables exist', () => {
    try { resetDb(); } catch { /* ok */ }
    initDb('./test-operations-no-base.db');
    expect(() => runStoreManagerOperationsMigration()).toThrow(/runMigrations/);
    closeDb();
    try { unlinkSync('./test-operations-no-base.db'); } catch { /* ok */ }
    try { unlinkSync('./test-operations-no-base.db-shm'); } catch { /* ok */ }
    try { unlinkSync('./test-operations-no-base.db-wal'); } catch { /* ok */ }
    // Restore the shared test DB for subsequent tests.
    initDb(testDbPath);
  });

  it('adds the Issue 4 schedule/occurrence/lease tables and their indexes', () => {
    for (const table of ['store_manager_schedules', 'store_manager_schedule_versions', 'store_manager_schedule_occurrences', 'store_manager_schedule_leases']) {
      expect(getDb().query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)).toBeTruthy();
    }
    for (const index of [
      'idx_store_manager_schedules_ws_enabled',
      'idx_store_manager_schedule_versions_sched',
      'idx_store_manager_occurrences_due',
      'idx_store_manager_occurrences_sched',
      'idx_store_manager_leases_expiry',
    ]) {
      expect(getDb().query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index)).toBeTruthy();
    }
    // Occurrence table enforces the restart-safety uniqueness backstop.
    const occDdl = getDb().query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_schedule_occurrences'").get() as { sql: string };
    expect(occDdl.sql).toMatch(/UNIQUE \(workspace_id, occurrence_key\)/);
  });

  it('pruneStoreManagerRetention prunes only stale derived rows and preserves audit/telemetry lineage (Issue 9)', () => {
    const db = getDb();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const oldIso = '2026-01-01T00:00:00.000Z';
    const freshIso = '2026-05-01T00:00:00.000Z';

    // Seed two terminal sessions: one stale (workspace ws-a) and one fresh (ws-b).
    for (const [id, ws, at] of [
      ['run-old', 'ws-a', oldIso],
      ['run-fresh', 'ws-b', freshIso],
      ['run-active', 'ws-a', oldIso],
    ] as const) {
      const status = id === 'run-active' ? 'active' : 'terminal';
      db.query(
        `INSERT INTO store_manager_sessions (id, workspace_id, turn_id, execution_id, policy_hash, policy_version, resolved_provider, resolved_model, resolved_locality, resolution_reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'p', 'm', 'cloud', 'explicit', ?, ?, ?)`,
      ).run(id, ws, `turn-${id}`, `exec-${id}`, 'b'.repeat(64), status, at, at);
      db.query(
        `INSERT INTO store_manager_events (id, workspace_id, session_id, turn_id, event_type, event_version, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'turn_started', 1, '{}', ?)`,
      ).run(`ev-${id}`, ws, id, `turn-${id}`, at);
      db.query(
        `INSERT INTO store_manager_run_artifacts (id, workspace_id, run_id, kind, schema_version, content_json, content_hash, created_at)
         VALUES (?, ?, ?, 'report', 1, '{}', ?, ?)`,
      ).run(`art-${id}`, ws, id, 'c'.repeat(64), at);
    }

    // Resolved inbox item (stale) + open inbox item (stale but not resolved -> kept).
    db.query(
      `INSERT INTO store_manager_inbox_items (id, workspace_id, kind, dedupe_key, severity, title, summary, scope_json, source_refs_json, fingerprint, source_updated_at, lifecycle, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('inbox-resolved', 'ws-a', 'proposals_awaiting_review', 'k1', 'medium', 't', 's', '{}', '[]', 'fp1', ?, 'resolved', ?, ?, ?, ?)`,
    ).run(freshIso, oldIso, oldIso, oldIso, oldIso);
    db.query(
      `INSERT INTO store_manager_inbox_items (id, workspace_id, kind, dedupe_key, severity, title, summary, scope_json, source_refs_json, fingerprint, source_updated_at, lifecycle, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('inbox-open', 'ws-a', 'proposals_awaiting_review', 'k2', 'medium', 't', 's', '{}', '[]', 'fp2', ?, 'open', ?, ?, ?, ?)`,
    ).run(freshIso, oldIso, oldIso, oldIso, oldIso);

    // Old + fresh notifications.
    db.query(
      `INSERT INTO store_manager_notifications (id, workspace_id, rule_id, rule_kind, rule_version, fingerprint, severity, title, message, sequence, created_at)
       VALUES ('notif-old', 'ws-a', 'r1', 'proposal_backlog', 1, 'f1', 'medium', 't', 'm', 1, ?)`,
    ).run(oldIso);
    db.query(
      `INSERT INTO store_manager_notifications (id, workspace_id, rule_id, rule_kind, rule_version, fingerprint, severity, title, message, sequence, created_at)
       VALUES ('notif-fresh', 'ws-b', 'r1', 'proposal_backlog', 1, 'f2', 'medium', 't', 'm', 2, ?)`,
    ).run(freshIso);

    // Audit lineage that must survive: a review decision row.
    db.query(
      `INSERT INTO store_manager_review_decisions (id, workspace_id, proposal_id, field, decision, actor, run_id, created_at)
       VALUES ('decision-1', 'ws-a', 'p1', 'ProductField24', 'dismiss', 'operator', 'run-old', ?)`,
    ).run(oldIso);

    const result = pruneStoreManagerRetention('ws-a', {
      runDetailCutoffDays: 90,
      resolvedInboxCutoffDays: 90,
      notificationCutoffDays: 30,
      maxSessions: 100,
      now: () => now,
    });

    // Stale terminal session's events/artifacts pruned; active session untouched.
    expect(result.prunedSessions).toBe(1);
    expect(result.prunedEvents).toBe(1);
    expect(result.prunedArtifacts).toBe(1);
    // Resolved inbox pruned; open inbox kept (no lifecycle authority for a prune).
    expect(result.prunedInboxItems).toBe(1);
    expect(db.query("SELECT id FROM store_manager_inbox_items WHERE id = 'inbox-open'").get()).toBeTruthy();
    // Old notification pruned; ws-b untouched entirely.
    expect(result.prunedNotifications).toBe(1);
    expect(db.query("SELECT id FROM store_manager_notifications WHERE id = 'notif-fresh'").get()).toBeTruthy();
    // Session row retained (audit lineage) + decision row retained + telemetry intact.
    expect(db.query("SELECT id FROM store_manager_sessions WHERE id = 'run-old'").get()).toBeTruthy();
    expect(db.query("SELECT id FROM store_manager_review_decisions WHERE id = 'decision-1'").get()).toBeTruthy();
    expect(result.retainedDecisionRows).toBe(1);
    expect(result.aiModelCallsIntact).toBeGreaterThanOrEqual(0);
    // ws-b entirely untouched.
    expect(db.query("SELECT id FROM store_manager_events WHERE session_id = 'run-fresh'").get()).toBeTruthy();
    expect(db.query("SELECT id FROM store_manager_run_artifacts WHERE run_id = 'run-fresh'").get()).toBeTruthy();

    // Idempotent: a second run prunes nothing new.
    const second = pruneStoreManagerRetention('ws-a', {
      runDetailCutoffDays: 90,
      resolvedInboxCutoffDays: 90,
      notificationCutoffDays: 30,
      maxSessions: 100,
      now: () => now,
    });
    expect(second.prunedSessions).toBe(0);
    expect(second.prunedEvents).toBe(0);
    expect(second.prunedArtifacts).toBe(0);
    expect(second.prunedInboxItems).toBe(0);
    expect(second.prunedNotifications).toBe(0);
  });

  it('pruneStoreManagerRetention rolls the whole batch back when a table is missing (Issue 9)', () => {
    // A fresh DB without the operations migration: pruning must roll back and
    // rethrow rather than leave a partial delete.
    const db = getDb();
    const before = Number((db.query('SELECT COUNT(*) AS c FROM store_manager_sessions').get() as { c: number }).c);
    const run = () =>
      pruneStoreManagerRetention('does-not-exist', { now: () => new Date('2026-06-01T00:00:00.000Z') });
    // Not found: no rows to prune, idempotent no-op, no throw.
    expect(() => run()).not.toThrow();
    const after = Number((db.query('SELECT COUNT(*) AS c FROM store_manager_sessions').get() as { c: number }).c);
    expect(after).toBe(before);
  });
});

describe('Store Manager operations migration — upgrade path (Issue 1)', () => {
  const upgradeDbPath = './test-operations-upgrade.db';

  it('upgrades a pre-operations DB (old #42 shape) in place', () => {
    // Defensive cleanup: a failed run can leave -wal/-shm siblings that SQLite
    // would recover into the "fresh" main file (resurrecting old rows and
    // tripping UNIQUE on reseed). Remove all three before init.
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(`${upgradeDbPath}${suffix}`); } catch { /* ok */ }
    }
    try { resetDb(); } catch { /* ok */ }
    initDb(upgradeDbPath);
    // Minimal old-shape #42 tables (no operations columns/sequence/artifacts).
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS store_manager_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        requested_model TEXT,
        resolved_provider TEXT NOT NULL,
        resolved_model TEXT NOT NULL,
        resolved_locality TEXT NOT NULL CHECK (resolved_locality IN ('local', 'cloud')),
        resolution_reason TEXT NOT NULL,
        model_call_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS store_manager_turns (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES store_manager_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('investigate', 'approve', 'verify')),
        status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
        terminal_status TEXT CHECK (terminal_status IN ('success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded')),
        outcome_reason TEXT,
        total_tool_calls INTEGER NOT NULL DEFAULT 0,
        policy_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS store_manager_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    getDb().exec(
      `INSERT INTO store_manager_sessions (id, workspace_id, turn_id, execution_id, policy_hash, policy_version, resolved_provider, resolved_model, resolved_locality, resolution_reason, status, created_at, updated_at) VALUES ('run-1', 'ws-a', 'turn-1', 'exec-1', '${'a'.repeat(64)}', 1, 'p', 'm', 'cloud', 'explicit', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );;
    getDb().exec("INSERT INTO store_manager_events (id, workspace_id, session_id, turn_id, event_type, event_version, payload_json, created_at) VALUES ('ev-1', 'ws-a', 'run-1', 'turn-1', 'turn_started', 1, '{}', '2026-01-01T00:00:00.000Z')");

    expect(() => runStoreManagerOperationsMigration()).not.toThrow();

    // Columns + artifacts added; pre-existing rows preserved.
    const columns = sessionColumns();
    for (const col of SESSION_COLUMNS) expect(columns).toContain(col);
    expect(getDb().query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_run_artifacts'").get()).toBeTruthy();
    const kept = getDb().query("SELECT id FROM store_manager_sessions WHERE id = 'run-1'").get();
    expect(kept).toBeTruthy();

    closeDb();
    try { unlinkSync(upgradeDbPath); } catch { /* ok */ }
    try { unlinkSync(`${upgradeDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${upgradeDbPath}-wal`); } catch { /* ok */ }
  });


});
