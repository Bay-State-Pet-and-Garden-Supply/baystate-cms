import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { getProviderDefinition, listProviderDefinitions } from '../../ai/provider-registry';
import { getModelProfile, getModelCapabilities, listModelProfiles } from '../../ai/model-registry';
import {
  resolveAiSdkModel,
  isModelToolCapable,
  ModelUnavailableError,
} from '../../server/services/ai-sdk-model-resolver';

describe('AI Infrastructure — Provider & Model Registry (PR 1)', () => {
  const testDbPath = 'src/tests/unit/provider-model-registry-test.db';

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

  describe('Provider Registry', () => {
    test('retrieves definition for Ollama', () => {
      const def = getProviderDefinition('ollama');
      expect(def).not.toBeNull();
      expect(def?.id).toBe('ollama');
      expect(def?.locality).toBe('local');
      expect(def?.transport).toBe('openai-compatible');
      expect(def?.defaultBaseUrl).toBe('http://localhost:11434/v1');
      expect(def?.requiresCredential).toBe(false);
    });

    test('retrieves definition for DeepSeek and OpenAI', () => {
      const deepseek = getProviderDefinition('deepseek');
      expect(deepseek?.locality).toBe('cloud');
      expect(deepseek?.requiresCredential).toBe(true);

      const openai = getProviderDefinition('openai');
      expect(openai?.locality).toBe('cloud');
      expect(openai?.requiresCredential).toBe(true);
    });

    test('returns null for unknown provider', () => {
      expect(getProviderDefinition('unknown-provider')).toBeNull();
      expect(getProviderDefinition('')).toBeNull();
    });

    test('lists all registered providers', () => {
      const all = listProviderDefinitions();
      expect(all.length).toBeGreaterThanOrEqual(3);
      expect(all.map(p => p.id)).toEqual(expect.arrayContaining(['ollama', 'deepseek', 'openai']));
    });
  });

  describe('Model Registry & Capabilities', () => {
    test('retrieves profile for gemma4:12b-mlx', () => {
      const profile = getModelProfile('gemma4:12b-mlx');
      expect(profile).not.toBeNull();
      expect(profile?.provider).toBe('ollama');
      expect(profile?.capabilities.modalities).toEqual(['text', 'image']);
      expect(profile?.capabilities.structuredOutput).toBe('json_schema');
      expect(profile?.localMemoryClass).toBe('medium');
    });

    test('retrieves profile for qwen3.5:9b and ministral-3:8b', () => {
      const qwen = getModelProfile('qwen3.5:9b');
      expect(qwen?.capabilities.toolCalling).toBe('parallel');
      expect(qwen?.capabilities.reasoning).toBe('configurable');

      const ministral = getModelProfile('ministral-3:8b');
      expect(ministral?.capabilities.structuredOutput).toBe('json_mode');
    });

    test('getModelCapabilities provides default capabilities for unregistered models', () => {
      const caps = getModelCapabilities('custom-unknown-model');
      expect(caps.modalities).toEqual(['text']);
      expect(caps.toolCalling).toBe('none');
      expect(caps.structuredOutput).toBe('prompted_json');
    });

    test('lists all model profiles', () => {
      const profiles = listModelProfiles();
      expect(profiles.length).toBeGreaterThanOrEqual(4);
      expect(profiles.map(m => m.id)).toEqual(expect.arrayContaining(['gemma4:12b-mlx', 'qwen3.5:9b', 'ministral-3:8b', 'deepseek-v4-flash']));
    });
  });

  describe('resolveAiSdkModel — resolved-model struct', () => {
    test('explicit provider+model object returns authoritative struct', () => {
      const resolved = resolveAiSdkModel({ provider: 'ollama', model: 'gemma4:12b-mlx' });
      expect(resolved).toBeDefined();
      expect(resolved.modelInstance).toBeDefined();
      expect(resolved.modelId).toBe('gemma4:12b-mlx');
      expect(resolved.provider).toBe('ollama');
      expect(resolved.locality).toBe('local');
      expect(resolved.resolutionReason).toBe('explicit');
    });

    test('explicit registered model string resolves via profile lookup', () => {
      const resolved = resolveAiSdkModel('gemma4:12b-mlx');
      expect(resolved.modelInstance).toBeDefined();
      expect(resolved.modelId).toBe('gemma4:12b-mlx');
      expect(resolved.provider).toBe('ollama');
      expect(resolved.resolutionReason).toBe('explicit');
    });

    test('explicit cloud baseline models resolve with cloud locality', () => {
      const deepseekModel = resolveAiSdkModel({ provider: 'deepseek', model: 'deepseek-v4-flash' });
      expect(deepseekModel.modelId).toBe('deepseek-v4-flash');
      expect(deepseekModel.provider).toBe('deepseek');
      expect(deepseekModel.locality).toBe('cloud');
      expect(deepseekModel.resolutionReason).toBe('explicit');

      const openaiModel = resolveAiSdkModel('gpt-4o-mini');
      expect(openaiModel.modelId).toBe('gpt-4o-mini');
      expect(openaiModel.provider).toBe('openai');
      expect(openaiModel.locality).toBe('cloud');
    });

    test('explicit unknown model throws ModelUnavailableError without fallback', () => {
      // Stale hard-coded picker ids are gone: these are not registered.
      expect(() => resolveAiSdkModel('deepseek-chat')).toThrow(ModelUnavailableError);
      expect(() => resolveAiSdkModel('gpt-4o')).toThrow(ModelUnavailableError);
      expect(() => resolveAiSdkModel('llama3')).toThrow(ModelUnavailableError);
    });

    test('explicit provider/model mismatch throws', () => {
      expect(() => resolveAiSdkModel({ provider: 'deepseek', model: 'gemma4:12b-mlx' })).toThrow(
        ModelUnavailableError,
      );
    });

    test('explicit masked credential throws ModelUnavailableError', () => {
      const db = getDb();
      db.query('UPDATE api_keys SET api_key = ? WHERE service = ?').run('••••sk-deepseek', 'deepseek');
      try {
        expect(() => resolveAiSdkModel('deepseek-v4-flash')).toThrow(ModelUnavailableError);
      } finally {
        db.query('UPDATE api_keys SET api_key = ? WHERE service = ?').run('sk-deepseek-test', 'deepseek');
      }
    });

    test('omitted input resolves the global default configuration', () => {
      const resolved = resolveAiSdkModel();
      expect(resolved.modelId).toBe('deepseek-v4-flash');
      expect(resolved.provider).toBe('deepseek');
      expect(resolved.resolutionReason).toBe('global_default');
    });

    test('omitted input with task config resolves the task_config route', () => {
      upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'ollama', model: 'gemma4:12b-mlx' });
      try {
        const resolved = resolveAiSdkModel();
        expect(resolved.modelId).toBe('gemma4:12b-mlx');
        expect(resolved.provider).toBe('ollama');
        expect(resolved.resolutionReason).toBe('task_config');
      } finally {
        deleteLlmTaskConfig('store_manager_assistant');
      }
    });

    test('explicit selection never falls back even when a default exists', () => {
      upsertLlmTaskConfig({ task: 'store_manager_assistant', provider: 'ollama', model: 'gemma4:12b-mlx' });
      try {
        const explicit = resolveAiSdkModel('deepseek-v4-flash');
        expect(explicit.resolutionReason).toBe('explicit');
        expect(explicit.modelId).toBe('deepseek-v4-flash');
        // Explicit unavailability still fails even though a default exists.
        expect(() => resolveAiSdkModel('deepseek-chat')).toThrow(ModelUnavailableError);
      } finally {
        deleteLlmTaskConfig('store_manager_assistant');
      }
    });

    test('isModelToolCapable accepts registered tool models and rejects unknowns', () => {
      expect(isModelToolCapable('gemma4:12b-mlx')).toBe(true);
      expect(isModelToolCapable('deepseek-v4-flash')).toBe(true);
      expect(isModelToolCapable('gpt-4o-mini')).toBe(true);
      expect(isModelToolCapable('not-a-registered-model')).toBe(false);
    });
  });
});
