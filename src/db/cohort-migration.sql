-- Cohort Migration (issue #30, PR1)
-- Adds durable candidate product-family tables for cohort-centric Curation.
-- Version-gated by app_meta key 'curation_cohort_schema_version' in
-- runMigrations() (src/db/migrations.ts). Uses CREATE TABLE IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS for idempotence. Historical cohort rows are
-- superseded, never mutated; a superseded row is no longer the active cohort.

-- Candidate curation cohort: a versioned candidate family of onboarding items
-- grouped by a deterministic grouping algorithm (grouping_version
-- 'product-family-v1').
CREATE TABLE IF NOT EXISTS curation_cohorts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  batch_id TEXT NOT NULL REFERENCES onboarding_batches(id),
  group_key TEXT NOT NULL,          -- deterministic brand + normalized name stem key
  group_label TEXT NOT NULL,
  grouping_version TEXT NOT NULL,   -- 'product-family-v1'
  membership_hash TEXT NOT NULL,    -- order-insensitive canonical hash
  status TEXT NOT NULL CHECK (status IN ('forming','waiting','ready','running','completed','failed','conflicted','superseded')),
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
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
