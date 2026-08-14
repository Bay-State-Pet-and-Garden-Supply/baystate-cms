/**
 * Store Manager operations-console test fixtures (epic: operations console,
 * Issue 1).
 *
 * Shared fakes for the execution-boundary and runtime suites: bounded adapters
 * (read + persistent), a registry, fake V3 model transports (plain text,
 * tool-call-then-finish), a resolved-model stub, and message builders. No
 * network/model/ShopSite contact anywhere.
 */

import { z } from 'zod';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type {
  StoreManagerToolAdapter,
  StoreManagerToolResult,
} from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';

/** Record every adapter dispatch (read/write) for side-effect assertions. */
export function makeTestAdapters(calls: string[]): StoreManagerToolAdapter[] {
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
      calls.push('read');
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
    sideEffects: 'writes a proposal row',
    requiresApproval: true,
    stateTransition: 'proposal stored',
    allowedPhases: ['approve'] as const,
    scopeSummary: (i) => `write ${String(i.proposalId ?? '')}`,
    execute: async (): Promise<StoreManagerToolResult> => {
      calls.push('write');
      return okResult({ ok: true });
    },
  };
  return [readAdapter, writeAdapter];
}

export function makeTestRegistry(calls: string[]): StoreManagerToolRegistry {
  return new StoreManagerToolRegistry(makeTestAdapters(calls));
}

export const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

export function userMessage(text: string) {
  return [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text }] }];
}

/**
 * Plain model: streams one text part then finishes. Usage fixed so cost stays
 * within the default policy budget.
 */
export function plainTextModel(): LanguageModelV3 {
  return {
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
        { type: 'text-delta', id: 't1', delta: 'completed objective' },
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
}

/**
 * Tool-call model: step 1 emits one tool call for `toolName` (optionally
 * reading prior tool results to terminate), step 2 finishes with final text.
 * Returns the stream-call counter for assertions.
 */
export function toolCallModel(opts: {
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, unknown>;
}): { model: LanguageModelV3; getStreamCalls: () => number } {
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
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (hasToolResult) {
        parts.push(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'done' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            finishReason: { unified: 'stop', raw: 'stop' },
          },
        );
      } else {
        parts.push(
          { type: 'tool-call', toolCallId: opts.toolCallId, toolName: opts.toolName, input: JSON.stringify(opts.toolInput) },
          {
            type: 'finish',
            usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          },
        );
      }
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return { model, getStreamCalls: () => streamCalls };
}

/** Fake approved-message history for a tool call (used by gate-level tests). */
export function approvedMessagesFor(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName, input },
        { type: 'tool-approval-request', approvalId: `ap-${toolCallId}`, toolCallId },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: `ap-${toolCallId}`, approved: true }] },
  ];
}
