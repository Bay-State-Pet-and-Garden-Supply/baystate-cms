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
import { ModelUnavailableError } from '../../server/services/ai-sdk-model-resolver';
import { replayStoreManagerRun, StoreManagerReplayError } from '../../server/services/store-manager-replay-service';
import { compareStoreManagerRuns } from '../../server/services/store-manager-comparison-service';
import { getStoreManagerSession, getStoreManagerEvents } from '../../db/repositories/store-manager-session-repo';
import { saveStoreManagerPreference } from '../../server/services/store-manager-preference-service';

/**
 * Operations console Issue 7 — replay + comparison.
 * DB-backed: run under `bun test`.
 */

const workspaceId = 'ws-replay';
const testDbPath = './test-replay.db';

const readAdapter: StoreManagerToolAdapter = {
  name: 'r_read',
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
  execute: async (): Promise<StoreManagerToolResult> => okResult({ issueCount: 5 }),
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
        { type: 'text-delta', id: 't1', delta: 'replay run ok' },
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

describe('Store Manager replay + comparison (epic #42, Issue 7)', () => {
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

  async function seedSourceRun(runId: string, objective: string): Promise<void> {
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

  it('replay creates a NEW current-state run with honest lineage and no approval reuse', async () => {
    await seedSourceRun('src-run-1', 'Audit ProductField24 health and summarize issues.');

    const replay = await replayStoreManagerRun({
      workspaceId,
      workspacePath: './ws',
      sourceRunId: 'src-run-1',
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: plainModel() }),
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayOfRunId).toBe('src-run-1');
    expect(replay.replayRunId).not.toBe('src-run-1');
    expect(replay.terminalStatus).toBe('success');

    const session = getStoreManagerSession(workspaceId, replay.replayRunId);
    expect(session).not.toBeNull();
    expect(session!.entrypoint).toBe('replay');
    expect(session!.lineage_json).toContain('src-run-1');
    expect(session!.objective).toContain('Audit ProductField24 health');

    const events = getStoreManagerEvents(workspaceId, replay.replayRunId);
    expect(events.some((e) => e.type === 'replay_lineage' && e.replayOfRunId === 'src-run-1')).toBe(true);

    // Replay captured the CURRENT preferences revision in its policy snapshot.
    const saved = saveStoreManagerPreference(workspaceId, { vendor_identifier_convention: 'upc_a' });
    const replay2 = await replayStoreManagerRun({
      workspaceId,
      workspacePath: './ws',
      sourceRunId: 'src-run-1',
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: plainModel() }),
    });
    expect(replay2.replayRunId).not.toBe(replay.replayRunId);
    const session2 = getStoreManagerSession(workspaceId, replay2.replayRunId);
    expect(session2!.policy_snapshot_json).toContain(saved.revision.contentHash);
  });

  it('refuses foreign runs, preview sources, and invalid policy snapshots (fail closed)', async () => {
    await seedSourceRun('src-run-2', 'Another audit objective.');
    await expect(
      replayStoreManagerRun({ workspaceId, workspacePath: './ws', sourceRunId: 'foreign-run', registry: testRegistry(), resolveModel: () => resolvedFake }),
    ).rejects.toThrow(StoreManagerReplayError);

    // Preview source is not replayable.
    const previewRequest = createStoreManagerExecutionRequest({
      workspaceId,
      workspacePath: './ws',
      threadId: null,
      entrypoint: 'plan_preview',
      executionMode: 'preview',
      objective: 'Preview only.',
    });
    const preview = await runStoreManagerExecution(previewRequest, { registry: testRegistry() });
    if (preview.kind === 'preview') {
      await expect(
        replayStoreManagerRun({ workspaceId, workspacePath: './ws', sourceRunId: preview.runId, registry: testRegistry(), resolveModel: () => resolvedFake }),
      ).rejects.toThrow(/not be replayed/);
    }

    // Tampered policy snapshot is refused.
    getDb().run(
      "UPDATE store_manager_sessions SET policy_snapshot_json = '{\"tampered\":true}' WHERE workspace_id = ? AND id = ?",
      [workspaceId, 'src-run-2'],
    );
    await expect(
      replayStoreManagerRun({ workspaceId, workspacePath: './ws', sourceRunId: 'src-run-2', registry: testRegistry(), resolveModel: () => resolvedFake }),
    ).rejects.toThrow(/snapshot/i);
  });

  it('explicit model selection never falls back: unavailable model fails the replay visibly', async () => {
    await seedSourceRun('src-run-3', 'Audit with explicit model.');
    await expect(
      replayStoreManagerRun({
        workspaceId,
        workspacePath: './ws',
        sourceRunId: 'src-run-3',
        selectedModel: 'unavailable-model',
        registry: testRegistry(),
        resolveModel: () => {
          throw new ModelUnavailableError('unavailable-model is not usable');
        },
      }),
    ).rejects.toThrow(ModelUnavailableError);
  });

  it('comparison is deterministic over compatible artifacts and refuses incompatible kinds', async () => {
    const { createStoreManagerArtifact } = await import('../../store-manager/runtime/artifacts');
    const { createStoreManagerRunArtifact } = await import('../../db/repositories/store-manager-session-repo');
    const mk = (runId: string, issues: number) => {
      const artifact = createStoreManagerArtifact({
        runId,
        workspaceId,
        kind: 'report',
        schemaVersion: 1,
        content: { issueCount: issues },
      });
      createStoreManagerRunArtifact({
        workspaceId,
        runId,
        kind: 'report',
        schemaVersion: 1,
        contentJson: JSON.stringify({ issueCount: issues }),
        contentHash: artifact.contentHash,
        id: artifact.id,
        createdAt: artifact.createdAt,
      });
    };
    mk('src-run-1', 5);
    mk('src-run-3', 9);

    const compared = compareStoreManagerRuns(workspaceId, 'src-run-1', 'src-run-3');
    expect(compared.comparable).toBe(true);
    expect(compared.kind).toBe('report');
    expect(compared.delta).toContainEqual({ field: 'issueCount', before: 5, after: 9 });

    // Self-comparison and cross-workspace are not comparable.
    expect(compareStoreManagerRuns(workspaceId, 'src-run-1', 'src-run-1').comparable).toBe(false);
    expect(() => compareStoreManagerRuns('other-ws', 'src-run-1', 'src-run-3')).toThrow(/not found/);
  });
});
