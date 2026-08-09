import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  upsertLlmTaskConfig,
  getLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';

describe('Zero-Deployment Rollback (PR 6)', () => {
  const testDbPath = 'src/tests/unit/zero-deployment-rollback-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('promotes task to local route gemma4:12b-mlx with fallback deepseek-v4-flash', () => {
    const config = upsertLlmTaskConfig({
      task: 'brand_inference',
      provider: 'ollama',
      model: 'gemma4:12b-mlx',
      fallbackProvider: 'deepseek',
      fallbackModel: 'deepseek-v4-flash',
    });

    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('gemma4:12b-mlx');
    expect(config.fallbackProvider).toBe('deepseek');
    expect(config.fallbackModel).toBe('deepseek-v4-flash');

    const fetched = getLlmTaskConfig('brand_inference');
    expect(fetched?.provider).toBe('ollama');
    expect(fetched?.model).toBe('gemma4:12b-mlx');
  });

  test('instantly rolls back route to DeepSeek cloud baseline via database configuration update with zero code deployment', () => {
    // Zero-deployment rollback: update the database task config row directly
    const updated = upsertLlmTaskConfig({
      task: 'brand_inference',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      fallbackProvider: null,
      fallbackModel: null,
    });

    expect(updated.provider).toBe('deepseek');
    expect(updated.model).toBe('deepseek-v4-flash');

    // Subsequent query immediately reflects the rolled-back route without server restart or redeployment
    const activeRoute = getLlmTaskConfig('brand_inference');
    expect(activeRoute?.provider).toBe('deepseek');
    expect(activeRoute?.model).toBe('deepseek-v4-flash');

    deleteLlmTaskConfig('brand_inference');
  });
});
