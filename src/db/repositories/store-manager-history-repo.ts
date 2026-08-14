/**
 * Store Manager run-history repository (operations console, Issue 7).
 *
 * Read-only joins over run/session/turn/event/artifact rows plus the EXISTING
 * ai_model_calls telemetry (no duplicate provider/model/token/cost columns).
 * Everything returned is bounded and redacted; chain of thought, raw prompts,
 * secrets, and absolute paths never enter these shapes.
 *
 * Also owns the durable per-proposal review-decision rows used by the
 * bounded history queries (rejected-more-than-once) and per-item audit.
 */

import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import {
  getStoreManagerRuns,
  getStoreManagerEventsCursored,
  getStoreManagerRunArtifacts,
  type StoreManagerSessionRow,
} from './store-manager-session-repo';
import { getAiModelCallByWorkspaceAndId } from './ai-model-call-repo';
import type { StoreManagerRunHistoryDetail, StoreManagerHistoryRun } from '../../shared/schemas/store-manager-history';

export interface StoreManagerHistoryListRow extends StoreManagerSessionRow {
  artifact_count: number;
}

/**
 * List runs (workspace-scoped, cursor paginated) with their bounded artifact
 * counts. Mirrors getStoreManagerRuns ordering (created_at DESC, id DESC).
 */
export function listRunHistory(
  workspaceId: string,
  opts: { after?: { createdAt: string; id: string } | null; limit?: number; entrypoint?: string | null } = {},
): { runs: StoreManagerHistoryListRow[]; nextCursor: { createdAt: string; id: string } | null } {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const base = 'FROM store_manager_sessions s WHERE s.workspace_id = ?';
  const params: unknown[] = [workspaceId];
  let where = base;
  if (opts.entrypoint) {
    where += ' AND s.entrypoint = ?';
    params.push(opts.entrypoint);
  }
  if (opts.after) {
    where += ' AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))';
    params.push(opts.after.createdAt, opts.after.createdAt, opts.after.id);
  }
  params.push(limit);
  const rows = db
    .query(
      `SELECT s.*, (SELECT COUNT(*) FROM store_manager_run_artifacts a WHERE a.workspace_id = s.workspace_id AND a.run_id = s.id) AS artifact_count ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...(params as any[])) as StoreManagerHistoryListRow[];
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    runs: rows,
    nextCursor: last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/** Map a session row to the bounded history run shape. */
export function toHistoryRun(
  row: StoreManagerHistoryListRow | StoreManagerSessionRow,
  artifactCount = 0,
  extras: { terminalStatus?: string | null; outcomeReason?: string | null } = {},
): StoreManagerHistoryRun {
  return {
    runId: row.id,
    workspaceId: row.workspace_id,
    entrypoint: (row.entrypoint ?? 'chat') as StoreManagerHistoryRun['entrypoint'],
    executionMode: (row.execution_mode ?? 'interactive') as StoreManagerHistoryRun['executionMode'],
    actorClass: (row.actor_class ?? 'operator') as StoreManagerHistoryRun['actorClass'],
    objective: (row.objective ?? '').slice(0, 300),
    status: row.status,
    terminalStatus: (extras.terminalStatus ?? null) as StoreManagerHistoryRun['terminalStatus'],
    outcomeReason: extras.outcomeReason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelCallId: row.model_call_id,
    policyHash: row.policy_hash,
    scopeHash: row.scope_hash,
    lineage: row.lineage_json ? JSON.parse(row.lineage_json) : null,
    artifactCount,
  };
}

/**
 * Workspace-scoped run detail: run metadata + bounded ordered events +
 * artifact rows + the exact ai_model_calls telemetry row. Foreign/unknown
 * runs return null (externally indistinguishable).
 */
export function getRunHistoryDetail(
  workspaceId: string,
  runId: string,
  opts: { maxEvents?: number; maxArtifacts?: number } = {},
): StoreManagerRunHistoryDetail | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_sessions WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, runId) as StoreManagerSessionRow | undefined;
  if (!row) return null;

  const turn = db
    .query('SELECT terminal_status, outcome_reason FROM store_manager_turns WHERE workspace_id = ? AND turn_id = ? LIMIT 1')
    .get(workspaceId, runId) as { terminal_status: string | null; outcome_reason: string | null } | undefined;

  const maxEvents = Math.min(Math.max(opts.maxEvents ?? 300, 1), 500);
  const maxArtifacts = Math.min(Math.max(opts.maxArtifacts ?? 50, 1), 100);
  const events = getStoreManagerEventsCursored(workspaceId, { sessionId: runId, limit: maxEvents }).map(
    (e) => JSON.parse(e.payload_json) as unknown,
  );
  const artifacts = getStoreManagerRunArtifacts(workspaceId, runId, maxArtifacts).map((a) => ({
    id: a.id,
    kind: a.kind,
    schemaVersion: a.schema_version,
    contentHash: a.content_hash,
    createdAt: a.created_at,
  }));
  const modelCall = row.model_call_id ? getAiModelCallByWorkspaceAndId(workspaceId, row.model_call_id) : null;

  return {
    run: toHistoryRun(row, artifacts.length, {
      terminalStatus: turn?.terminal_status ?? null,
      outcomeReason: turn?.outcome_reason ?? null,
    }),
    events,
    artifacts,
    modelCall: modelCall
      ? {
          id: modelCall.id,
          provider: modelCall.provider,
          model: modelCall.model,
          locality: modelCall.locality,
          status: modelCall.status,
          promptTokens: modelCall.prompt_tokens,
          completionTokens: modelCall.completion_tokens,
          estimatedApiCostUsd: modelCall.estimated_api_cost_usd,
          errorCode: modelCall.error_code,
          startedAt: modelCall.started_at,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Review decisions (durable per-proposal operator decisions)
// ---------------------------------------------------------------------------

export type StoreManagerReviewDecisionValue = 'dismissed' | 'denied';

export interface RecordReviewDecisionInput {
  workspaceId: string;
  proposalId: string;
  field: string;
  decision: StoreManagerReviewDecisionValue;
  actor: string;
  runId?: string | null;
  stepId?: string | null;
}

export function recordReviewDecision(input: RecordReviewDecisionInput): void {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const id = `${input.workspaceId}:${input.proposalId}:${input.decision}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    `INSERT INTO store_manager_review_decisions
       (id, workspace_id, proposal_id, field, decision, actor, run_id, step_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.proposalId,
      input.field,
      input.decision,
      input.actor,
      input.runId ?? null,
      input.stepId ?? null,
      new Date().toISOString(),
    ],
  );
}

export interface ReviewDecisionRow {
  proposal_id: string;
  field: string;
  decision: string;
  actor: string;
  run_id: string | null;
  step_id: string | null;
  created_at: string;
}

/** Proposals dismissed/denied more than once in a workspace (bounded). */
export function listRepeatedlyRejectedProposals(
  workspaceId: string,
  opts: { minRejections?: number; limit?: number } = {},
): Array<{ proposalId: string; field: string; rejections: number; decisions: ReviewDecisionRow[] }> {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const minRejections = Math.min(Math.max(opts.minRejections ?? 2, 1), 100);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const groups = db
    .query(
      `SELECT proposal_id, field, COUNT(*) AS rejections
       FROM store_manager_review_decisions
       WHERE workspace_id = ? AND decision IN ('dismissed', 'denied')
       GROUP BY proposal_id HAVING COUNT(*) >= ?
       ORDER BY rejections DESC LIMIT ?`,
    )
    .all(workspaceId, minRejections, limit) as Array<{ proposal_id: string; field: string; rejections: number }>;
  const out: Array<{ proposalId: string; field: string; rejections: number; decisions: ReviewDecisionRow[] }> = [];
  for (const group of groups) {
    const decisions = db
      .query(
        `SELECT proposal_id, field, decision, actor, run_id, step_id, created_at
         FROM store_manager_review_decisions
         WHERE workspace_id = ? AND proposal_id = ?
         ORDER BY created_at ASC LIMIT 100`,
      )
      .all(workspaceId, group.proposal_id) as ReviewDecisionRow[];
    out.push({
      proposalId: group.proposal_id,
      field: group.field,
      rejections: group.rejections,
      decisions,
    });
  }
  return out;
}

/** Number of dismiss/deny decisions per field (cleanup-work ranking). */
export function countReviewDecisionsByField(workspaceId: string): Record<string, number> {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const rows = db
    .query(
      `SELECT field, COUNT(*) AS count FROM store_manager_review_decisions
       WHERE workspace_id = ? GROUP BY field ORDER BY count DESC LIMIT 100`,
    )
    .all(workspaceId) as Array<{ field: string; count: number }>;
  const byField: Record<string, number> = {};
  for (const row of rows) byField[row.field] = Number(row.count) || 0;
  return byField;
}

/**
 * Recurring issue fingerprints from the durable source-cursor substrate
 * (Issue 5): a source kind+id observed many times means the same finding keeps
 * reappearing across reconciliations (deterministic recurrence evidence).
 */
export function listRecurringInboxFingerprints(
  workspaceId: string,
  opts: { minOccurrences?: number; limit?: number } = {},
): Array<{ dedupeKey: string; kind: string; occurrences: number; firstSeenAt: string; lastSeenAt: string; lifecycle: string }> {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const minOccurrences = Math.min(Math.max(opts.minOccurrences ?? 2, 2), 100);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .query(
      `SELECT source_kind, source_id, eval_count, last_observed_at
       FROM store_manager_source_cursors
       WHERE workspace_id = ? AND eval_count >= ?
       ORDER BY eval_count DESC LIMIT ?`,
    )
    .all(workspaceId, minOccurrences, limit) as Array<{
    source_kind: string;
    source_id: string;
    eval_count: number;
    last_observed_at: string;
  }>;
  return rows.map((r) => ({
    dedupeKey: `${r.source_kind}:${r.source_id}`,
    kind: r.source_kind,
    occurrences: Number(r.eval_count) || 0,
    firstSeenAt: r.last_observed_at,
    lastSeenAt: r.last_observed_at,
    lifecycle: 'recurred',
  }));
}
