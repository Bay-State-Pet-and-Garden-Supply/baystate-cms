import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getWeeklyReportItems } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The weekly route's quality section must never touch the live catalog DB:
// getCurrentWorkspace() unconditionally calls migrateLegacyWorkspaceIfNeeded()
// when no workspace is found, which re-points the connection at
// storage/catalog/.shopsite-cms/app.db and runs migrations on it. This suite
// therefore seeds a workspace in its own isolated throwaway DB so the lookup
// short-circuits before that fallback. (bun:test's mock.module cannot be
// scoped reliably in Bun 1.3.x — file scope breaks for modules with their own
// imports and mock.restore() cannot un-register a module mock — so module
// mocks are not usable here.)

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

  it('keeps existing item-query behavior intact when quality summary data exists (issue #17 F)', async () => {
    const db = getDb();
    const batchId = randomUUID();
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    insertWorkspace({
      id: 'ws-quality',
      name: 'Quality WS',
      workspacePath: '/tmp/quality',
      gitPath: '/tmp/quality/.git',
      createdAt: tenDaysAgo,
      updatedAt: tenDaysAgo,
      bootstrapStatus: 'complete',
      baselineCommit: 'main',
    });

    db.query(`
      INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, created_at, updated_at)
      VALUES (?, 'ws-quality', 'Weekly Batch', 'items.csv', 'active', ?, ?)
    `).run(batchId, tenDaysAgo, tenDaysAgo);

    const itemId = randomUUID();
    db.query(`
      INSERT INTO onboarding_items (id, batch_id, upc, name, expected_name, brand_hint, status, stage, stage_status, row_number, created_at, updated_at)
      VALUES (?, ?, '111222333444', 'Quality Product', 'Quality Product Title', 'Acme', 'promoted', 'promotion', 'completed', 1, ?, ?)
    `).run(itemId, batchId, threeDaysAgo, threeDaysAgo);

    // Compute the window BEFORE creating the run so its started_at (now)
    // falls inside the window; a small buffer covers sub-second skew.
    const startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const endIso = new Date(now.getTime() + 60 * 1000).toISOString();

    // Seed a completed classification run + proposal + decision inside the window
    // so a quality summary is non-trivial (the weekly-report endpoint wires the
    // same pure metrics builder).
    const { createRun, completeRun } = await import('../../db/repositories/classification-run-repo');
    const { getQualityRunIds } = await import('../../db/repositories/classification-metrics-repo');
    const hash = 'c'.repeat(64);
    const run = createRun('ws-quality', 'SKU-QUAL', null, hash, { sourceKind: 'onboarding', sourceProductHash: 'pq' });
    completeRun(run.id, 'completed');

    const runIds = getQualityRunIds('ws-quality', startIso, endIso);
    expect(runIds).toContain(run.id);

    // Item behavior unchanged: the item is still returned.
    const items = getWeeklyReportItems(startIso, endIso);
    expect(items.some(i => i.id === itemId)).toBe(true);
  });

  it('reports an honest quality section for an empty window (issue #17 F note B): 200 with n/a coverage — never a fabricated 0.0%', async () => {
    // No module mock here: bun:test's mock.module cannot be scoped reliably in
    // Bun 1.3.x (file scope breaks for modules with their own imports, and
    // mock.restore() cannot un-register a module mock), so any module mock
    // would leak into unrelated Bun suites sharing the process. Instead this
    // test seeds a workspace in the isolated throwaway DB: getCurrentWorkspace()
    // short-circuits on the first findWorkspace() hit and never reaches
    // migrateLegacyWorkspaceIfNeeded(), so the live storage/catalog DB is
    // never touched by the suite.
    insertWorkspace({
      id: 'ws-empty',
      name: 'Empty Window Test',
      workspacePath: TEST_DB_PATH,
      gitPath: TEST_DB_PATH,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    // One ELIGIBLE run (v2 snapshot with an enabled target, terminal status)
    // but ZERO proposals: decision-eligible runs = 0, eligible runs = 1.
    // The pre-pass-7b display code returned fmtPercent(0/1) = '0.0%' here — a
    // fabricated coverage zero; the honest display is 'n/a'. This fixture is
    // the exact regression the pass-7b fix guards.
    const hash = 'a'.repeat(64);
    getDb().run(
      `INSERT INTO classification_config_snapshots
       (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'snap-1',
        'ws-empty',
        hash,
        JSON.stringify({
          schemaVersion: 2,
          snapshotHash: hash,
          config: { curationTargets: [{ id: 'pt-food', enabled: true }] },
        }),
        new Date().toISOString(),
      ],
    );
    getDb().run(
      `INSERT INTO classification_runs
       (id, workspace_id, source_kind, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at, completed_at)
       VALUES (?, ?, 'onboarding', 'SKU-1', 'snap-1', ?, 'completed', ?, ?)`,
      [
        'run-1',
        'ws-empty',
        hash,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      ],
    );
    const { Hono } = await import('hono');
    const { default: onboardingRoutes } = await import('../../server/routes/onboarding-routes');
    const app = new Hono();
    app.route('/api', onboardingRoutes);

    const res = await app.request('/api/onboarding/weekly-report');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qualitySummary).not.toBeNull();
    const coverageRow = body.qualitySummary.summaryRows.find((r: any) => r.label === 'Coverage');
    // Honest n/a when an eligible run produced no decision-eligible proposal —
    // the old display returned the fabricated 0.0% for exactly this fixture
    // (eligibleRuns=1, decisionEligibleRuns=0); the pass-7b fix makes it 'n/a'.
    expect(coverageRow.value).toBe('n/a');
    expect(body.qualitySummary.warnings.some((w: string) => /decision-eligible proposal/.test(w))).toBe(true);
  });
});
