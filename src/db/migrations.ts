import { getDb } from './connection';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

const SCHEMA_PATH = path.resolve(import.meta.dirname, 'schema.sql');
const ONBOARDING_MIGRATION_PATH = path.resolve(import.meta.dirname, 'onboarding-migration.sql');
const CLASSIFICATION_MIGRATION_PATH = path.resolve(import.meta.dirname, 'classification-migration.sql');
const STAGE_PIPELINE_MIGRATION_PATH = path.resolve(import.meta.dirname, 'stage-pipeline-migration.sql');

export function runMigrations(): void {
  const db = getDb();
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);

  // Run onboarding migration if not already applied
  const onboardingVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('onboarding_schema_version') as
    | { value: string }
    | undefined;
  if (!onboardingVersion) {
    const onboardingSql = fs.readFileSync(ONBOARDING_MIGRATION_PATH, 'utf-8');
    db.exec(onboardingSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_schema_version', '1');");
  }

  // Ensure product_index has parent_sku and search columns (migration support for existing databases)
  try {
    const columns = db.query('PRAGMA table_info(product_index)').all() as Array<{ name: string }>;
    if (!columns.some(col => col.name === 'parent_sku')) {
      db.exec('ALTER TABLE product_index ADD COLUMN parent_sku TEXT REFERENCES product_index(sku);');
    }
    if (!columns.some(col => col.name === 'description')) {
      db.exec('ALTER TABLE product_index ADD COLUMN description TEXT;');
    }
    if (!columns.some(col => col.name === 'search_keywords')) {
      db.exec('ALTER TABLE product_index ADD COLUMN search_keywords TEXT;');
    }
    if (!columns.some(col => col.name === 'custom_fields')) {
      db.exec('ALTER TABLE product_index ADD COLUMN custom_fields TEXT;');
    }
  } catch (e) {
    console.error('Failed to update product_index columns:', e);
  }

  // Ensure onboarding_items table has curation_data_json and expected_name columns
  try {
    const columns = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'curation_data_json')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN curation_data_json TEXT;');
    }
    if (columns.length > 0 && !columns.some(col => col.name === 'expected_name')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN expected_name TEXT;');
    }
    if (columns.length > 0 && !columns.some(col => col.name === 'coordinated_title')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN coordinated_title TEXT;');
    }
  } catch (e) {
    console.error('Failed to update onboarding_items columns:', e);
  }

  // Ensure extractor_profiles table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extractor_profiles (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        title_selector TEXT,
        price_selector TEXT,
        description_selector TEXT,
        brand_selector TEXT,
        images_selector TEXT,
        sitemap_product_url_pattern TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_extractor_profiles_domain ON extractor_profiles(domain);
    `);
  } catch (e) {
    console.error('Failed to create extractor_profiles table:', e);
  }

  // Ensure extractor_profiles has sitemap_product_url_pattern column (migration
  // support for existing databases created before the column was added).
  try {
    const columns = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'sitemap_product_url_pattern')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN sitemap_product_url_pattern TEXT;');
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has shopify_json_path column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'shopify_json_path')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN shopify_json_path INTEGER NOT NULL DEFAULT 0;');
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has custom_selectors_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'custom_selectors_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN custom_selectors_json TEXT DEFAULT '{}';");
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has title_optional_selectors_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'title_optional_selectors_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN title_optional_selectors_json TEXT DEFAULT '[]';");
      console.log('[Migrations] Added title_optional_selectors_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add title_optional_selectors_json column:', e);
  }

  // Ensure domain_status table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_status (
        domain TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        reason TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_domain_status_status ON domain_status(status);
    `);
  } catch (e) {
    console.error('Failed to create domain_status table:', e);
  }

  // Ensure profile_generations table exists (audit trail for LLM-generated
  // selector profile proposals; one row per generation attempt).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generations (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        source_url TEXT NOT NULL,
        expected_name TEXT,
        brand_hint TEXT,
        selectors_json TEXT NOT NULL,
        field_samples_json TEXT,
        validation_json TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        llm_provider TEXT,
        llm_model TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        promoted_at TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_domain ON profile_generations(domain);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_status ON profile_generations(status);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_domain_status ON profile_generations(domain, status);
    `);
  } catch (e) {
    console.error('Failed to create profile_generations table:', e);
  }

  // Profile generation revisions — versioned history of selector proposals
  // tied to a parent `profile_generations` row. Each revision may carry
  // its own feedback/selectors/validation and is created either by the
  // generator (initial_generation) or by an operator-driven structured
  // revision request (manager_feedback / manual_css / system_validation).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_revisions (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        parent_revision_id TEXT REFERENCES profile_generation_revisions(id),
        source TEXT NOT NULL,
        feedback_json TEXT,
        selectors_json TEXT NOT NULL,
        field_samples_json TEXT,
        validation_summary_json TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        llm_task TEXT,
        llm_provider TEXT,
        llm_model TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_generation
        ON profile_generation_revisions(generation_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_parent
        ON profile_generation_revisions(parent_revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_status
        ON profile_generation_revisions(status);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_revisions table:', e);
  }

  // Per-revision, per-field, per-sample validation evidence. Records the
  // extracted value (or image previews) plus any warnings the governance
  // service surfaced. Status values: pass | warning | fail.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_validation_results (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES profile_generation_revisions(id) ON DELETE CASCADE,
        selector_field TEXT NOT NULL,
        sample_url TEXT NOT NULL,
        item_id TEXT,
        expected_name TEXT,
        brand_hint TEXT,
        extracted_value_json TEXT,
        image_previews_json TEXT,
        warnings_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_validation_results_revision
        ON profile_generation_validation_results(revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_validation_results_revision_field
        ON profile_generation_validation_results(revision_id, selector_field);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_validation_results table:', e);
  }

  // Per-field approval / rejection / rollback history. One row per operator
  // decision. Powers the governance UI's per-field approval semantics and
  // rollback surface; the `previous_selector` column is what rollback
  // restores from.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_field_decisions (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES profile_generation_revisions(id),
        domain TEXT NOT NULL,
        selector_field TEXT NOT NULL,
        decision TEXT NOT NULL,
        previous_selector TEXT,
        proposed_selector TEXT,
        approved_selector TEXT,
        feedback_json TEXT,
        validation_result_ids_json TEXT,
        decided_at TEXT NOT NULL,
        decided_by TEXT,
        notes TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_generation
        ON profile_generation_field_decisions(generation_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_revision
        ON profile_generation_field_decisions(revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_domain_field
        ON profile_generation_field_decisions(domain, selector_field);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_domain_decision
        ON profile_generation_field_decisions(domain, decision);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_field_decisions table:', e);
  }

  // ── Add page_id to product_pages for stable page identity ────────────────
  try {
    const ppCols = db.query('PRAGMA table_info(product_pages)').all() as Array<{ name: string }>;
    if (ppCols.length > 0 && !ppCols.some(col => col.name === 'page_id')) {
      db.exec('ALTER TABLE product_pages ADD COLUMN page_id TEXT REFERENCES page_index(id);');
      console.log('[Migrations] Added page_id column to product_pages.');
    }
    const ppIdx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_product_pages_page_id'").get();
    if (!ppIdx) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_product_pages_page_id ON product_pages(page_id);');
      console.log('[Migrations] Created idx_product_pages_page_id index.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add page_id to product_pages:', e);
  }

  // Task-specific LLM routing. Provider credentials (api_keys) hold the
  // secrets; this table only stores which provider/model each AI task
  // should use. Tasks include `product_name_consolidation`,
  // `profile_generation`, `profile_revision`, `product_curation`, and
  // `category_classification`. Profile tasks require an explicit row
  // (fail-closed) so a missing config never silently falls back to a
  // model the operator did not pick.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_task_configs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url_override TEXT,
        temperature REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_llm_task_configs_task
        ON llm_task_configs(task);
    `);
  } catch (e) {
    console.error('Failed to create llm_task_configs table:', e);
  }

  // Ensure serper_cache table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS serper_cache (
        query TEXT PRIMARY KEY,
        results_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  } catch (e) {
    console.error('Failed to create serper_cache table:', e);
  }

  // Ensure sitemap_cache table exists. Caches the list of URLs discovered in
  // a domain's sitemap.xml (or equivalent) along with a TTL-derived expiry so
  // repeated discovery runs don't re-fetch the same file.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sitemap_cache (
        domain TEXT PRIMARY KEY,
        urls_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_url TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sitemap_cache_domain ON sitemap_cache(domain);
    `);
  } catch (e) {
    console.error('Failed to create sitemap_cache table:', e);
  }

  // Run classification migration if not already applied
  const classificationVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('classification_schema_version') as
    | { value: string }
    | undefined;
  if (!classificationVersion) {
    const classificationSql = fs.readFileSync(CLASSIFICATION_MIGRATION_PATH, 'utf-8');
    db.exec(classificationSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('classification_schema_version', '1');");
  }

  // ── Ensure classification_brands table exists (existing DB migration) ───────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classification_brands (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT DEFAULT '[]',
        old_id_aliases_json TEXT DEFAULT '[]',
        config_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_classification_brands_workspace ON classification_brands(workspace_id);');
  } catch (e) {
    console.error('[Migrations] Failed to create classification_brands table:', e);
  }

  // ── Ensure curation orchestration tables exist (Phase 8A) ─────────────────
  try {
    // curation_runs
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        total_items INTEGER NOT NULL DEFAULT 0,
        completed_items INTEGER NOT NULL DEFAULT 0,
        failed_items INTEGER NOT NULL DEFAULT 0,
        progress_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_workspace ON curation_runs(workspace_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_status ON curation_runs(status);');

    // curation_run_items
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_run_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        onboarding_item_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_run ON curation_run_items(run_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_status ON curation_run_items(status);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_sku ON curation_run_items(sku);');

    // curation_run_groups
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_run_groups (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        group_label TEXT NOT NULL,
        skus_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_groups_run ON curation_run_groups(run_id);');

    // curation_model_calls
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        run_item_id TEXT REFERENCES curation_run_items(id) ON DELETE SET NULL,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_model_calls_run ON curation_model_calls(run_id);');
  } catch (e) {
    console.error('[Migrations] Failed to create curation orchestration tables:', e);
  }

  // ── Migration to expand classification_stage_results CHECK constraint ──────
  //
  // The original CHECK constraint included 6 stage names. After adding
  // name_consolidation, existing databases need the table rebuilt with
  // the expanded constraint. This runs only when needed.
  try {
    const tableInfo = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'classification_stage_results') as { sql: string } | undefined;
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('name_consolidation')) {
      console.log('[Migrations] Expanding classification_stage_results CHECK constraint for name_consolidation...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_stage_results_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
          stage_name TEXT NOT NULL CHECK (stage_name IN ('evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'category_page_proposals', 'product_draft_projection')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
          output_json TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
      `);
      db.exec('INSERT INTO classification_stage_results_new SELECT * FROM classification_stage_results;');
      db.exec('DROP TABLE classification_stage_results;');
      db.exec('ALTER TABLE classification_stage_results_new RENAME TO classification_stage_results;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_stage_results_run ON classification_stage_results(run_id);');
      console.log('[Migrations] classification_stage_results CHECK constraint expanded successfully.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to expand classification_stage_results CHECK constraint:', e);
  }

  // Run stage pipeline migration if not already applied
  const stagePipelineVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('stage_pipeline_schema_version') as
    | { value: string }
    | undefined;
  if (!stagePipelineVersion) {
    const stagePipelineSql = fs.readFileSync(STAGE_PIPELINE_MIGRATION_PATH, 'utf-8');
    db.exec(stagePipelineSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('stage_pipeline_schema_version', '1');");
  }
  // ── Seed category_page_assignment LLM task config ───────────────────────
  //
  // The category_page_assignment task is used by the LLM-first page assignment
  // pipeline (page-assignment-llm.ts). It routes to deepseek-v4-pro, matching
  // the existing category_classification config.
  try {
    const catPageSeeded = db.query('SELECT value FROM app_meta WHERE key = ?').get('category_page_assignment_task_seeded') as
      | { value: string }
      | undefined;
    if (!catPageSeeded) {
      const existing = db.query('SELECT id FROM llm_task_configs WHERE task = ?').get('category_page_assignment') as
        | { id: string }
        | undefined;
      if (!existing) {
        const now = new Date().toISOString();
        const id = randomUUID();
        db.exec(`INSERT INTO llm_task_configs (id, task, provider, model, created_at, updated_at) VALUES ('${id}', 'category_page_assignment', 'deepseek', 'deepseek-v4-pro', '${now}', '${now}')`);
        console.log('[Migrations] Seeded category_page_assignment task config (deepseek-v4-pro).');
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('category_page_assignment_task_seeded', '1');");
    }
  } catch (e) {
    console.error('[Migrations] Failed to seed category_page_assignment task config:', e);
  }

  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    throw new Error('Schema migration did not create app_meta');
  }
}

export function getSchemaVersion(): string {
  const db = getDb();
  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  return row?.value ?? '0';
}
