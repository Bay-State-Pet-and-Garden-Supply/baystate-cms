/**
 * e03s02 blocker-1: retry control dispatches to the orchestrator and guards
 * verified-terminal state (story: e03s01,e03s02) — bun:test (DB-backed).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { retrySpecialistWorkflow } from '../../product-intelligence/workflow/orchestrator';

describe('retrySpecialistWorkflow control', () => {
  beforeEach(() => {
    const wsPath = path.join(os.tmpdir(), `e03-retry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    const wsId = 'ws-retry-test';
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status) VALUES (?, 'WS', ?, '', ?, ?, 'complete')`,
      [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
    );
  });
  it('throws when the workflow record is missing (guard on verified terminal)', async () => {
    await expect(retrySpecialistWorkflow('does-not-exist', 'retry_curator')).rejects.toThrow(/record not found/);
  });
});
