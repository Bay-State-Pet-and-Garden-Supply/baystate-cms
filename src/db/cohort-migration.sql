-- Cohort Migration (issue #30; schema v5 = FINAL, PR3 M1)
-- Adds durable candidate product-family tables for cohort-centric Curation
-- (v1–v4) plus the parent cohort RUN table (v5, PR3 M1).
-- Version-gated by app_meta key 'curation_cohort_schema_version' in
-- runMigrations() (src/db/migrations.ts). Uses CREATE TABLE IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS for idempotence. Historical cohort rows are
-- superseded, never mutated; a superseded row is no longer the active cohort.
--
-- v4 (issue #31 cleanup F3): execution metadata (`started_at`/`completed_at`)
-- is REMOVED from curation_cohorts. The candidate cohort row is a candidate
-- family record only; execution timestamps are owned solely by
-- `classification_cohort_runs`. Fresh installs read the FINAL v4 shape
-- directly from this file; existing databases are rebuilt hop-by-hop in
-- runMigrations() (v3 → v4 drops the two columns).
-- v5 (issue #30 PR3 M1): adds `classification_cohort_runs` — the parent cohort
-- run that owns the execution lifecycle AND the claim lease. Fresh installs
-- write marker '5'; marker-'4' databases run db.exec(cohortSql) (idempotent)
-- and bump to '5'. The candidate cohort row stays candidate-only.
-- v3 (D7): curation_cohorts.status CHECK is NARROWED to the candidate-family
-- lifecycle `forming | waiting | ready | superseded`. Execution/lifecycle
-- states (`running`/`completed`/`failed`/`conflicted`) never belong on the
-- cohort row — cohort RUN state is owned by the cohort run (PR3+).
-- v2 (round-2 F3): curation_cohorts.batch_id references onboarding_batches(id)
-- ON DELETE CASCADE so deleting a batch cleans up its cohort rows. Existing
-- v1 databases are rebuilt by runMigrations() (SQLite cannot alter an FK);
-- fresh databases get the v2 shape directly from this file.

-- Candidate curation cohort: a versioned candidate family of onboarding items
-- grouped by a deterministic grouping algorithm (grouping_version
-- 'product-family-v1').
CREATE TABLE IF NOT EXISTS curation_cohorts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,          -- deterministic brand + normalized name stem key
  group_label TEXT NOT NULL,
  grouping_version TEXT NOT NULL,   -- 'product-family-v1'
  membership_hash TEXT NOT NULL,    -- order-insensitive canonical hash
  status TEXT NOT NULL CHECK (status IN ('forming','waiting','ready','superseded')),
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT
);

-- Cohort members: the onboarding items belonging to a candidate cohort, with
-- the frozen per-member extraction evidence hash.
CREATE TABLE IF NOT EXISTS curation_cohort_members (
  cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
  onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  product_sku TEXT,
  normalized_brand TEXT NOT NULL,
  normalized_name_stem TEXT NOT NULL,
  membership_reason_json TEXT,      -- e.g. {"kind":"deterministic_grouping","groupingVersion":"product-family-v1"}
  extraction_hash TEXT,             -- canonical hash of extraction/sourcing evidence; NULL until complete
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (cohort_id, onboarding_item_id)
);

CREATE INDEX IF NOT EXISTS idx_curation_cohorts_batch ON curation_cohorts(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_curation_cohort_members_item ON curation_cohort_members(onboarding_item_id);

-- At most one ACTIVE (non-superseded) cohort per (batch, group_key, grouping_version).
CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_cohorts_active_group
  ON curation_cohorts(batch_id, group_key, grouping_version) WHERE status != 'superseded';

-- ════════════════════════════════════════════════════════════════════════════
-- classification_cohort_runs (issue #30, PR3 M1; cohort schema v5)
--
-- Parent cohort classification run: ONE execution identity per cohort
-- revision. Owns the execution lifecycle AND the claim/lease; curation_cohorts
-- stays a candidate-family record only (schema v4 — execution metadata never
-- returns to the candidate row). Child per-SKU classification_runs link here
-- via classification_runs.cohort_run_id (ON DELETE SET NULL, PRAGMA-guarded
-- ALTER in runMigrations()).
--
-- Lifecycle (PR3 M1 contract): claiming atomically inserts a `freezing` row
-- with the lease (claimed_by/claimed_at/lease_expires_at) and the frozen
-- candidate membership hash; `freezing → running` happens ONLY after the
-- final freeze CAS commits (started_at records execution start and is NULL
-- until then). Terminal states: completed | completed_with_abstentions |
-- completed_with_member_failures | failed | cancelled. `superseded` is
-- settable from ANY state (including terminal ones) and has no transition
-- out of it. At most one current (non-superseded) run exists per cohort
-- (unique current-run index below); a completed/failed run stays the current
-- historical decision until something explicitly supersedes it.
--
-- Authority columns: candidate_membership_hash is frozen at claim (the
-- cohort's membership_hash — H1 identity). final_membership_hash and
-- execution_product_type_id/product_type_confidence are PR4 placeholders
-- (NULL until PR4 writes them once). config_snapshot_id/hash,
-- page_import_id/hash and model_policy_digest are nullable mirrors of the
-- per-SKU classification_runs authority columns (frozen by the freeze
-- service). The hash-required CHECK only requires the two mandatory evidence
-- hashes before a run may LEAVE `freezing`.
CREATE TABLE IF NOT EXISTS classification_cohort_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
  candidate_membership_hash TEXT NOT NULL,  -- frozen cohort.membership_hash at claim (H1)
  final_membership_hash TEXT,               -- PR4 (write-once); NULL until then
  evidence_snapshot_hash TEXT,              -- H2 digest; NULL while freezing
  config_snapshot_id TEXT REFERENCES classification_config_snapshots(id),  -- H3 authority ref (nullable mirror)
  config_snapshot_hash TEXT,
  page_import_id TEXT REFERENCES page_imports(id),  -- H4 authority ref (nullable mirror)
  page_import_hash TEXT,
  model_policy_digest TEXT,                 -- H5 unbound model-execution digest (nullable mirror)
  execution_product_type_id TEXT,           -- PR4 placeholder
  product_type_confidence REAL CHECK (product_type_confidence IS NULL OR (product_type_confidence >= 0 AND product_type_confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'freezing' CHECK (status IN
    ('freezing','running','completed','completed_with_abstentions','completed_with_member_failures','failed','cancelled','superseded')),
  claimed_by TEXT,                          -- worker id that owns the claim lease
  claimed_at TEXT,                          -- ownership start (set at claim)
  lease_expires_at TEXT,                    -- claim deadline (stale sweep predicate)
  started_at TEXT,                          -- execution start (set on freezing → running)
  completed_at TEXT,
  error_message TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  -- Hash gate on EXECUTION states only: leaving `freezing` for running/
  -- completed*/failed requires the two mandatory evidence hashes. `superseded`
  -- and `cancelled` are terminal lifecycle states that may carry no frozen
  -- data (an abandoned unfinalized freeze is still historical truth); the
  -- unique current-run index excludes superseded rows so a NULL-hash
  -- superseded row never blocks re-claim.
  CHECK (status IN ('freezing','superseded','cancelled') OR (candidate_membership_hash IS NOT NULL AND evidence_snapshot_hash IS NOT NULL))
);

-- Indexes (v5)
CREATE INDEX IF NOT EXISTS idx_classification_cohort_runs_cohort
  ON classification_cohort_runs(cohort_id, created_at DESC);   -- run history per cohort
CREATE INDEX IF NOT EXISTS idx_classification_cohort_runs_status
  ON classification_cohort_runs(status);
CREATE INDEX IF NOT EXISTS idx_classification_cohort_runs_workspace
  ON classification_cohort_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_classification_cohort_runs_lease
  ON classification_cohort_runs(status, lease_expires_at);      -- stale-lease sweep predicate
-- At most one CURRENT (non-superseded) run per cohort: two workers can never
-- own the same cohort. `superseded` frees the slot for a legitimate retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_cohort_runs_current
  ON classification_cohort_runs(cohort_id) WHERE status != 'superseded';
