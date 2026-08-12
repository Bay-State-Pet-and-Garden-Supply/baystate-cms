-- Cohort Migration (issue #30; schema v7 = FINAL, PR3 M1 + M2, PR4 C1, PR6 C1)
-- Adds durable candidate product-family tables for cohort-centric Curation
-- (v1–v4) plus the parent cohort RUN table (v5, PR3 M1) and the
-- content-addressed execution-evidence snapshot table (v5, PR3 M2).
-- Version-gated by app_meta key 'curation_cohort_schema_version' in
-- runMigrations() (src/db/migrations.ts). Uses CREATE TABLE IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS for idempotence. Historical cohort rows are
-- superseded, never mutated; a superseded row is no longer the active cohort.
--
-- v7 (issue #30 PR6 C1): adds the durable cohort-output table
-- `classification_cohort_outputs` (PR6 — durable cohort outputs). ONE row per
-- (cohort_run_id, output_kind, product_sku); 'curated_title' is the first
-- kind (the parent-cohort title-coordination output), PR7 adds
-- 'coordinated_page'. output_kind is a free-form string mirroring the
-- `dependency_kind` precedent (no CHECK — SQLite cannot alter a CHECK without
-- a table rebuild, and PR7 extends the kind set). Historical outputs are
-- IMMUTABLE: there is no UPDATE path — a new cohort revision is a NEW run id,
-- so superseding the parent run (which leaves its outputs in place)
-- automatically produces NEW output rows under the new run. Fresh installs
-- read the FINAL v7 shape directly from this file; existing databases are
-- converged in runMigrations(): marker-'6' databases run db.exec(cohortSql)
-- (idempotent — creates the outputs table + indexes) and bump to '7'.
--
-- PR7 (issue #30, durable coordinated Category Pages): the same table carries
-- 'coordinated_page' outputs — one row per (run, kind, product_sku), the
-- payload being {status:'assigned', pages, source:'llm_cohort'} or
-- {status:'abstained', reason}. Page outputs cover ALL cohort members —
-- groups AND singletons (DECISION-A: singletons are parent-owned too) — a
-- deliberate asymmetry vs the 'curated_title' kind, which writes multi-item
-- group members only (DECISION-O). Both kinds are write-once per
-- (cohort_run_id, output_kind) with kind isolation enforced by the SQL
-- predicates, so one run can hold both sets independently. NO DDL change:
-- output_kind is already free-form and the UNIQUE index already spans it.
-- v6 (issue #30 PR4 C1): adds the nullable `product_type_outcome` column to
-- `classification_cohort_runs` (the PR4 Execution Product Type outcome marker:
-- 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained'; NULL
-- until PR4 resolves it — abstain/conflict deliberately leave the execution
-- id/confidence NULL) plus the `classification_proposal_dependencies` table
-- (PR4 dependency metadata: every `field_assignment` proposal a member
-- pipeline creates under a coherent cohort execution type gets one
-- dependency row keyed off the effective type — PR5 hardening refined this
-- to proposal-accurate separate kinds (`execution_product_type` vs
-- `reviewed_product_type`); no recompute/invalidation machinery yet, that
-- is PR6+).
-- Fresh installs read the FINAL v7 shape directly from this file; existing
-- databases are converged in runMigrations(): marker-'5' databases run
-- db.exec(cohortSql) (idempotent — creates the dependency table + indexes)
-- and bump to '6', and the PRAGMA-guarded `product_type_outcome` ALTER lives
-- OUTSIDE the version gate (precedent: the `evidence_snapshot_id` block) so
-- pre-C1 '5' databases converge. Existing run rows keep NULL placeholders —
-- no backfill required (historical runs predate execution types).
-- v4 (issue #31 cleanup F3): execution metadata (`started_at`/`completed_at`)
-- is REMOVED from curation_cohorts. The candidate cohort row is a candidate
-- family record only; execution timestamps are owned solely by
-- `classification_cohort_runs`. Fresh installs read the FINAL v4 shape
-- directly from this file; existing databases are rebuilt hop-by-hop in
-- runMigrations() (v3 → v4 drops the two columns).
-- v5 (issue #30 PR3 M1 + M2): adds `classification_cohort_runs` — the parent
-- cohort run that owns the execution lifecycle AND the claim lease — plus the
-- content-addressed `classification_cohort_snapshots` table (M2) holding the
-- frozen execution-evidence projection. `classification_cohort_runs`
-- references its snapshot via `evidence_snapshot_id` (nullable while
-- `freezing`). Fresh installs write marker '5'; marker-'4' databases run
-- db.exec(cohortSql) (idempotent) and bump to '5'. Pre-M2 marker-'5'
-- databases receive the snapshots table via the idempotent OUTSIDE-the-gate
-- block in runMigrations(). The candidate cohort row stays candidate-only.
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
-- classification_cohort_snapshots (issue #30, PR3 M2; cohort schema v5)
--
-- Content-addressed store of the frozen execution-evidence projection. One
-- row per distinct projection payload: `snapshot_hash` is the canonical
-- digest (H2) over the versioned payload_json, so identical payloads dedupe
-- to the same row (UNIQUE(workspace_id, snapshot_hash)). The projection
-- version ('execution-evidence-v1') lets the projection schema evolve without
-- silently reinterpreting historical snapshots. A cohort run row references
-- the persisted snapshot via evidence_snapshot_id (nullable while freezing).
CREATE TABLE IF NOT EXISTS classification_cohort_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  snapshot_hash TEXT NOT NULL,          -- H2 digest over payload_json (content-addressed)
  snapshot_kind TEXT NOT NULL DEFAULT 'evidence' CHECK (snapshot_kind IN ('evidence')),
  projection_version TEXT NOT NULL,     -- 'execution-evidence-v1'
  payload_json TEXT NOT NULL,           -- versioned execution-evidence projection
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS idx_classification_cohort_snapshots_ws
  ON classification_cohort_snapshots(workspace_id, created_at DESC);

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
-- (NULL until PR4 writes them once). product_type_outcome (v6, PR4 C1) is
-- the PR4 Execution Product Type outcome marker — NULL until PR4 resolves
-- it; abstain/conflict deliberately leave the execution id/confidence NULL
-- and only write the outcome. No FK on execution_product_type_id (product
-- types are config/bundle-derived; `target_id` precedent is FK-free) and no
-- NOT NULL after completion (would break abstain/conflict runs).
-- evidence_snapshot_id references the persisted
-- classification_cohort_snapshots row (M2) whose payload produced
-- evidence_snapshot_hash; both are NULL while freezing. config_snapshot_id/
-- hash, page_import_id/hash and model_policy_digest are nullable mirrors of
-- the per-SKU classification_runs authority columns (frozen by the freeze
-- service). The hash-required CHECK only requires the two mandatory evidence
-- hashes before a run may LEAVE `freezing`.
CREATE TABLE IF NOT EXISTS classification_cohort_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
  candidate_membership_hash TEXT NOT NULL,  -- frozen cohort.membership_hash at claim (H1)
  final_membership_hash TEXT,               -- PR4 (write-once); NULL until then
  evidence_snapshot_hash TEXT,              -- H2 digest; NULL while freezing
  evidence_snapshot_id TEXT REFERENCES classification_cohort_snapshots(id),  -- M2: persisted snapshot ref (NULL while freezing)
  config_snapshot_id TEXT REFERENCES classification_config_snapshots(id),  -- H3 authority ref (nullable mirror)
  config_snapshot_hash TEXT,
  page_import_id TEXT REFERENCES page_imports(id),  -- H4 authority ref (nullable mirror)
  page_import_hash TEXT,
  model_policy_digest TEXT,                 -- H5 unbound model-execution digest (nullable mirror)
  execution_product_type_id TEXT,           -- PR4 placeholder (no FK; config/bundle-derived id)
  product_type_confidence REAL CHECK (product_type_confidence IS NULL OR (product_type_confidence >= 0 AND product_type_confidence <= 1)),
  -- PR4 C1 (v6): Execution Product Type outcome marker. NULL until PR4
  -- resolves it; abstain/conflict write the outcome while id/confidence stay
  -- NULL. Queryable run-row state (architecture-report §8 DECISION-F).
  product_type_outcome TEXT CHECK (product_type_outcome IS NULL OR product_type_outcome IN ('coherent','coherent_with_abstentions','conflicted','abstained')),
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

-- ════════════════════════════════════════════════════════════════════════════
-- classification_proposal_dependencies (issue #30, PR4 C1; cohort schema v6)
--
-- PR4 dependency metadata (architecture-report §6): when a member SKU run
-- executes under a coherent cohort Execution Product Type, the member's
-- `field_assignment` proposals are stamped with ONE dependency row:
--   dependency_kind       = 'execution_product_type'
--   dependency_target_id  = the run's execution_product_type_id at proposal creation
--   dependency_value_hash = hashCanonicalJson({executionProductTypeId, productTypeConfidence})
-- PR5 hardening (issue #30 P2) adds the reviewed-source kind for members whose
-- effective Curation Product Type came from a reviewed Primary Product Type:
--   dependency_kind       = 'reviewed_product_type'
--   dependency_target_id  = the reviewed (accepted) Primary Product Type id
--   dependency_value_hash = hashCanonicalJson({reviewedProductTypeId})
-- ONLY `field_assignment` proposals are stamped — `primary_product_type` /
-- `category_page` proposals are not downstream of the effective type (the
-- type proposal is proposed from member evidence; Category Page authority is
-- review-only until PR7). The hash is the future invalidation key
-- (PR5/PR9/PR11): if the effective Product Type changes, affected downstream
-- proposals become stale and are recomputed or invalidated. PR4 RECORDS
-- metadata only — no staleness recompute, no invalidation sweep, no promotion
-- consumption. Written in the same member-projection atomic commit as the
-- proposals they reference.
--
-- proposal_id has a real FK (ON DELETE CASCADE): deleting a proposal removes
-- its dependency metadata. dependency_target_id has NO FK (product types are
-- config/bundle-derived; `target_id` precedent is FK-free).
CREATE TABLE IF NOT EXISTS classification_proposal_dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
  dependency_kind TEXT NOT NULL,            -- 'execution_product_type' | 'reviewed_product_type' (PR4 + PR5 hardening P2)
  dependency_target_id TEXT NOT NULL,       -- effective (execution or reviewed) Product Type id at proposal creation
  dependency_value_hash TEXT NOT NULL,      -- hashCanonicalJson({executionProductTypeId, productTypeConfidence}) | hashCanonicalJson({reviewedProductTypeId})
  created_at TEXT NOT NULL
);

-- Supporting lookup indexes (v6)
CREATE INDEX IF NOT EXISTS idx_classification_proposal_dependencies_proposal
  ON classification_proposal_dependencies(proposal_id);
CREATE INDEX IF NOT EXISTS idx_classification_proposal_dependencies_target
  ON classification_proposal_dependencies(dependency_target_id);
-- PR4 review fix: one dependency row per (proposal, kind). The member commit
-- stamps every `field_assignment` proposal row belonging to the child run
-- (including rows persisted by a pre-crash attempt) via an idempotent
-- check-then-insert; this unique index is the race-safe backstop that makes
-- a re-stamp a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_proposal_dependencies_unique
  ON classification_proposal_dependencies(proposal_id, dependency_kind);

-- ════════════════════════════════════════════════════════════════════════════
-- classification_cohort_outputs (issue #30, PR6 C1; cohort schema v7)
--
-- Durable cohort-run outputs (architecture-report §2.1). ONE row per
-- (cohort_run_id, output_kind, product_sku). The kind set starts with
-- 'curated_title' (PR6); PR7 adds 'coordinated_page'. Historical outputs are
-- IMMUTABLE: there is no UPDATE path — a new cohort revision is a NEW run id,
-- so superseding the parent run (which leaves its outputs in place)
-- automatically produces NEW output rows under the new run. output_kind is a
-- free-form string mirroring the classification_proposal_dependencies.
-- dependency_kind precedent (no CHECK — SQLite cannot alter a CHECK without a
-- table rebuild, and PR7 must extend the kind set). Validated by the zod
-- schema + repo enum. input_hash is the canonical title input hash
-- (workstream 2) — redundant across members of one run but keeps every row
-- independently auditable and makes the completeness+hash check a single
-- query. model_call_id is a nullable soft ref to the audited
-- classification_model_calls id when the title came from the LLM (null for
-- deterministic fallback). No FK on product_sku (member SKUs are onboarding
-- keys, mirroring the FK-free dependency_target_id precedent). No
-- superseded_at: outputs belong to the run; run supersession is the lifecycle
-- (supersedeCohortRun sets status='superseded' on the run) — old output rows
-- are never mutated and never deleted by supersession.
CREATE TABLE IF NOT EXISTS classification_cohort_outputs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  cohort_run_id TEXT NOT NULL REFERENCES classification_cohort_runs(id) ON DELETE CASCADE,
  output_kind TEXT NOT NULL,                  -- 'curated_title' (PR6); 'coordinated_page' (PR7)
  product_sku TEXT NOT NULL,                  -- member onboarding key (onboarding_items.upc is NOT NULL)
  input_hash TEXT NOT NULL,                   -- canonical title input hash (workstream 2) — per-row audit
  output_value_json TEXT NOT NULL,            -- {"title": "...", "source": "llm_cohort"|"cohort_fallback"}
  model_call_id TEXT,                         -- audited callId when source='llm_cohort' (soft ref; null for fallback)
  created_at TEXT NOT NULL,
  UNIQUE (cohort_run_id, output_kind, product_sku)
);

CREATE INDEX IF NOT EXISTS idx_classification_cohort_outputs_run
  ON classification_cohort_outputs(cohort_run_id, output_kind, created_at);
