/**
 * e03s01 Task4 historical runs remain readable — DB additive test (bun test) (story: e03s01)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, getPiRun } from '../../db/repositories/product-intelligence-repo';

describe('historical PI runs readable after additive changes', () => {
  let wsPath: string;
  const wsId = 'ws-additive-test';
  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `e03-additive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    getDb().run(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status) VALUES (?, 'WS', ?, '', ?, ?, 'complete')`, [wsId, wsPath, new Date().toISOString(), new Date().toISOString()]);
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });
  it('old single-agent run still queryable after shadow/eval tables added', () => {
    const run = createPiRun({ workspaceId: wsId, mode: 'shadow', executor: 'pi', inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA' }), policyJson: JSON.stringify({ configId: 'c' }), configSnapshotId: 'c', configSnapshotHash: 'c' });
    const loaded = getPiRun(run.id);
    expect(loaded?.id).toBe(run.id);
    // Additive tables must not break read path — nullable new cols/tables only.
    const tables = getDb().query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('product_intelligence_runs','pi_evaluation_runs','shadow_comparisons')`).all() as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toContain('product_intelligence_runs');
  });
});
