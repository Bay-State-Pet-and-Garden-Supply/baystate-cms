import { describe, test, expect, beforeAll, afterAll, expectTypeOf } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { streamText, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { getAiModelCallsByWorkspace, getAiModelCallByWorkspaceAndId } from '../../db/repositories/ai-model-call-repo';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import {
  beginStoreManagerCall,
  terminalizeStoreManagerCall,
  buildStoreManagerMessageMetadata,
  insertStoreManagerUnavailableCall,
  sanitizeChatMessagesForPersistence,
  STORE_MANAGER_TASK,
} from '../../server/services/store-manager-telemetry';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';

/**
 * A fake two-step model: step 1 emits a tool call (usage A), the tool executes,
 * step 2 emits final text (usage B). streamText must report A+B as aggregate
 * usage on onEnd, proving the #37 invariant that we never persist final-step
 * usage only.
 */
function createTwoStepFakeModel() {
  let streamCalls = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate is not exercised in this test');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      streamCalls += 1;
      // After step 1 the SDK appends the executed tool result as a `tool`
      // message; any tool-result part means a previous step ran a tool.
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
            // Step 2 usage: 200 input + 100 output tokens.
            type: 'finish',
            usage: {
              inputTokens: { total: 200, noCache: 200, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 100, text: 100, reasoning: 0 },
            },
            finishReason: { unified: 'stop', raw: 'stop' },
          },
        );
      } else {
        parts.push(
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'fake_lookup',
            input: JSON.stringify({ q: 'x' }),
          },
          {
            // Step 1 usage: 100 input + 50 output tokens.
            type: 'finish',
            usage: {
              inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 50, text: 50, reasoning: 0 },
            },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          },
        );
      }

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { model, getStreamCalls: () => streamCalls };
}

const resolvedModel: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

describe('Store Manager chat runtime telemetry (epic #42, #37)', () => {
  const testDbPath = 'src/tests/unit/store-manager-chat-runtime-test.db';
  const workspaceId = 'workspace-runtime-a';

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(testDbPath);
    } catch {
      /* ok */
    }
  });

  test('AI SDK 7 onEnd usage is the aggregate of all tool-loop steps (never final-step only)', async () => {
    const { model, getStreamCalls } = createTwoStepFakeModel();
    const captured: { usage?: { inputTokens?: number; outputTokens?: number } } = {};

    const result = streamText({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: {
        fake_lookup: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ ok: true }),
        }),
      },
      onEnd: ({ usage }) => {
        const u = usage as unknown as { inputTokens?: number; outputTokens?: number };
        captured.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      },
      // Mirror the route: a bounded multi-step tool loop (not the SDK default
      // of a single step).
      stopWhen: isStepCount(10),
    });

    // Awaiting result.usage consumes the stream and resolves with aggregate.
    const aggregate = (await result.usage) as { inputTokens?: number; outputTokens?: number };

    expect(getStreamCalls()).toBe(2);
    expect(aggregate.inputTokens).toBe(300); // 100 + 200
    expect(aggregate.outputTokens).toBe(150); // 50 + 100
    expect(captured.usage).toBeDefined();
    expect(captured.usage?.inputTokens).toBe(300);
    expect(captured.usage?.outputTokens).toBe(150);
  });

  test('started row is durable before any transport; terminalize writes aggregate usage + exact resolved metadata', async () => {
    // Simulate route order: insert `started` before the model call, then
    // terminalize `success` with the aggregate usage from onEnd.
    const callId = beginStoreManagerCall(workspaceId, resolvedModel);

    const started = getAiModelCallByWorkspaceAndId(workspaceId, callId);
    expect(started).not.toBeNull();
    expect(started?.status).toBe('started');
    expect(started?.provider).toBe('deepseek');
    expect(started?.model).toBe('deepseek-v4-flash');
    expect(started?.locality).toBe('cloud');
    expect(started?.task).toBe(STORE_MANAGER_TASK);

    const terminalized = terminalizeStoreManagerCall(callId, resolvedModel, 'success', {
      promptTokens: 300,
      completionTokens: 150,
    });

    expect(terminalized).toBe(true);
    const row = getAiModelCallByWorkspaceAndId(workspaceId, callId);
    expect(row?.status).toBe('success');
    expect(row?.prompt_tokens).toBe(300);
    expect(row?.completion_tokens).toBe(150);
    // deepseek-v4-flash: $0.14/1M in, $0.28/1M out → 300/1M*0.14 + 150/1M*0.28
    expect(row?.estimated_api_cost_usd).toBeCloseTo(0.000084, 10);
    expect(row?.cost_basis).toBe('published_rate');
  });

  test('terminalization is exactly once even when multiple terminal paths fire', () => {
    const callId = beginStoreManagerCall(workspaceId, resolvedModel);
    const first = terminalizeStoreManagerCall(callId, resolvedModel, 'cancelled');
    const second = terminalizeStoreManagerCall(callId, resolvedModel, 'success', {
      promptTokens: 999,
      completionTokens: 999,
    });
    expect(first).toBe(true);
    expect(second).toBe(false); // repository guard: only `started` rows update

    const row = getAiModelCallByWorkspaceAndId(workspaceId, callId);
    expect(row?.status).toBe('cancelled');
    expect(row?.prompt_tokens).toBeNull(); // never overwritten by the second call
  });

  test('failed path terminalizes with a redacted error code', () => {
    const callId = beginStoreManagerCall(workspaceId, resolvedModel);
    const ok = terminalizeStoreManagerCall(callId, resolvedModel, 'failed', {
      errorCode: 'AI_APICallError',
    });
    expect(ok).toBe(true);
    const row = getAiModelCallByWorkspaceAndId(workspaceId, callId);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('AI_APICallError');
  });

  test('unknown cloud cost stays null with costBasis unknown in message metadata', () => {
    const unknownResolved: ResolvedAiSdkModel = {
      ...resolvedModel,
      modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
      provider: 'custom_cloud',
      modelId: 'unknown-model-xyz',
    };
    const metadata = buildStoreManagerMessageMetadata(unknownResolved, 'call-unknown', {
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(metadata.estimatedCostUsd).toBeNull();
    expect(metadata.costBasis).toBe('unknown');
    expect(metadata.provider).toBe('custom_cloud');
    expect(metadata.model).toBe('unknown-model-xyz');
  });

  test('no client save is required for durability: the row survives a server restart', () => {
    // Rows are written at call start/end; there is no in-memory handoff.
    const callId = beginStoreManagerCall(workspaceId, resolvedModel);
    terminalizeStoreManagerCall(callId, resolvedModel, 'success', {
      promptTokens: 10,
      completionTokens: 5,
    });
    // After "restart" the row is still readable with full metadata.
    const row = getAiModelCallByWorkspaceAndId(workspaceId, callId);
    expect(row).not.toBeNull();
    expect(row?.provider).toBe('deepseek');
    expect(row?.model).toBe('deepseek-v4-flash');
    expect(row?.status).toBe('success');
  });

  test('explicit unavailable selection inserts one terminal unavailable row (no fallback row)', () => {
    insertStoreManagerUnavailableCall(workspaceId, 'deepseek-v4-flash');
    const rows = getAiModelCallsByWorkspace(workspaceId);
    const unavailable = rows.filter((r) => r.status === 'unavailable');
    const last = unavailable[unavailable.length - 1];
    expect(last).toBeDefined();
    expect(last.error_code).toBe('model_unavailable');
    expect(last.ended_at).not.toBeNull();
    // Registered-but-unresolvable selection maps to the registry profile.
    expect(last.model).toBe('deepseek-v4-flash');
    expect(last.provider).toBe('deepseek');

    // An unregistered id cannot be attributed: explicit unknown provider.
    insertStoreManagerUnavailableCall(workspaceId, 'not-a-registered-model');
    const unknown = getAiModelCallsByWorkspace(workspaceId)
      .filter((r) => r.status === 'unavailable')
      .at(-1);
    expect(unknown?.provider).toBe('unknown');
    expect(unknown?.model).toBe('not-a-registered-model');
  });

  test('sanitizeChatMessagesForPersistence strips forged usage and re-hydrates from the workspace-owned row', () => {
    const callId = beginStoreManagerCall(workspaceId, resolvedModel);
    terminalizeStoreManagerCall(callId, resolvedModel, 'success', {
      promptTokens: 40,
      completionTokens: 20,
    });

    const forged: unknown = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }],
      // Client lies about totals/provider/model.
      usage: { promptTokens: 999999, completionTokens: 999999, provider: 'evil', model: 'forged', cost: 123 },
      metadata: {
        modelCallId: callId,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        resolutionReason: 'explicit',
        promptTokens: 1,
        completionTokens: 1,
        estimatedCostUsd: 999,
        costBasis: 'published_rate',
      },
    };

    const sanitized = sanitizeChatMessagesForPersistence(workspaceId, [forged]);
    expect(sanitized.length).toBe(1);
    const meta = sanitized[0].metadata as Record<string, unknown>;
    expect((sanitized[0] as Record<string, unknown>).usage).toBeUndefined();
    expect(meta.modelCallId).toBe(callId);
    expect(meta.provider).toBe('deepseek');
    expect(meta.model).toBe('deepseek-v4-flash');
    // resolutionReason has no table column; preserved only when the
    // server-attached provider/model match the durable row.
    expect(meta.resolutionReason).toBe('explicit');
    expect(meta.promptTokens).toBe(40);
    expect(meta.completionTokens).toBe(20);
    // computeApiCost rounds to 6 decimals via toFixed(6):
    // 40/1M*0.14 + 20/1M*0.28 = 0.0000112 -> 0.000011
    expect(meta.estimatedCostUsd).toBe(Number((40 / 1_000_000 * 0.14 + 20 / 1_000_000 * 0.28).toFixed(6)));
    expect(meta.costBasis).toBe('published_rate');
  });

  test('foreign or unknown model call ids are stripped, never trusted', () => {
    const foreign: unknown = {
      id: 'assistant-2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'x' }],
      metadata: { modelCallId: 'does-not-exist', provider: 'deepseek', model: 'deepseek-v4-flash' },
    };
    const sanitized = sanitizeChatMessagesForPersistence(workspaceId, [foreign]);
    const meta = sanitized[0].metadata as Record<string, unknown>;
    expect(meta.modelCallId).toBeUndefined();
    expect(meta.provider).toBeUndefined();
  });

  test('malformed messages and non-chat roles are dropped; user messages pass through', () => {
    const payload: unknown = [
      null,
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant' }, // missing id → dropped
      { id: 'sys-1', role: 'system', parts: [] }, // disallowed role → dropped
      'not-an-object',
    ];
    const sanitized = sanitizeChatMessagesForPersistence(workspaceId, payload);
    expect(sanitized.length).toBe(1);
    expect(sanitized[0].id).toBe('user-1');
    expect(sanitized[0].role).toBe('user');
  });

  test('message metadata shape matches the safe server contract', () => {
    const metadata = buildStoreManagerMessageMetadata(resolvedModel, 'call-meta', {
      inputTokens: 12,
      outputTokens: 7,
    });
    expectTypeOf(metadata.modelCallId).toBeString();
    expect(metadata.locality).toBe('cloud');
    expect(metadata.resolutionReason).toBe('explicit');
    expect(metadata.costBasis).toBe('published_rate');
  });
});
