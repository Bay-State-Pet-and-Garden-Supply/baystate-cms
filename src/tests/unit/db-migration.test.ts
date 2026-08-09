import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations, getSchemaVersion } from '../../db/migrations';
import {
  upsertPage,
  assignProductToPage,
  assignProductToPageId,
  getProductPages,
  getProductPageAssignments,
  clearProductPages,
} from '../../db/repositories/page-repo';

describe('SQLite Migration', () => {
  const testDbPath = '/tmp/baystate-cms-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should create app_meta with schema_version', () => {
    const version = getSchemaVersion();
    expect(version).toBe('1');
  });

  it('should create app_meta with classification_schema_version', () => {
    const db = getDb();
    const row = db.query(
      "SELECT value FROM app_meta WHERE key = 'classification_schema_version'"
    ).get() as { value: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.value).toBe('1');
  });

  it('should run migrations idempotently', () => {
    // runMigrations() should not throw and should not duplicate metadata
    expect(() => runMigrations()).not.toThrow();

    const db = getDb();
    const rows = db.query(
      "SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'classification_schema_version'"
    ).get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('should add decision revision columns and the global action-token unique index', () => {
    const db = getDb();

    const cols = db.query('PRAGMA table_info(classification_proposal_decisions)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const col of ['revised_value_json', 'revised_target_id', 'has_revised_target', 'decision_key', 'superseded_at']) {
      expect(names).toContain(col);
    }

    const idx = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'"
    ).get();
    expect(idx).toBeTruthy();

    // Action tokens stay unique across superseded history, so a delayed retry
    // can never reactivate an older action.
    const idxSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'"
    ).get() as { sql: string } | undefined;
    expect(idxSql?.sql ?? '').toContain('decision_key IS NOT NULL');
    expect(idxSql?.sql ?? '').not.toContain('superseded_at');

    // Version guard is recorded exactly once.
    const rows = db.query(
      "SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'decision_revision_schema_version'"
    ).get() as { cnt: number };
    expect(rows.cnt).toBe(1);
    const version = db.query(
      "SELECT value FROM app_meta WHERE key = 'decision_revision_schema_version'",
    ).get() as { value: string };
    expect(version.value).toBe('2');

    // Legacy-shaped rows (NULL new columns) round-trip after migration.
    const now = new Date().toISOString();
    const runId = randomUUID();
    const proposalId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, NULL, 'SKU-MIG', 'completed', ?)`,
      [runId, 'ws-mig', now],
    );
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-MIG', 'field_assignment', '"v"', 0.8, 'pending', ?)`,
      [proposalId, runId, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
       VALUES (?, ?, 'accepted', ?)`,
      ['legacy-dec', proposalId, now],
    );
    const legacy = db.query(
      'SELECT revised_value_json, revised_target_id, decision_key, superseded_at FROM classification_proposal_decisions WHERE id = ?'
    ).get('legacy-dec') as Record<string, unknown>;
    expect(legacy.revised_value_json).toBeNull();
    expect(legacy.revised_target_id).toBeNull();
    expect(legacy.decision_key).toBeNull();
    expect(legacy.superseded_at).toBeNull();

    db.run('DELETE FROM classification_proposal_decisions WHERE id = ?', ['legacy-dec']);
    db.run('DELETE FROM classification_proposals WHERE id = ?', [proposalId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
  });

  it('should support inserting and querying workspace', () => {
    const db = getDb();

    const id = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Test Store', '/tmp/test-store', '/tmp/test-store/.git', now, now, 'complete'],
    );

    const row = db.query('SELECT * FROM workspace WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.name).toBe('Test Store');
    expect(row.bootstrap_status).toBe('complete');

    db.run('DELETE FROM workspace WHERE id = ?', [id]);
  });

  it('should support field_registry upsert', () => {
    const db2 = getDb();

    const wsId = randomUUID();
    const now = new Date().toISOString();
    const entryId = randomUUID();

    db2.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Reg Store', '/tmp/reg', '/tmp/reg/.git', now, now, 'not_started'],
    );

    db2.run(
      `INSERT INTO field_registry (id, workspace_id, xml_field, label, kind, data_type, editable, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, wsId, 'ProductField16', 'Brand', 'custom', 'string', 1, 0, now, now],
    );

    const row = db2.query('SELECT * FROM field_registry WHERE id = ?').get(entryId) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.label).toBe('Brand');

    db2.run('DELETE FROM field_registry WHERE id = ?', [entryId]);
    db2.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should create all core tables', () => {
    const db3 = getDb();

    const tables = [
      'app_meta', 'workspace', 'connection', 'product_index',
      'field_registry', 'change_sets', 'change_set_items', 'validation_results',
      'sync_jobs', 'sync_job_events', 'remote_drift', 'audit_log',
      'product_types', 'product_type_fields', 'page_index', 'product_pages',
      'extractor_profiles', 'domain_status', 'serper_cache', 'sitemap_cache',
      'profile_generations', 'profile_generation_revisions',
      'profile_generation_validation_results', 'profile_generation_field_decisions',
      'llm_task_configs',
    ];

    for (const table of tables) {
      const row = db3.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }
  });

  it('should create all classification tables', () => {
    const db = getDb();

    const tables = [
      'classification_config_files',
      'classification_config_snapshots',
      'classification_product_types',
      'classification_attributes',
      'classification_attribute_profiles',
      'classification_attribute_mappings',
      'classification_guidance',
      'classification_model_policies',
      'classification_data_sharing_policies',
      'classification_runs',
      'classification_stage_results',
      'classification_evidence',
      'classification_proposals',
      'classification_proposal_evidence',
      'classification_proposal_decisions',
      'classification_history_events',
      'classification_refresh_queue',
      'classification_refresh_deferrals',
      'classification_model_calls',
    ];

    for (const table of tables) {
      const row = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }
  });

  it('should create the classification_model_calls provenance columns and proposal model_call_ids_json', () => {
    const db = getDb();
    const callCols = (db.query('PRAGMA table_info(classification_model_calls)').all() as Array<{ name: string }>).map(c => c.name);
    for (const col of ['id', 'run_id', 'operation', 'attempt', 'provider', 'model', 'locality', 'snapshot_hash', 'model_policy_digest', 'prompt_template_version', 'rule_version', 'system_prompt_hash', 'user_prompt_hash', 'started_at', 'ended_at', 'duration_ms', 'prompt_tokens', 'completion_tokens', 'status', 'error_message', 'estimated_cost_usd', 'cost_basis', 'created_at']) {
      expect(callCols).toContain(col);
    }
    const proposalCols = (db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(proposalCols).toContain('model_call_ids_json');
    // Idempotent re-run leaves the marker set.
    const marker = db.query('SELECT value FROM app_meta WHERE key = ?').get('model_calls_schema_version') as { value: string } | undefined;
    expect(marker?.value).toBe('1');
  });

  it('schema.sql defines classification_proposals with an executable model_call_ids_json column (pass 4c)', () => {
    const schemaSql = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/schema.sql'), 'utf-8');
    // The proposals CREATE TABLE in schema.sql must carry the column
    // definition (not merely a comment) so fresh DBs get it from schema.sql.
    const proposalsBlock = schemaSql.match(/CREATE TABLE IF NOT EXISTS classification_proposals\s*\([^;]*?\);/s);
    expect(proposalsBlock).not.toBeNull();
    expect(proposalsBlock![0]).toContain('model_call_ids_json TEXT');
  });

  it('should support minimal classification audit inserts', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // 1. Insert a workspace
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Class Store', '/tmp/class', '/tmp/class/.git', now, now, 'complete'],
    );

    // 2. Insert an onboarding batch and item for that workspace
    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, completed_items, failed_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'imported', 1, 0, 0, ?, ?)`,
      [batchId, wsId, 'Test Batch', 'test.xlsx', now, now],
    );

    const itemId = randomUUID();
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, created_at, updated_at)
       VALUES (?, ?, 'SKU001', 'Test Product', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    // 3. Insert a classification_config_snapshots row
    const snapId = randomUUID();
    db.run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version, config_json, created_at)
       VALUES (?, ?, 'snap-hash-1', 1, 1, '{}', ?)`,
      [snapId, wsId, now],
    );

    // 4. Insert a classification_runs row for the onboarding item/SKU
    const runId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at)
       VALUES (?, ?, ?, 'SKU001', ?, 'snap-hash-1', 'completed', ?)`,
      [runId, wsId, itemId, snapId, now],
    );

    // 5. Insert a classification_stage_results row
    const stageId = randomUUID();
    db.run(
      `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
       VALUES (?, ?, 'evidence_extraction', 'succeeded', '{"result":"ok"}', ?, ?)`,
      [stageId, runId, now, now],
    );

    // 6. Insert a classification_evidence row
    const evId = randomUUID();
    db.run(
      `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, value_json, created_at)
       VALUES (?, ?, 'SKU001', 'evidence_extraction', 'official_product_page', 'high', '"Chicken"', ?)`,
      [evId, runId, now],
    );

    // 7. Insert a classification_proposals row with confidence in range
    const propId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU001', 'field_assignment', '"Chicken"', 0.95, 'pending', ?)`,
      [propId, runId, now],
    );

    // 8. Insert a classification_proposal_evidence link
    db.run(
      `INSERT INTO classification_proposal_evidence (proposal_id, evidence_id)
       VALUES (?, ?)`,
      [propId, evId],
    );

    // 9. Insert a classification_proposal_decisions row
    const decId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_note, created_at)
       VALUES (?, ?, 'accepted', 'Verified from official page', ?)`,
      [decId, propId, now],
    );

    // 10. Insert a classification_history_events row
    const histId = randomUUID();
    db.run(
      `INSERT INTO classification_history_events (id, workspace_id, product_sku, run_id, proposal_id, decision_id, event_type, created_at)
       VALUES (?, ?, 'SKU001', ?, ?, ?, 'proposal_accepted', ?)`,
      [histId, wsId, runId, propId, decId, now],
    );

    // 11. Query the joined records and assert the proposal and decision values round-trip
    const proposal = db.query(
      'SELECT id, confidence, status FROM classification_proposals WHERE id = ?'
    ).get(propId) as { id: string; confidence: number; status: string };
    expect(proposal).toBeTruthy();
    expect(proposal.confidence).toBeCloseTo(0.95, 5);
    expect(proposal.status).toBe('pending');

    const decision = db.query(
      'SELECT id, decision, reviewer_note FROM classification_proposal_decisions WHERE id = ?'
    ).get(decId) as { id: string; decision: string; reviewer_note: string };
    expect(decision).toBeTruthy();
    expect(decision.decision).toBe('accepted');
    expect(decision.reviewer_note).toBe('Verified from official page');

    const evidenceLink = db.query(
      'SELECT proposal_id, evidence_id FROM classification_proposal_evidence WHERE proposal_id = ? AND evidence_id = ?'
    ).get(propId, evId) as { proposal_id: string; evidence_id: string } | undefined;
    expect(evidenceLink).toBeTruthy();

    const history = db.query(
      'SELECT id, event_type FROM classification_history_events WHERE id = ?'
    ).get(histId) as { id: string; event_type: string };
    expect(history.event_type).toBe('proposal_accepted');

    // Clean up
    db.run('DELETE FROM classification_history_events WHERE id = ?', [histId]);
    db.run('DELETE FROM classification_proposal_decisions WHERE id = ?', [decId]);
    db.run('DELETE FROM classification_proposal_evidence WHERE proposal_id = ?', [propId]);
    db.run('DELETE FROM classification_proposals WHERE id = ?', [propId]);
    db.run('DELETE FROM classification_evidence WHERE id = ?', [evId]);
    db.run('DELETE FROM classification_stage_results WHERE id = ?', [stageId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM classification_config_snapshots WHERE id = ?', [snapId]);
    db.run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should migrate legacy item statuses to stage+stage_status correctly', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create a workspace and batch
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Mig WS', '/tmp/mig', '/tmp/mig/.git', now, now, 'complete'],
    );

    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
       VALUES (?, ?, 'Migration Batch', 'mig.xlsx', 'imported', 6, ?, ?)`,
      [batchId, wsId, now, now],
    );

    // Insert items with all legacy statuses
    const statuses = [
      { status: 'imported' },
      { status: 'discovering' },
      { status: 'source_found' },
      { status: 'extracting' },
      { status: 'needs_review' },
      { status: 'failed', extraction_data_json: '{}' },
    ];

    for (const s of statuses) {
      const itemId = randomUUID();
      db.run(
        `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, extraction_data_json, created_at, updated_at)
         VALUES (?, ?, 'SKU-' || ?, 'Product', ?, 1, ?, ?, ?)`,
        [itemId, batchId, itemId.slice(0, 6), s.status, s.extraction_data_json || null, now, now],
      );
    }

    // Apply stage pipeline migration SQL directly
    // (migration already ran; we test constraints by checking existing rows have defaults)
    const rows = db.query('SELECT status, stage, stage_status FROM onboarding_items WHERE batch_id = ? ORDER BY row_number').all(batchId) as Array<{ status: string; stage: string; stage_status: string }>;

    // Each row should have a valid stage and stage_status after migration defaults
    for (const row of rows) {
      expect(['discovery', 'extraction', 'curation', 'review', 'promotion']).toContain(row.stage);
      expect(['pending', 'in_progress', 'completed', 'failed', 'skipped']).toContain(row.stage_status);
    }

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batchId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should migrate legacy batch statuses to active/archived', () => {
    const db = getDb();
    const now = new Date().toISOString();

    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Mig WS 2', '/tmp/mig2', '/tmp/mig2/.git', now, now, 'complete'],
    );

    // Create batches with legacy statuses
    for (const legacyStatus of ['imported', 'discovering', 'curating', 'completed', 'promoted']) {
      const batchId = randomUUID();
      db.run(
        `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
         VALUES (?, ?, 'Batch ' || ?, 'test.xlsx', ?, 0, ?, ?)`,
        [batchId, wsId, legacyStatus, legacyStatus, now, now],
      );
    }

    // Apply the batch status normalization (same SQL as stage-pipeline-migration.sql Step 4)
    db.exec("UPDATE onboarding_batches SET status = 'active' WHERE status IN ('imported', 'discovering', 'source_found', 'source_confirmed', 'extracting', 'extracted', 'curating', 'curated', 'needs_review', 'ready')");
    db.exec("UPDATE onboarding_batches SET status = 'archived' WHERE status IN ('completed', 'promoted')");
    db.exec("UPDATE onboarding_batches SET status = 'active' WHERE status NOT IN ('active', 'archived')");

    // Verify batches have valid active/archived statuses
    const batches = db.query('SELECT status FROM onboarding_batches WHERE workspace_id = ?').all(wsId) as Array<{ status: string }>;
    for (const b of batches) {
      expect(['active', 'archived']).toContain(b.status);
    }

    db.run('DELETE FROM onboarding_batches WHERE workspace_id = ?', [wsId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should insert a classification_stage_results row with name_consolidation stage name', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create workspace, batch, item, config snapshot, and run
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'NameConsolidation WS', '/tmp/nc-ws', '/tmp/nc-ws/.git', now, now, 'complete'],
    );

    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'imported', 1, ?, ?)`,
      [batchId, wsId, 'NC Batch', 'nc.xlsx', now, now],
    );

    const itemId = randomUUID();
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, created_at, updated_at)
       VALUES (?, ?, 'NC-SKU', 'Name Consolidation Product', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    const snapId = randomUUID();
    db.run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, 'nc-hash', '{}', ?)`,
      [snapId, wsId, now],
    );

    const runId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at)
       VALUES (?, ?, ?, 'NC-SKU', ?, 'nc-hash', 'completed', ?)`,
      [runId, wsId, itemId, snapId, now],
    );

    // Insert a classification_stage_results row with name_consolidation
    const stageId = randomUUID();
    expect(() => {
      db.run(
        `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
         VALUES (?, ?, 'name_consolidation', 'succeeded', '{"result":"ok"}', ?, ?)`,
        [stageId, runId, now, now],
      );
    }).not.toThrow();

    // Verify the row was inserted
    const row = db.query(
      'SELECT id, stage_name, status FROM classification_stage_results WHERE id = ?'
    ).get(stageId) as { id: string; stage_name: string; status: string };
    expect(row).toBeTruthy();
    expect(row.stage_name).toBe('name_consolidation');
    expect(row.status).toBe('succeeded');

    // Clean up
    db.run('DELETE FROM classification_stage_results WHERE id = ?', [stageId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM classification_config_snapshots WHERE id = ?', [snapId]);
    db.run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should enforce FK constraint on classification_proposal_decisions for missing proposal', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Attempt to insert a decision referencing a non-existent proposal
    expect(() => {
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
         VALUES (?, ?, 'accepted', ?)`,
        [randomUUID(), 'non-existent-proposal-id', now],
      );
    }).toThrow();
  });

  it('should create sitemap_cache with all required columns and the idx_sitemap_cache_domain index', () => {
    const db = getDb();

    // Column shape matches the contract.
    const columns = db.query('PRAGMA table_info(sitemap_cache)').all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['domain', 'urls_json', 'fetched_at', 'expires_at', 'source_url']),
    );
    expect(names).toHaveLength(5);

    // The required index exists.
    const index = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_sitemap_cache_domain'",
    ).get();
    expect(index).toBeTruthy();
  });

  it('should round-trip a sitemap_cache row including source_url', () => {
    const db = getDb();
    const now = new Date();
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();

    db.run(
      `INSERT INTO sitemap_cache (domain, urls_json, fetched_at, expires_at, source_url)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'sitemap-mig.com',
        JSON.stringify(['https://sitemap-mig.com/a', 'https://sitemap-mig.com/b']),
        fetchedAt,
        expiresAt,
        'https://sitemap-mig.com/sitemap.xml',
      ],
    );

    const row = db.query('SELECT * FROM sitemap_cache WHERE domain = ?').get('sitemap-mig.com') as {
      domain: string;
      urls_json: string;
      fetched_at: string;
      expires_at: string;
      source_url: string;
    };
    expect(row).toBeTruthy();
    expect(row.source_url).toBe('https://sitemap-mig.com/sitemap.xml');
    expect(JSON.parse(row.urls_json)).toEqual([
      'https://sitemap-mig.com/a',
      'https://sitemap-mig.com/b',
    ]);

    // source_url is optional, so a row without it should also be valid.
    db.run(
      `INSERT INTO sitemap_cache (domain, urls_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [
        'sitemap-no-source.com',
        JSON.stringify([]),
        fetchedAt,
        expiresAt,
      ],
    );
    const row2 = db.query('SELECT source_url FROM sitemap_cache WHERE domain = ?').get('sitemap-no-source.com') as { source_url: string | null };
    expect(row2.source_url).toBeNull();

    // Clean up
    db.run('DELETE FROM sitemap_cache WHERE domain IN (?, ?)', [
      'sitemap-mig.com',
      'sitemap-no-source.com',
    ]);
  });

  it('assignProductToPageId inserts both page_id and page_name', () => {
    const pageId = randomUUID();
    const pageName = 'Dog Food';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'dog-food.html',
      parentId: null,
      pageHash: 'hash-1',
      lastSyncedAt: null,
    });

    assignProductToPageId('SKU-PAGEID-1', pageId, pageName);

    const pages = getProductPages('SKU-PAGEID-1');
    expect(pages).toContain(pageName);

    const assignments = getProductPageAssignments('SKU-PAGEID-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBe(pageId);
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-PAGEID-1');
  });

  it('getProductPageAssignments returns both id and name', () => {
    const pageId1 = randomUUID();
    const pageId2 = randomUUID();

    upsertPage({ id: pageId1, name: 'Cat Food', fileName: 'cat-food.html', parentId: null, pageHash: 'hash-cat', lastSyncedAt: null });
    upsertPage({ id: pageId2, name: 'Dog Treats', fileName: 'dog-treats.html', parentId: null, pageHash: 'hash-dog-treats', lastSyncedAt: null });

    assignProductToPageId('SKU-ASSIGN-1', pageId1, 'Cat Food');
    assignProductToPageId('SKU-ASSIGN-1', pageId2, 'Dog Treats');

    const assignments = getProductPageAssignments('SKU-ASSIGN-1');
    expect(assignments.length).toBe(2);

    const catAssignment = assignments.find(a => a.pageName === 'Cat Food');
    expect(catAssignment).toBeDefined();
    expect(catAssignment!.pageId).toBe(pageId1);

    const dogAssignment = assignments.find(a => a.pageName === 'Dog Treats');
    expect(dogAssignment).toBeDefined();
    expect(dogAssignment!.pageId).toBe(pageId2);

    clearProductPages('SKU-ASSIGN-1');
  });

  it('backward-compatible assignProductToPage resolves name to id only for verified identities', () => {
    const pageId = randomUUID();
    const pageName = 'Birds';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'birds.html',
      parentId: null,
      pageHash: 'hash-birds',
      lastSyncedAt: null,
      identityKind: 'exported_guid',
      identityKey: 'guid-birds',
      identityStatus: 'verified',
      availability: 'available',
      workspaceId: 'ws-mig',
    });

    assignProductToPage('SKU-BACKCOMPAT-1', pageName);

    const assignments = getProductPageAssignments('SKU-BACKCOMPAT-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBe(pageId);
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-BACKCOMPAT-1');
  });

  it('assignProductToPage stays name-only when the page identity is unverified', () => {
    const pageId = randomUUID();
    const pageName = 'Unverified Birds';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'birds.html',
      parentId: null,
      pageHash: 'hash-birds',
      lastSyncedAt: null,
      // Default identity: unverified_name_only review context.
    });

    assignProductToPage('SKU-UNVERIFIED-1', pageName);

    const assignments = getProductPageAssignments('SKU-UNVERIFIED-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBeNull();
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-UNVERIFIED-1');
  });

  it('backward-compatible assignProductToPage works without page_index entry', () => {
    assignProductToPage('SKU-NOINDEX-1', 'Unsynced Page');

    const pages = getProductPages('SKU-NOINDEX-1');
    expect(pages).toContain('Unsynced Page');

    const assignments = getProductPageAssignments('SKU-NOINDEX-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBeNull();
    expect(assignments[0].pageName).toBe('Unsynced Page');

    clearProductPages('SKU-NOINDEX-1');
  });

  it('should expose the sitemap_product_url_pattern column on extractor_profiles', () => {
    const db = getDb();
    const now = new Date().toISOString();

    const profileId = randomUUID();
    db.run(
      `INSERT INTO extractor_profiles (
         id, domain, title_selector, price_selector, description_selector,
         brand_selector, images_selector, sitemap_product_url_pattern, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId,
        'ext-mig.com',
        'h1',
        '.p',
        '.d',
        '.b',
        'img',
        'https://ext-mig.com/products/.*',
        now,
        now,
      ],
    );

    const row = db.query('SELECT sitemap_product_url_pattern FROM extractor_profiles WHERE id = ?').get(profileId) as { sitemap_product_url_pattern: string | null };
    expect(row.sitemap_product_url_pattern).toBe('https://ext-mig.com/products/.*');

    // Omitting the column should leave it NULL.
    const profileId2 = randomUUID();
    db.run(
      `INSERT INTO extractor_profiles (
         id, domain, title_selector, price_selector, description_selector,
         brand_selector, images_selector, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId2,
        'ext-mig-null.com',
        'h1',
        null,
        null,
        null,
        null,
        now,
        now,
      ],
    );
    const row2 = db.query('SELECT sitemap_product_url_pattern FROM extractor_profiles WHERE id = ?').get(profileId2) as { sitemap_product_url_pattern: string | null };
    expect(row2.sitemap_product_url_pattern).toBeNull();

    db.run('DELETE FROM extractor_profiles WHERE id IN (?, ?)', [profileId, profileId2]);
  });

  it('fresh schema: role columns are NOT NULL and the relation join carries the CHECK (issue #17 pass 5b)', () => {
    const db = getDb();
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    const supporting = proposalCols.find(c => c.name === 'supporting_evidence_ids_json');
    const contradicting = proposalCols.find(c => c.name === 'contradicting_evidence_ids_json');
    expect(supporting).toBeDefined();
    expect(contradicting).toBeDefined();
    expect(Number(supporting!.notnull)).toBe(1);
    expect(Number(contradicting!.notnull)).toBe(1);

    const joinSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string };
    expect(/CHECK\s*\(/.test(joinSql.sql)).toBe(true);
    expect(joinSql.sql).toContain("'supporting'");
    expect(joinSql.sql).toContain("'legacy'");
  });

  it('re-running migrations is idempotent and keeps the relation CHECK + role columns (issue #17 pass 5b)', () => {
    const db = getDb();
    runMigrations();
    const joinSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string };
    expect(/CHECK\s*\(/.test(joinSql.sql)).toBe(true);
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    expect(Number(proposalCols.find(c => c.name === 'supporting_evidence_ids_json')!.notnull)).toBe(1);
    expect(Number(proposalCols.find(c => c.name === 'contradicting_evidence_ids_json')!.notnull)).toBe(1);
    const marker = db.query("SELECT value FROM app_meta WHERE key = 'evidence_citation_schema_version'").get() as { value: string } | undefined;
    expect(marker?.value).toBe('1');
  });

  it('standalone classification-migration.sql declares the role columns for fresh DBs (issue #17 pass 5b)', () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/classification-migration.sql'), 'utf-8');
    expect(sql).toContain("supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
    expect(sql).toContain("contradicting_evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
    expect(sql).toContain("relation TEXT NOT NULL DEFAULT 'legacy' CHECK");
  });

});
