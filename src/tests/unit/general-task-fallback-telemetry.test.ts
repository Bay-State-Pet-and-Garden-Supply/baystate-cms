import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import { callLlmForTask } from '../../onboarding/llm-client';

describe('General Task Fallback & Telemetry Integration', () => {
  const testDbPath = 'src/tests/unit/general-task-fallback-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    upsertApiKey('ollama', 'ollama-key', 'http://127.0.0.1:59999/v1', 'gemma4:12b-mlx');
    upsertApiKey('deepseek', 'sk-test-fallback-key', 'http://127.0.0.1:59998/v1', 'deepseek-v4-flash');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('callLlmForTask logs telemetry start/terminal and escalates to fallback on primary transport failure', async () => {
    upsertLlmTaskConfig({
      task: 'product_field_refactor',
      provider: 'ollama',
      model: 'gemma4:12b-mlx',
      fallbackProvider: 'deepseek',
      fallbackModel: 'deepseek-v4-flash',
    });

    // Mock global fetch to simulate primary port failure and fallback success
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('59999')) {
        throw new Error('Connection refused to local Ollama on port 59999');
      }
      if (url.includes('59998')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Refactored field' } }],
            usage: { prompt_tokens: 50, completion_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const output = await callLlmForTask('product_field_refactor', 'Refactor field');
      expect(output).toBe('Refactored field');

      // Verify ai_model_calls telemetry row was created and updated with fallback details
      const calls = getAiModelCallsByWorkspace('default');
      expect(calls.length).toBeGreaterThan(0);
      const latestCall = calls[calls.length - 1];
      expect(latestCall.task).toBe('product_field_refactor');
      expect(latestCall.status).toBe('success');
      expect(latestCall.prompt_tokens).toBe(50);
      expect(latestCall.completion_tokens).toBe(15);
      expect(latestCall.cost_basis).toBe('published_rate');
    } finally {
      globalThis.fetch = originalFetch;
      deleteLlmTaskConfig('product_field_refactor');
    }
  });
});
