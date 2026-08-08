import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getWeeklyReportItems } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB_PATH = path.join(__dirname, 'weekly-report-test.db');

describe('getWeeklyReportItems', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    process.env.SHOPSITE_CMS_DB_PATH = TEST_DB_PATH;
    initDb(TEST_DB_PATH);
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    delete process.env.SHOPSITE_CMS_DB_PATH;
  });

  it('queries items created or updated within specified ISO date range', () => {
    const db = getDb();
    const batchId = randomUUID();
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertWorkspace({
      id: 'ws1',
      name: 'Test Workspace',
      workspacePath: '/tmp/test',
      gitPath: '/tmp/test/.git',
      createdAt: tenDaysAgo,
      updatedAt: tenDaysAgo,
      bootstrapStatus: 'complete',
      baselineCommit: 'main',
    });

    db.query(`
      INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, created_at, updated_at)
      VALUES (?, 'ws1', 'Weekly Batch', 'items.csv', 'active', ?, ?)
    `).run(batchId, tenDaysAgo, tenDaysAgo);

    // Recent item (3 days ago)
    const recentItemId = randomUUID();
    db.query(`
      INSERT INTO onboarding_items (id, batch_id, upc, name, expected_name, brand_hint, status, stage, stage_status, row_number, created_at, updated_at)
      VALUES (?, ?, '123456789012', 'Recent Product', 'Recent Product Title', 'Acme', 'promoted', 'promotion', 'completed', 1, ?, ?)
    `).run(recentItemId, batchId, threeDaysAgo, threeDaysAgo);

    // Old item (10 days ago)
    const oldItemId = randomUUID();
    db.query(`
      INSERT INTO onboarding_items (id, batch_id, upc, name, expected_name, brand_hint, status, stage, stage_status, row_number, created_at, updated_at)
      VALUES (?, ?, '987654321098', 'Old Product', 'Old Product Title', 'BrandX', 'promoted', 'promotion', 'completed', 2, ?, ?)
    `).run(oldItemId, batchId, tenDaysAgo, tenDaysAgo);

    const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    const items = getWeeklyReportItems(sevenDaysAgoIso, nowIso);
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(recentItemId);
    expect(items[0].name).toBe('Recent Product Title');
    expect(items[0].brandHint).toBe('Acme');
    expect(items[0].batchName).toBe('Weekly Batch');
  });
});
