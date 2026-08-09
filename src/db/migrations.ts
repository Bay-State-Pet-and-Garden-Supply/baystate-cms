import { getDb } from './connection';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';

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

  // Ensure extractor_profiles has variant_selection_strategy_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'variant_selection_strategy_json')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN variant_selection_strategy_json TEXT;');
      console.log('[Migrations] Added variant_selection_strategy_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add variant_selection_strategy_json column:', e);
  }

  // Ensure extractor_profiles has custom_selector_metadata_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'custom_selector_metadata_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN custom_selector_metadata_json TEXT DEFAULT '{}';");
      console.log('[Migrations] Added custom_selector_metadata_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add custom_selector_metadata_json column:', e);
  }

  // Ensure extractor_profiles has runtime column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'runtime')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN runtime TEXT NOT NULL DEFAULT 'rendered';");
      console.log('[Migrations] Added runtime column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add runtime column:', e);
  }

  // Ensure onboarding_sources has metadata_json column
  try {
    const columns = db.query('PRAGMA table_info(onboarding_sources)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'metadata_json')) {
      db.exec('ALTER TABLE onboarding_sources ADD COLUMN metadata_json TEXT;');
      console.log('[Migrations] Added metadata_json column to onboarding_sources.');
    }
  } catch (e) {
    console.error('Failed to update onboarding_sources columns:', e);
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

  // Ensure catalog_health_proposals table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_health_proposals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        affected_skus TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'deterministic',
        status TEXT NOT NULL DEFAULT 'proposed',
        change_set_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_ws ON catalog_health_proposals(workspace_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_status ON catalog_health_proposals(status);
    `);
  } catch (e) {
    console.error('Failed to create catalog_health_proposals table:', e);
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

  try {
    db.exec('ALTER TABLE llm_task_configs ADD COLUMN reasoning_effort TEXT');
  } catch { /* column already exists */ }

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
  // ── Clean up product_draft_projection noise proposals ───────────────────
  //
  // The product_draft_projection stage previously emitted a fake
  // field_assignment proposal with targetId='product_draft_projection'.
  // These proposals are noise — they are never consumed by promotion or
  // review, but they pollute the classification_proposals table and
  // confuse downstream queries. Remove them in a one-time cleanup.
  try {
    const draftProjCleanup = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_draft_projection_cleanup') as
      | { value: string }
      | undefined;
    if (!draftProjCleanup) {
      const deleted = db.query("DELETE FROM classification_proposals WHERE target_id = 'product_draft_projection'").run();
      console.log(`[Migrations] Cleaned up ${deleted.changes} product_draft_projection proposals.`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_draft_projection_cleanup', '1');");
    }
  } catch (e) {
    console.error('[Migrations] product_draft_projection cleanup failed:', e);
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

  // Ensure store_manager_chat_history table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_chat_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    
    // Add columns if they do not exist
    try {
      db.exec("ALTER TABLE store_manager_chat_history ADD COLUMN thread_id TEXT;");
    } catch { /* already exists */ }
    try {
      db.exec("ALTER TABLE store_manager_chat_history ADD COLUMN thread_title TEXT;");
    } catch { /* already exists */ }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_ws 
        ON store_manager_chat_history(workspace_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_thread 
        ON store_manager_chat_history(thread_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_created 
        ON store_manager_chat_history(created_at);
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create store_manager_chat_history table:', e);
  }

  // ── Run curation V2 migration if not already applied ──────────────────────
  //
  // Adds columns for atomic item claims, run-scoped proposal tracking,
  // cohort snapshots, evidence denormalization, and refresh-staleness columns.
  // Each ALTER TABLE ADD COLUMN is wrapped in a PRAGMA column-existence guard
  // so the migration is idempotent in all scenarios.
  try {
    const curationV2Version = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_v2_schema_version') as
      | { value: string }
      | undefined;
    if (!curationV2Version) {
      console.log('[Migrations] Running curation V2 migration...');

      // Helper: add a column only if it does not already exist
      const cols = (tbl: string) => db.query('PRAGMA table_info(' + tbl + ')').all() as Array<{ name: string }>;
      const addCol = (tbl: string, col: string, def: string) => {
        if (!cols(tbl).some((c: { name: string }) => c.name === col)) {
          db.exec('ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added ' + tbl + '.' + col);
        }
      };

      // 1. onboarding_items — worker claim columns
      addCol('onboarding_items', 'claimed_by', 'TEXT');
      addCol('onboarding_items', 'claimed_at', 'TEXT');

      // 2. classification_proposals — evidence denormalization, staleness, metadata
      addCol('classification_proposals', 'evidence_ids_json', "TEXT DEFAULT '[]'");
      addCol('classification_proposals', 'stale_at', 'TEXT');
      addCol('classification_proposals', 'superseded_by_run_id', 'TEXT REFERENCES classification_runs(id)');
      addCol('classification_proposals', 'metadata_json', "TEXT DEFAULT '{}'");

      // 3. curation_run_items — link to per-SKU ClassificationRun
      addCol('curation_run_items', 'classification_run_id', 'TEXT REFERENCES classification_runs(id) ON DELETE SET NULL');

      // 4. curation_runs — batch link, curation mode, config snapshot, snapshots
      addCol('curation_runs', 'batch_id', 'TEXT REFERENCES onboarding_batches(id)');
      addCol('curation_runs', 'curation_mode', "TEXT NOT NULL DEFAULT 'modular' CHECK (curation_mode IN ('modular', 'legacy'))");
      addCol('curation_runs', 'config_snapshot_id_v2', 'TEXT REFERENCES classification_config_snapshots(id)');
      addCol('curation_runs', 'input_snapshot_json', 'TEXT');
      addCol('curation_runs', 'cohort_snapshot_json', 'TEXT');

      // 5. curation_model_calls — cost observability
      addCol('curation_model_calls', 'estimated_cost_usd', 'REAL');

      // 6. New indexes (CREATE INDEX IF NOT EXISTS is inherently idempotent)
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_run_sku_status ON classification_proposals(run_id, product_sku, status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_items_stage_status_claimed ON onboarding_items(stage, stage_status, claimed_by)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_batch ON curation_runs(batch_id)');

      db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_v2_schema_version', '1');");
      console.log('[Migrations] Curation V2 migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Curation V2 migration failed:', e);
  }

  // Classification is item-centric: at most one live run may own an item.
  // Keep this outside the version guard so databases that already recorded
  // curation_v2_schema_version still receive the concurrency constraint.
  // If historical duplicate running rows exist, index creation fails closed
  // instead of silently choosing a winner.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_runs_one_running_item
    ON classification_runs(onboarding_item_id)
    WHERE onboarding_item_id IS NOT NULL AND status = 'running'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_remote_drift_ws_sku_status
    ON remote_drift(workspace_id, sku, status)
  `);

  // ── Catalog Classification Migration ──────────────────────────────────────
  //
  // Adds source_kind and source_product_hash columns to classification_runs,
  // expands the classification_evidence CHECK constraint to include 'catalog_product',
  // and creates new indexes for catalog-run concurrency and lookup.
  try {
    const catalogClassVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('catalog_classification_schema_version') as
      | { value: string }
      | undefined;
    if (!catalogClassVersion) {
      console.log('[Migrations] Running catalog classification migration...');

      // Add columns to classification_runs
      const runCols = db.query('PRAGMA table_info(classification_runs)').all() as Array<{ name: string }>;
      if (!runCols.some(c => c.name === 'source_kind')) {
        db.exec("ALTER TABLE classification_runs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'onboarding' CHECK (source_kind IN ('onboarding', 'catalog_product'))");
      }
      if (!runCols.some(c => c.name === 'source_product_hash')) {
        db.exec('ALTER TABLE classification_runs ADD COLUMN source_product_hash TEXT');
      }

      // Rebuild classification_evidence to update CHECK constraint for source.
      // Foreign keys are temporarily disabled so classification_proposal_evidence
      // (which references classification_evidence) survives the table swap.
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        // ── Clean up orphaned rows first ───────────────────────────────
        // Rows whose run_id doesn't exist in classification_runs are dead
        // data from prior operations that ran with foreign_keys=OFF.
        const orphanedEvidence = db.query(
          "SELECT COUNT(*) as cnt FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };
        const orphanedStageResults = db.query(
          "SELECT COUNT(*) as cnt FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };
        const orphanedProposals = db.query(
          "SELECT COUNT(*) as cnt FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };

        if (orphanedEvidence.cnt > 0) {
          db.run('DELETE FROM classification_proposal_evidence WHERE evidence_id IN (SELECT id FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedEvidence.cnt} orphaned classification_evidence row(s).`);
        }
        if (orphanedStageResults.cnt > 0) {
          db.run('DELETE FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedStageResults.cnt} orphaned classification_stage_results row(s).`);
        }
        if (orphanedProposals.cnt > 0) {
          db.run('DELETE FROM classification_proposal_evidence WHERE proposal_id IN (SELECT id FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_proposal_decisions WHERE proposal_id IN (SELECT id FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedProposals.cnt} orphaned classification_proposals row(s).`);
        }

        // ── Rebuild evidence table with updated CHECK ──────────────────
        db.transaction(() => {
          // Create new table with updated CHECK
          db.exec(`CREATE TABLE classification_evidence_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
          onboarding_item_id TEXT,
          product_sku TEXT NOT NULL,
          stage_name TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('spreadsheet', 'official_product_page', 'third_party_page', 'visual_product_evidence', 'page_context', 'approved_product_example', 'catalog_manager_guidance', 'catalog_product')),
          reliability TEXT NOT NULL DEFAULT 'unknown' CHECK (reliability IN ('high', 'medium', 'low', 'conflicting', 'unknown')),
          attribute_id TEXT,
          source_url TEXT,
          source_field TEXT,
          snippet TEXT,
          value_json TEXT,
          metadata_json TEXT,
          snapshot_json TEXT,
          retention_expires_at TEXT,
          created_at TEXT NOT NULL
        )`);
          // Copy data
          db.exec('INSERT INTO classification_evidence_new SELECT * FROM classification_evidence');
          // Drop old, rename new
          db.exec('DROP TABLE classification_evidence');
          db.exec('ALTER TABLE classification_evidence_new RENAME TO classification_evidence');
          // Recreate indexes
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_run ON classification_evidence(run_id)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source ON classification_evidence(product_sku, source)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product ON classification_evidence(product_sku)');
        })();
      } finally {
        // Always restore foreign key enforcement, even if the rebuild fails
        db.exec('PRAGMA foreign_keys = ON');
      }

      // Create new indexes
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_runs_one_running_catalog ON classification_runs(workspace_id, product_sku) WHERE source_kind = \'catalog_product\' AND status = \'running\'');
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_runs_workspace_sku_source_time ON classification_runs(workspace_id, product_sku, source_kind, started_at DESC)');

      // Verify the table rebuild was correct by checking row counts match.
      // Pre-existing FK violations (e.g. evidence rows with orphaned run_ids)
      // are logged as warnings but must NOT block the migration — they predate
      // this schema update.
      const evidenceFkCheck = db.query("PRAGMA foreign_key_check('classification_evidence')").all();
      if (evidenceFkCheck.length > 0) {
        console.warn(`[Migrations] ${evidenceFkCheck.length} pre-existing FK violations in classification_evidence (not caused by this migration):`, evidenceFkCheck.slice(0, 5));
      }

      const allFkCheck = db.query('PRAGMA foreign_key_check').all() as Array<{table: string}>;
      const otherViolations = allFkCheck.filter(v => v.table !== 'classification_evidence');
      if (otherViolations.length > 0) {
        console.warn(`[Migrations] ${otherViolations.length} pre-existing FK violations in other tables:`, otherViolations.slice(0, 5));
      }

      db.exec("INSERT INTO app_meta (key, value) VALUES ('catalog_classification_schema_version', '1')");
      console.log('[Migrations] Catalog classification migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Catalog classification migration failed:', e);
  }

  // ── Rename shopsite_connection to connection ────────────────────────────────
  // schema.sql creates `connection` first (CREATE IF NOT EXISTS). On an upgrade
  // DB that still has shopsite_connection, a plain RENAME collides with the
  // empty destination. Copy legacy rows into connection, then drop the old
  // table, and only then mark the migration complete.
  try {
    const connectionRenameVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('connection_rename_schema_version') as
      | { value: string }
      | undefined;
    if (!connectionRenameVersion) {
      console.log('[Migrations] Running connection table rename migration...');
      db.transaction(() => {
        const oldTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='shopsite_connection'").all();
        const newTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'").all();

        if (oldTables.length > 0 && newTables.length === 0) {
          db.exec('ALTER TABLE shopsite_connection RENAME TO connection;');
        } else if (oldTables.length > 0 && newTables.length > 0) {
          // Destination already exists (fresh schema.sql). Merge any missing
          // legacy rows by primary key, preferring already-present connection
          // rows for the same id. Also skip legacy rows whose workspace_id is
          // already represented in connection under a different id.
          db.exec(`
            INSERT INTO connection (
              id, workspace_id, cgi_base_url, auth_strategy, merchant_id,
              password_secret_ref, last_tested_at, last_test_status, last_test_error
            )
            SELECT
              old.id, old.workspace_id, old.cgi_base_url, old.auth_strategy, old.merchant_id,
              old.password_secret_ref, old.last_tested_at, old.last_test_status, old.last_test_error
            FROM shopsite_connection AS old
            WHERE NOT EXISTS (SELECT 1 FROM connection AS cur WHERE cur.id = old.id)
              AND NOT EXISTS (SELECT 1 FROM connection AS cur WHERE cur.workspace_id = old.workspace_id)
          `);
          db.exec('DROP TABLE shopsite_connection;');
        }

        const stillOld = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='shopsite_connection'").all();
        if (stillOld.length > 0) {
          throw new Error('shopsite_connection still exists after connection rename migration');
        }
        const hasConnection = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'").all();
        if (hasConnection.length === 0) {
          throw new Error('connection table missing after connection rename migration');
        }

        db.exec("INSERT INTO app_meta (key, value) VALUES ('connection_rename_schema_version', '1');");
      })();
      console.log('[Migrations] Connection table rename migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Connection table rename migration failed:', e);
    throw e;
  }

  // ── Decision Revision Migration ─────────────────────────────────────────────
  // decision_key stores an explicit user-action token. Its uniqueness spans
  // historical and live rows so a delayed retry can never reactivate an older
  // action. This repair runs on every startup (even with a version marker) to
  // fail closed if a partial deployment left the index missing or malformed.
  try {
    db.transaction(() => {
      const decCols = db.query('PRAGMA table_info(classification_proposal_decisions)').all() as Array<{ name: string }>;
      const addDecCol = (col: string, def: string) => {
        if (!decCols.some(c => c.name === col)) {
          db.exec('ALTER TABLE classification_proposal_decisions ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added classification_proposal_decisions.' + col);
        }
      };

      addDecCol('revised_value_json', 'TEXT');
      addDecCol('revised_target_id', 'TEXT');
      addDecCol('has_revised_target', 'INTEGER NOT NULL DEFAULT 0');
      addDecCol('decision_key', 'TEXT');
      addDecCol('superseded_at', 'TEXT');

      // Backfill presence for rows that already stored a non-null revised target
      // before the explicit presence column existed.
      db.exec(`UPDATE classification_proposal_decisions
        SET has_revised_target = 1
        WHERE revised_target_id IS NOT NULL AND COALESCE(has_revised_target, 0) = 0`);

      // A partial version of the old live-only index could contain duplicate
      // keys on superseded rows. Keep the earliest action-token owner and clear
      // only duplicate tokens; decision rows/history remain intact.
      db.exec('DROP INDEX IF EXISTS idx_classification_decisions_key');
      const duplicateKeys = db.query(
        `SELECT decision_key FROM classification_proposal_decisions
         WHERE decision_key IS NOT NULL
         GROUP BY decision_key HAVING COUNT(*) > 1`,
      ).all() as Array<{ decision_key: string }>;
      for (const { decision_key: key } of duplicateKeys) {
        const canonical = db.query(
          `SELECT id FROM classification_proposal_decisions
           WHERE decision_key = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get(key) as { id: string } | undefined;
        if (!canonical) throw new Error(`Unable to reconcile duplicate decision token ${key}`);
        db.run(
          'UPDATE classification_proposal_decisions SET decision_key = NULL WHERE decision_key = ? AND id != ?',
          [key, canonical.id],
        );
      }

      db.exec(`CREATE UNIQUE INDEX idx_classification_decisions_key
        ON classification_proposal_decisions(decision_key)
        WHERE decision_key IS NOT NULL`);

      const indexSql = db.query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'",
      ).get() as { sql: string } | undefined;
      if (!indexSql || /superseded_at/i.test(indexSql.sql)) {
        throw new Error('Decision action-token uniqueness index was not created correctly.');
      }

      db.run(
        `INSERT INTO app_meta (key, value) VALUES ('decision_revision_schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
    })();
    console.log('[Migrations] Decision revision migration verified.');
  } catch (e) {
    console.error('[Migrations] Decision revision migration failed:', e);
    throw e;
  }

  // ── Benchmark / Evaluation Migration ─────────────────────────────────────────
  try {
    db.transaction(() => {
      // Legacy (pre-v2) shape. Kept so upgrade DBs that predate schema.sql's
      // benchmark tables still receive the old columns; the guarded
      // benchmark_v2 migration below adds the lifecycle/immutability columns.
      db.exec(`
        CREATE TABLE IF NOT EXISTS benchmark_datasets (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          holdout_strategy TEXT NOT NULL DEFAULT 'product_family',
          split_seed INTEGER NOT NULL,
          total_examples INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS benchmark_examples (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
          product_sku TEXT NOT NULL,
          product_family_id TEXT,
          split_group TEXT NOT NULL CHECK (split_group IN ('train', 'test', 'holdout')),
          input_snapshot_json TEXT NOT NULL,
          gold_labels_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_examples_dataset ON benchmark_examples(dataset_id);
        CREATE INDEX IF NOT EXISTS idx_benchmark_examples_split ON benchmark_examples(dataset_id, split_group);
        CREATE TABLE IF NOT EXISTS benchmark_eval_runs (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
          run_label TEXT NOT NULL,
          model_config_json TEXT,
          metrics_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_eval_runs_dataset ON benchmark_eval_runs(dataset_id);
      `);
    })();
    console.log('[Migrations] Benchmark/evaluation tables verified.');
  } catch (e) {
    console.error('[Migrations] Benchmark migration failed:', e);
    throw e;
  }

  // ── Benchmark V2 Migration (frozen Gold + prediction bundles) ────────────────
  {
    const benchmarkV2Version = db.query('SELECT value FROM app_meta WHERE key = ?').get('benchmark_v2_schema_version') as
      | { value: string }
      | undefined;
    if (!benchmarkV2Version) {
      console.log('[Migrations] Running benchmark v2 migration...');
      db.transaction(() => {
        const hasColumn = (table: string, column: string): boolean => {
          const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          return cols.some(c => c.name === column);
        };

        // datasets: lifecycle columns.
        if (!hasColumn('benchmark_datasets', 'status')) {
          db.exec("ALTER TABLE benchmark_datasets ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';");
        }
        if (!hasColumn('benchmark_datasets', 'family_review_complete')) {
          db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_review_complete INTEGER NOT NULL DEFAULT 0;');
        }
        if (!hasColumn('benchmark_datasets', 'family_reviewed_by')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_reviewed_by TEXT;');
        if (!hasColumn('benchmark_datasets', 'family_reviewed_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_reviewed_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'dataset_hash')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN dataset_hash TEXT;');
        if (!hasColumn('benchmark_datasets', 'frozen_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN frozen_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'frozen_by')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN frozen_by TEXT;');
        if (!hasColumn('benchmark_datasets', 'retired_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN retired_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'source_config_hash')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN source_config_hash TEXT;');

        // examples: immutability/provenance columns.
        if (!hasColumn('benchmark_examples', 'example_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN example_hash TEXT;');
        if (!hasColumn('benchmark_examples', 'reviewer_id')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN reviewer_id TEXT;');
        if (!hasColumn('benchmark_examples', 'adjudicated_by')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN adjudicated_by TEXT;');
        if (!hasColumn('benchmark_examples', 'source_run_id')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_run_id TEXT;');
        if (!hasColumn('benchmark_examples', 'source_config_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_config_hash TEXT;');
        if (!hasColumn('benchmark_examples', 'source_product_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_product_hash TEXT;');

        // eval_runs: bind evaluations to the persisted prediction bundle.
        if (!hasColumn('benchmark_eval_runs', 'prediction_bundle_id')) {
          db.exec('ALTER TABLE benchmark_eval_runs ADD COLUMN prediction_bundle_id TEXT;');
        }

        // Backfill example_hash for pre-existing rows (deterministic and
        // idempotent — matches the repository's insert-time hash domain).
        const hasFamilyColumn = hasColumn('benchmark_examples', 'product_family_id');
        const legacyExamples = db.query(
          hasFamilyColumn
            ? 'SELECT id, product_sku, product_family_id, split_group, input_snapshot_json, gold_labels_json FROM benchmark_examples'
            : 'SELECT id, product_sku, split_group, input_snapshot_json, gold_labels_json FROM benchmark_examples',
        ).all() as Array<{
          id: string;
          product_sku: string;
          product_family_id: string | null;
          split_group: string;
          input_snapshot_json: string;
          gold_labels_json: string;
        }>;
        const backfillHash = (row: { product_sku: string; product_family_id: string | null; split_group: string; input_snapshot_json: string; gold_labels_json: string }): string => {
          return sha256Hex(JSON.stringify({
            productSku: row.product_sku,
            productFamilyId: row.product_family_id,
            splitGroup: row.split_group,
            inputSnapshotJson: row.input_snapshot_json,
            goldLabelsJson: row.gold_labels_json,
            sourceRunId: null,
            sourceConfigHash: null,
            sourceProductHash: null,
          }));
        };
        for (const example of legacyExamples) {
          const existing = db.query('SELECT example_hash FROM benchmark_examples WHERE id = ?').get(example.id) as { example_hash: string | null } | undefined;
          if (!existing || !existing.example_hash) {
            db.query('UPDATE benchmark_examples SET example_hash = ? WHERE id = ?').run(backfillHash(example), example.id);
          }
        }

        // Prediction bundles + qualification receipts (new tables).
        db.exec(`
          CREATE TABLE IF NOT EXISTS benchmark_prediction_bundles (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL,
            run_label TEXT NOT NULL,
            split_group TEXT NOT NULL CHECK (split_group IN ('test', 'holdout')),
            predictions_json TEXT NOT NULL,
            bundle_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_benchmark_prediction_bundles_dataset ON benchmark_prediction_bundles(dataset_id);
          CREATE TABLE IF NOT EXISTS benchmark_qualification_receipts (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            dataset_hash TEXT NOT NULL,
            prediction_bundle_id TEXT NOT NULL,
            bundle_hash TEXT NOT NULL,
            holdout_size INTEGER NOT NULL,
            coverage REAL NOT NULL,
            min_class_support INTEGER NOT NULL,
            violation_counts_json TEXT NOT NULL,
            primary_metric TEXT NOT NULL,
            delta_lower95 REAL NOT NULL,
            non_regression_floors_met INTEGER NOT NULL DEFAULT 0,
            qualified INTEGER NOT NULL DEFAULT 0,
            reasons_json TEXT NOT NULL,
            digest TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            generated_by TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_dataset ON benchmark_qualification_receipts(dataset_id);
          CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_digest ON benchmark_qualification_receipts(digest);
          CREATE INDEX IF NOT EXISTS idx_benchmark_datasets_workspace ON benchmark_datasets(workspace_id);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('benchmark_v2_schema_version', '1');");
      console.log('[Migrations] Benchmark v2 migration complete.');
    }
  }


  // ── Product Embeddings Migration ──────────────────────────────────────────
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_embeddings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          product_sku TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_text TEXT NOT NULL,
          embedding_blob BLOB NOT NULL,
          embedding_dim INTEGER NOT NULL,
          source_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_embeddings_unique
          ON product_embeddings(workspace_id, product_sku, embedding_model);
        CREATE INDEX IF NOT EXISTS idx_product_embeddings_workspace
          ON product_embeddings(workspace_id, embedding_model);
      `);
    })();
    console.log('[Migrations] Product embeddings table verified.');
  } catch (e) {
    console.error('[Migrations] Product embeddings migration failed:', e);
    throw e;
  }

  // ── Embedding v2 schema (namespace / fingerprint / failure status) ────────
  try {
    const embeddingV2Version = db.query("SELECT value FROM app_meta WHERE key = 'embedding_v2_schema_version'").get() as
      | { value: string }
      | undefined;
    if (!embeddingV2Version || embeddingV2Version.value !== '2') {
      console.log('[Migrations] Running embedding v2 schema migration...');
      db.transaction(() => {
        const hasColumn = (table: string, column: string): boolean => {
          const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          return cols.some(c => c.name === column);
        };
        if (!hasColumn('product_embeddings', 'provider')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN provider TEXT NOT NULL DEFAULT 'ollama';");
        }
        if (!hasColumn('product_embeddings', 'schema_version')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;');
        }
        if (!hasColumn('product_embeddings', 'namespace')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN namespace TEXT NOT NULL DEFAULT 'production';");
        }
        if (!hasColumn('product_embeddings', 'failure_status')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN failure_status TEXT;');
        }
        if (!hasColumn('product_embeddings', 'source_config_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN source_config_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'decision_run_id')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN decision_run_id TEXT;');
        }
        if (!hasColumn('product_embeddings', 'updated_at')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN updated_at TEXT;');
        }
        if (!hasColumn('product_embeddings', 'model_fingerprint')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN model_fingerprint TEXT NOT NULL DEFAULT '';");
        }
        if (!hasColumn('product_embeddings', 'document_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN document_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'config_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN config_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'decision_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN decision_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'run_id')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN run_id TEXT;');
        }
        // Namespace-aware uniqueness replaces the legacy 3-column unique index
        // so the same SKU+model can exist in both namespaces.
        db.exec('DROP INDEX IF EXISTS idx_product_embeddings_unique;');
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_product_embeddings_unique
            ON product_embeddings(workspace_id, product_sku, embedding_model, namespace);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_product_embeddings_namespace
            ON product_embeddings(workspace_id, namespace, embedding_model);
        `);
      })();
      db.exec(`INSERT INTO app_meta (key, value) VALUES ('embedding_v2_schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
      console.log('[Migrations] Embedding v2 schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Embedding v2 schema migration failed:', e);
    throw e;
  }

  // ── Page Identity Migration ────────────────────────────────────────────────
  //
  // Demotes all synthetic/local Page rows to `unverified_name_only` review
  // context, drops the UNIQUE(name) identity assumption, adds workspace/import
  // provenance and identity columns, clears inferred product_pages.page_id
  // references (preserving names and assignment history), and marks
  // category_page proposals referencing inferred identities stale without
  // deleting decisions. A real ShopSite Pages export is required before any
  // row can become a verified identity.
  try {
    const pageIdentityVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('page_identity_schema_version') as
      | { value: string }
      | undefined;
    if (!pageIdentityVersion) {
      console.log('[Migrations] Running page identity migration...');
      // PRAGMA foreign_keys cannot be toggled inside a transaction (SQLite
      // silently ignores it), so the historical OFF/ON pair around the table
      // rebuild was a no-op whenever foreign_keys was ON. Capture the current
      // state, toggle OFF BEFORE the rebuild transaction (so DROP TABLE on a
      // table referenced by FK constraints is permitted), and restore the
      // captured state after it completes.
      const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const fkWasOn = fkRow ? Number(fkRow.foreign_keys) === 1 : false;
      if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
        // 1. page_imports table (previewed imports are never stored; only
        //    activations persist, so this table is the verified-import audit).
        db.exec(`
          CREATE TABLE IF NOT EXISTS page_imports (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            parser_format_version TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('previewed', 'active', 'superseded')),
            counts_json TEXT NOT NULL,
            records_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            activated_at TEXT,
            superseded_at TEXT,
            activated_by TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_page_imports_workspace_status ON page_imports(workspace_id, status);
        `);

        // 2. Add page_index provenance/identity columns when missing.
        const pageCols = db.query('PRAGMA table_info(page_index)').all() as Array<{ name: string }>;
        const pageHas = (name: string) => pageCols.some(c => c.name === name);
        if (!pageHas('workspace_id')) db.exec('ALTER TABLE page_index ADD COLUMN workspace_id TEXT;');
        if (!pageHas('import_id')) db.exec('ALTER TABLE page_index ADD COLUMN import_id TEXT REFERENCES page_imports(id);');
        if (!pageHas('identity_kind')) db.exec("ALTER TABLE page_index ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'unverified_name_only';");
        if (!pageHas('identity_key')) db.exec('ALTER TABLE page_index ADD COLUMN identity_key TEXT;');
        if (!pageHas('identity_status')) db.exec("ALTER TABLE page_index ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unverified';");
        if (!pageHas('source_hash')) db.exec('ALTER TABLE page_index ADD COLUMN source_hash TEXT;');
        if (!pageHas('availability')) db.exec("ALTER TABLE page_index ADD COLUMN availability TEXT NOT NULL DEFAULT 'unavailable';");
        if (!pageHas('review_status')) db.exec("ALTER TABLE page_index ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';");

        // 3. Rebuild page_index to drop the UNIQUE(name) constraint. A name is
        //    never an identity key — duplicate names must be representable.
        const pageIndexSql = db.query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_index'",
        ).get() as { sql: string } | undefined;
        if (pageIndexSql && /UNIQUE/i.test(pageIndexSql.sql)) {
          db.exec(`
              CREATE TABLE page_index_new (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                file_name TEXT,
                parent_id TEXT REFERENCES page_index(id),
                page_hash TEXT NOT NULL,
                workspace_id TEXT,
                import_id TEXT REFERENCES page_imports(id),
                identity_kind TEXT NOT NULL DEFAULT 'unverified_name_only',
                identity_key TEXT,
                identity_status TEXT NOT NULL DEFAULT 'unverified',
                source_hash TEXT,
                availability TEXT NOT NULL DEFAULT 'unavailable',
                review_status TEXT NOT NULL DEFAULT 'pending',
                last_synced_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              )
            `);
            db.exec(`
              INSERT INTO page_index_new (
                id, name, file_name, parent_id, page_hash, workspace_id, import_id,
                identity_kind, identity_key, identity_status, source_hash, availability,
                review_status, last_synced_at, created_at, updated_at
              )
              SELECT
                id, name, file_name, parent_id, page_hash, workspace_id, import_id,
                identity_kind, identity_key, identity_status, source_hash, availability,
                review_status, last_synced_at, created_at, updated_at
              FROM page_index
            `);
            db.exec('DROP TABLE page_index;');
            db.exec('ALTER TABLE page_index_new RENAME TO page_index;');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_name ON page_index(name);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_identity ON page_index(workspace_id, identity_kind, identity_key);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_import ON page_index(import_id);');

        // 4. Backfill legacy rows: every existing row is name-only review
        //    context with no verified identity. Names are preserved.
        db.exec(
          'UPDATE page_index SET identity_key = name WHERE identity_key IS NULL AND name IS NOT NULL',
        );
        db.exec(
          'UPDATE page_index SET workspace_id = (SELECT id FROM workspace ORDER BY rowid ASC LIMIT 1) WHERE workspace_id IS NULL',
        );
        db.exec(`
          UPDATE page_index SET
            identity_kind = 'unverified_name_only',
            identity_status = 'unverified',
            availability = 'unavailable',
            review_status = 'pending',
            source_hash = COALESCE(source_hash, page_hash)
          WHERE identity_kind = 'unverified_name_only' OR identity_status = 'unverified' OR identity_kind IS NULL
        `);

        // 5. Clear inferred product_pages.page_id references while preserving
        //    the rows (names and assignment history survive; the FK is unset).
        db.exec('UPDATE product_pages SET page_id = NULL WHERE page_id IS NOT NULL');

        // 6. Mark category_page proposals referencing inferred identities stale
        //    without deleting proposals or their decision history.
        const staleCount = db.run(
          `UPDATE classification_proposals SET status = 'stale', is_stale = 1, staleness_reason = 'page_identity_unverified'
           WHERE proposal_type = 'category_page' AND status IN ('pending', 'accepted', 'deferred')`,
        ).changes;
        console.log(`[Migrations] Marked ${staleCount} category_page proposal(s) stale (page identity unverified).`);

        db.exec("INSERT INTO app_meta (key, value) VALUES ('page_identity_schema_version', '1');");
        console.log('[Migrations] Page identity migration complete.');
        })();
      } finally {
        if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
      }
    }
  } catch (e) {
    console.error('[Migrations] Page identity migration failed:', e);
    throw e;
  }

  // Unique verified-identity index: a name is never an identity key, and each
  // (workspace, import, identity kind, identity key) tuple is unique. Created
  // outside the guarded page_identity block (idempotent) so databases that
  // already ran that migration still get the index. The in-code capture check
  // rejects duplicates even where this index cannot be created.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_page_index_identity_unique ON page_index(workspace_id, import_id, identity_kind, identity_key);',
  );

  // ── Classification model-call provenance (issue #17 work item E) ──────────
  //
  // Durable per-call observability for protected model calls bound to
  // classification runs: `classification_model_calls` (started → terminal on
  // every path) and the `model_call_ids_json` column on proposals so a
  // proposal can be traced to the exact calls that produced it. Legacy
  // `curation_model_calls` is deprecated and untouched. Idempotent; guarded by
  // `model_calls_schema_version`.
  try {
    const modelCallsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('model_calls_schema_version') as
      | { value: string }
      | undefined;
    if (!modelCallsVersion) {
      console.log('[Migrations] Running classification model-call provenance migration...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_model_calls (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
          stage_name TEXT,
          operation TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          provider TEXT,
          model TEXT,
          locality TEXT,
          snapshot_hash TEXT,
          model_policy_digest TEXT,
          prompt_template_version TEXT,
          rule_version TEXT,
          system_prompt_hash TEXT,
          user_prompt_hash TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed', 'policy_denied', 'unavailable', 'cancelled')),
          error_message TEXT,
          estimated_cost_usd REAL,
          cost_basis TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_classification_model_calls_run ON classification_model_calls(run_id);
        CREATE INDEX IF NOT EXISTS idx_classification_model_calls_snapshot ON classification_model_calls(snapshot_hash);
      `);
      const proposalColumns = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
      if (!proposalColumns.some(col => col.name === 'model_call_ids_json')) {
        db.exec('ALTER TABLE classification_proposals ADD COLUMN model_call_ids_json TEXT;');
      }
      db.exec("INSERT INTO app_meta (key, value) VALUES ('model_calls_schema_version', '1');");
      console.log('[Migrations] Classification model-call provenance migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Classification model-call provenance migration failed:', e);
    throw e;
  }

  // Issue #17 work items H + I: target-specific evidence relations and
  // reviewer-correction evidence citations.
  // - classification_proposal_evidence gains the authoritative `relation`
  //   column (supporting/contradicting/context; legacy rows default to
  //   'legacy' — run-wide unions written before relations existed).
  // - classification_proposal_decision_evidence stores append-only citations
  //   per reviewer decision (FKs, PK (decision_id, evidence_id)).
  // - classification_proposals gains supporting/contradicting JSON columns so
  //   proposals hydrate with the authoritative role split.
  // Idempotent; guarded by `evidence_citation_schema_version`.
  try {
    const evidenceCitationVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('evidence_citation_schema_version') as
      | { value: string }
      | undefined;
    if (!evidenceCitationVersion) {
      console.log('[Migrations] Running evidence relation/citation migration...');
      const cols = (tbl: string) => db.query('PRAGMA table_info(' + tbl + ')').all() as Array<{ name: string }>;
      const addCol = (tbl: string, col: string, def: string) => {
        if (!cols(tbl).some((c: { name: string }) => c.name === col)) {
          db.exec('ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added ' + tbl + '.' + col);
        }
      };

      // Authoritative evidence-role column on the proposal-evidence join.
      if (!cols('classification_proposal_evidence').some(c => c.name === 'relation')) {
        db.exec(`ALTER TABLE classification_proposal_evidence ADD COLUMN relation TEXT NOT NULL DEFAULT 'legacy'`);
        console.log('[Migrations] Added classification_proposal_evidence.relation');
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_classification_proposal_evidence_relation ON classification_proposal_evidence(relation);");

      // Append-only reviewer-correction citations.
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_proposal_decision_evidence (
          decision_id TEXT NOT NULL REFERENCES classification_proposal_decisions(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
          PRIMARY KEY (decision_id, evidence_id)
        );
        CREATE INDEX IF NOT EXISTS idx_classification_decision_evidence_decision ON classification_proposal_decision_evidence(decision_id);
      `);

      // Role-split hydration columns on proposals (mirror the union column).
      // NOT NULL DEFAULT '[]' so upgrade columns match the fresh schema; a
      // backfill below covers any nullable column from an earlier migration.
      addCol('classification_proposals', 'supporting_evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'");
      addCol('classification_proposals', 'contradicting_evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'");

      // Backfill any nullable role columns left by an earlier migration run.
      db.exec("UPDATE classification_proposals SET supporting_evidence_ids_json = '[]' WHERE supporting_evidence_ids_json IS NULL;");
      db.exec("UPDATE classification_proposals SET contradicting_evidence_ids_json = '[]' WHERE contradicting_evidence_ids_json IS NULL;");

      db.exec("INSERT INTO app_meta (key, value) VALUES ('evidence_citation_schema_version', '1');");
      console.log('[Migrations] Evidence relation/citation migration complete.');
    }

    // Upgrade parity (runs on EVERY migration invocation, even when the
    // evidence-citation marker is already set): the join table must carry the
    // same relation CHECK as the fresh schema. SQLite cannot add CHECK via
    // ALTER, so rebuild the (small) join table when the CHECK is absent — for
    // DBs that ran an earlier version of this migration with a CHECK-less
    // ALTER-added relation column.
    const proposalEvidenceSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string } | undefined;
    if (proposalEvidenceSql && !/CHECK\s*\(/i.test(proposalEvidenceSql.sql)) {
      db.exec(`
        CREATE TABLE classification_proposal_evidence_new (
          proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
          relation TEXT NOT NULL DEFAULT 'legacy' CHECK (relation IN ('supporting', 'contradicting', 'context', 'legacy')),
          PRIMARY KEY (proposal_id, evidence_id)
        )
      `);
      db.exec(`
        INSERT INTO classification_proposal_evidence_new (proposal_id, evidence_id, relation)
        SELECT proposal_id, evidence_id, COALESCE(relation, 'legacy')
        FROM classification_proposal_evidence
      `);
      db.exec('DROP TABLE classification_proposal_evidence;');
      db.exec('ALTER TABLE classification_proposal_evidence_new RENAME TO classification_proposal_evidence;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposal_evidence_relation ON classification_proposal_evidence(relation);');
      console.log('[Migrations] Rebuilt classification_proposal_evidence with the relation CHECK constraint.');
    }

    // Upgrade parity for classification_proposals role columns (runs on EVERY
    // migration invocation, even when evidence_citation_schema_version is set):
    // SQLite cannot change an existing column's NOT NULL constraint via ALTER,
    // so rebuild the proposals table whenever any role column is still
    // nullable (a DB that ran an earlier evidence-citation migration). The
    // live CREATE TABLE SQL is patched to force all three role columns to
    // NOT NULL DEFAULT '[]'; every other column, constraint, and row is
    // preserved. No-op when the columns are already correct.
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const roleCols = ['evidence_ids_json', 'supporting_evidence_ids_json', 'contradicting_evidence_ids_json'];
    const needsProposalRebuild = roleCols.some(name => {
      const col = proposalCols.find(c => c.name === name);
      return col !== undefined && col.notnull === 0;
    });
    if (needsProposalRebuild) {
      const proposalsSql = db.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposals'",
      ).get() as { sql: string } | undefined;
      if (proposalsSql) {
        let patched = proposalsSql.sql;
        for (const name of roleCols) {
          // Replace each role column's definition with the strict form,
          // regardless of the earlier migration's column shape.
          patched = patched.replace(
            new RegExp(`(\\b${name}\\s+)[^,)]*`),
            `$1TEXT NOT NULL DEFAULT '[]'`,
          );
        }
        // Point the rebuilt DDL at a staging table name so the established
        // CREATE-new → copy → drop-old → rename pattern applies (the same
        // pattern as the page_index rebuild). Handles both 'CREATE TABLE
        // classification_proposals' and 'CREATE TABLE IF NOT EXISTS
        // classification_proposals' forms stored in sqlite_master.
        patched = patched.replace(
          /CREATE TABLE (?:IF NOT EXISTS )?classification_proposals\b/,
          'CREATE TABLE classification_proposals_new',
        );
        const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
        const fkWasOn = fkRow ? Number(fkRow.foreign_keys) === 1 : false;
        if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(patched);
            // Copy ONLY the columns that exist in the live table (upgrade DBs
            // may predate some columns, e.g. model_call_ids_json). Nullable
            // role columns are COALESCE'd to '[]'.
            const liveCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
            const copyCols = liveCols.map(c => c.name);
            const roleColumnSet = new Set(roleCols);
            const insertList = copyCols.map(name => `"${name}"`).join(', ');
            const selectList = copyCols
              .map(name => (roleColumnSet.has(name) ? `COALESCE("${name}", '[]')` : `"${name}"`))
              .join(', ');
            db.exec(`
              INSERT INTO classification_proposals_new (${insertList})
              SELECT ${selectList}
              FROM classification_proposals
            `);
            db.exec('DROP TABLE classification_proposals;');
            db.exec('ALTER TABLE classification_proposals_new RENAME TO classification_proposals;');
          })();
        } finally {
          if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_run ON classification_proposals(run_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_product_status ON classification_proposals(product_sku, status);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_product ON classification_proposals(product_sku);');
        console.log('[Migrations] Rebuilt classification_proposals with NOT NULL role columns.');
      }
    }
  } catch (e) {
    console.error('[Migrations] Evidence relation/citation migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Migration (PI-2) ──────────────────────────────────
  //
  // Durable data model for Product Intelligence runs (epic #28, issue #19):
  // runs, the replayable event stream, steps, tool calls, sources, evidence,
  // conflicts, results, and Pi-vs-baseline comparisons. Normalized tables are
  // authoritative; onboarding imports reference the originating run and
  // selected evidence. Child rows cascade on run deletion (explicit retention
  // policy lives in the run service).
  try {
    const piVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_schema_version') as
      | { value: string }
      | undefined;
    if (!piVersion) {
      console.log('[Migrations] Running product intelligence schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_runs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            onboarding_item_id TEXT,
            mode TEXT NOT NULL DEFAULT 'interactive' CHECK (mode IN ('shadow', 'interactive', 'onboarding')),
            status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
            executor TEXT NOT NULL,
            input_json TEXT NOT NULL,
            policy_json TEXT NOT NULL,
            config_snapshot_id TEXT NOT NULL,
            config_snapshot_hash TEXT NOT NULL,
            code_commit TEXT,
            pi_version TEXT,
            extension_versions_json TEXT NOT NULL DEFAULT '[]',
            started_at TEXT NOT NULL,
            completed_at TEXT,
            cancelled_at TEXT,
            error_code TEXT,
            error_message TEXT,
            estimated_cost REAL,
            actual_cost REAL,
            token_usage_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_pi_runs_workspace_status ON product_intelligence_runs(workspace_id, status);
          CREATE INDEX IF NOT EXISTS idx_pi_runs_started ON product_intelligence_runs(started_at);

          CREATE TABLE IF NOT EXISTS product_intelligence_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_events_run ON product_intelligence_events(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_steps (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            step_type TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
            summary TEXT,
            input_hash TEXT,
            output_ref TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_json TEXT,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_steps_run ON product_intelligence_steps(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_tool_calls (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            step_id TEXT REFERENCES product_intelligence_steps(id) ON DELETE SET NULL,
            sequence INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            tool_version TEXT,
            policy_outcome TEXT NOT NULL DEFAULT 'allowed' CHECK (policy_outcome IN ('allowed', 'denied', 'budget_exceeded')),
            request_hash TEXT,
            response_hash TEXT,
            artifact_ref TEXT,
            latency_ms INTEGER,
            cost_usd REAL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_json TEXT,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_tool_calls_run ON product_intelligence_tool_calls(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_sources (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            canonical_url TEXT,
            domain TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'other' CHECK (source_type IN ('catalog', 'supplier', 'registry', 'retailer', 'manufacturer', 'other')),
            gtin_match_status TEXT NOT NULL DEFAULT 'unknown' CHECK (gtin_match_status IN ('exact', 'variant', 'unknown', 'conflicting')),
            variant_match_status TEXT NOT NULL DEFAULT 'unknown' CHECK (variant_match_status IN ('exact', 'variant', 'unknown', 'conflicting')),
            retrieved_at TEXT,
            content_hash TEXT,
            artifact_ref TEXT,
            license_ref TEXT,
            terms_ref TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_sources_run ON product_intelligence_sources(run_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_evidence (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL REFERENCES product_intelligence_sources(id) ON DELETE CASCADE,
            target_field TEXT NOT NULL,
            value_json TEXT NOT NULL,
            extraction_method TEXT,
            source_field TEXT,
            reliability TEXT,
            direct_support INTEGER NOT NULL DEFAULT 0,
            snippet TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_evidence_run ON product_intelligence_evidence(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_evidence_source ON product_intelligence_evidence(source_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_conflicts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            field TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
            competing_values_json TEXT NOT NULL DEFAULT '[]',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            resolution_json TEXT,
            resolved_by TEXT,
            resolved_at TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_conflicts_run ON product_intelligence_conflicts(run_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_results (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL UNIQUE REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            schema_version INTEGER NOT NULL,
            disposition TEXT NOT NULL CHECK (disposition IN ('submitted', 'abstained', 'unavailable')),
            result_json TEXT NOT NULL,
            result_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS product_intelligence_comparisons (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            baseline_type TEXT NOT NULL,
            baseline_ref TEXT NOT NULL,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_comparisons_run ON product_intelligence_comparisons(run_id);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_schema_version', '1');");
      console.log('[Migrations] Product intelligence schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Policy Migration (PI-5) ──────────────────────────
  // Policy gateway audit trail (every external/model/budget decision) and the
  // prompt hash captured with each run's immutable snapshot.
  try {
    const piPolicyVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_policy_schema_version') as
      | { value: string }
      | undefined;
    if (!piPolicyVersion) {
      console.log('[Migrations] Running product intelligence policy schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_policy_decisions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
            policy_version TEXT NOT NULL,
            target_type TEXT NOT NULL CHECK (target_type IN ('model', 'network', 'budget', 'tool')),
            target TEXT NOT NULL,
            data_classification TEXT,
            fallback_status TEXT NOT NULL DEFAULT 'none' CHECK (fallback_status IN ('none', 'fallback_denied', 'fallback_used')),
            reason_code TEXT NOT NULL,
            detail_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_policy_decisions_run ON product_intelligence_policy_decisions(run_id, sequence);
        `);
        const runCols = db.query('PRAGMA table_info(product_intelligence_runs)').all() as Array<{ name: string }>;
        if (!runCols.some((col) => col.name === 'prompt_hash')) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN prompt_hash TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_policy_schema_version', '1');");
      console.log('[Migrations] Product intelligence policy schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence policy schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Asset Migration (PI-6) ───────────────────────────
  // Durable image-asset evidence records (exact-product/variant identity,
  // source + rights provenance, content + perceptual hashes, quality, and the
  // deterministic commerce-approval flag). Image provenance persists with the
  // run; onboarding import and draft-promotion consumption of approved asset
  // records is wired in a later issue (Agent Lab imports).
  try {
    const piAssetsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_assets_schema_version') as
      | { value: string }
      | undefined;
    if (!piAssetsVersion) {
      console.log('[Migrations] Running product intelligence asset schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_assets (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_assets_run ON product_intelligence_assets(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_commerce ON product_intelligence_assets(run_id, commerce_approved);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_assets_schema_version', '1');");
      console.log('[Migrations] Product intelligence asset schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence asset schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Import Migration (PI-8) ─────────────────────────
  // Durable import records: a reviewed Agent Lab run imported to an
  // onboarding item (create or augment), with the field-selection map,
  // excluded/overridden values, and the imported source/evidence/image ids.
  // Idempotent per (run, item); run deletion marks records stale (FK SET
  // NULL) so provenance survives while promotion rejects stale imports.
  try {
    const piImportsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_imports_schema_version') as
      | { value: string }
      | undefined;
    if (!piImportsVersion) {
      console.log('[Migrations] Running product intelligence import schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_imports (
            id TEXT PRIMARY KEY,
            run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL,
            onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            result_hash TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('create', 'augment')),
            importing_user TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'stale')),
            field_selection_json TEXT NOT NULL DEFAULT '[]',
            excluded_values_json TEXT NOT NULL DEFAULT '{}',
            overridden_values_json TEXT NOT NULL DEFAULT '{}',
            imported_source_ids_json TEXT NOT NULL DEFAULT '[]',
            imported_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            imported_image_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE (run_id, onboarding_item_id)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_imports_item ON product_intelligence_imports(onboarding_item_id);
          CREATE INDEX IF NOT EXISTS idx_pi_imports_run ON product_intelligence_imports(run_id);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_imports_schema_version', '1');");
      console.log('[Migrations] Product intelligence import schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence import schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Evaluation Migration (PI-9) ────────────────────
  // Durable evaluation runs: a golden-dataset example compared against a
  // completed Pi run, with the gold labels, prediction, comparison, and
  // outcome preserved for audit. Held-out products are never evaluated by
  // default (the runner defaults to the 'test' split).
  try {
    const piEvalVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('pi_evaluation_schema_version') as
      | { value: string }
      | undefined;
    if (!piEvalVersion) {
      console.log('[Migrations] Running product intelligence evaluation schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_evaluation_runs (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            dataset_hash TEXT NOT NULL,
            product_sku TEXT NOT NULL,
            split_group TEXT NOT NULL,
            run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL,
            gold_labels_json TEXT NOT NULL,
            prediction_json TEXT NOT NULL,
            comparison_json TEXT NOT NULL,
            outcome TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_eval_dataset ON pi_evaluation_runs(dataset_id);
          CREATE INDEX IF NOT EXISTS idx_pi_eval_sku ON pi_evaluation_runs(product_sku);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_evaluation_schema_version', '1');");
      console.log('[Migrations] Product intelligence evaluation schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence evaluation schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Ops Migration (PI-10) ───────────────────────────
  // Operational tooling: replay lineage (every replay is a new run linked to
  // its origin; originals stay immutable), centralized workspace budgets, and
  // per-category retention policies (metadata / tool calls / sources / raw
  // fetched content / model request+response artifacts / images).
  try {
    const piOpsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_ops_schema_version') as
      | { value: string }
      | undefined;
    if (!piOpsVersion) {
      console.log('[Migrations] Running product intelligence ops schema migration...');
      db.transaction(() => {
        // Replay lineage: origin_run_id self-reference (SET NULL so a replayed
        // run survives its origin's deletion); replay_depth guards runaway chains.
        const runCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'origin_run_id'").get() as { c: number };
        if (runCols.c === 0) {
          db.exec(`ALTER TABLE product_intelligence_runs ADD COLUMN origin_run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL;`);
        }
        const depthCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'replay_depth'").get() as { c: number };
        if (depthCols.c === 0) {
          db.exec(`ALTER TABLE product_intelligence_runs ADD COLUMN replay_depth INTEGER NOT NULL DEFAULT 0;`);
        }
        // Workspace budget policies (NULL fields = unlimited) and per-category
        // retention policies (NULL fields = keep forever). Enforced centrally
        // in src/product-intelligence/budgets.ts / retention.ts, never trusted
        // to the agent prompt.
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_budget_policies (
            workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
            policy_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pi_retention_policies (
            workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
            policy_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_ops_schema_version', '1');");
      console.log('[Migrations] Product intelligence ops schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence ops schema migration failed:', e);
    throw e;
  }

  // P0-2 (review remediation): server-authoritative, immutable/versioned PI
  // execution policies. Callers select an approved policy by record id and
  // may only apply strictly-reducing overrides; the policy object itself is
  // never caller-supplied. Each version row is immutable; a policy change
  // creates a new version and deactivates the previous ones (only the newest
  // version of a record may be active).
  try {
    const piApprovedPoliciesVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('product_intelligence_approved_policies_schema_version') as
      | { value: string }
      | undefined;
    if (!piApprovedPoliciesVersion) {
      console.log('[Migrations] Running product intelligence approved policies migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_approved_policies (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            version INTEGER NOT NULL,
            policy_json TEXT NOT NULL,
            policy_config_id TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            UNIQUE(workspace_id, name, version)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_approved_policies_ws_active ON pi_approved_policies(workspace_id, active);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_approved_policies_schema_version', '1');");
      console.log('[Migrations] Product intelligence approved policies migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence approved policies migration failed:', e);
    throw e;
  }

  // Review remediation (P1-2/P0-6): durable human review decisions for
  // Agent Lab imports, server-authoritative reuse grants for image rights,
  // and the extended extraction_method CHECK on product_intelligence_assets.
  // Review decisions are append-only: every approve/reject is a new row with
  // a result_hash binding the decision to the exact stored result, chained
  // via supersedes_decision_id. Reuse grants are workspace-scoped
  // (source tier + domain pattern) and resolve independently of source
  // identity — a canonical vendor domain proves ORIGIN, never reuse rights.
  try {
    const reviewRemediationVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_review_remediation_schema_version') as
      | { value: string }
      | undefined;
    if (!reviewRemediationVersion) {
      console.log('[Migrations] Running review remediation schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_review_decisions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
            result_hash TEXT NOT NULL,
            supersedes_decision_id TEXT REFERENCES pi_review_decisions(id),
            reviewer TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_review_decisions_run ON pi_review_decisions(run_id);
          CREATE TABLE IF NOT EXISTS pi_reuse_policies (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            source_tier TEXT NOT NULL,
            domain_pattern TEXT NOT NULL,
            allowed INTEGER NOT NULL DEFAULT 1,
            terms TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(workspace_id, source_tier, domain_pattern)
          );
          -- SQLite cannot ALTER a CHECK constraint: rebuild the assets table
          -- with the extended extraction_method enum ('image_ocr', 'decoder'
          -- were added to the zod schema in P0-6). No table references
          -- product_intelligence_assets (verified), so the drop/rename is safe.
          CREATE TABLE IF NOT EXISTS product_intelligence_assets_new (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual', 'image_ocr', 'decoder')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO product_intelligence_assets_new
            (id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at)
          SELECT id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at
          FROM product_intelligence_assets;
          DROP TABLE product_intelligence_assets;
          ALTER TABLE product_intelligence_assets_new RENAME TO product_intelligence_assets;
          CREATE INDEX IF NOT EXISTS idx_pi_assets_run ON product_intelligence_assets(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_commerce ON product_intelligence_assets(run_id, commerce_approved);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_review_remediation_schema_version', '1');");
      console.log('[Migrations] Review remediation schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Review remediation schema migration failed:', e);
    throw e;
  }

  // Policy lineage (review finding 7): real reruns reauthorize the BASE
  // approved-policy record, then re-apply the stored reducing overrides.
  // Without this, a run created with a reducing override has a resolved
  // configId with no matching pi_approved_policies row, so the rerun gate
  // would refuse a perfectly valid run. base_policy_id/version reference the
  // immutable approved record; policy_overrides_json holds the exact
  // override snapshot the run was created with (re-validated as still
  // reducing on every rerun).
  try {
    const policyLineageVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('product_intelligence_policy_lineage_schema_version') as
      | { value: string }
      | undefined;
    if (!policyLineageVersion) {
      console.log('[Migrations] Running product intelligence policy lineage migration...');
      db.transaction(() => {
        const baseIdCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'base_policy_id'").get() as { c: number };
        if (baseIdCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN base_policy_id TEXT;');
        }
        const baseVersionCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'base_policy_version'").get() as { c: number };
        if (baseVersionCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN base_policy_version INTEGER;');
        }
        const overridesCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'policy_overrides_json'").get() as { c: number };
        if (overridesCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN policy_overrides_json TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_policy_lineage_schema_version', '1');");
      console.log('[Migrations] Product intelligence policy lineage migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence policy lineage migration failed:', e);
    throw e;
  }

  // Round-8 (review P1): capture effective research-tool versions + schema
  // hashes on runs for replay/provenance. Tool NAMES are already persisted
  // via tool_calls rows; versions and schema hashes need the run-level field.
  // tools_json = JSON array of { name, version, schemaHash } for every
  // effective research/terminal tool in the session, captured at session
  // creation (the executor writes it once the session exists — the tools are
  // not knowable at createPiRun time).
  try {
    const toolsVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_tools_capture_schema_version') as
      | { value: string }
      | undefined;
    if (!toolsVersion) {
      console.log('[Migrations] Running pi tools capture migration...');
      db.transaction(() => {
        const toolsCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'tools_json'").get() as { c: number };
        if (toolsCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN tools_json TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_tools_capture_schema_version', '1');");
      console.log('[Migrations] Pi tools capture migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi tools capture migration failed:', e);
    throw e;
  }

  // Round-4 (review P0): a 'server-verified' image asset must be bound to the
  // run's immutable product identity. verified_against_hash is the SHA-256 of
  // the canonical identity snapshot (runId + gtin + name, server-derived from
  // the run input at verification time) — the terminal validator recomputes it
  // from the CURRENT run's input and refuses assets that were verified against
  // anything else. declared_source_type is the durable source-kind derived from
  // the source row, never the agent's declared string.
  try {
    const verifiedAgainstVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_assets_verified_against_schema_version') as
      | { value: string }
      | undefined;
    if (!verifiedAgainstVersion) {
      console.log('[Migrations] Running pi assets verified-against schema migration...');
      db.transaction(() => {
        const jsonCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'verified_against_json'").get() as { c: number };
        if (jsonCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN verified_against_json TEXT;');
        }
        const hashCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'verified_against_hash'").get() as { c: number };
        if (hashCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN verified_against_hash TEXT;');
        }
        const sourceTypeCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'declared_source_type'").get() as { c: number };
        if (sourceTypeCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN declared_source_type TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_assets_verified_against_schema_version', '1');");
      console.log('[Migrations] Pi assets verified-against schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi assets verified-against schema migration failed:', e);
    throw e;
  }

  // Round-7 (review P0): server-CREATED image-candidate provenance. The
  // candidate->discovering-page relationship is established by the server when
  // discover_image_candidates runs; verify_image_candidate cites the durable
  // record (candidateId) and the source tier / rights grant resolve from its
  // discovering source — never from an agent-supplied sourcePageUrl or
  // agent-selected evidence rows.
  try {
    const candidateVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_image_candidates_schema_version') as { value: string } | undefined;
    if (!candidateVersion) {
      console.log('[Migrations] Running pi image candidates schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_image_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        discovering_source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
        source_artifact_id TEXT,
        source_path TEXT,
        extraction_method TEXT,
        variant_reference TEXT,
        created_at TEXT NOT NULL
      );`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_image_candidates_schema_version', '1');");
      console.log('[Migrations] Pi image candidates schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi image candidates schema migration failed:', e);
    throw e;
  }

  // Round-9 (review P1): media-set/entity identity on image candidates —
  // supporting images must be durably linked to the SAME product entity
  // (SKU/productId/@id/variation id), never merely the same discovering page.
  try {
    const entityVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_image_candidates_entity_schema_version') as { value: string } | undefined;
    if (!entityVersion) {
      console.log('[Migrations] Running pi image candidates entity-id migration...');
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN entity_id TEXT NULL;');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_image_candidates_entity_schema_version', '1');");
      console.log('[Migrations] Pi image candidates entity-id migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi image candidates entity-id migration failed:', e);
    throw e;
  }

  // Round-9 (review P0): first-class durable source authority. Rights tiers
  // never derive from evidence kinds; check_source_priority (or future
  // trusted CMS records) establish authority here with a brand-matched
  // manufacturer/supplier relationship.
  try {
    const authorityVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_source_authorities_schema_version') as { value: string } | undefined;
    if (!authorityVersion) {
      console.log('[Migrations] Running pi source authorities schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_source_authorities (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES product_intelligence_sources(id) ON DELETE CASCADE,
        authority_type TEXT NOT NULL,
        authority_ref TEXT,
        brand_name TEXT,
        established_by TEXT NOT NULL,
        established_at TEXT NOT NULL,
        UNIQUE(source_id, authority_type)
      );`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_source_authorities_schema_version', '1');");
      console.log('[Migrations] Pi source authorities schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi source authorities schema migration failed:', e);
    throw e;
  }

  // Round-9 (review P1-1/P1-5): artifact-driven image discovery. The server
  // retains bounded page artifacts (content + hash); discover_image_candidates
  // loads them by artifactId — the agent never supplies artifact bytes — and
  // each candidate row records the attestation (artifact id + attested hash)
  // that made the candidate->page relationship trustworthy.
  try {
    const artifactVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_artifact_driven_discovery_schema_version') as { value: string } | undefined;
    if (!artifactVersion) {
      console.log('[Migrations] Running pi artifact-driven discovery schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_page_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );`);
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN attestation_artifact_id TEXT NULL;');
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN attested_content_hash TEXT NULL;');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_artifact_driven_discovery_schema_version', '1');");
      console.log('[Migrations] Pi artifact-driven discovery schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi artifact-driven discovery schema migration failed:', e);
    throw e;
  }

  // Round-10 (review P0/P1): run-scoped artifact authority + durable
  // asset->candidate linkage + typed page artifacts.
  // - pi_page_artifacts gains artifact_type ('page_html' | 'browser_network_capture').
  // - Attestation is referentially enforced with a SAME-RUN trigger (a plain
  //   FK cannot express "artifact must belong to this candidate's run").
  // - product_intelligence_assets gains candidate_id (exact FK to the
  //   pi_image_candidates row the asset was verified from), same-run enforced.
  const artifactColumns = db.query("SELECT name FROM pragma_table_info('pi_page_artifacts') WHERE name = 'artifact_type'").get();
  if (!artifactColumns) {
    db.exec("ALTER TABLE pi_page_artifacts ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'page_html';");
  }
  const candidateRunTrigger = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pi_candidate_attestation_same_run'")
    .get();
  if (!candidateRunTrigger) {
    db.exec(`
      CREATE TRIGGER trg_pi_candidate_attestation_same_run
      BEFORE INSERT ON pi_image_candidates
      WHEN NEW.attestation_artifact_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_page_artifacts WHERE id = NEW.attestation_artifact_id)
            THEN RAISE(ABORT, 'attestation_artifact_id references a nonexistent pi_page_artifacts row')
          WHEN (SELECT run_id FROM pi_page_artifacts WHERE id = NEW.attestation_artifact_id) <> NEW.run_id
            THEN RAISE(ABORT, 'attestation_artifact_id belongs to a different run')
        END;
      END;`);
  }
  const assetCandidateColumn = db
    .query("SELECT name FROM pragma_table_info('product_intelligence_assets') WHERE name = 'candidate_id'")
    .get();
  if (!assetCandidateColumn) {
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN candidate_id TEXT NULL;');
  }
  const assetCandidateTrigger = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pi_asset_candidate_same_run'")
    .get();
  if (!assetCandidateTrigger) {
    db.exec(`
      CREATE TRIGGER trg_pi_asset_candidate_same_run
      BEFORE INSERT ON product_intelligence_assets
      WHEN NEW.candidate_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_image_candidates WHERE id = NEW.candidate_id)
            THEN RAISE(ABORT, 'candidate_id references a nonexistent pi_image_candidates row')
          WHEN (SELECT run_id FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.run_id
            THEN RAISE(ABORT, 'candidate_id belongs to a different run')
        END;
      END;`);
  }
  db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round10_authority_schema_version', '1');");
  console.log('[Migrations] Pi round-10 authority schema migration complete.');

  // Round-11 (review P0/P1s): workspace authority + evidence-provenanced
  // brand authority.
  // - trg_pi_asset_candidate_same_run is strengthened: the candidate's
  //   image_url must equal the asset's source_url (the invariant the live
  //   verifier already enforces becomes a storage invariant too).
  // - pi_source_authorities retains the evidence that resolved the brand
  //   (verified asset id + content hash + evidence kind) so an authority
  //   record is a durable statement "Brand A was observed from evidence E
  //   on asset bytes H whose GTIN X was independently exact".
  const round11 = db
    .query("SELECT value FROM app_meta WHERE key = 'pi_round11_authority_schema_version'")
    .get() as { value: string } | undefined;
  if (!round11) {
    db.exec('DROP TRIGGER IF EXISTS trg_pi_asset_candidate_same_run;');
    db.exec(`
      CREATE TRIGGER trg_pi_asset_candidate_same_run
      BEFORE INSERT ON product_intelligence_assets
      WHEN NEW.candidate_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_image_candidates WHERE id = NEW.candidate_id)
            THEN RAISE(ABORT, 'candidate_id references a nonexistent pi_image_candidates row')
          WHEN (SELECT run_id FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.run_id
            THEN RAISE(ABORT, 'candidate_id belongs to a different run')
          WHEN (SELECT image_url FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.source_url
            THEN RAISE(ABORT, 'candidate image_url must equal the asset source_url')
        END;
      END;`);
    const authCols = db.query("SELECT name FROM pragma_table_info('pi_source_authorities')").all() as Array<{ name: string }>;
    if (!authCols.some((c) => c.name === 'brand_evidence_id')) {
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_id TEXT NULL;');
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_hash TEXT NULL;');
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_kind TEXT NULL;');
    }
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round11_authority_schema_version', '1');");
    console.log('[Migrations] Pi round-11 authority schema migration complete.');
  }

  // Round-12 (review P0-3): assets retain the QUALIFYING brand evidence
  // binding — the exact evidence row + hash that established the observed
  // brand (never reconstructed from observedBrand + image hash later).
  const assetBrandEvidence = db
    .query("SELECT name FROM pragma_table_info('product_intelligence_assets') WHERE name = 'brand_evidence_id'")
    .get();
  if (!assetBrandEvidence) {
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN brand_evidence_id TEXT NULL;');
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN brand_evidence_hash TEXT NULL;');
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round12_brand_evidence_schema_version', '1');");
    console.log('[Migrations] Pi round-12 brand-evidence schema migration complete.');
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
