/**
 * PI-10 centralized workspace budgets (issue #27): defaults are unlimited,
 * run-start budgets (concurrency/daily runs/cost/tokens) throw centrally,
 * tool-category request budgets count the daily tool-call ledger, and the
 * artifact-storage budget counts asset payload bytes.
 *
 * DB-backed (bun test).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/27
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createPiRun, insertPiToolCall, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import { sumPiDailyCost, sumPiDailyTokens } from '../../db/repositories/pi-ops-repo';
import {
  PiBudgetPolicySchema,
  checkPiRunStartBudget,
  checkPiStorageBudget,
  checkPiToolCategoryBudget,
  dayStartIso,
  getPiBudgetPolicy,
  piToolCategory,
  setPiBudgetPolicy,
} from '../../product-intelligence/budgets';
import { PiProductIntelligenceExecutor } from '../../product-intelligence/pi/pi-executor';
import { FakeSessionFactory, TEST_INPUT, testContext } from './product-intelligence/test-helpers';
import { createExecutionEventSink } from '../../product-intelligence/executor';

const workspaceId = 'ws-pi-budget-test';

function seedWorkspace(wsId: string, wsPath: string) {
  getDb().run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
    [wsId, wsPath, new Date().toISOString(), new Date().toISOString()],
  );
}

function makeRun(overrides: Partial<Parameters<typeof createPiRun>[0]> = {}) {
  return createPiRun({
    workspaceId,
    mode: 'shadow',
    executor: 'pi',
    inputJson: JSON.stringify({ gtin: '085000079585' }),
    policyJson: JSON.stringify({ configId: 'c' }),
    configSnapshotId: 'c',
    configSnapshotHash: 'c',
    ...overrides,
  });
}

describe('PI-10 workspace budgets', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `pi-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    seedWorkspace(workspaceId, wsPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(wsPath, { recursive: true, force: true });
  });

  it('defaults to an unlimited policy', () => {
    expect(getPiBudgetPolicy(workspaceId)).toEqual({});
    expect(() => checkPiRunStartBudget(workspaceId)).not.toThrow();
    expect(() => checkPiStorageBudget(workspaceId)).not.toThrow();
  });

  it('persists a validated budget policy round-trip', () => {
    const policy = setPiBudgetPolicy(workspaceId, { maxConcurrentRuns: 2, maxDailyRuns: 5 });
    expect(policy).toEqual({ maxConcurrentRuns: 2, maxDailyRuns: 5 });
    expect(getPiBudgetPolicy(workspaceId)).toEqual({ maxConcurrentRuns: 2, maxDailyRuns: 5 });
    expect(() => PiBudgetPolicySchema.parse({ maxConcurrentRuns: -1 })).toThrow();
  });

  it('enforces the concurrent-run budget on a running run', () => {
    makeRun(); // stays running
    setPiBudgetPolicy(workspaceId, { maxConcurrentRuns: 1 });
    expect(() => checkPiRunStartBudget(workspaceId)).toThrow(/concurrent run budget exhausted \(1\/1\)/);
  });

  it('ignores completed runs for the concurrency budget', () => {
    const run = makeRun();
    transitionPiRunStatus(run.id, 'completed', {});
    setPiBudgetPolicy(workspaceId, { maxConcurrentRuns: 1 });
    expect(() => checkPiRunStartBudget(workspaceId)).not.toThrow();
  });

  it('enforces the daily-run budget from started_at', () => {
    makeRun();
    setPiBudgetPolicy(workspaceId, { maxDailyRuns: 1 });
    expect(() => checkPiRunStartBudget(workspaceId)).toThrow(/daily run budget exhausted \(1\/1\)/);
  });

  it('enforces the daily estimated-cost budget', () => {
    makeRun();
    transitionPiRunStatus(makeRun().id, 'completed', {});
    setPiBudgetPolicy(workspaceId, { maxDailyEstimatedCostUsd: 0.05 });
    // Force an estimated cost on the started-today run.
    getDb().run(`UPDATE product_intelligence_runs SET estimated_cost = 0.06 WHERE workspace_id = ?`, [workspaceId]);
    expect(() => checkPiRunStartBudget(workspaceId)).toThrow(/daily estimated cost budget exhausted/);
  });

  it('maps tools to the search/fetch/browser categories', () => {
    expect(piToolCategory('search_upc')).toBe('search');
    expect(piToolCategory('extract_product_page')).toBe('fetch');
    expect(piToolCategory('lookup_existing_product')).toBeNull();
  });

  it('enforces the daily search-request budget from the tool-call ledger', () => {
    const run = makeRun();
    for (let i = 0; i < 2; i++) {
      insertPiToolCall({ runId: run.id, stepId: null, sequence: i, toolName: 'search_upc' });
    }
    setPiBudgetPolicy(workspaceId, { maxDailySearchRequests: 2 });
    expect(() => checkPiToolCategoryBudget(workspaceId, 'search_upc')).toThrow(/daily search request budget exhausted \(2\/2\)/);
    // Unbudgeted tool: never limited by category policies.
    expect(() => checkPiToolCategoryBudget(workspaceId, 'lookup_existing_product')).not.toThrow();
  });

  it('enforces the daily fetch-request budget separately from search', () => {
    const run = makeRun();
    insertPiToolCall({ runId: run.id, stepId: null, sequence: 0, toolName: 'verify_image_candidate' });
    setPiBudgetPolicy(workspaceId, { maxDailyFetchRequests: 1, maxDailySearchRequests: 1 });
    expect(() => checkPiToolCategoryBudget(workspaceId, 'extract_product_page')).toThrow(/daily fetch request budget exhausted/);
    expect(() => checkPiToolCategoryBudget(workspaceId, 'search_upc')).not.toThrow();
  });

  it('enforces the artifact-storage budget over asset payload bytes', () => {
    setPiBudgetPolicy(workspaceId, { maxArtifactStorageBytes: 10 });
    expect(() => checkPiStorageBudget(workspaceId)).not.toThrow();
    expect(() => checkPiStorageBudget(workspaceId, 100)).toThrow(/artifact storage budget exhausted/);
  });

  it('uses a stable UTC day window', () => {
    const start = dayStartIso();
    expect(start.endsWith('T00:00:00.000Z')).toBe(true);
  });
  it('terminal transitions persist cost + token usage so daily cost budgets are live', () => {
    const run = makeRun();
    transitionPiRunStatus(run.id, 'completed', {
      actualCost: 5,
      estimatedCost: 5,
      tokenUsageJson: JSON.stringify({ input_tokens: 10, output_tokens: 20 }),
    });
    expect(sumPiDailyCost(workspaceId, dayStartIso(), 'estimated_cost')).toBe(5);
    expect(sumPiDailyCost(workspaceId, dayStartIso(), 'actual_cost')).toBe(5);
    expect(sumPiDailyTokens(workspaceId, dayStartIso())).toBe(30);
    // At the limit the run-start check refuses.
    setPiBudgetPolicy(workspaceId, { maxDailyActualCostUsd: 5 });
    expect(() => checkPiRunStartBudget(workspaceId)).toThrow(/actual cost budget exhausted/);
  });

  it('daily cost budgets persist per run and accumulate', () => {
    const a = makeRun();
    const b = makeRun();
    transitionPiRunStatus(a.id, 'completed', { actualCost: 2, estimatedCost: 2 });
    transitionPiRunStatus(b.id, 'completed', { actualCost: 3, estimatedCost: 3 });
    setPiBudgetPolicy(workspaceId, { maxDailyEstimatedCostUsd: 4 });
    expect(() => checkPiRunStartBudget(workspaceId)).toThrow(/estimated cost budget exhausted/);
  });

  it('the Pi executor enforces the workspace search budget at dispatch (fail-closed)', async () => {
    const run = makeRun({ executor: 'pi' });
    // Ledger already at the daily limit: one prior search call today.
    insertPiToolCall({ runId: run.id, sequence: 0, toolName: 'search_upc' });
    setPiBudgetPolicy(workspaceId, { maxDailySearchRequests: 1 });

    const factory = new FakeSessionFactory();
    const executor = new PiProductIntelligenceExecutor({ sessionFactory: factory });
    const events = createExecutionEventSink(run.id);
    const runPromise = executor.startResearch(TEST_INPUT, testContext({ runId: run.id }), events);
    await Promise.resolve();
    factory.created[0].emitToolStart('search_upc');
    const result = await runPromise;

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('policy_denied');
    const types = events.snapshot().map((event: { type: string }) => event.type);
    expect(types).toContain('run_failed');
  });
});
