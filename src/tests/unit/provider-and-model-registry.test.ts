import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { getProviderDefinition, listProviderDefinitions } from '../../ai/provider-registry';
import { getModelProfile, getModelCapabilities, listModelProfiles } from '../../ai/model-registry';
import { resolveAiSdkModel } from '../../server/services/ai-sdk-model-resolver';

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

  describe('resolveAiSdkModel Refactor', () => {
    test('resolves model using explicit provider and model object options', () => {
      const model = resolveAiSdkModel({ provider: 'ollama', model: 'gemma4:12b-mlx' });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemma4:12b-mlx');
      expect(model.provider).toBe('openai.chat'); // AI SDK OpenAI-compatible wrapper identifier
    });

    test('resolves model using registered model name string via profile lookup', () => {
      const model = resolveAiSdkModel('gemma4:12b-mlx');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gemma4:12b-mlx');
    });

    test('resolves cloud baseline models explicitly', () => {
      const deepseekModel = resolveAiSdkModel({ provider: 'deepseek', model: 'deepseek-v4-flash' });
      expect(deepseekModel.modelId).toBe('deepseek-v4-flash');

      const openaiModel = resolveAiSdkModel('gpt-4o-mini');
      expect(openaiModel.modelId).toBe('gpt-4o-mini');
    });
  });
});
