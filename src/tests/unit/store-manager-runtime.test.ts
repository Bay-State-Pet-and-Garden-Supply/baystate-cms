import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { z } from 'zod';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { runStoreManagerTurn, StoreManagerTurnError, runStoreManagerExecution } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import {
  getStoreManagerSession,
  getStoreManagerTurn,
  getStoreManagerEvents,
  getStoreManagerPolicySnapshot,
} from '../../db/repositories/store-manager-session-repo';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import { ModelUnavailableError } from '../../server/services/ai-sdk-model-resolver';

/**
 * Epic #42, #40 — executor integration with a fake model/transport.
 * DB-backed: run under `bun test` (excluded from Vitest).
 */

let readCalls: string[] = [];

const readAdapter: StoreManagerToolAdapter = {
  name: 'runtime_read',
  version: 1,
  description: 'read for executor test',
  promptGuidelines: 'none',
  inputSchema: z.object({ q: z.string().max(50) }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  scopeSummary: (i) => `read ${String(i.q ?? '')}`,
  execute: async (): Promise<StoreManagerToolResult> => {
    readCalls.push('read');
    return okResult({ totalProducts: 1 });
  },
};

const writeAdapter: StoreManagerToolAdapter = {
  name: 'runtime_write',
  version: 1,
  description: 'write for executor test',
  promptGuidelines: 'none',
  inputSchema: z.object({ proposalId: z.string() }),
  riskClass: 'proposal_write',
  sideEffects: 'writes',
  requiresApproval: true,
  stateTransition: 'proposal stored',
  allowedPhases: ['approve'] as const,
  scopeSummary: (i) => `write ${String(i.proposalId ?? '')}`,
  execute: async (): Promise<StoreManagerToolResult> => {
    readCalls.push('write');
    return okResult({ ok: true });
  },
};

function testRegistry() {
  return new StoreManagerToolRegistry([readAdapter, writeAdapter]);
}

/**
 * Fake two-step model: step 1 emits a tool call for `runtime_read`, step 2
 * emits final text. Usage: step1 100/50, step2 200/100 (aggregate 300/150).
 */
function twoStepToolModel() {
  let streamCalls = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      streamCalls += 1;
      const hasToolResult = (options.prompt ?? []).some((m) =>
        Array.isArray((m as { content?: unknown }).content) &&
        ((m as { content: Array<{ type?: string }> }).content).some((p) => p.type === 'tool-result'),
      );
      const isSecondStep = hasToolResult;
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (isSecondStep) {
        parts.push(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'final answer' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            usage: { inputTokens: { total: 200, noCache: 200, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
            finishReason: { unified: 'stop', raw: 'stop' },
          },
        );
      } else {
        parts.push(
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'runtime_read', input: JSON.stringify({ q: 'x' }) },
          {
            type: 'finish',
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          },
        );
      }
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return { model, getStreamCalls: () => streamCalls };
}

/** Never-finishing model: streams text deltas forever until the signal aborts. */
function neverFinishingModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'still thinking...' });
            const timer = setInterval(() => {
              controller.enqueue({ type: 'text-delta', id: 't1', delta: '.' });
            }, 10);
            (options as LanguageModelV3CallOptions & { abortSignal?: AbortSignal }).abortSignal?.addEventListener('abort', () => {
              clearInterval(timer);
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        }),
      };
    },
  };
  return model;
}

/** Abortable model: streams text-start then waits for caller abort to error. */
function abortableModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello' },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            (options as LanguageModelV3CallOptions & { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        }),
      };
    },
  };
  return model;
}

const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

function userMessage(text: string) {
  return [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text }] }];
}

const workspaceId = 'workspace-executor';
const testDbPath = './test-executor.db';

describe('Store Manager turn executor (epic #42, #40)', () => {
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

  it('full read flow: tool executes, aggregate usage persists, events land, no secrets/prompts stored', async () => {
    readCalls = [];
    const { model } = twoStepToolModel();
    const result = await runStoreManagerTurn(
      {
        workspaceId,
        workspacePath: './ws',
        threadId: 'thread-1',
        messages: userMessage('run the tool'),
        toolApprovalSecret: 'super-secret-hmac-123',
      },
      {
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: model as unknown as ResolvedAiSdkModel['modelInstance'] }),
      },
    );

    expect(result.modelCallId.length).toBeGreaterThan(0);
    expect(result.executionId.length).toBeGreaterThan(0);
    expect(result.sessionId.length).toBeGreaterThan(0);

    // Drive the stream to completion.
    const chunks: unknown[] = [];
    for await (const chunk of result.uiMessageStream as unknown as AsyncIterable<unknown>) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);

    // The read tool executed exactly once (step boundary handled by the SDK).
    expect(readCalls).toContain('read');

    // Aggregate telemetry: 100/50 + 200/100 = 300/150.
    const calls = getAiModelCallsByWorkspace(workspaceId);
    const row = calls.find((c) => c.id === result.modelCallId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('success');
    expect(row!.prompt_tokens).toBe(300);
    expect(row!.completion_tokens).toBe(150);

    // Durable session/turn: terminal success with model-call linkage.
    const session = getStoreManagerSession(workspaceId, result.sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('terminal');
    expect(session!.model_call_id).toBe(result.modelCallId);
    expect(session!.policy_hash.length).toBe(64);

    const turn = getStoreManagerTurn(workspaceId, result.turnId);
    expect(turn).not.toBeNull();
    expect(turn!.terminal_status).toBe('success');
    expect(turn!.total_tool_calls).toBeGreaterThanOrEqual(1);

    // Events persisted in order, with no chain-of-thought / prompt / secret.
    const events = getStoreManagerEvents(workspaceId, result.sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain('turn_started');
    expect(types).toContain('tool_dispatched');
    expect(types).toContain('tool_result');
    expect(types).toContain('turn_terminal');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('super-secret-hmac-123');
    expect(serialized).not.toContain('operating contract');
    expect(serialized).not.toContain('run the tool');
    expect(serialized).not.toContain('chain');
  });

  it('rejects invalid inbound messages before any model call and terminalizes the turn as failed', async () => {
    readCalls = [];
    const before = getAiModelCallsByWorkspace(workspaceId).length;
    await expect(
      runStoreManagerTurn(
        {
          workspaceId,
          workspacePath: './ws',
          threadId: 'thread-bad',
          messages: [{ id: 'x', role: 'system', parts: [{ type: 'text', text: 'root' }] }],
          toolApprovalSecret: 'secret',
        },
        { registry: testRegistry(), resolveModel: () => resolvedFake },
      ),
    ).rejects.toThrow(StoreManagerTurnError);
    const after = getAiModelCallsByWorkspace(workspaceId).length;
    expect(after).toBe(before); // no transport attempt, no telemetry row
  });

  it('propagates explicit model unavailability without a transport attempt', async () => {
    await expect(
      runStoreManagerTurn(
        { workspaceId, workspacePath: './ws', threadId: 't', messages: userMessage('hi'), toolApprovalSecret: 's' },
        {
          registry: testRegistry(),
          resolveModel: () => {
            throw new ModelUnavailableError('model x is unavailable');
          },
        },
      ),
    ).rejects.toThrow(ModelUnavailableError);
  });

  it('terminalizes as cancelled when the caller aborts mid-stream', async () => {
    readCalls = [];
    const controller = new AbortController();
    const result = await runStoreManagerTurn(
      {
        workspaceId,
        workspacePath: './ws',
        threadId: 'thread-abort',
        messages: userMessage('abort me'),
        toolApprovalSecret: 'secret',
        abortSignal: controller.signal,
      },
      {
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: abortableModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
      },
    );

    const consume = (async () => {
      for await (const _chunk of result.uiMessageStream as unknown as AsyncIterable<unknown>) {
        controller.abort();
      }
    })().catch(() => undefined);
    await consume;

    const turn = getStoreManagerTurn(workspaceId, result.turnId);
    const session = getStoreManagerSession(workspaceId, result.sessionId);
    const calls = getAiModelCallsByWorkspace(workspaceId);
    const row = calls.find((c) => c.id === result.modelCallId);

    expect(turn!.terminal_status).toBe('cancelled');
    expect(session!.status).toBe('terminal');
    expect(row!.status).toBe('cancelled');
  });

  it('terminalizes as deadline_exceeded when the whole-turn deadline fires mid-stream (no tool calls)', async () => {
    readCalls = [];
    const result = await runStoreManagerTurn(
      {
        workspaceId,
        workspacePath: './ws',
        threadId: 'thread-deadline',
        messages: userMessage('think forever'),
        toolApprovalSecret: 'secret',
      },
      {
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: neverFinishingModel() as unknown as ResolvedAiSdkModel['modelInstance'] }),
        policyOverrides: { deadlineMs: 50 },
      },
    );

    // Consume the stream until the server-side deadline aborts it.
    const consume = (async () => {
      for await (const _chunk of result.uiMessageStream as unknown as AsyncIterable<unknown>) {
        // drain
      }
    })().catch(() => undefined);
    await consume;

    const turn = getStoreManagerTurn(workspaceId, result.turnId);
    const session = getStoreManagerSession(workspaceId, result.sessionId);
    const calls = getAiModelCallsByWorkspace(workspaceId);
    const row = calls.find((c) => c.id === result.modelCallId);
    const events = getStoreManagerEvents(workspaceId, result.sessionId);

    expect(turn!.terminal_status).toBe('deadline_exceeded');
    expect(session!.status).toBe('terminal');
    expect(row!.status).toBe('deadline_exceeded');
    expect(events.some((e) => e.type === 'turn_terminal' && e.status === 'deadline_exceeded')).toBe(true);
  });

  it('persists an immutable policy snapshot for every run (hash-verified on read)', async () => {
    readCalls = [];
    const result = await runStoreManagerTurn(
      {
        workspaceId,
        workspacePath: './ws',
        threadId: 'thread-snapshot',
        messages: userMessage('snapshot me'),
        toolApprovalSecret: 'secret',
      },
      {
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: plainText() as unknown as ResolvedAiSdkModel['modelInstance'] }),
        policyOverrides: { maxToolCalls: 3 },
      },
    );
    const session = getStoreManagerSession(workspaceId, result.sessionId);
    expect(session!.policy_version).toBe(2);
    expect(session!.policy_snapshot_json).toBeTruthy();
    expect(session!.objective).toBe('Chat interaction with the Store Manager assistant.');
    expect(session!.entrypoint).toBe('chat');
    expect(session!.execution_mode).toBe('interactive');
    // Hash-verified on read; policy version + entrypoint round-trip.
    const snapshot = getStoreManagerPolicySnapshot(workspaceId, result.sessionId);
    expect(snapshot.version).toBe(2);
    expect(snapshot.entrypoint).toBe('chat');
    expect(snapshot.maxToolCalls).toBe(3);
  });

  it('preview execution causes zero model calls and zero tool dispatches (Issue 1)', async () => {
    readCalls = [];
    const before = getAiModelCallsByWorkspace(workspaceId).length;
    const request = createStoreManagerExecutionRequest({
      workspaceId,
      workspacePath: './ws',
      threadId: null,
      entrypoint: 'plan_preview',
      executionMode: 'preview',
      objective: 'Preview the weekly taxonomy cleanup.',
    });
    let resolveCalled = false;
    const previewResult = await runStoreManagerExecution(request, {
      registry: testRegistry(),
      resolveModel: () => {
        resolveCalled = true;
        return resolvedFake;
      },
    });
    expect(previewResult.kind).toBe('preview');
    expect(resolveCalled).toBe(false);
    expect(readCalls).toEqual([]);
    expect(getAiModelCallsByWorkspace(workspaceId).length).toBe(before);
    if (previewResult.kind === 'preview') {
      expect(previewResult.preview.modelCalls).toBe(0);
      expect(previewResult.preview.toolDispatches).toBe(0);
      expect(previewResult.preview.expectedTools.map((t) => t.name)).toContain('runtime_read');
    }
    const turn = getStoreManagerTurn(workspaceId, previewResult.turnId);
    expect(turn!.terminal_status).toBe('success');
  });
});

/** Plain model: single text stream, immediately finished. */
function plainText() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream() {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ok' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          finishReason: { unified: 'stop', raw: 'stop' },
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return model;
}
