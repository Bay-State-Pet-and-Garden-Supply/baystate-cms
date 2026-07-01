import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations, getSchemaVersion } from '../../db/migrations';

describe('SQLite Migration', () => {
  const testDbPath = '/tmp/shopsite-cms-test.db';

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
      'app_meta', 'workspace', 'shopsite_connection', 'product_index',
      'field_registry', 'change_sets', 'change_set_items', 'validation_results',
      'sync_jobs', 'sync_job_events', 'remote_drift', 'audit_log',
      'product_types', 'product_type_fields', 'page_index', 'product_pages'
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
    ];

    for (const table of tables) {
      const row = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }
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
       VALUES (?, ?, 'evidence_extraction', 'succeeded', '{\"result\":\"ok\"}', ?, ?)`,
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
});
