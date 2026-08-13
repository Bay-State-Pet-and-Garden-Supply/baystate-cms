import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { computeApiCost, getModelPricing, assertPublishedPricingRegistered } from '../../ai/model-pricing';
import {
  insertAiModelCallStart,
  completeAiModelCall,
  insertTerminalAiModelCall,
  getAiModelCallsByWorkspace,
  getAiModelCallById,
  getAiModelCallByWorkspaceAndId,
} from '../../db/repositories/ai-model-call-repo';
import {
  upsertLlmTaskConfig,
  getLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { callLlmForTask } from '../../onboarding/llm-client';
import {
  insertStoreManagerUnavailableCall,
  terminalizeStoreManagerCall,
  STORE_MANAGER_TASK,
} from '../../server/services/store-manager-telemetry';

describe('Pricing & Telemetry Repository (PR 3)', () => {
  const testDbPath = 'src/tests/unit/pricing-telemetry-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  describe('Model Pricing', () => {
    test('local model calls return cost 0 and costBasis local_zero', () => {
      const res = computeApiCost('ollama', 'gemma4:12b-mlx', 'local', 1000, 500);
      expect(res.estimatedApiCostUsd).toBe(0);
      expect(res.costBasis).toBe('local_zero');
    });

    test('known cloud models compute published rates', () => {
      // deepseek-v4-flash: 0.14/1M input, 0.28/1M output
      // 1,000,000 prompt + 1,000,000 completion = $0.42
      const res = computeApiCost('deepseek', 'deepseek-v4-flash', 'cloud', 1_000_000, 1_000_000);
      expect(res.estimatedApiCostUsd).toBe(0.42);
      expect(res.costBasis).toBe('published_rate');
    });

    test('unknown cloud models return null cost and costBasis unknown', () => {
      const res = computeApiCost('custom_cloud', 'unknown-model-xyz', 'cloud', 1000, 500);
      expect(res.estimatedApiCostUsd).toBeNull();
      expect(res.costBasis).toBe('unknown');
    });

    test('getModelPricing lookup works for registered models', () => {
      const flash = getModelPricing('deepseek-v4-flash');
      expect(flash).not.toBeNull();
      expect(flash?.inputPerMillion).toBe(0.14);

      const pro = getModelPricing('deepseek-v4-pro');
      expect(pro?.inputPerMillion).toBe(0.435);
      expect(pro?.outputPerMillion).toBe(0.87);

      const mini = getModelPricing('gpt-4o-mini');
      expect(mini?.outputPerMillion).toBe(0.60);
    });

    test('obsolete pricing aliases are removed (deepseek-chat / gpt-4o)', () => {
      expect(getModelPricing('deepseek-chat')).toBeNull();
      expect(getModelPricing('gpt-4o')).toBeNull();
    });

    test('every published pricing key is a registered model profile (drift invariant)', () => {
      // The pricing table and the model registry are one catalog; a non-empty
      // result means the lists drifted and the aliases must be reconciled.
      expect(assertPublishedPricingRegistered()).toEqual([]);
    });
  });

  describe('General AI Model Call Telemetry (ai_model_calls)', () => {
    test('inserts started row and completes it with terminal metrics', () => {
      const callId = insertAiModelCallStart({
        workspaceId: 'ws-101',
        task: 'store_manager_assistant',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        locality: 'cloud',
      });

      expect(callId).toBeDefined();
      let row = getAiModelCallById(callId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe('started');
      expect(row?.workspace_id).toBe('ws-101');

      const completed = completeAiModelCall(callId, {
        status: 'success',
        durationMs: 1250,
        promptTokens: 500,
        completionTokens: 200,
        estimatedApiCostUsd: 0.000126,
        costBasis: 'published_rate',
      });

      expect(completed).toBe(true);
      row = getAiModelCallById(callId);
      expect(row?.status).toBe('success');
      expect(row?.duration_ms).toBe(1250);
      expect(row?.prompt_tokens).toBe(500);
      expect(row?.completion_tokens).toBe(200);
      expect(row?.estimated_api_cost_usd).toBe(0.000126);
    });

    test('inserts direct terminal row for policy denied or unavailable status', () => {
      const callId = insertTerminalAiModelCall({
        workspaceId: 'ws-101',
        task: 'product_field_refactor',
        provider: 'ollama',
        model: 'gemma4:12b-mlx',
        locality: 'local',
        status: 'unavailable',
        errorCode: 'MODEL_NOT_FOUND',
      });

      const row = getAiModelCallById(callId);
      expect(row?.status).toBe('unavailable');
      expect(row?.error_code).toBe('MODEL_NOT_FOUND');
      expect(row?.estimated_api_cost_usd).toBe(0);
      expect(row?.cost_basis).toBe('local_zero');
    });

    test('getAiModelCallsByWorkspace lists records for workspace', () => {
      const list = getAiModelCallsByWorkspace('ws-101');
      expect(list.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Store Manager telemetry (epic #42, #37)', () => {
    test('workspace-scoped row lookup returns null for a foreign workspace id', () => {
      const callId = insertAiModelCallStart({
        workspaceId: 'ws-owned',
        task: STORE_MANAGER_TASK,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        locality: 'cloud',
      });
      expect(getAiModelCallByWorkspaceAndId('ws-owned', callId)).not.toBeNull();
      expect(getAiModelCallByWorkspaceAndId('ws-other', callId)).toBeNull();
    });

    test('explicit unavailable selection writes exactly one terminal unavailable row', () => {
      insertStoreManagerUnavailableCall('ws-101', 'deepseek-v4-flash');
      const calls = getAiModelCallsByWorkspace('ws-101');
      const unavailable = calls.filter((c) => c.status === 'unavailable');
      // The earlier MODEL_NOT_FOUND fixture row may share the same started_at
      // timestamp; select by error_code instead of relying on tie-break order.
      const written = unavailable.filter((c) => c.error_code === 'model_unavailable');
      expect(written).toHaveLength(1);
      const row = written[0];
      expect(row).toBeDefined();
      expect(row!.error_code).toBe('model_unavailable');
      expect(row!.task).toBe(STORE_MANAGER_TASK);
      // Registered selection maps to the registry profile.
      expect(row!.model).toBe('deepseek-v4-flash');
      expect(row!.provider).toBe('deepseek');
      expect(row!.ended_at).not.toBeNull();
    });

    test('aggregate cost uses resolved provider/model/locality and full token totals', () => {
      // Two tool-loop steps: 300 prompt + 150 completion tokens total.
      // deepseek-v4-flash $0.14/1M in, $0.28/1M out.
      const cost = computeApiCost('deepseek', 'deepseek-v4-flash', 'cloud', 300, 150);
      expect(cost.estimatedApiCostUsd).toBeCloseTo(0.000084, 10);
      expect(cost.costBasis).toBe('published_rate');

      // Local zero stays zero regardless of token totals.
      const local = computeApiCost('ollama', 'gemma4:12b-mlx', 'local', 999999, 999999);
      expect(local.estimatedApiCostUsd).toBe(0);
      expect(local.costBasis).toBe('local_zero');
    });

    test('general Store Manager tasks write ai_model_calls only, never classification_model_calls', async () => {
      upsertApiKey('deepseek', 'sk-store-manager-test', 'http://127.0.0.1:59997/v1', 'deepseek-v4-flash');
      upsertLlmTaskConfig({
        task: 'product_field_refactor',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('59997')) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"proposals":[]}' } }],
              usage: { prompt_tokens: 30, completion_tokens: 10 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const db = getDb();
      const before = (db.query('SELECT COUNT(*) as n FROM classification_model_calls').get() as { n: number }).n;
      const ws = 'ws-store-manager-general';

      try {
        const output = await callLlmForTask('product_field_refactor', 'Refactor field', undefined, {
          workspaceId: ws,
        });
        expect(output).toBe('{"proposals":[]}');

        const calls = getAiModelCallsByWorkspace(ws);
        expect(calls.length).toBe(1);
        expect(calls[0].task).toBe('product_field_refactor');
        expect(calls[0].status).toBe('success');
        expect(calls[0].provider).toBe('deepseek');
        expect(calls[0].model).toBe('deepseek-v4-flash');
        expect(calls[0].prompt_tokens).toBe(30);
        expect(calls[0].completion_tokens).toBe(10);

        const after = (db.query('SELECT COUNT(*) as n FROM classification_model_calls').get() as { n: number }).n;
        expect(after).toBe(before);
      } finally {
        globalThis.fetch = originalFetch;
        deleteLlmTaskConfig('product_field_refactor');
      }
    });

    test('terminalizeStoreManagerCall computes cost from the exact resolved metadata', () => {
      const callId = insertAiModelCallStart({
        workspaceId: 'ws-101',
        task: STORE_MANAGER_TASK,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        locality: 'cloud',
      });
      terminalizeStoreManagerCall(
        callId,
        {
          modelInstance: {} as never,
          provider: 'deepseek',
          modelId: 'deepseek-v4-flash',
          locality: 'cloud',
          resolutionReason: 'explicit',
        },
        'success',
        { promptTokens: 1000000, completionTokens: 1000000 },
      );
      const row = getAiModelCallById(callId);
      expect(row?.estimated_api_cost_usd).toBe(0.42);
      expect(row?.cost_basis).toBe('published_rate');
    });
  });

  describe('Explicit Fallback Schema in Task Configs', () => {
    test('persists and retrieves fallbackProvider and fallbackModel', () => {
      upsertLlmTaskConfig({
        task: 'store_manager_assistant',
        provider: 'ollama',
        model: 'gemma4:12b-mlx',
        fallbackProvider: 'deepseek',
        fallbackModel: 'deepseek-v4-flash',
      });

      const config = getLlmTaskConfig('store_manager_assistant');
      expect(config).not.toBeNull();
      expect(config?.provider).toBe('ollama');
      expect(config?.model).toBe('gemma4:12b-mlx');
      expect(config?.fallbackProvider).toBe('deepseek');
      expect(config?.fallbackModel).toBe('deepseek-v4-flash');

      deleteLlmTaskConfig('store_manager_assistant');
    });
  });
});
