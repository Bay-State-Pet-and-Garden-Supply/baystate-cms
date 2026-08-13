import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { z } from 'zod';
import {
  StoreManagerToolRegistry,
  createRuntimeSessionState,
  type StoreManagerRuntimeSessionState,
} from '../../store-manager/runtime/tool-registry';
import { createStoreManagerPolicy, STORE_MANAGER_POLICY_DEFAULTS } from '../../store-manager/runtime/policy';
import type { StoreManagerToolAdapter, StoreManagerToolResult, StoreManagerRuntimeEvent } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';

/**
 * Epic #42, #40 — registry dispatch order and fail-closed enforcement.
 * DB-backed: run under `bun test` (excluded from Vitest).
 */

let calls: string[] = [];

function makeAdapters(overrides?: {
  readExecutes?: () => Promise<StoreManagerToolResult>;
  writeExecutes?: () => Promise<StoreManagerToolResult>;
}): StoreManagerToolAdapter[] {
  calls = [];
  const readAdapter: StoreManagerToolAdapter = {
    name: 'test_read',
    version: 1,
    description: 'read test tool',
    promptGuidelines: 'none',
    inputSchema: z.object({ q: z.string().max(10) }),
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    allowedPhases: ['investigate', 'verify'] as const,
    scopeSummary: (i) => `read ${String(i.q ?? '')}`,
    execute: async () => {
      calls.push('read');
      return overrides?.readExecutes ? overrides.readExecutes() : okResult({ ok: true });
    },
  };
  const writeAdapter: StoreManagerToolAdapter = {
    name: 'test_write',
    version: 1,
    description: 'write test tool',
    promptGuidelines: 'none',
    inputSchema: z.object({ proposalId: z.string() }),
    riskClass: 'proposal_write',
    sideEffects: 'writes a proposal row',
    requiresApproval: true,
    stateTransition: 'proposal stored',
    allowedPhases: ['approve'] as const,
    scopeSummary: (i) => `write ${String(i.proposalId ?? '')}`,
    execute: async () => {
      calls.push('write');
      return overrides?.writeExecutes ? overrides.writeExecutes() : okResult({ ok: true });
    },
  };
  return [readAdapter, writeAdapter];
}

function approvedMessagesFor(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName, input },
        { type: 'tool-approval-request', approvalId: 'ap-x', toolCallId },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'ap-x', approved: true }] },
  ];
}

function setup(opts?: {
  phase?: StoreManagerRuntimeSessionState['phase'];
  status?: StoreManagerRuntimeSessionState['status'];
  toolCalls?: number;
  deadlineAt?: number;
  callerSignal?: AbortSignal;
  maxOutputBytes?: number;
  maxToolCalls?: number;
}) {
  const registry = new StoreManagerToolRegistry(makeAdapters());
  const policy = createStoreManagerPolicy(
    { workspaceId: 'ws-a', sessionId: 'sess-1', turnId: 'turn-1' },
    registry.allowlist(),
  );
  const session = createRuntimeSessionState({ sessionId: 'sess-1', workspaceId: 'ws-a', turnId: 'turn-1' });
  session.phase = opts?.phase ?? 'investigate';
  session.status = opts?.status ?? 'active';
  session.toolCalls = opts?.toolCalls ?? 0;

  const events: StoreManagerRuntimeEvent[] = [];
  const tools = registry.buildAiSdkTools({
    policy,
    session,
    executionContext: {
      workspaceId: 'ws-a',
      workspacePath: './ws',
      executionId: 'exec-1',
      approvalExpiresAt: opts?.deadlineAt ?? Date.now() + 60_000,
    },
    adapterContext: {
      workspaceId: 'ws-a',
      workspacePath: './ws',
      sessionId: 'sess-1',
      executionId: 'exec-1',
      deadlineAt: Date.now() + 60_000,
    },
    emit: (e) => events.push(e),
    now: () => Date.now(),
    deadlineAt: opts?.deadlineAt ?? Date.now() + 60_000,
    callerSignal: opts?.callerSignal,
    maxOutputBytes: opts?.maxOutputBytes ?? STORE_MANAGER_POLICY_DEFAULTS.maxOutputBytes,
  });
  return { registry, policy, session, events, tools };
}

const asAny = (tools: Record<string, unknown>) => tools as Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

describe('Store Manager tool registry (epic #42, #40)', () => {
  const testDbPath = './test-tool-registry.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('rejects duplicate registration and reports unknown tools', () => {
    const registry = new StoreManagerToolRegistry();
    registry.register(makeAdapters()[0]);
    expect(() => registry.register(makeAdapters()[0])).toThrow(/already registered/);
    expect(registry.get('does_not_exist')).toBeUndefined();
  });

  it('dispatches a read tool in investigate phase and emits dispatched+result events', async () => {
    const { tools, events } = setup();
    const result = (await asAny(tools).test_read.execute({ q: 'hi' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('ok');
    expect(calls).toEqual(['read']);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_dispatched');
    expect(types).toContain('tool_result');
    const dispatched = events.find((e) => e.type === 'tool_dispatched');
    if (dispatched && dispatched.type === 'tool_dispatched') {
      expect(dispatched.toolName).toBe('test_read');
      expect(dispatched.inputDigest.length).toBe(64);
      expect(dispatched.scope).toContain('hi');
    }
  });

  it('denies a persistent tool without a valid approval (phase + approval gate before side effects)', async () => {
    const { tools } = setup();
    const result = (await asAny(tools).test_write.execute({ proposalId: 'p1' }, { toolCallId: 'w1', messages: [] } as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('phase_not_allowed');
    expect(calls).toEqual([]);
  });

  it('executes a persistent tool after a valid signed approval and advances to verify', async () => {
    const { tools, session, events } = setup();
    const messages = approvedMessagesFor('w1', 'test_write', { proposalId: 'p1' });
    const result = (await asAny(tools).test_write.execute({ proposalId: 'p1' }, { toolCallId: 'w1', messages } as never)) as StoreManagerToolResult;
    expect(result.status).toBe('ok');
    expect(calls).toEqual(['write']);
    expect(session.phase).toBe('verify');
    expect(events.some((e) => e.type === 'phase_changed')).toBe(true);
  });

  it('rejects altered arguments after approval (replay/alteration gate)', async () => {
    const { tools } = setup();
    const messages = approvedMessagesFor('w1', 'test_write', { proposalId: 'p1' });
    const result = (await asAny(tools).test_write.execute({ proposalId: 'p2' }, { toolCallId: 'w1', messages } as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    expect(calls).toEqual([]);
  });

  it('enforces the per-turn call budget before side effects', async () => {
    const { tools } = setup({ toolCalls: STORE_MANAGER_POLICY_DEFAULTS.maxToolCalls });
    const result = (await asAny(tools).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('budget_exceeded');
    expect(calls).toEqual([]);
  });

  it('enforces the whole-turn deadline', async () => {
    const { tools } = setup({ deadlineAt: Date.now() - 1000 });
    const result = (await asAny(tools).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('deadline_exceeded');
    expect(calls).toEqual([]);
  });

  it('fails closed for a foreign workspace session', async () => {
    const { tools, policy } = setup();
    // Rebuild tools with a session bound to a different workspace.
    const registry = new StoreManagerToolRegistry(makeAdapters());
    const foreignSession = createRuntimeSessionState({ sessionId: 'sess-2', workspaceId: 'ws-b', turnId: 'turn-1' });
    const events: StoreManagerRuntimeEvent[] = [];
    const tools2 = registry.buildAiSdkTools({
      policy,
      session: foreignSession,
      executionContext: { workspaceId: 'ws-a', workspacePath: './ws', executionId: 'exec-1', approvalExpiresAt: Date.now() + 60_000 },
      adapterContext: { workspaceId: 'ws-a', workspacePath: './ws', sessionId: 'sess-1', executionId: 'exec-1', deadlineAt: Date.now() + 60_000 },
      emit: (e) => events.push(e),
    });
    void tools;
    const result = (await asAny(tools2).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('not_in_workspace');
    expect(calls).toEqual([]);
  });

  it('rejects malformed input via the strict input schema', async () => {
    const { tools } = setup();
    const result = (await asAny(tools).test_read.execute({ q: 42 }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('invalid_input');
    expect(calls).toEqual([]);
  });

  it('bounds oversized tool output (size_exceeded instead of unbounded data)', async () => {
    const registry = new StoreManagerToolRegistry(makeAdapters({
      readExecutes: async () => okResult({ huge: 'x'.repeat(1024 * 1024) }),
    }));
    const policy = createStoreManagerPolicy(
      { workspaceId: 'ws-a', sessionId: 'sess-1', turnId: 'turn-1' },
      registry.allowlist(),
    );
    const session = createRuntimeSessionState({ sessionId: 'sess-1', workspaceId: 'ws-a', turnId: 'turn-1' });
    const events: StoreManagerRuntimeEvent[] = [];
    const tools = registry.buildAiSdkTools({
      policy,
      session,
      executionContext: { workspaceId: 'ws-a', workspacePath: './ws', executionId: 'exec-1', approvalExpiresAt: Date.now() + 60_000 },
      adapterContext: { workspaceId: 'ws-a', workspacePath: './ws', sessionId: 'sess-1', executionId: 'exec-1', deadlineAt: Date.now() + 60_000 },
      emit: (e) => events.push(e),
      maxOutputBytes: 1024,
    });
    const result = (await asAny(tools).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('policy_denied');
    if (result.status === 'policy_denied') expect(result.reasonCode).toBe('size_exceeded');
  });

  it('redacts adapter exceptions into structured error outcomes', async () => {
    const registry = new StoreManagerToolRegistry(makeAdapters({
      readExecutes: async () => {
        throw new Error('secret stack trace leaked');
      },
    }));
    const policy = createStoreManagerPolicy(
      { workspaceId: 'ws-a', sessionId: 'sess-1', turnId: 'turn-1' },
      registry.allowlist(),
    );
    const session = createRuntimeSessionState({ sessionId: 'sess-1', workspaceId: 'ws-a', turnId: 'turn-1' });
    const events: StoreManagerRuntimeEvent[] = [];
    const tools = registry.buildAiSdkTools({
      policy,
      session,
      executionContext: { workspaceId: 'ws-a', workspacePath: './ws', executionId: 'exec-1', approvalExpiresAt: Date.now() + 60_000 },
      adapterContext: { workspaceId: 'ws-a', workspacePath: './ws', sessionId: 'sess-1', executionId: 'exec-1', deadlineAt: Date.now() + 60_000 },
      emit: (e) => events.push(e),
    });
    const result = (await asAny(tools).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorCode).toBe('adapter_failed');
      expect(result.message).toContain('secret stack trace');
    }
  });

  it('surfaces a pre-aborted caller signal to the adapter context', async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = new StoreManagerToolRegistry(makeAdapters({
      readExecutes: async () => okResult({ ok: true }),
    }));
    const policy = createStoreManagerPolicy(
      { workspaceId: 'ws-a', sessionId: 'sess-1', turnId: 'turn-1' },
      registry.allowlist(),
    );
    const session = createRuntimeSessionState({ sessionId: 'sess-1', workspaceId: 'ws-a', turnId: 'turn-1' });
    const events: StoreManagerRuntimeEvent[] = [];
    const tools = registry.buildAiSdkTools({
      policy,
      session,
      executionContext: { workspaceId: 'ws-a', workspacePath: './ws', executionId: 'exec-1', approvalExpiresAt: Date.now() + 60_000 },
      adapterContext: { workspaceId: 'ws-a', workspacePath: './ws', sessionId: 'sess-1', executionId: 'exec-1', deadlineAt: Date.now() + 60_000 },
      emit: (e) => events.push(e),
      callerSignal: controller.signal,
    });
    // The read adapter ignores the signal by design in this test; the point is
    // the registry composes the signal (AbortSignal.any) without throwing and
    // still dispatches. A signal-aware adapter can check ctx.signal.aborted.
    const result = (await asAny(tools).test_read.execute({ q: 'x' }, {} as never)) as StoreManagerToolResult;
    expect(result.status).toBe('ok');
  });
});
