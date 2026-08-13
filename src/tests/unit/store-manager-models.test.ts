import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import {
  listUsableStoreManagerModels,
  resolveAiSdkModel,
  ModelUnavailableError,
} from '../../server/services/ai-sdk-model-resolver';
import storeManagerRoutes from '../../server/routes/store-manager-routes';

describe('Store Manager model descriptor endpoint (epic #42, #32)', () => {
  const testDbPath = 'src/tests/unit/store-manager-models-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'gemma4:12b-mlx');
    upsertApiKey('deepseek', 'sk-deepseek-test', 'https://api.deepseek.com', 'deepseek-v4-flash');
    upsertApiKey('openai', 'sk-openai-test', 'https://api.openai.com/v1', 'gpt-4o-mini');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function withTaskConfig(body: () => void) {
    upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'deepseek', model: 'deepseek-v4-flash' });
    try {
      body();
    } finally {
      deleteLlmTaskConfig('store_manager_assistant');
    }
  }

  describe('listUsableStoreManagerModels', () => {
    test('normally configured install exposes exactly one usable default', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        expect(result.models.length).toBeGreaterThan(0);
        expect(result.defaultModelId).toBe('deepseek-v4-flash');
        const defaults = result.models.filter(m => m.isDefault);
        expect(defaults.length).toBe(1);
        expect(defaults[0].id).toBe('deepseek-v4-flash');
        expect(defaults[0].provider).toBe('deepseek');
        expect(defaults[0].locality).toBe('cloud');
      });
    });

    test('every returned model resolves through resolveAiSdkModel and supports tools', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        expect(result.models.length).toBeGreaterThan(0);
        for (const m of result.models) {
          const resolved = resolveAiSdkModel(m.id);
          expect(resolved.modelId).toBe(m.id);
          expect(resolved.provider).toBe(m.provider);
          expect(resolved.locality).toBe(m.locality);
          expect(resolved.resolutionReason).toBe('explicit');
          expect(resolved.modelInstance).toBeDefined();
        }
      });
    });

    test('omitted selection resolves to the same default the endpoint marks', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        const resolved = resolveAiSdkModel();
        expect(resolved.resolutionReason).toBe('task_config');
        expect(result.defaultModelId).toBe(resolved.modelId);
        const defaultOption = result.models.find(m => m.isDefault);
        expect(defaultOption?.id).toBe(resolved.modelId);
      });
    });

    test('never leaks credentials or base URLs', () => {
      withTaskConfig(() => {
        const result = listUsableStoreManagerModels();
        const json = JSON.stringify(result);
        expect(json).not.toContain('sk-');
        expect(json).not.toContain('apiKey');
        expect(json).not.toContain('baseUrl');
        expect(json).not.toContain('http');
      });
    });
  });

  describe('unconfigured install fails closed', () => {
    test('empty/unconfigured state returns empty list plus setup message', () => {
      const db = getDb();
      db.query('DELETE FROM api_keys').run();
      try {
        const result = listUsableStoreManagerModels();
        expect(result.models).toEqual([]);
        expect(result.defaultModelId).toBeNull();
        expect(result.setupMessage).toBeDefined();
        expect(result.setupMessage?.length).toBeGreaterThan(0);
        expect(() => resolveAiSdkModel()).toThrow(ModelUnavailableError);
      } finally {
        upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'gemma4:12b-mlx');
        upsertApiKey('deepseek', 'sk-deepseek-test', 'https://api.deepseek.com', 'deepseek-v4-flash');
        upsertApiKey('openai', 'sk-openai-test', 'https://api.openai.com/v1', 'gpt-4o-mini');
      }
    });
  });

  describe('GET /store-manager/models route', () => {
    test('returns the descriptor payload without secrets', async () => {
      await withTaskConfigAsync(async () => {
        const res = await storeManagerRoutes.request('/store-manager/models');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          models: unknown[];
          defaultModelId: string | null;
          setupMessage?: string;
        };
        expect(Array.isArray(body.models)).toBe(true);
        expect(body.models.length).toBeGreaterThan(0);
        expect(body.defaultModelId).toBe('deepseek-v4-flash');
        expect(body.setupMessage).toBeUndefined();
        const json = JSON.stringify(body);
        expect(json).not.toContain('sk-');
        expect(json).not.toContain('apiKey');
        expect(json).not.toContain('baseUrl');
      });
    });
  });
});

async function withTaskConfigAsync(body: () => Promise<void>) {
  upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'deepseek', model: 'deepseek-v4-flash' });
  try {
    await body();
  } finally {
    deleteLlmTaskConfig('store_manager_assistant');
  }
}
