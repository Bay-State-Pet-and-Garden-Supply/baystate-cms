import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { z } from 'zod';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { runStoreManagerExecution } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import { getStoreManagerEvents, createStoreManagerRunArtifact } from '../../db/repositories/store-manager-session-repo';
import { createStoreManagerArtifact } from '../../store-manager/runtime/artifacts';
import {
  listRunHistory,
  getRunHistoryDetail,
  recordReviewDecision,
  listRepeatedlyRejectedProposals,
  listRecurringInboxFingerprints,
} from '../../db/repositories/store-manager-history-repo';

/**
 * Operations console Issue 7 — run history substrate.
 * DB-backed: run under `bun test`.
 */

const workspaceId = 'ws-history';
const testDbPath = './test-history.db';

const readAdapter: StoreManagerToolAdapter = {
  name: 'h_read',
  version: 1,
  description: 'read',
  promptGuidelines: 'none',
  inputSchema: z.object({ q: z.string().max(50) }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  scopeSummary: (i) => `read ${String(i.q ?? '')}`,
  execute: async (): Promise<StoreManagerToolResult> => okResult({ itemCount: 3, issues: [{ fingerprint: 'fp-1' }] }),
};

function testRegistry() {
  return new StoreManagerToolRegistry([readAdapter]);
}

function plainModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('x');
    },
    async doStream() {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'history run ok' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, finishReason: { unified: 'stop', raw: 'stop' } },
      ];
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return model as unknown as ResolvedAiSdkModel['modelInstance'];
}

const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

async function runACommand(runId: string, objective: string): Promise<void> {
  const request = createStoreManagerExecutionRequest({
    workspaceId,
    workspacePath: './ws',
    threadId: null,
    runId,
    entrypoint: 'command',
    executionMode: 'interactive',
    objective,
  });
  const result = await runStoreManagerExecution(request, {
    registry: testRegistry(),
    resolveModel: () => ({ ...resolvedFake, modelInstance: plainModel() }),
  });
  expect(result.kind).toBe('completed');
}

describe('Store Manager run history (epic #42, Issue 7)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(`${testDbPath}${suffix}`); } catch { /* ok */ }
    }
  });

  it('lists runs with cursor pagination and joins telemetry/artifacts/events in the detail (workspace-scoped, redacted)', async () => {
    await runACommand('run-history-1', 'Run a bounded health check with secret material nearby.');
    await runACommand('run-history-2', 'Audit ProductField24 and summarize duplicates.');

    const page1 = listRunHistory(workspaceId, { limit: 1 });
    expect(page1.runs.length).toBe(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = listRunHistory(workspaceId, { limit: 10, after: page1.nextCursor });
    expect(page2.runs.length).toBeGreaterThanOrEqual(1);

    const detail = getRunHistoryDetail(workspaceId, 'run-history-1');
    expect(detail).not.toBeNull();
    expect(detail!.run.entrypoint).toBe('command');
    expect(detail!.run.objective).toContain('bounded health check');
    expect(detail!.run.modelCallId).toBeTruthy();
    expect(detail!.modelCall).not.toBeNull();
    expect(detail!.modelCall!.provider).toBe('fake-provider');
    expect(detail!.events.some((e) => (e as { type?: string }).type === 'turn_terminal')).toBe(true);
    // Redaction: the bounded objective is stored, but raw system prompt / chain
    // of thought / absolute paths / approval secrets are never persisted.
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('operating contract v2');
    expect(serialized).not.toContain('chain of thought');
    expect(serialized).not.toContain('/Users');
    expect(serialized).not.toContain('toolApprovalSecret');

    // Workspace scoping: another workspace cannot see these runs.
    expect(getRunHistoryDetail('other-ws', 'run-history-1')).toBeNull();
    expect(listRunHistory('other-ws', {}).runs.length).toBe(0);
  });

  it('history detail includes persisted run artifacts (content-addressed)', async () => {
    const artifact = createStoreManagerArtifact({
      runId: 'run-history-1',
      workspaceId,
      kind: 'report',
      schemaVersion: 1,
      content: { issues: 5, field: 'ProductField24' },
    });
    createStoreManagerRunArtifact({
      workspaceId,
      runId: 'run-history-1',
      kind: 'report',
      schemaVersion: 1,
      contentJson: JSON.stringify({ issues: 5, field: 'ProductField24' }),
      contentHash: artifact.contentHash,
      id: artifact.id,
      createdAt: artifact.createdAt,
    });
    const detail = getRunHistoryDetail(workspaceId, 'run-history-1');
    expect(detail!.artifacts.length).toBe(1);
    expect(detail!.artifacts[0].kind).toBe('report');
    expect(detail!.artifacts[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('events carry a monotonic per-workspace sequence for cursor pagination', async () => {
    const events = getStoreManagerEvents(workspaceId, 'run-history-2');
    const rows = (getDb().query(
      'SELECT sequence FROM store_manager_events WHERE workspace_id = ? AND session_id = ? ORDER BY sequence ASC',
    ).all(workspaceId, 'run-history-2') as Array<{ sequence: number }>);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].sequence).toBeGreaterThan(rows[i - 1].sequence);
    }
  });

  it('durable review decisions: repeated dismissals are counted per proposal', () => {
    for (let i = 0; i < 2; i += 1) {
      recordReviewDecision({
        workspaceId,
        proposalId: 'prop-repeat-1',
        field: 'ProductField24',
        decision: 'dismissed',
        actor: 'operator',
        runId: 'run-history-1',
      });
    }
    recordReviewDecision({
      workspaceId,
      proposalId: 'prop-single',
      field: 'ProductField9',
      decision: 'dismissed',
      actor: 'operator',
    });
    const repeated = listRepeatedlyRejectedProposals(workspaceId);
    const hit = repeated.find((r) => r.proposalId === 'prop-repeat-1');
    expect(hit).toBeDefined();
    expect(hit!.rejections).toBe(2);
    expect(hit!.decisions.length).toBe(2);
    expect(repeated.some((r) => r.proposalId === 'prop-single')).toBe(false);
    // Workspace scoping.
    expect(listRepeatedlyRejectedProposals('other-ws')).toEqual([]);
  });

  it('recurring issue fingerprints derive from the durable source-cursor substrate', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const insert = db.query(
      `INSERT INTO store_manager_source_cursors
        (id, workspace_id, source_kind, source_id, fingerprint, baseline_json,
         terminal_observed, last_observed_at, eval_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
    );
    insert.run('cursor-1', workspaceId, 'high_severity_catalog_issues', 'fp-1', 'fp-1', now, 4, now, now);
    insert.run('cursor-2', workspaceId, 'sync_failures', 'fp-9', 'fp-9', now, 1, now, now);

    const recurring = listRecurringInboxFingerprints(workspaceId);
    const hit = recurring.find((r) => r.kind === 'high_severity_catalog_issues');
    expect(hit).toBeDefined();
    expect(hit!.occurrences).toBe(4);
    expect(recurring.some((r) => r.kind === 'sync_failures')).toBe(false); // below threshold
    expect(listRecurringInboxFingerprints('other-ws')).toEqual([]);
  });
});
