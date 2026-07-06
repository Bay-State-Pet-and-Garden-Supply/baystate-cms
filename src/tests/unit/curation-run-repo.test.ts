import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createCurationRun,
  getCurationRun,
  updateCurationRunStatus,
  incrementCurationRunCompleted,
  incrementCurationRunFailed,
  updateCurationRunProgress,
  listCurationRuns,
  createCurationRunItem,
  getCurationRunItems,
  getCurationRunItem,
  updateCurationRunItemStatus,
  incrementCurationRunItemRetry,
  markCurationRunItemRunning,
  createCurationRunGroup,
  getCurationRunGroups,
  recordModelCall,
  getModelCallsForRun,
} from '../../db/repositories/curation-run-repo';

describe('Curation Run Repository — Phase 8A Batch Orchestration', () => {
  const testDbPath = '/tmp/shopsite-cms-curation-run-test.db';
  const now = () => new Date().toISOString();

  /** Create a workspace and return its id */
  function createTestWorkspace(): string {
    const id = randomUUID();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Test WS ' + id.slice(0, 6), '/tmp/test-' + id.slice(0, 6), '/tmp/test-' + id.slice(0, 6) + '/.git', now(), now(), 'complete'],
    );
    return id;
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('creates a curation run', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 5 });
    expect(run).toBeDefined();
    expect(run.id).toBeTruthy();
    expect(run.workspaceId).toBe(wsId);
    expect(run.status).toBe('queued');
    expect(run.totalItems).toBe(5);
    expect(run.completedItems).toBe(0);
    expect(run.failedItems).toBe(0);
    expect(run.startedAt).toBeTruthy();
  });

  it('gets a curation run by id', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 3 });
    const fetched = getCurationRun(run.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(run.id);
    expect(fetched!.workspaceId).toBe(wsId);
    expect(fetched!.totalItems).toBe(3);
  });

  it('returns null for missing run', () => {
    const result = getCurationRun('nonexistent-id');
    expect(result).toBeNull();
  });

  it('updates curation run status and completed/failed counts', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 10 });

    incrementCurationRunCompleted(run.id);
    incrementCurationRunCompleted(run.id);
    incrementCurationRunFailed(run.id);

    updateCurationRunStatus(run.id, 'completed');

    const fetched = getCurationRun(run.id);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.completedItems).toBe(2);
    expect(fetched!.failedItems).toBe(1);
    expect(fetched!.completedAt).toBeTruthy();
  });

  it('updates curation run progress json', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 5 });

    updateCurationRunProgress(run.id, JSON.stringify({ stage: 'name_consolidation', itemId: 'item-1', message: 'Processing' }));

    const fetched = getCurationRun(run.id);
    expect(fetched!.progressJson).toBeTruthy();
    const parsed = JSON.parse(fetched!.progressJson!);
    expect(parsed.stage).toBe('name_consolidation');
  });

  it('lists curation runs for workspace filtered by status', () => {
    const wsId = createTestWorkspace();
    createCurationRun({ workspaceId: wsId, totalItems: 2 });
    createCurationRun({ workspaceId: wsId, totalItems: 3 });

    const runs = listCurationRuns(wsId);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every(r => r.workspaceId === wsId)).toBe(true);
  });

  it('lists curation runs filtered by status', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });
    updateCurationRunStatus(run.id, 'failed', 'Something went wrong');

    const failed = listCurationRuns(wsId, 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.some(r => r.id === run.id)).toBe(true);
    expect(failed[0].errorMessage).toBeTruthy();
  });

  it('creates curation run items', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 2 });

    const item1 = createCurationRunItem(run.id, 'SKU-001', 'onboarding-item-1');
    const item2 = createCurationRunItem(run.id, 'SKU-002', 'onboarding-item-2');

    expect(item1.sku).toBe('SKU-001');
    expect(item2.sku).toBe('SKU-002');
    expect(item1.status).toBe('queued');
    expect(item1.attemptCount).toBe(0);

    const items = getCurationRunItems(run.id);
    expect(items.length).toBe(2);
  });

  it('gets a curation run item by id', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });
    const item = createCurationRunItem(run.id, 'SKU-GET', 'item-get');

    const fetched = getCurationRunItem(item.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(item.id);
    expect(fetched!.sku).toBe('SKU-GET');
  });

  it('updates curation run item status', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });
    const item = createCurationRunItem(run.id, 'SKU-UPDATE', 'item-update');

    updateCurationRunItemStatus(item.id, 'running');
    const afterRunning = getCurationRunItem(item.id);
    expect(afterRunning!.status).toBe('running');

    updateCurationRunItemStatus(item.id, 'completed');
    const afterCompleted = getCurationRunItem(item.id);
    expect(afterCompleted!.status).toBe('completed');
    expect(afterCompleted!.completedAt).toBeTruthy();
  });

  it('increments curation run item retry count', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });
    const item = createCurationRunItem(run.id, 'SKU-RETRY', 'item-retry');

    const count1 = incrementCurationRunItemRetry(item.id);
    expect(count1).toBe(1);

    const count2 = incrementCurationRunItemRetry(item.id);
    expect(count2).toBe(2);
  });

  it('marks curation run item running and increments retry', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });
    const item = createCurationRunItem(run.id, 'SKU-RUNNING', 'item-running');

    markCurationRunItemRunning(item.id);
    const after = getCurationRunItem(item.id);
    expect(after!.status).toBe('running');
    expect(after!.attemptCount).toBe(1);
  });

  it('creates and retrieves curation run groups', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 3 });

    const group = createCurationRunGroup(run.id, 'group-dog-food', 'Dry Dog Food', ['SKU-001', 'SKU-002']);
    expect(group.groupId).toBe('group-dog-food');
    expect(group.groupLabel).toBe('Dry Dog Food');

    const groups = getCurationRunGroups(run.id);
    expect(groups.length).toBe(1);
    const skus = JSON.parse(groups[0].skusJson);
    expect(skus).toEqual(['SKU-001', 'SKU-002']);
  });

  it('records and retrieves model calls', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });

    const call = recordModelCall({
      runId: run.id,
      runItemId: undefined,
      task: 'product_type_classification',
      provider: 'ollama',
      model: 'llama3',
      promptTokens: 150,
      completionTokens: 5,
      durationMs: 1200,
      status: 'success',
    });

    expect(call.task).toBe('product_type_classification');
    expect(call.provider).toBe('ollama');
    expect(call.promptTokens).toBe(150);
    expect(call.durationMs).toBe(1200);

    const calls = getModelCallsForRun(run.id);
    expect(calls.length).toBe(1);
    expect(calls[0].status).toBe('success');
  });

  it('records a failed model call', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 1 });

    const call = recordModelCall({
      runId: run.id,
      task: 'category_page_assignment',
      provider: 'deepseek',
      model: 'deepseek-chat',
      status: 'failed',
      errorMessage: 'Rate limit exceeded',
    });

    expect(call.status).toBe('failed');
    expect(call.errorMessage).toBe('Rate limit exceeded');

    const calls = getModelCallsForRun(run.id);
    expect(calls.some(c => c.status === 'failed')).toBe(true);
  });

  it('cancels a curation run with error message', () => {
    const wsId = createTestWorkspace();
    const run = createCurationRun({ workspaceId: wsId, totalItems: 5 });

    updateCurationRunStatus(run.id, 'cancelled', 'Operator cancelled');

    const fetched = getCurationRun(run.id);
    expect(fetched!.status).toBe('cancelled');
    expect(fetched!.errorMessage).toBe('Operator cancelled');
    expect(fetched!.completedAt).toBeTruthy();
  });

  it('supports full lifecycle: create → process items → complete', () => {
    const wsId = createTestWorkspace();

    // Create run with 3 items
    const run = createCurationRun({ workspaceId: wsId, totalItems: 3 });
    expect(run.status).toBe('queued');

    // Create items
    const item1 = createCurationRunItem(run.id, 'SKU-LIFE-1', 'item-life-1');
    const item2 = createCurationRunItem(run.id, 'SKU-LIFE-2', 'item-life-2');
    const item3 = createCurationRunItem(run.id, 'SKU-LIFE-3', 'item-life-3');

    // Mark running and complete each
    for (const item of [item1, item2, item3]) {
      markCurationRunItemRunning(item.id);
      updateCurationRunItemStatus(item.id, 'completed');
      incrementCurationRunCompleted(run.id);
    }

    // Complete the run
    updateCurationRunStatus(run.id, 'completed');

    const fetched = getCurationRun(run.id);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.completedItems).toBe(3);
    expect(fetched!.failedItems).toBe(0);

    const items = getCurationRunItems(run.id);
    expect(items.every(i => i.status === 'completed')).toBe(true);
  });
});
