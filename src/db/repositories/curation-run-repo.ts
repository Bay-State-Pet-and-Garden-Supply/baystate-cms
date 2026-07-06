/**
 * Curation Run Repository — Phase 8A batch orchestration data access.
 *
 * Provides CRUD for the curation orchestration tables: runs, items, groups,
 * and model-call metadata. This is the foundation for the curation dashboard
 * and bulk operations.
 *
 * All operations use provider-agnostic types; provider-specific identifiers
 * are stored in JSON metadata columns, not dedicated columns.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CurationRun {
  id: string;
  workspaceId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  totalItems: number;
  completedItems: number;
  failedItems: number;
  progressJson?: string;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface CurationRunItem {
  id: string;
  runId: string;
  onboardingItemId: string;
  sku: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attemptCount: number;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface CurationRunGroup {
  id: string;
  runId: string;
  groupId: string;
  groupLabel: string;
  skusJson: string;
  createdAt: string;
}

export interface ModelCall {
  id: string;
  runId: string;
  runItemId?: string;
  task: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  status: 'success' | 'failed';
  errorMessage?: string;
  createdAt: string;
}

// ─── Create Curation Run ───────────────────────────────────────────────────────

export interface CreateCurationRunParams {
  workspaceId: string;
  totalItems: number;
}

export function createCurationRun(params: CreateCurationRunParams): CurationRun {
  const id = randomUUID();
  const startedAt = now();
  getDb().run(
    `INSERT INTO curation_runs (id, workspace_id, status, total_items, completed_items, failed_items, started_at)
     VALUES (?, ?, 'queued', ?, 0, 0, ?)`,
    [id, params.workspaceId, params.totalItems, startedAt],
  );
  return {
    id,
    workspaceId: params.workspaceId,
    status: 'queued',
    totalItems: params.totalItems,
    completedItems: 0,
    failedItems: 0,
    startedAt,
  };
}

// ─── Get Curation Run ──────────────────────────────────────────────────────────

export function getCurationRun(id: string): CurationRun | null {
  const row = getDb()
    .query('SELECT * FROM curation_runs WHERE id = ?')
    .get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

// ─── Update Curation Run Status ────────────────────────────────────────────────

export function updateCurationRunStatus(
  id: string,
  status: CurationRun['status'],
  errorMessage?: string,
): void {
  getDb().run(
    'UPDATE curation_runs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?',
    [status, now(), errorMessage ?? null, id],
  );
}

export function incrementCurationRunCompleted(id: string): void {
  getDb().run(
    'UPDATE curation_runs SET completed_items = completed_items + 1 WHERE id = ?',
    [id],
  );
}

export function incrementCurationRunFailed(id: string): void {
  getDb().run(
    'UPDATE curation_runs SET failed_items = failed_items + 1 WHERE id = ?',
    [id],
  );
}

export function updateCurationRunProgress(id: string, progressJson: string): void {
  getDb().run(
    'UPDATE curation_runs SET progress_json = ? WHERE id = ?',
    [progressJson, id],
  );
}

// ─── List Curation Runs ────────────────────────────────────────────────────────

export function listCurationRuns(
  workspaceId: string,
  status?: CurationRun['status'],
  limit = 50,
): CurationRun[] {
  let query = 'SELECT * FROM curation_runs WHERE workspace_id = ?';
  const params: any[] = [workspaceId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);

  const rows = getDb().query(query).all(...params) as Record<string, any>[];
  return rows.map(mapRun);
}

// ─── Curation Run Items ────────────────────────────────────────────────────────

export function createCurationRunItem(
  runId: string,
  sku: string,
  onboardingItemId: string,
): CurationRunItem {
  const id = randomUUID();
  const startedAt = now();
  getDb().run(
    `INSERT INTO curation_run_items (id, run_id, onboarding_item_id, sku, status, attempt_count, started_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?)`,
    [id, runId, onboardingItemId, sku, startedAt],
  );
  return {
    id,
    runId,
    onboardingItemId,
    sku,
    status: 'queued',
    attemptCount: 0,
    startedAt,
  };
}

export function getCurationRunItems(runId: string): CurationRunItem[] {
  const rows = getDb()
    .query('SELECT * FROM curation_run_items WHERE run_id = ? ORDER BY started_at ASC')
    .all(runId) as Record<string, any>[];
  return rows.map(mapRunItem);
}

export function getCurationRunItem(id: string): CurationRunItem | null {
  const row = getDb()
    .query('SELECT * FROM curation_run_items WHERE id = ?')
    .get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRunItem(row);
}

export function updateCurationRunItemStatus(
  id: string,
  status: CurationRunItem['status'],
  errorMessage?: string,
): void {
  getDb().run(
    'UPDATE curation_run_items SET status = ?, completed_at = ?, error_message = ? WHERE id = ?',
    [status, now(), errorMessage ?? null, id],
  );
}

export function incrementCurationRunItemRetry(id: string): number {
  getDb().run(
    'UPDATE curation_run_items SET attempt_count = attempt_count + 1 WHERE id = ?',
    [id],
  );
  const row = getDb()
    .query('SELECT attempt_count FROM curation_run_items WHERE id = ?')
    .get(id) as { attempt_count: number } | undefined;
  return row?.attempt_count ?? 0;
}

export function markCurationRunItemRunning(id: string): void {
  getDb().run(
    "UPDATE curation_run_items SET status = 'running', attempt_count = attempt_count + 1 WHERE id = ?",
    [id],
  );
}

// ─── Curation Run Groups ───────────────────────────────────────────────────────

export function createCurationRunGroup(
  runId: string,
  groupId: string,
  groupLabel: string,
  skus: string[],
): CurationRunGroup {
  const id = randomUUID();
  const createdAt = now();
  getDb().run(
    `INSERT INTO curation_run_groups (id, run_id, group_id, group_label, skus_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, runId, groupId, groupLabel, JSON.stringify(skus), createdAt],
  );
  return {
    id,
    runId,
    groupId,
    groupLabel,
    skusJson: JSON.stringify(skus),
    createdAt,
  };
}

export function getCurationRunGroups(runId: string): CurationRunGroup[] {
  const rows = getDb()
    .query('SELECT * FROM curation_run_groups WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as Record<string, any>[];
  return rows.map(mapRunGroup);
}

// ─── Model Calls ───────────────────────────────────────────────────────────────

export interface RecordModelCallParams {
  runId: string;
  runItemId?: string;
  task: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  status: 'success' | 'failed';
  errorMessage?: string;
}

export function recordModelCall(params: RecordModelCallParams): ModelCall {
  const id = randomUUID();
  const createdAt = now();
  getDb().run(
    `INSERT INTO curation_model_calls
     (id, run_id, run_item_id, task, provider, model, prompt_tokens, completion_tokens, duration_ms, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.runId,
      params.runItemId ?? null,
      params.task,
      params.provider,
      params.model,
      params.promptTokens ?? null,
      params.completionTokens ?? null,
      params.durationMs ?? null,
      params.status,
      params.errorMessage ?? null,
      createdAt,
    ],
  );
  return {
    id,
    runId: params.runId,
    runItemId: params.runItemId,
    task: params.task,
    provider: params.provider,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    durationMs: params.durationMs,
    status: params.status,
    errorMessage: params.errorMessage,
    createdAt,
  };
}

export function getModelCallsForRun(runId: string): ModelCall[] {
  const rows = getDb()
    .query('SELECT * FROM curation_model_calls WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as Record<string, any>[];
  return rows.map(mapModelCall);
}

// ─── Mappers ───────────────────────────────────────────────────────────────────

function mapRun(row: Record<string, any>): CurationRun {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    status: row.status as CurationRun['status'],
    totalItems: Number(row.total_items),
    completedItems: Number(row.completed_items),
    failedItems: Number(row.failed_items),
    progressJson: row.progress_json ? String(row.progress_json) : undefined,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
  };
}

function mapRunItem(row: Record<string, any>): CurationRunItem {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    onboardingItemId: String(row.onboarding_item_id),
    sku: String(row.sku),
    status: row.status as CurationRunItem['status'],
    attemptCount: Number(row.attempt_count),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
  };
}

function mapRunGroup(row: Record<string, any>): CurationRunGroup {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    groupId: String(row.group_id),
    groupLabel: String(row.group_label),
    skusJson: String(row.skus_json),
    createdAt: String(row.created_at),
  };
}

function mapModelCall(row: Record<string, any>): ModelCall {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    runItemId: row.run_item_id ? String(row.run_item_id) : undefined,
    task: String(row.task),
    provider: String(row.provider),
    model: String(row.model),
    promptTokens: row.prompt_tokens != null ? Number(row.prompt_tokens) : undefined,
    completionTokens: row.completion_tokens != null ? Number(row.completion_tokens) : undefined,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
    status: row.status as ModelCall['status'],
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
  };
}
