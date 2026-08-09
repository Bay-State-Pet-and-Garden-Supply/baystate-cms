/**
 * Telemetry repository for general application AI model calls (`ai_model_calls`).
 *
 * MUTUALLY EXCLUSIVE with `classification_model_calls`:
 * - Protected classification operations use `classification_model_calls` ONLY.
 * - Non-protected general application AI operations use `ai_model_calls` ONLY.
 *
 * Prompts are NOT stored by default.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { computeApiCost, type CostBasis } from '../../ai/model-pricing';

const now = () => new Date().toISOString();

export type GeneralModelCallStatus =
  | 'started'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'policy_denied'
  | 'unavailable';

export interface GeneralModelCallStartInput {
  workspaceId: string;
  task: string;
  provider: string;
  model: string;
  locality: 'local' | 'cloud';
  promptTemplateVersion?: string | null;
  fallbackFromCallId?: string | null;
  retryCount?: number;
}

export interface GeneralModelCallTerminalUpdate {
  status: GeneralModelCallStatus;
  endedAt?: string;
  durationMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedApiCostUsd?: number | null;
  costBasis?: CostBasis | null;
  fallbackCount?: number;
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  errorCode?: string | null;
}

export interface GeneralModelCallRow {
  id: string;
  workspace_id: string;
  task: string;
  provider: string;
  model: string;
  locality: 'local' | 'cloud';
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  status: GeneralModelCallStatus;
  fallback_from_call_id: string | null;
  retry_count: number;
  estimated_api_cost_usd: number | null;
  cost_basis: CostBasis;
  prompt_template_version: string | null;
  error_code: string | null;
  created_at: string;
}

/**
 * Insert a `started` telemetry row for a non-protected general AI operation.
 */
export function insertAiModelCallStart(input: GeneralModelCallStartInput): string {
  const id = randomUUID();
  const db = getDb();
  const nowTs = now();

  db.run(
    `INSERT INTO ai_model_calls
     (id, workspace_id, task, provider, model, locality, started_at, status,
      fallback_from_call_id, retry_count, cost_basis, prompt_template_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.task,
      input.provider,
      input.model,
      input.locality,
      nowTs,
      'started',
      input.fallbackFromCallId ?? null,
      input.retryCount ?? 0,
      input.locality === 'local' ? 'local_zero' : 'unknown',
      input.promptTemplateVersion ?? null,
      nowTs,
    ],
  );

  return id;
}

/**
 * Complete a `started` telemetry row for a general AI operation.
 */
export function completeAiModelCall(callId: string, update: GeneralModelCallTerminalUpdate): boolean {
  const db = getDb();
  const nowTs = update.endedAt ?? now();

  const result = db.run(
    `UPDATE ai_model_calls SET
       status = ?, ended_at = ?, duration_ms = ?, prompt_tokens = ?, completion_tokens = ?,
       estimated_api_cost_usd = ?, cost_basis = COALESCE(?, cost_basis), error_code = ?
     WHERE id = ? AND status = 'started'`,
    [
      update.status,
      nowTs,
      update.durationMs ?? null,
      update.promptTokens ?? null,
      update.completionTokens ?? null,
      update.estimatedApiCostUsd ?? null,
      update.costBasis ?? null,
      update.errorCode ?? null,
      callId,
    ],
  );

  return (result.changes ?? 0) > 0;
}

/**
 * Insert a terminal telemetry row directly when no transport attempt occurred (e.g. unavailable/policy denied).
 */
export function insertTerminalAiModelCall(
  input: GeneralModelCallStartInput & {
    status: 'policy_denied' | 'unavailable';
    errorCode?: string | null;
  },
): string {
  const id = randomUUID();
  const db = getDb();
  const nowTs = now();
  const cost = computeApiCost(input.provider, input.model, input.locality, null, null);

  db.run(
    `INSERT INTO ai_model_calls
     (id, workspace_id, task, provider, model, locality, started_at, ended_at, duration_ms,
      status, fallback_from_call_id, retry_count, estimated_api_cost_usd, cost_basis,
      prompt_template_version, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.task,
      input.provider,
      input.model,
      input.locality,
      nowTs,
      nowTs,
      0,
      input.status,
      input.fallbackFromCallId ?? null,
      input.retryCount ?? 0,
      cost.estimatedApiCostUsd,
      cost.costBasis,
      input.promptTemplateVersion ?? null,
      input.errorCode ?? null,
      nowTs,
    ],
  );

  return id;
}

/**
 * List telemetry calls for a workspace.
 */
export function getAiModelCallsByWorkspace(workspaceId: string, limit = 50): GeneralModelCallRow[] {
  return getDb()
    .query('SELECT * FROM ai_model_calls WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(workspaceId, limit) as unknown as GeneralModelCallRow[];
}

export function getAiModelCallById(callId: string): GeneralModelCallRow | null {
  const row = getDb()
    .query('SELECT * FROM ai_model_calls WHERE id = ?')
    .get(callId) as Record<string, unknown> | undefined;
  return row ? (row as unknown as GeneralModelCallRow) : null;
}
