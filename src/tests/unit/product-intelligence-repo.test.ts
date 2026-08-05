/**
 * Product Intelligence repository tests (PI-2).
 *
 * DB-backed (bun test): runs, idempotent events, derived steps/tool calls,
 * sources/evidence/conflicts, results with content hash, comparisons,
 * transition guards, cascade deletion (no orphans), retention, and migration
 * presence. Runs against a scratch database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  appendPiEvent,
  completePiStep,
  completePiToolCall,
  countPiRuns,
  createPiRun,
  deletePiRun,
  deletePiRunsOlderThan,
  getPiResult,
  getPiRun,
  insertPiComparison,
  insertPiConflict,
  insertPiEvidence,
  insertPiResult,
  insertPiSource,
  insertPiStep,
  insertPiToolCall,
  latestPiEventSequence,
  listPiConflicts,
  listPiEvents,
  listPiEvidence,
  listPiRuns,
  listPiSources,
  listPiToolCalls,
  resolvePiConflict,
  transitionPiRunStatus,
} from '../../db/repositories/product-intelligence-repo';
import { sha256Hex } from '../../shared/stable-id';
import { insertWorkspace } from '../../db/repositories/workspace-repo';

describe('Product Intelligence repositories', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-repo-test.db');
  const wsId = 'pi-test-workspace';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Test Workspace',
      workspacePath: '/tmp/pi-test-workspace',
      gitPath: '/tmp/pi-test-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function makeRun(overrides: Partial<Parameters<typeof createPiRun>[0]> = {}) {
    return createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: JSON.stringify({ gtin: '085000079585', registerName: 'STELLA CHKN BROTH 16OZ' }),
      policyJson: JSON.stringify({ configId: 'cfg-1' }),
      configSnapshotId: 'cfg-1',
      configSnapshotHash: 'cfg-1',
      codeCommit: 'deadbeef',
      ...overrides,
    });
  }

  it('migration creates the product intelligence schema version', () => {
    const db = getDb();
    const row = db
      .query("SELECT value FROM app_meta WHERE key = 'product_intelligence_schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('1');
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'product_intelligence_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'product_intelligence_comparisons',
      'product_intelligence_conflicts',
      'product_intelligence_events',
      'product_intelligence_evidence',
      'product_intelligence_results',
      'product_intelligence_runs',
      'product_intelligence_sources',
      'product_intelligence_steps',
      'product_intelligence_tool_calls',
    ]);
  });

  it('creates a run with immutable input and policy snapshot', () => {
    const run = makeRun();
    expect(run.status).toBe('running');
    expect(run.mode).toBe('shadow');
    expect(run.executor).toBe('pi');
    expect(JSON.parse(run.inputJson).gtin).toBe('085000079585');
    expect(JSON.parse(run.policyJson).configId).toBe('cfg-1');
    expect(run.configSnapshotId).toBe('cfg-1');
    expect(run.codeCommit).toBe('deadbeef');
    expect(getPiRun(run.id)?.id).toBe(run.id);
    expect(listPiRuns({ workspaceId: wsId }).some((r) => r.id === run.id)).toBe(true);
    expect(countPiRuns(wsId)).toBeGreaterThan(0);
  });

  it('transitions runs only once and rejects invalid transitions', () => {
    const run = makeRun();
    const completed = transitionPiRunStatus(run.id, 'completed', { piVersion: '0.83.0' });
    expect(completed.status).toBe('completed');
    expect(completed.piVersion).toBe('0.83.0');
    expect(() => transitionPiRunStatus(run.id, 'failed', {})).toThrow(/only running runs/);
    const failed = makeRun();
    transitionPiRunStatus(failed.id, 'failed', { errorCode: 'missing_submission', errorMessage: 'no submission' });
    expect(getPiRun(failed.id)?.errorCode).toBe('missing_submission');
    expect(() => transitionPiRunStatus(failed.id, 'completed', {})).toThrow(/only running runs/);
  });

  it('appends events idempotently by (run_id, sequence)', () => {
    const run = makeRun();
    expect(appendPiEvent(run.id, 0, 'run.started', { executor: 'pi' })).toBe(true);
    expect(appendPiEvent(run.id, 1, 'tool.started', { tool: 'read' })).toBe(true);
    // Duplicate delivery of the same sequence is ignored.
    expect(appendPiEvent(run.id, 1, 'tool.started', { tool: 'read' })).toBe(false);
    const events = listPiEvents(run.id);
    expect(events).toHaveLength(2);
    expect(events[1].sequence).toBe(1);
    expect(events[1].type).toBe('tool.started');
    expect(JSON.parse(events[1].payloadJson).tool).toBe('read');
    expect(listPiEvents(run.id, 1)).toHaveLength(0);
    expect(latestPiEventSequence(run.id)).toBe(1);
  });

  it('persists steps and tool calls attributable to the run', () => {
    const run = makeRun();
    const step = insertPiStep({ runId: run.id, stepType: 'session', sequence: 0, summary: 'created' });
    expect(step.status).toBe('running');
    completePiStep(step.id, { summary: 'done' });
    const call = insertPiToolCall({
      runId: run.id,
      stepId: step.id,
      sequence: 1,
      toolName: 'read',
      requestHash: sha256Hex('req'),
    });
    expect(call.policyOutcome).toBe('allowed');
    completePiToolCall(call.id, { isError: false, responseHash: sha256Hex('res') });
    const calls = listPiToolCalls(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('read');
    expect(calls[0].stepId).toBe(step.id);
    expect(calls[0].responseHash).toBe(sha256Hex('res'));
    expect(calls[0].latencyMs).not.toBeNull();
  });

  it('persists sources, evidence (FK to source), and conflicts', () => {
    const run = makeRun();
    const source = insertPiSource({ runId: run.id, url: 'https://supplier.example.com/p', domain: 'supplier.example.com', sourceType: 'supplier' });
    const evidence = insertPiEvidence({ runId: run.id, sourceId: source.id, targetField: 'title', value: 'Stella Broth', directSupport: true, snippet: 'quote' });
    expect(evidence.sourceId).toBe(source.id);
    expect(JSON.parse(evidence.valueJson)).toBe('Stella Broth');
    expect(evidence.directSupport).toBe(1);
    const conflict = insertPiConflict({ runId: run.id, field: 'title_conflict', severity: 'high', evidenceIds: ['e1'], competingValues: ['A', 'B'] });
    expect(conflict.status).toBe('open');
    resolvePiConflict(conflict.id, { status: 'resolved', resolution: { value: 'A' }, resolvedBy: 'reviewer-1' });
    const conflicts = listPiConflicts(run.id);
    expect(conflicts[0].status).toBe('resolved');
    expect(JSON.parse(conflicts[0].resolutionJson as string).value).toBe('A');
    expect(conflicts[0].resolvedBy).toBe('reviewer-1');
    expect(listPiSources(run.id)).toHaveLength(1);
    expect(listPiEvidence(run.id)).toHaveLength(1);
  });

  it('stores results with schema version and content hash (upsert, no duplicates)', () => {
    const run = makeRun();
    const result = { outcome: 'submitted', configId: 'cfg-1' };
    const row = insertPiResult({ runId: run.id, schemaVersion: 1, disposition: 'submitted', result });
    expect(row.schemaVersion).toBe(1);
    expect(row.resultHash).toBe(sha256Hex(JSON.stringify(result)));
    // Re-delivery upserts in place.
    insertPiResult({ runId: run.id, schemaVersion: 1, disposition: 'submitted', result: { outcome: 'submitted', configId: 'cfg-2' } });
    const db = getDb();
    const count = db.query('SELECT COUNT(*) AS c FROM product_intelligence_results WHERE run_id = ?').get(run.id) as { c: number };
    expect(Number(count.c)).toBe(1);
    expect(getPiResult(run.id)?.resultHash).toBe(sha256Hex(JSON.stringify({ outcome: 'submitted', configId: 'cfg-2' })));
  });

  it('stores comparisons with metrics', () => {
    const run = makeRun();
    const comparison = insertPiComparison({ runId: run.id, baselineType: 'legacy', baselineRef: 'legacy-run-1', metrics: { latencyMs: 12 } });
    expect(comparison.baselineType).toBe('legacy');
    expect(JSON.parse(comparison.metricsJson).latencyMs).toBe(12);
  });

  it('deletes runs with cascade and leaves no orphans', () => {
    const run = makeRun();
    appendPiEvent(run.id, 0, 'run.started', {});
    insertPiStep({ runId: run.id, stepType: 'session', sequence: 1 });
    const source = insertPiSource({ runId: run.id, url: 'https://x.example/1', domain: 'x.example', sourceType: 'other' });
    insertPiEvidence({ runId: run.id, sourceId: source.id, targetField: 'title', value: 'v' });
    insertPiResult({ runId: run.id, schemaVersion: 1, disposition: 'submitted', result: { ok: true } });
    // Running runs are protected at the repository level.
    expect(() => deletePiRun(run.id)).toThrow(/running/);
    transitionPiRunStatus(run.id, 'completed', {});
    expect(deletePiRun(run.id)).toBe(true);
    expect(getPiRun(run.id)).toBeFalsy();
    const db = getDb();
    for (const table of ['product_intelligence_events', 'product_intelligence_steps', 'product_intelligence_sources', 'product_intelligence_evidence', 'product_intelligence_results']) {
      const row = db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE run_id = ?`).get(run.id) as { c: number };
      expect(Number(row.c), table).toBe(0);
    }
  });

  it('retention deletes only terminal runs older than the cutoff', () => {
    const oldRun = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    // Force the old run into the past, then complete it.
    const db = getDb();
    db.run("UPDATE product_intelligence_runs SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [oldRun.id]);
    transitionPiRunStatus(oldRun.id, 'completed', {});
    const freshRun = makeRun();
    db.run("UPDATE product_intelligence_runs SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [freshRun.id]);
    transitionPiRunStatus(freshRun.id, 'completed', {});
    const runningRun = makeRun();

    const deleted = deletePiRunsOlderThan(wsId, '2025-01-01T00:00:00.000Z');
    expect(deleted).toBe(1);
    expect(getPiRun(oldRun.id)).toBeFalsy();
    expect(getPiRun(freshRun.id)).toBeDefined();
    expect(getPiRun(runningRun.id)).toBeDefined();
  });
});
