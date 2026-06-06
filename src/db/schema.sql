-- ShopSite CMS SQLite Schema
-- SQLite is not canonical catalog storage. It is local operational state:
-- setup, indexing, drafts, validation, sync jobs, logs, and drift.

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  git_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bootstrap_status TEXT NOT NULL DEFAULT 'not_started',
  baseline_commit TEXT
);

CREATE TABLE IF NOT EXISTS shopsite_connection (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  cgi_base_url TEXT NOT NULL,
  auth_strategy TEXT NOT NULL DEFAULT 'basic',
  merchant_id TEXT,
  password_secret_ref TEXT,
  last_tested_at TEXT,
  last_test_status TEXT,
  last_test_error TEXT
);

CREATE TABLE IF NOT EXISTS product_index (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  price TEXT,
  inventory_quantity INTEGER,
  primary_image TEXT,
  product_hash TEXT NOT NULL,
  last_approved_commit TEXT,
  last_pulled_remote_hash TEXT,
  last_synced_remote_hash TEXT,
  last_synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'not_synced',
  has_advanced_blocks INTEGER NOT NULL DEFAULT 0,
  has_warnings INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS field_registry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  xml_field TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  data_type TEXT NOT NULL DEFAULT 'string',
  editable INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  ui_group TEXT,
  sample_values_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, xml_field)
);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  base_commit TEXT NOT NULL,
  approved_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS change_set_items (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  sku TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'update',
  draft_json TEXT NOT NULL,
  base_json TEXT,
  draft_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(change_set_id, sku)
);

CREATE TABLE IF NOT EXISTS validation_results (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  field_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  change_set_id TEXT REFERENCES change_sets(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  completed_at TEXT,
  product_count INTEGER DEFAULT 0,
  artifact_path TEXT,
  error_summary TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS sync_job_events (
  id TEXT PRIMARY KEY,
  sync_job_id TEXT NOT NULL REFERENCES sync_jobs(id),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_drift (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  sku TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  local_hash TEXT,
  remote_hash TEXT NOT NULL,
  local_json TEXT,
  remote_json TEXT NOT NULL,
  diff_json TEXT,
  reconcile_change_set_id TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_index_sku ON product_index(sku);
CREATE INDEX IF NOT EXISTS idx_product_index_status ON product_index(status);
CREATE INDEX IF NOT EXISTS idx_change_set_items_change_set ON change_set_items(change_set_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_workspace ON sync_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_remote_drift_workspace ON remote_drift(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id);

INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('app_version', '0.1.0');
