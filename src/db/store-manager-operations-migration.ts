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
 * New surface (v4, Issue 4):
 *  - store_manager_schedules / _versions / _occurrences / _leases: leased
 *    scheduled read-only runs (unique occurrence keys, atomic claims).
 * New surface (v5, Issue 5):
 *  - store_manager_triggers / _versions / _occurrences / _leases: durable
 *    event-triggered read-only runs (same lease + unique-key discipline).
 *  - store_manager_source_cursors: per-source observation cursors with
 *    fingerprints + deterministic baselines (drift), out-of-order safe.
 * New surface (v6, Issue 7):
 *  - store_manager_playbook_runs / _steps: durable playbook execution with
 *    per-step claims, checkpoints, leases, and typed outputs/artifacts.
 *  - store_manager_review_decisions: durable per-proposal review decisions
 *    (dismiss/deny) so history queries can count repeated rejections.
 *  - history indexes for run listing + decision lookups.
 */

import { getDb } from './connection';
import type { Database } from './driver';

export const STORE_MANAGER_OPERATIONS_SCHEMA_VERSION = '7';
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

  // Nested-safe transaction: when a caller is already inside a transaction
  // (e.g. the proposal replace path calls insertProposal -> self-heal), use a
  // SAVEPOINT so the migration never throws "cannot start a transaction
  // within a transaction". A failing savepoint only undoes the migration's own
  // work; the outer transaction decides what happens next.
  const nested = (db as Database & { inTransaction?: boolean }).inTransaction === true;
  db.exec(nested ? 'SAVEPOINT store_manager_ops_migration' : 'BEGIN');
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
    // Block 8 (Issue 5): durable event-triggered read-only runs. Triggers are
    // versioned definitions (immutable version rows; the trigger row holds the
    // current pointer), occurrences are restart-safe via a unique per-workspace
    // occurrence key, leases drive atomic claim/heartbeat/expiry, and source
    // cursors record last-seen fingerprints + deterministic baselines so
    // at-least-once observation survives restarts and out-of-order updates.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_triggers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        scope_json TEXT,
        selected_model TEXT,
        objective TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        enable_audit_json TEXT,
        last_scan_at TEXT,
        last_scan_status TEXT,
        last_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_triggers_ws_enabled
        ON store_manager_triggers(workspace_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_store_manager_triggers_ws_kind
        ON store_manager_triggers(workspace_id, kind);
      CREATE TABLE IF NOT EXISTS store_manager_trigger_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, trigger_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_trigger_versions_trig
        ON store_manager_trigger_versions(workspace_id, trigger_id, version);
      CREATE TABLE IF NOT EXISTS store_manager_trigger_occurrences (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        trigger_version INTEGER NOT NULL,
        occurrence_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        scope_json TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_store_manager_trigger_occ_due
        ON store_manager_trigger_occurrences(workspace_id, status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_trigger_occ_trig
        ON store_manager_trigger_occurrences(workspace_id, trigger_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_trigger_occ_source
        ON store_manager_trigger_occurrences(workspace_id, source_kind, source_id);
      CREATE TABLE IF NOT EXISTS store_manager_trigger_leases (
        occurrence_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_trigger_leases_expiry
        ON store_manager_trigger_leases(workspace_id, lease_expires_at);
      CREATE TABLE IF NOT EXISTS store_manager_source_cursors (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        baseline_json TEXT,
        terminal_observed INTEGER NOT NULL DEFAULT 0,
        last_observed_at TEXT NOT NULL,
        eval_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, source_kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_source_cursors_ws
        ON store_manager_source_cursors(workspace_id, source_kind, source_id);
    `);
    // Block 9 (Issue 6): immutable versioned playbooks. The logical playbook
    // row holds the current pointer (name, status, active version + audit);
    // every edit appends a NEW immutable version row (content-addressed) — a
    // playbook can never observe later edits. Activation is an explicit
    // reviewed operation recording actor/time/hash. Versions are bounded and
    // redacted by construction (strict Zod at the boundary).
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_playbooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        template_kind TEXT,
        current_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        active_version INTEGER,
        active_hash TEXT,
        activated_at TEXT,
        activated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbooks_ws
        ON store_manager_playbooks(workspace_id, updated_at);
      CREATE TABLE IF NOT EXISTS store_manager_playbook_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        playbook_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, playbook_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbook_versions_pb
        ON store_manager_playbook_versions(workspace_id, playbook_id, version);
    `);
    // Block 10 (Issue 7): durable playbook runs + steps. One run row per
    // invocation with a current-step pointer and lease; one step row per
    // declared step capturing typed input/output, diff hash for the
    // checkpoint, execution run id, and approval state. Checkpoints pause
    // the run (status paused_at_checkpoint) and only a fresh operator
    // approval with the exact diff hash resumes it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_playbook_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        playbook_id TEXT NOT NULL,
        playbook_version INTEGER NOT NULL,
        definition_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        current_step_id TEXT,
        variables_json TEXT NOT NULL,
        scope_json TEXT,
        actor TEXT NOT NULL DEFAULT 'operator',
        owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        error_code TEXT,
        error_detail TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbook_runs_ws
        ON store_manager_playbook_runs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbook_runs_status
        ON store_manager_playbook_runs(workspace_id, status);
      CREATE TABLE IF NOT EXISTS store_manager_playbook_steps (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tool_name TEXT,
        tool_version INTEGER,
        tool_call_id TEXT,
        input_json TEXT,
        output_json TEXT,
        artifact_id TEXT,
        diff_hash TEXT,
        execution_run_id TEXT,
        approval_actor TEXT,
        approval_diff_hash TEXT,
        approval_expires_at TEXT,
        error_code TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbook_steps_run
        ON store_manager_playbook_steps(workspace_id, run_id, step_id);
      CREATE INDEX IF NOT EXISTS idx_store_manager_playbook_steps_status
        ON store_manager_playbook_steps(workspace_id, status);
      -- Durable per-proposal review decisions (dismiss/deny) for history
      -- queries (rejected-more-than-once) and per-item audit. Never a
      -- staging authority: decisions record ONLY what an operator did.
      CREATE TABLE IF NOT EXISTS store_manager_review_decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        field TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        run_id TEXT,
        step_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_decisions_ws_proposal
        ON store_manager_review_decisions(workspace_id, proposal_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_decisions_ws_created
        ON store_manager_review_decisions(workspace_id, created_at);
      -- History listing index (run list is ordered by created_at DESC).
      CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_ws_created
        ON store_manager_sessions(workspace_id, created_at);
    `);
    // Block 11 (Issue 8): homogeneous bulk review. One immutable batch
    // header + per-item snapshots/digests (the approval binds the EXACT set),
    // plus an append-only per-item decision ledger. Batch id is correlation
    // only — per-item audit comes from the decision rows + proposal status
    // transitions + Change Set item references. The catalog_health_proposals
    // additive columns (normalization_kind, rule_version, evidence_key,
    // manual_review_required, current_digest) are self-healed below so legacy
    // rows default to manual_review_required = 1 (ineligible).
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_bulk_review_batches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        group_key TEXT NOT NULL,
        field TEXT NOT NULL,
        normalization_kind TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        proposal_count INTEGER NOT NULL DEFAULT 0,
        distinct_sku_count INTEGER NOT NULL DEFAULT 0,
        diff_hash TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_bulk_batches_ws
        ON store_manager_bulk_review_batches(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_bulk_batches_status
        ON store_manager_bulk_review_batches(workspace_id, status);
      CREATE TABLE IF NOT EXISTS store_manager_bulk_review_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        affected_skus_json TEXT NOT NULL,
        item_digest TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        decision_actor TEXT,
        change_set_item_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (batch_id, proposal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_bulk_items_ws_batch
        ON store_manager_bulk_review_items(workspace_id, batch_id);
      CREATE TABLE IF NOT EXISTS store_manager_bulk_review_decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        run_id TEXT,
        diff_hash TEXT,
        change_set_item_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_bulk_decisions_ws_proposal
        ON store_manager_bulk_review_decisions(workspace_id, proposal_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_store_manager_bulk_decisions_ws_batch
        ON store_manager_bulk_review_decisions(workspace_id, batch_id);
    `);
    // Self-heal: additive bulk-review metadata columns on catalog_health_proposals.
    // Legacy rows keep manual_review_required = 1 (never reclassified safe).
    // Guarded on the base table: synthetic #42 upgrade fixtures may omit it,
    // and the proposal repo self-heals its own surface on demand.
    if (tableExists(db, 'catalog_health_proposals')) {
      for (const [column, ddl] of [
        ['normalization_kind', 'TEXT'],
        ['rule_version', 'TEXT'],
        ['evidence_key', 'TEXT'],
        ['manual_review_required', 'INTEGER NOT NULL DEFAULT 1'],
        ['current_digest', 'TEXT'],
      ] as const) {
        if (!columnExists(db, 'catalog_health_proposals', column)) {
          db.exec(`ALTER TABLE catalog_health_proposals ADD COLUMN ${column} ${ddl}`);
        }
      }
    }
    db.query(
      'INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)',
    ).run(STORE_MANAGER_OPERATIONS_MARKER, STORE_MANAGER_OPERATIONS_SCHEMA_VERSION);
    db.exec(nested ? 'RELEASE store_manager_ops_migration' : 'COMMIT');
  } catch (err) {
    db.exec(nested ? 'ROLLBACK TO store_manager_ops_migration; RELEASE store_manager_ops_migration' : 'ROLLBACK');
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

// ---------------------------------------------------------------------------
// Issue 9: retention pruning (data maintenance, not schema)
// ---------------------------------------------------------------------------

/**
 * Workspace-scoped retention policy (Issue 9). Pruning deletes only derived
 * runtime rows whose owning run is terminal and older than the window:
 *
 *  - run events (`store_manager_events`) and run artifacts
 *    (`store_manager_run_artifacts`) for terminal sessions older than
 *    `runDetailCutoffDays` (the session/turn rows themselves are retained:
 *    they carry the audit lineage and the `ai_model_calls` linkage, so
 *    telemetry is never orphaned or pruned while a run is retained);
 *  - resolved Inbox items older than `resolvedInboxCutoffDays`;
 *  - notifications older than `notificationCutoffDays`.
 *
 * NEVER touched: `ai_model_calls`, `catalog_health_proposals`, review
 * decisions, bulk-review decisions/items, playbook runs/steps, policy
 * snapshots, schedules/triggers/occurrences. Conservative defaults are the
 * locked plan values (90d run details, 90d resolved Inbox, 30d
 * notifications); a max batch bound keeps each transaction small.
 */
export interface StoreManagerRetentionOptions {
  runDetailCutoffDays?: number;
  resolvedInboxCutoffDays?: number;
  notificationCutoffDays?: number;
  /** Hard cap on pruned run sessions per invocation (bounded batches). */
  maxSessions?: number;
  now?: () => Date;
}

export interface StoreManagerRetentionResult {
  workspaceId: string;
  prunedSessions: number;
  prunedEvents: number;
  prunedArtifacts: number;
  prunedInboxItems: number;
  prunedNotifications: number;
  aiModelCallsIntact: number;
  retainedDecisionRows: number;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Prune stale derived runtime rows for ONE workspace inside one transaction
 * (SAVEPOINT so an interruption rolls the batch back cleanly). Idempotent:
 * re-running with the same cutoffs deletes nothing new. Returns per-class
 * counts plus proof that `ai_model_calls` and decision/audit rows survived.
 */
export function pruneStoreManagerRetention(
  workspaceId: string,
  options: StoreManagerRetentionOptions = {},
): StoreManagerRetentionResult {
  const db = getDb();
  if (!workspaceId || workspaceId.length > 200) {
    throw new Error('pruneStoreManagerRetention: invalid workspace id.');
  }
  const now = options.now ? options.now() : new Date();
  const runCutoff = isoDaysAgo(now, options.runDetailCutoffDays ?? 90);
  const inboxCutoff = isoDaysAgo(now, options.resolvedInboxCutoffDays ?? 90);
  const notifCutoff = isoDaysAgo(now, options.notificationCutoffDays ?? 30);
  const maxSessions = Math.min(Math.max(options.maxSessions ?? 500, 1), 5000);

  db.exec('SAVEPOINT store_manager_retention');
  try {
    const sessionRows = db
      .query(
        `SELECT id FROM store_manager_sessions
         WHERE workspace_id = ? AND status = 'terminal' AND created_at < ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(workspaceId, runCutoff, maxSessions) as Array<{ id: string }>;
    const sessionIds = sessionRows.map((r) => r.id);

    let prunedEvents = 0;
    let prunedArtifacts = 0;
    let prunedSessions = 0;
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(',');
      const hadDerivedRowsBefore = Number(
        (
          db
            .query(
              `SELECT COUNT(*) AS c FROM store_manager_events WHERE session_id IN (${placeholders})`,
            )
            .get(...sessionIds) as { c: number }
        ).c ?? 0,
      );
      const eventsResult = db
        .query(`DELETE FROM store_manager_events WHERE session_id IN (${placeholders})`)
        .run(...sessionIds);
      prunedEvents = Number(eventsResult.changes ?? 0);
      const artifactsResult = db
        .query(`DELETE FROM store_manager_run_artifacts WHERE run_id IN (${placeholders})`)
        .run(...sessionIds);
      prunedArtifacts = Number(artifactsResult.changes ?? 0);
      // Sessions are retained as audit lineage; count only sessions whose
      // derived rows were actually removed so repeated prunes are idempotent.
      const hasDerivedRowsAfter = Number(
        (
          db
            .query(
              `SELECT COUNT(*) AS c FROM store_manager_events WHERE session_id IN (${placeholders})`,
            )
            .get(...sessionIds) as { c: number }
        ).c ?? 0,
      );
      prunedSessions = Math.max(0, hadDerivedRowsBefore - hasDerivedRowsAfter);
    }

    const inboxResult = db
      .query(
        `DELETE FROM store_manager_inbox_items
         WHERE workspace_id = ? AND lifecycle = 'resolved' AND updated_at < ?`,
      )
      .run(workspaceId, inboxCutoff);
    const prunedInboxItems = Number(inboxResult.changes ?? 0);

    const notifResult = db
      .query(
        `DELETE FROM store_manager_notifications
         WHERE workspace_id = ? AND created_at < ?`,
      )
      .run(workspaceId, notifCutoff);
    const prunedNotifications = Number(notifResult.changes ?? 0);

    const aiModelCallsIntact = Number(
      (
        db
          .query('SELECT COUNT(*) AS c FROM ai_model_calls')
          .get() as { c: number }
      ).c ?? 0,
    );
    const retainedDecisionRows = tableExists(db, 'store_manager_review_decisions')
      ? Number(
          (
            db
              .query(
                'SELECT COUNT(*) AS c FROM store_manager_review_decisions',
              )
              .get() as { c: number }
          ).c ?? 0,
        )
      : 0;

    db.exec('RELEASE store_manager_retention');
    return {
      workspaceId,
      prunedSessions,
      prunedEvents,
      prunedArtifacts,
      prunedInboxItems,
      prunedNotifications,
      aiModelCallsIntact,
      retainedDecisionRows,
    };
  } catch (err) {
    db.exec('ROLLBACK TO store_manager_retention; RELEASE store_manager_retention');
    throw err;
  }
}
