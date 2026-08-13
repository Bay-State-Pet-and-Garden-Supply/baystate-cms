import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getDb } from '../../db/connection';
import {
  saveChatMessage,
  getChatHistory,
  getChatThreads,
  clearChatHistory,
  pruneOldChatHistory,
} from '../../server/services/store-manager-chat-history-service';
import {
  sanitizeChatMessagesForPersistence,
  beginStoreManagerCall,
  terminalizeStoreManagerCall,
} from '../../server/services/store-manager-telemetry';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import type { UIMessage } from 'ai';

describe('Store Manager Chat History Service', () => {
  const testDbPath = './test-chat.db';
  const workspaceId = randomUUID();
  const threadId = randomUUID();
  const threadTitle = 'Test Conversation';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    if (existsSync(testDbPath)) {
      try { unlinkSync(testDbPath); } catch { /* ok */ }
    }
  });

  it('should save and load chat history correctly', () => {
    const messageId1 = randomUUID();
    const userMessage: UIMessage = {
      id: messageId1,
      role: 'user',
      parts: [{ type: 'text', text: 'Hello, audit custom fields please' }],
    };

    saveChatMessage(workspaceId, threadId, threadTitle, messageId1, 'user', userMessage);

    const messageId2 = randomUUID();
    const assistantMessage: UIMessage = {
      id: messageId2,
      role: 'assistant',
      parts: [{ type: 'text', text: 'I am auditing custom fields now' }],
    };

    saveChatMessage(workspaceId, threadId, threadTitle, messageId2, 'assistant', assistantMessage);

    const history = getChatHistory(workspaceId, threadId);
    expect(history.length).toBe(2);
    expect(history[0].id).toBe(messageId1);
    expect(history[0].role).toBe('user');
    expect(history[1].id).toBe(messageId2);
    expect(history[1].role).toBe('assistant');

    const threads = getChatThreads(workspaceId);
    expect(threads.length).toBe(1);
    expect(threads[0].id).toBe(threadId);
    expect(threads[0].title).toBe(threadTitle);
  });

  it('should clear chat history', () => {
    const historyBefore = getChatHistory(workspaceId, threadId);
    expect(historyBefore.length).toBe(2);

    clearChatHistory(workspaceId, threadId);

    const historyAfter = getChatHistory(workspaceId, threadId);
    expect(historyAfter.length).toBe(0);
  });

  it('should prune messages older than 1 week (7 days)', () => {
    const db = getDb();
    const tId = randomUUID();
    const idOld = randomUUID();
    const idNew = randomUUID();

    const oldMsg: UIMessage = {
      id: idOld,
      role: 'user',
      parts: [{ type: 'text', text: 'Old message' }],
    };

    const newMsg: UIMessage = {
      id: idNew,
      role: 'user',
      parts: [{ type: 'text', text: 'New message' }],
    };

    // Save both
    saveChatMessage(workspaceId, tId, 'Pruning Test', idOld, 'user', oldMsg);
    saveChatMessage(workspaceId, tId, 'Pruning Test', idNew, 'user', newMsg);

    // Explicitly modify the created_at column of the old message to be 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE store_manager_chat_history SET created_at = ? WHERE id = ?', [eightDaysAgo, idOld]);

    // Run pruning
    pruneOldChatHistory();

    // Verify
    const history = getChatHistory(workspaceId, tId);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(idNew);
  });

  it('hydrates assistant-message telemetry from the durable, workspace-owned model-call row (restart-safe)', () => {
    const resolved: ResolvedAiSdkModel = {
      modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      locality: 'cloud',
      resolutionReason: 'explicit',
    };
    const callId = beginStoreManagerCall(workspaceId, resolved);
    terminalizeStoreManagerCall(callId, resolved, 'success', {
      promptTokens: 55,
      completionTokens: 22,
    });

    // The client only needs to carry the server-attached call id; everything
    // else is reconstructed from the durable row (no in-memory map needed).
    const sanitized = sanitizeChatMessagesForPersistence(workspaceId, [
      {
        id: 'assistant-telemetry',
        role: 'assistant',
        parts: [{ type: 'text', text: 'done' }],
        usage: { promptTokens: 1, completionTokens: 1, provider: 'forged', model: 'forged' },
        metadata: { modelCallId: callId, provider: 'deepseek', model: 'deepseek-v4-flash', resolutionReason: 'explicit' },
      },
    ]);

    expect(sanitized.length).toBe(1);
    const msg = sanitized[0] as Record<string, unknown>;
    expect(msg.usage).toBeUndefined();
    const meta = msg.metadata as Record<string, unknown>;
    expect(meta.modelCallId).toBe(callId);
    expect(meta.provider).toBe('deepseek');
    expect(meta.model).toBe('deepseek-v4-flash');
    expect(meta.promptTokens).toBe(55);
    expect(meta.completionTokens).toBe(22);
    expect(meta.estimatedCostUsd).not.toBeNull();
    expect(meta.costBasis).toBe('published_rate');
  });

  it('rejects telemetry metadata from another workspace and unknown call ids', () => {
    const resolved: ResolvedAiSdkModel = {
      modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      locality: 'cloud',
      resolutionReason: 'explicit',
    };
    // Row owned by a different workspace than the one saving the thread.
    const foreignCallId = beginStoreManagerCall('other-workspace', resolved);
    terminalizeStoreManagerCall(foreignCallId, resolved, 'success', { promptTokens: 7, completionTokens: 3 });

    const sanitized = sanitizeChatMessagesForPersistence(workspaceId, [
      {
        id: 'assistant-foreign',
        role: 'assistant',
        parts: [{ type: 'text', text: 'x' }],
        metadata: { modelCallId: foreignCallId },
      },
      {
        id: 'assistant-unknown',
        role: 'assistant',
        parts: [{ type: 'text', text: 'y' }],
        metadata: { modelCallId: 'no-such-call' },
      },
    ]);

    const foreignMeta = sanitized[0].metadata as Record<string, unknown>;
    const unknownMeta = sanitized[1].metadata as Record<string, unknown>;
    expect(foreignMeta.modelCallId).toBeUndefined();
    expect(foreignMeta.provider).toBeUndefined();
    expect(unknownMeta.modelCallId).toBeUndefined();
  });
});
