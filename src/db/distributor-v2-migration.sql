-- Multi-Distributor Sourcing V2 schema (ADR 0014).
--
-- Runs under the `distributor_v2_schema_version` gate in src/db/migrations.ts
-- AFTER the existing 13-column `onboarding_evidence_attempts` table is
-- created. This file contains ONLY the new tables (CREATE TABLE IF NOT
-- EXISTS); the PRAGMA-guarded ALTERs that extend pre-existing tables
-- (onboarding_evidence_attempts, onboarding_evidence_conflicts,
-- onboarding_item_evidence_acceptances) live in migrations.ts next to the
-- gate, because SQLite cannot add columns idempotently via CREATE TABLE.
--
-- Contract highlights (see ADR 0014):
-- - `secret_ref` references a server-side secret; configuration_json never
--   carries raw credentials (schema-level recursive rejection).
-- - Evidence attempts are immutable and generation-scoped
--   (`sourcing_generation_id`); retry supersedes the generation.
-- - Conflicts persist durably with candidates; one OPEN conflict per
--   (item, field, generation) enforced by a partial unique index.
-- - Acceptances are normalized relational rows; after this migration they
--   are 100% authoritative (empty = zero acceptances, never legacy JSON).

CREATE TABLE IF NOT EXISTS sourcing_generations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'superseded', 'failed')),
  supersedes_id TEXT,
  reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distributors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distributor_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  distributor_id TEXT NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('api', 'ftp_catalog', 'csv', 'html_scraper', 'legacy_adapter')),
  secret_ref TEXT,
  configuration_json TEXT DEFAULT '{}',
  authority_policy_json TEXT DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distributor_catalog_snapshots (
  id TEXT PRIMARY KEY,
  distributor_connection_id TEXT NOT NULL REFERENCES distributor_connections(id) ON DELETE CASCADE,
  external_version TEXT,
  content_hash TEXT,
  observed_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_evidence_conflicts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('hard', 'soft')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  sourcing_generation_id TEXT,
  resolution_type TEXT,
  resolved_value TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_evidence_conflict_candidates (
  id TEXT PRIMARY KEY,
  conflict_id TEXT NOT NULL REFERENCES onboarding_evidence_conflicts(id) ON DELETE CASCADE,
  evidence_attempt_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_item_evidence_acceptances (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  evidence_attempt_id TEXT NOT NULL,
  sourcing_generation_id TEXT,
  accepted_by TEXT NOT NULL DEFAULT 'system',
  accepted_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, evidence_attempt_id)
);

CREATE TABLE IF NOT EXISTS brand_advisory_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  brand TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, brand)
);

CREATE INDEX IF NOT EXISTS idx_sourcing_generations_item ON sourcing_generations(item_id);
CREATE INDEX IF NOT EXISTS idx_distributor_connections_workspace ON distributor_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_distributor_connections_distributor ON distributor_connections(distributor_id);
CREATE INDEX IF NOT EXISTS idx_distributor_catalog_snapshots_conn ON distributor_catalog_snapshots(distributor_connection_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_conflicts_item ON onboarding_evidence_conflicts(item_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_conflicts_status ON onboarding_evidence_conflicts(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_conflicts_generation ON onboarding_evidence_conflicts(sourcing_generation_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_conflict_candidates_conflict ON onboarding_evidence_conflict_candidates(conflict_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_item_evidence_acceptances_item ON onboarding_item_evidence_acceptances(item_id);
CREATE INDEX IF NOT EXISTS idx_brand_advisory_profiles_workspace ON brand_advisory_profiles(workspace_id);
