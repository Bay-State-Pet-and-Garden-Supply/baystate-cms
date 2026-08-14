/**
 * Store Manager playbook-run repository (operations console, Issue 7).
 *
 * Durable playbook execution state: one run row per invocation with a
 * current-step pointer + lease, and one step row per declared step with
 * typed input/output, checkpoint diff hash, execution run id, and approval
 * state. All reads/writes are workspace-scoped. Checkpoints pause the run;
 * only a fresh operator approval bound to the exact diff hash resumes it.
 * The runner (src/store-manager/playbooks/runner.ts) claims steps one at a
 * time and calls runStoreManagerExecution per step — adapters are never
 * called directly from here.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';

export type StoreManagerPlaybookRunStatus =
  | 'running'
  | 'paused_at_checkpoint'
  | 'completed'
  | 'failed'
  | 'terminal';

export type StoreManagerPlaybookStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'approved'
  | 'denied'
  | 'executed'
  | 'verified'
  | 'failed'
  | 'skipped';

export interface StoreManagerPlaybookRunRow {
  id: string;
  workspace_id: string;
  workspace_path: string;
  playbook_id: string;
  playbook_version: number;
  definition_hash: string;
  status: StoreManagerPlaybookRunStatus;
  current_step_id: string | null;
  variables_json: string;
  scope_json: string | null;
  actor: string;
  owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  error_code: string | null;
  error_detail: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreManagerPlaybookStepRow {
  id: string;
  workspace_id: string;
  run_id: string;
  step_id: string;
  kind: string;
  status: StoreManagerPlaybookStepStatus;
  tool_name: string | null;
  tool_version: number | null;
  tool_call_id: string | null;
  input_json: string | null;
  output_json: string | null;
  artifact_id: string | null;
  diff_hash: string | null;
  execution_run_id: string | null;
  approval_actor: string | null;
  approval_diff_hash: string | null;
  approval_expires_at: string | null;
  error_code: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePlaybookRunInput {
  id?: string;
  workspaceId: string;
  workspacePath: string;
  playbookId: string;
  playbookVersion: number;
  definitionHash: string;
  variables: unknown;
  scope: unknown;
  actor: string;
}

export interface CreatePlaybookStepInput {
  workspaceId: string;
  runId: string;
  stepId: string;
  kind: string;
  toolName?: string | null;
  toolVersion?: number | null;
  input?: unknown;
}

const nowIso = () => new Date().toISOString();

export function createStoreManagerPlaybookRun(input: CreatePlaybookRunInput): string {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO store_manager_playbook_runs
       (id, workspace_id, workspace_path, playbook_id, playbook_version, definition_hash, status,
        current_step_id, variables_json, scope_json, actor, owner, lease_expires_at,
        heartbeat_at, error_code, error_detail, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.workspacePath,
      input.playbookId,
      input.playbookVersion,
      input.definitionHash,
      JSON.stringify(input.variables),
      input.scope === undefined || input.scope === null ? null : JSON.stringify(input.scope),
      input.actor,
      now,
      now,
      now,
    ],
  );
  return id;
}

export function createStoreManagerPlaybookStep(input: CreatePlaybookStepInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = nowIso();
  db.run(
    `INSERT INTO store_manager_playbook_steps
       (id, workspace_id, run_id, step_id, kind, status, tool_name, tool_version,
        tool_call_id, input_json, output_json, artifact_id, diff_hash, execution_run_id,
        approval_actor, approval_diff_hash, approval_expires_at, error_code,
        started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.runId,
      input.stepId,
      input.kind,
      input.toolName ?? null,
      input.toolVersion ?? null,
      input.input === undefined || input.input === null ? null : JSON.stringify(input.input).slice(0, 16 * 1024),
      now,
      now,
    ],
  );
  return id;
}

export function getStoreManagerPlaybookRun(
  workspaceId: string,
  runId: string,
): StoreManagerPlaybookRunRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_playbook_runs WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, runId) as StoreManagerPlaybookRunRow | undefined;
  return row ?? null;
}

export function listStoreManagerPlaybookRuns(
  workspaceId: string,
  limit = 50,
): StoreManagerPlaybookRunRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  return db
    .query(
      'SELECT * FROM store_manager_playbook_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(workspaceId, bounded) as StoreManagerPlaybookRunRow[];
}

export function listStoreManagerPlaybookSteps(
  workspaceId: string,
  runId: string,
): StoreManagerPlaybookStepRow[] {
  const db = getDb();
  return db
    .query(
      'SELECT * FROM store_manager_playbook_steps WHERE workspace_id = ? AND run_id = ? ORDER BY rowid ASC',
    )
    .all(workspaceId, runId) as StoreManagerPlaybookStepRow[];
}

/** Claim the run with an owner + lease (fail closed when already claimed). */
export function claimStoreManagerPlaybookRun(
  workspaceId: string,
  runId: string,
  owner: string,
  leaseExpiresAt: string,
): boolean {
  const db = getDb();
  const result = db
    .query(
      `UPDATE store_manager_playbook_runs
       SET owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND (owner IS NULL OR owner = ? OR lease_expires_at < ?)
         AND status IN ('running', 'paused_at_checkpoint')`,
    )
    .run(owner, leaseExpiresAt, nowIso(), nowIso(), workspaceId, runId, owner, nowIso());
  return (result.changes ?? 0) > 0;
}

export function heartbeatStoreManagerPlaybookRun(
  workspaceId: string,
  runId: string,
  leaseExpiresAt: string,
): boolean {
  const db = getDb();
  const result = db
    .query(
      'UPDATE store_manager_playbook_runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(nowIso(), leaseExpiresAt, nowIso(), workspaceId, runId);
  return (result.changes ?? 0) > 0;
}

export function releaseStoreManagerPlaybookRun(
  workspaceId: string,
  runId: string,
): boolean {
  const db = getDb();
  const result = db
    .query(
      'UPDATE store_manager_playbook_runs SET owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(nowIso(), workspaceId, runId);
  return (result.changes ?? 0) > 0;
}

export function updateStoreManagerPlaybookRunStatus(
  workspaceId: string,
  runId: string,
  status: StoreManagerPlaybookRunStatus,
  input: { currentStepId?: string | null; errorCode?: string | null; errorDetail?: string | null } = {},
): boolean {
  const db = getDb();
  const completedAt = status === 'completed' || status === 'failed' || status === 'terminal' ? nowIso() : null;
  const result = db
    .query(
      `UPDATE store_manager_playbook_runs
       SET status = ?, current_step_id = COALESCE(?, current_step_id),
           error_code = COALESCE(?, error_code), error_detail = COALESCE(?, error_detail),
           completed_at = COALESCE(?, completed_at), updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    )
    .run(
      status,
      input.currentStepId === undefined ? null : input.currentStepId,
      input.errorCode === undefined ? null : input.errorCode,
      input.errorDetail === undefined ? null : input.errorDetail,
      completedAt,
      nowIso(),
      workspaceId,
      runId,
    );
  return (result.changes ?? 0) > 0;
}

export function updateStoreManagerPlaybookStep(
  workspaceId: string,
  runId: string,
  stepId: string,
  input: {
    status?: StoreManagerPlaybookStepStatus;
    toolCallId?: string | null;
    output?: unknown;
    artifactId?: string | null;
    diffHash?: string | null;
    executionRunId?: string | null;
    approvalActor?: string | null;
    approvalDiffHash?: string | null;
    approvalExpiresAt?: string | null;
    errorCode?: string | null;
  },
): boolean {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.toolCallId !== undefined) {
    sets.push('tool_call_id = ?');
    params.push(input.toolCallId);
  }
  if (input.output !== undefined) {
    sets.push('output_json = ?');
    params.push(JSON.stringify(input.output).slice(0, 64 * 1024));
  }
  if (input.artifactId !== undefined) {
    sets.push('artifact_id = ?');
    params.push(input.artifactId);
  }
  if (input.diffHash !== undefined) {
    sets.push('diff_hash = ?');
    params.push(input.diffHash);
  }
  if (input.executionRunId !== undefined) {
    sets.push('execution_run_id = ?');
    params.push(input.executionRunId);
  }
  if (input.approvalActor !== undefined) {
    sets.push('approval_actor = ?');
    params.push(input.approvalActor);
  }
  if (input.approvalDiffHash !== undefined) {
    sets.push('approval_diff_hash = ?');
    params.push(input.approvalDiffHash);
  }
  if (input.approvalExpiresAt !== undefined) {
    sets.push('approval_expires_at = ?');
    params.push(input.approvalExpiresAt);
  }
  if (input.errorCode !== undefined) {
    sets.push('error_code = ?');
    params.push(input.errorCode);
  }
  if (input.status === 'running' || input.status === 'executed' || input.status === 'verified' || input.status === 'failed') {
    sets.push(input.status === 'running' ? 'started_at = COALESCE(started_at, ?)' : 'ended_at = ?');
    params.push(nowIso());
  }
  sets.push('updated_at = ?');
  params.push(nowIso(), workspaceId, runId, stepId);
  const result = db
    .query(`UPDATE store_manager_playbook_steps SET ${sets.join(', ')} WHERE workspace_id = ? AND run_id = ? AND step_id = ?`)
    .run(...(params as any[]));
  return (result.changes ?? 0) > 0;
}
