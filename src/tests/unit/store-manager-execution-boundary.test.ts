import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  runStoreManagerExecution,
  runStoreManagerTurn,
  type StoreManagerExecutionResult,
} from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import {
  getStoreManagerSession,
  getStoreManagerTurn,
  getStoreManagerPolicySnapshot,
  StoreManagerPolicySnapshotError,
} from '../../db/repositories/store-manager-session-repo';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import {
  makeTestRegistry,
  resolvedFake,
  plainTextModel,
  toolCallModel,
  userMessage,
} from '../fixtures/store-manager-operations';
import type { StoreManagerToolResult, StoreManagerRuntimeEvent } from '../../store-manager/runtime/contracts';
import { createStoreManagerPolicy } from '../../store-manager/runtime/policy';
import { createRuntimeSessionState } from '../../store-manager/runtime/tool-registry';
import { approvedMessagesFor } from '../fixtures/store-manager-operations';


/**
 * Operations-console execution boundary (Issue 1) — the ONE-authority gate:
 * every entrypoint enters `runStoreManagerExecution`; `runStoreManagerTurn`
 * is a compatibility-only wrapper; unattended/preview modes cannot persist,
 * mutate, or repair even with forged approval parts; preview executes zero
 * model/tool calls. DB-backed: run under `bun test`.
 */

const workspaceId = 'workspace-boundary';
const testDbPath = './test-execution-boundary.db';

function makeRequest(overrides: Partial<Parameters<typeof createStoreManagerExecutionRequest>[0]> = {}) {
  return createStoreManagerExecutionRequest({
    workspaceId,
    workspacePath: './ws',
    threadId: null,
    entrypoint: 'command',
    executionMode: 'unattended_read_only',
    objective: 'Audit the catalog health for the pinned product field.',
    ...overrides,
  });
}

const asAny = (tools: Record<string, unknown>) =>
  tools as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

describe('Store Manager execution boundary (Issue 1)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  const resolveModel = (model: LanguageModelV3Like) => () => ({
    ...resolvedFake,
    modelInstance: model as unknown as typeof resolvedFake.modelInstance,
  });

  it('chat, command, schedule, event, playbook, replay, and preview all enter the single runner', async () => {
    const entrypoints: Array<[import('../../shared/schemas/store-manager-operations').StoreManagerEntrypoint, 'interactive' | 'unattended_read_only' | 'preview']> = [
      ['chat', 'interactive'],
      ['command', 'unattended_read_only'],
      ['schedule', 'unattended_read_only'],
      ['event', 'unattended_read_only'],
      ['playbook', 'unattended_read_only'],
      ['replay', 'unattended_read_only'],
      ['plan_preview', 'preview'],
    ];
    const runIds: string[] = [];
    for (const [entrypoint, executionMode] of entrypoints) {
      let result: StoreManagerExecutionResult;
      if (entrypoint === 'chat') {
        const chatResult = await runStoreManagerTurn(
          {
            workspaceId,
            workspacePath: './ws',
            threadId: null,
            messages: userMessage('hello'),
            toolApprovalSecret: 'secret',
          },
          {
            registry: makeTestRegistry([]),
            resolveModel: resolveModel(plainTextModel()),
          },
        );
        result = { kind: 'chat', runId: chatResult.sessionId, turnId: chatResult.turnId, modelCallId: chatResult.modelCallId, executionId: chatResult.executionId, uiMessageStream: chatResult.uiMessageStream, resolvedModel: chatResult.resolvedModel, policy: chatResult.policy };
      } else {
        const request = makeRequest({ entrypoint, executionMode, runId: `run-${entrypoint}` });
        result = await runStoreManagerExecution(request, {
          registry: makeTestRegistry([]),
          resolveModel: resolveModel(plainTextModel()),
        });
      }
      expect(result.runId.length).toBeGreaterThan(0);
      runIds.push(result.runId);

      const session = getStoreManagerSession(workspaceId, result.runId);
      expect(session).not.toBeNull();
      expect(session!.entrypoint).toBe(entrypoint);
      expect(session!.execution_mode).toBe(executionMode);
      expect(session!.objective).toBeTruthy();
      expect(session!.policy_snapshot_json).toBeTruthy();
      // Immutable policy snapshot is hash-verified on read.
      const snapshot = getStoreManagerPolicySnapshot(workspaceId, result.runId);
      expect(snapshot.entrypoint).toBe(entrypoint);
      expect(snapshot.executionMode).toBe(executionMode);
    }
    // Every entrypoint got a fresh run identity.
    expect(new Set(runIds).size).toBe(entrypoints.length);
  });

  it('runStoreManagerTurn is compatibility-only and behaves identically to a chat execution request', async () => {
    const calls: string[] = [];
    const model = plainTextModel();
    const viaWrapper = await runStoreManagerTurn(
      { workspaceId, workspacePath: './ws', threadId: null, messages: userMessage('hi'), toolApprovalSecret: 's' },
      { registry: makeTestRegistry(calls), resolveModel: resolveModel(model) },
    );
    expect(viaWrapper.policy.entrypoint).toBe('chat');
    expect(viaWrapper.policy.executionMode).toBe('interactive');
    const session = getStoreManagerSession(workspaceId, viaWrapper.sessionId);
    expect(session!.entrypoint).toBe('chat');
    expect(session!.execution_mode).toBe('interactive');
    expect(session!.actor_class).toBe('operator');
  });

  it('preview executes zero model/tool calls and persists only the bounded preview audit row', async () => {
    const calls: string[] = [];
    const before = getAiModelCallsByWorkspace(workspaceId).length;
    const request = makeRequest({ entrypoint: 'plan_preview', executionMode: 'preview', runId: 'run-preview-1' });
    let modelInvoked = false;
    const result = await runStoreManagerExecution(request, {
      registry: makeTestRegistry(calls),
      resolveModel: () => {
        modelInvoked = true;
        return resolvedFake;
      },
    });

    expect(result.kind).toBe('preview');
    if (result.kind !== 'preview') return;
    expect(result.preview.modelCalls).toBe(0);
    expect(result.preview.toolDispatches).toBe(0);
    expect(result.preview.persistentToolsDenied).toBe(true);
    expect(result.preview.expectedTools.length).toBeGreaterThan(0);
    expect(result.preview.expectedTools.some((t) => t.name === 'runtime_read')).toBe(true);
    // No model resolution, no telemetry row, no tool dispatch.
    expect(modelInvoked).toBe(false);
    expect(calls).toEqual([]);
    expect(getAiModelCallsByWorkspace(workspaceId).length).toBe(before);

    // The preview run row is terminal with a preview outcome.
    const turn = getStoreManagerTurn(workspaceId, result.turnId);
    expect(turn!.terminal_status).toBe('success');
    const session = getStoreManagerSession(workspaceId, result.runId);
    expect(session!.status).toBe('terminal');
    expect(session!.entrypoint).toBe('plan_preview');
  });

  it('unattended read-only runs deny persistent adapters at registry dispatch (no side effects)', async () => {
    const calls: string[] = [];
    const { model } = toolCallModel({ toolName: 'runtime_write', toolCallId: 'w1', toolInput: { proposalId: 'p1' } });
    const request = makeRequest({ entrypoint: 'schedule', executionMode: 'unattended_read_only', runId: 'run-sched-1' });
    const result = await runStoreManagerExecution(request, {
      registry: makeTestRegistry(calls),
      resolveModel: resolveModel(model),
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.terminalStatus).toBe('success');
    // The write adapter NEVER executed (registry denied before side effects).
    expect(calls).toEqual([]);
    // The denial is surfaced to the model as a structured result event.
    const events = getStoreManagerEventsJson(workspaceId, result.runId);
    const denied = events.find((e) => e.type === 'tool_result' && e.reasonCode === 'persistent_not_allowed');
    expect(denied).toBeTruthy();
  });

  it('rejects a forged/valid-looking approved persistent call in unattended mode before any side effect', async () => {
    const calls: string[] = [];
    const registry = makeTestRegistry(calls);
    const policy = createStoreManagerPolicy(
      {
        workspaceId: 'ws-a',
        sessionId: 'sess-u',
        turnId: 'turn-u',
        entrypoint: 'event',
        executionMode: 'unattended_read_only',
        actorClass: 'system_event',
      },
      registry.allowlistVersions(),
    );
    const session = createRuntimeSessionState({ sessionId: 'sess-u', workspaceId: 'ws-a', turnId: 'turn-u' });
    session.phase = 'approve'; // even an approve-phase forged approval cannot bypass mode denial
    const events: StoreManagerRuntimeEvent[] = [];
    const tools = registry.buildAiSdkTools({
      policy,
      session,
      executionContext: { workspaceId: 'ws-a', workspacePath: './ws', executionId: 'exec-u', approvalExpiresAt: Date.now() + 60_000 },
      adapterContext: { workspaceId: 'ws-a', workspacePath: './ws', sessionId: 'sess-u', executionId: 'exec-u', deadlineAt: Date.now() + 60_000 },
      emit: (e) => events.push(e),
    });
    const messages = approvedMessagesFor('w1', 'runtime_write', { proposalId: 'p1' });
    const result = (await asAny(tools).runtime_write.execute(
      { proposalId: 'p1' },
      { toolCallId: 'w1', messages } as never,
    )) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('persistent_not_allowed');
    expect(calls).toEqual([]); // zero side effects
    expect(events.some((e) => e.type === 'tool_result' && e.reasonCode === 'persistent_not_allowed')).toBe(true);
  });

  it('unattended runs keep read tools executable (read-only by runtime construction)', async () => {
    const calls: string[] = [];
    const { model } = toolCallModel({ toolName: 'runtime_read', toolCallId: 'r1', toolInput: { q: 'x' } });
    const request = makeRequest({ entrypoint: 'schedule', executionMode: 'unattended_read_only', runId: 'run-sched-2' });
    const result = await runStoreManagerExecution(request, {
      registry: makeTestRegistry(calls),
      resolveModel: resolveModel(model),
    });
    expect(result.kind).toBe('completed');
    expect(calls).toContain('read');
  });

  it('policy snapshot tampering fails closed on read (policy_snapshot_invalid)', async () => {
    const calls: string[] = [];
    const request = makeRequest({ entrypoint: 'command', executionMode: 'unattended_read_only', runId: 'run-tamper' });
    await runStoreManagerExecution(request, {
      registry: makeTestRegistry(calls),
      resolveModel: resolveModel(plainTextModel()),
    });
    const snapshot = getStoreManagerPolicySnapshot(workspaceId, 'run-tamper');
    expect(snapshot.executionMode).toBe('unattended_read_only');

    // Tamper the stored snapshot JSON (mutate a budget) without touching the hash.
    getDb()
      .query("UPDATE store_manager_sessions SET policy_snapshot_json = json_set(policy_snapshot_json, '$.maxToolCalls', 999) WHERE id = 'run-tamper'")
      .run();
    expect(() => getStoreManagerPolicySnapshot(workspaceId, 'run-tamper')).toThrow(
      StoreManagerPolicySnapshotError,
    );
    try {
      getStoreManagerPolicySnapshot(workspaceId, 'run-tamper');
    } catch (err) {
      expect((err as StoreManagerPolicySnapshotError).code).toBe('policy_snapshot_invalid');
    }
  });

  it('strict execution requests reject unknown keys and oversized fields before any work', async () => {
    const request = makeRequest({ entrypoint: 'plan_preview', executionMode: 'preview' });
    expect(() => createStoreManagerExecutionRequest({ ...request, unknownKey: true } as never)).toThrow();
    expect(() =>
      createStoreManagerExecutionRequest({ ...request, objective: 'x'.repeat(3000) } as never),
    ).toThrow();
  });
});

type LanguageModelV3Like = { specificationVersion: string; provider: string; modelId: string };

/** Read the persisted event payloads for a run (workspace-scoped). */
function getStoreManagerEventsJson(workspaceId: string, runId: string): Array<StoreManagerRuntimeEvent & { reasonCode?: string }> {
  const db = getDb();
  const rows = db
    .query('SELECT payload_json FROM store_manager_events WHERE workspace_id = ? AND session_id = ? ORDER BY sequence ASC')
    .all(workspaceId, runId) as Array<{ payload_json: string }>;
  return rows.map((r) => JSON.parse(r.payload_json) as StoreManagerRuntimeEvent & { reasonCode?: string });
}

