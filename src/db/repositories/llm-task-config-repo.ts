import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

/**
 * Known LLM provider identifiers accepted by `llm_task_configs`. The
 * `api_keys` table holds credentials under matching service names
 * (`deepseek`, `openai`, `ollama`).
 */
export type LlmProvider = 'deepseek' | 'openai' | 'ollama';

const LLM_PROVIDERS: ReadonlyArray<LlmProvider> = [
  'deepseek',
  'openai',
  'ollama',
];

/**
 * Known AI tasks that can be routed through the LLM client. The
 * planner locked-in set (decisions 15-19) defines these as distinct
 * AI capabilities, each with its own model choice. Adding a new task
 * is a one-line change here plus a new UI row in the settings page.
 */
export type LlmTask =
  | 'product_name_consolidation'
  | 'profile_generation'
  | 'profile_revision'
  | 'product_curation'
  | 'category_classification'
  | 'classification_evidence_extraction';

export const LLM_TASKS: ReadonlyArray<LlmTask> = [
  'product_name_consolidation',
  'profile_generation',
  'profile_revision',
  'product_curation',
  'category_classification',
  'classification_evidence_extraction',
];

/**
 * Snapshot of a single `llm_task_configs` row. Provider credentials
 * (api_key) are NOT stored here — they live in `api_keys` under the
 * matching service name. This table only routes which provider and
 * model each AI task should use.
 */
export interface LlmTaskConfig {
  id: string;
  task: LlmTask;
  provider: LlmProvider;
  model: string;
  baseUrlOverride: string | null;
  temperature: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DbLlmTaskConfig {
  id: string;
  task: string;
  provider: string;
  model: string;
  base_url_override: string | null;
  temperature: number | null;
  created_at: string;
  updated_at: string;
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as ReadonlyArray<string>).includes(value);
}

function isLlmTask(value: string): value is LlmTask {
  return (LLM_TASKS as ReadonlyArray<string>).includes(value);
}

function mapToConfig(row: DbLlmTaskConfig): LlmTaskConfig {
  return {
    id: row.id,
    task: isLlmTask(row.task) ? row.task : (row.task as LlmTask),
    provider: isLlmProvider(row.provider) ? row.provider : 'openai',
    model: row.model,
    baseUrlOverride: row.base_url_override,
    temperature: row.temperature,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertLlmTaskConfigInput {
  task: LlmTask;
  provider: LlmProvider;
  model: string;
  baseUrlOverride?: string | null;
  temperature?: number | null;
}

export function upsertLlmTaskConfig(
  input: UpsertLlmTaskConfigInput,
): LlmTaskConfig {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .query('SELECT * FROM llm_task_configs WHERE task = ?')
    .get(input.task) as DbLlmTaskConfig | undefined;

  const baseUrlOverride = input.baseUrlOverride ?? null;
  const temperature = input.temperature ?? null;

  if (existing) {
    db.query(`
      UPDATE llm_task_configs
      SET provider = ?, model = ?, base_url_override = ?, temperature = ?, updated_at = ?
      WHERE task = ?
    `).run(
      input.provider,
      input.model,
      baseUrlOverride,
      temperature,
      now,
      input.task,
    );
    return mapToConfig({
      ...existing,
      provider: input.provider,
      model: input.model,
      base_url_override: baseUrlOverride,
      temperature,
      updated_at: now,
    });
  }

  const id = randomUUID();
  db.query(`
    INSERT INTO llm_task_configs (id, task, provider, model, base_url_override, temperature, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.task,
    input.provider,
    input.model,
    baseUrlOverride,
    temperature,
    now,
    now,
  );

  return {
    id,
    task: input.task,
    provider: input.provider,
    model: input.model,
    baseUrlOverride,
    temperature,
    createdAt: now,
    updatedAt: now,
  };
}

export function getLlmTaskConfig(task: LlmTask): LlmTaskConfig | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM llm_task_configs WHERE task = ?')
    .get(task) as DbLlmTaskConfig | undefined;
  return row ? mapToConfig(row) : null;
}

export function listLlmTaskConfigs(): LlmTaskConfig[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM llm_task_configs ORDER BY task ASC')
    .all() as DbLlmTaskConfig[];
  return rows.map(mapToConfig);
}

export function deleteLlmTaskConfig(task: LlmTask): boolean {
  const db = getDb();
  const result = db
    .query('DELETE FROM llm_task_configs WHERE task = ?')
    .run(task);
  return result.changes > 0;
}
