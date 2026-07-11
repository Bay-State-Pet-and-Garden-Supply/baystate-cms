/**
 * Unit tests for `src/db/repositories/llm-task-config-repo.ts`.
 *
 * Runs under `bun test` (excluded from vitest) because the repo is
 * DB-dependent and vitest cannot load `bun:sqlite`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  getLlmTaskConfig,
  listLlmTaskConfigs,
  deleteLlmTaskConfig,
  LLM_TASKS,
} from '../../db/repositories/llm-task-config-repo';

describe('LLM Task Config Repository', () => {
  const testDbPath = 'src/tests/unit/llm-task-config-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('inserts and reads back a task config', () => {
    const config = upsertLlmTaskConfig({
      task: 'profile_generation',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrlOverride: 'https://custom.example.com/v1',
      temperature: 0.2,
    });
    expect(config.id).toBeDefined();
    expect(config.task).toBe('profile_generation');
    expect(config.provider).toBe('deepseek');
    expect(config.model).toBe('deepseek-v4-pro');
    expect(config.baseUrlOverride).toBe('https://custom.example.com/v1');
    expect(config.temperature).toBe(0.2);

    const found = getLlmTaskConfig('profile_generation');
    expect(found?.id).toBe(config.id);
    expect(found?.provider).toBe('deepseek');
    expect(found?.model).toBe('deepseek-v4-pro');
  });

  test('upsert updates the same task row in place', () => {
    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3',
    });
    const first = getLlmTaskConfig('product_name_consolidation');
    expect(first?.provider).toBe('ollama');

    // Re-upsert with a different provider/model
    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.5,
    });
    const second = getLlmTaskConfig('product_name_consolidation');
    expect(second?.id).toBe(first?.id);
    expect(second?.provider).toBe('openai');
    expect(second?.model).toBe('gpt-4o-mini');
    expect(second?.temperature).toBe(0.5);
  });

  test('LLM_TASKS contains all planned task identifiers', () => {
    expect(new Set(LLM_TASKS)).toEqual(
      new Set([
        'product_name_consolidation',
        'brand_inference',
        'profile_generation',
        'profile_revision',
        'product_curation',
        'category_classification',
        'classification_evidence_extraction',
        'product_type_classification',
        'category_page_assignment',
        'attribute_value_classification',
        'product_field_refactor',
        'store_manager_assistant',
      ]),
    );
  });

  test('listLlmTaskConfigs returns rows ordered by task name', () => {
    upsertLlmTaskConfig({
      task: 'profile_revision',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    upsertLlmTaskConfig({
      task: 'product_curation',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const list = listLlmTaskConfigs();
    expect(list.length).toBeGreaterThan(0);
    // Sorted by task ASC
    const tasks = list.map((c) => c.task);
    const sorted = [...tasks].sort();
    expect(tasks).toEqual(sorted);
  });

  test('deleteLlmTaskConfig removes the row', () => {
    upsertLlmTaskConfig({
      task: 'category_classification',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(getLlmTaskConfig('category_classification')).not.toBeNull();

    const deleted = deleteLlmTaskConfig('category_classification');
    expect(deleted).toBe(true);
    expect(getLlmTaskConfig('category_classification')).toBeNull();
  });

  test('deleteLlmTaskConfig returns false for a missing task', () => {
    const deleted = deleteLlmTaskConfig('classification_evidence_extraction');
    expect(deleted).toBe(false);
  });

  test('getLlmTaskConfig returns null for a missing task', () => {
    expect(getLlmTaskConfig('classification_evidence_extraction')).toBeNull();
  });

  test('task config provider credentials stay separate from api_keys', () => {
    // Seed a credential in api_keys
    upsertApiKey('deepseek', 'sk-credential-test');
    // Insert a task config that points to deepseek
    upsertLlmTaskConfig({
      task: 'profile_generation',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    // The task config row itself should NOT contain an api_key.
    const config = getLlmTaskConfig('profile_generation');
    expect(config).not.toBeNull();
    expect((config as unknown as Record<string, unknown>).api_key).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });
});
