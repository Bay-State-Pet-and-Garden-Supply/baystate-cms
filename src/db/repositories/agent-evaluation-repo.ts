/**
 * Agent Lab: Agent Evaluation Repository.
 *
 * Persists paired evaluation headers (agent_evaluation_snapshots) and
 * granular experiment case rows (agent_evaluation_cases).
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvaluationCase,
  AgentEvaluationSnapshot,
  EvaluationDeltaClass,
} from '../../shared/schemas/agent-training';

const now = () => new Date().toISOString();

// ─── Mappers ────────────────────────────────────────────────────────────────

function mapSnapshotRow(row: Record<string, any>): AgentEvaluationSnapshot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    candidateVersionId: String(row.candidate_version_id),
    baselineVersionId: String(row.baseline_version_id),
    datasetId: String(row.dataset_id),
    datasetHash: String(row.dataset_hash),
    splitGroup: String(row.split_group),
    scorecard: JSON.parse(row.scorecard_json || '{}'),
    promotionGateVerdict: JSON.parse(row.promotion_gate_verdict_json || '{}'),
    status: String(row.status) as AgentEvaluationSnapshot['status'],
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapCaseRow(row: Record<string, any>): AgentEvaluationCase {
  return {
    id: String(row.id),
    evaluationId: String(row.evaluation_id),
    workspaceId: String(row.workspace_id),
    benchmarkExampleId: String(row.benchmark_example_id),
    productSku: String(row.product_sku),
    candidateRunId: String(row.candidate_run_id),
    baselineRunId: String(row.baseline_run_id),
    candidateOutcome: String(row.candidate_outcome),
    baselineOutcome: String(row.baseline_outcome),
    comparison: JSON.parse(row.comparison_json || '{}'),
    deltaClass: String(row.delta_class) as EvaluationDeltaClass,
    criticalRegression: Number(row.critical_regression) === 1,
    status: String(row.status) as AgentEvaluationCase['status'],
    createdAt: String(row.created_at),
  };
}

// ─── Snapshot Operations ────────────────────────────────────────────────────

export function createEvaluationSnapshot(
  workspaceId: string,
  input: {
    candidateVersionId: string;
    baselineVersionId: string;
    datasetId: string;
    datasetHash: string;
    splitGroup: string;
  },
): AgentEvaluationSnapshot {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.query(`
    INSERT INTO agent_evaluation_snapshots (
      id, workspace_id, candidate_version_id, baseline_version_id,
      dataset_id, dataset_hash, split_group, scorecard_json,
      promotion_gate_verdict_json, status, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    workspaceId,
    input.candidateVersionId,
    input.baselineVersionId,
    input.datasetId,
    input.datasetHash,
    input.splitGroup,
    '{}',
    '{}',
    'running',
    createdAt,
    null,
  );

  return {
    id,
    workspaceId,
    candidateVersionId: input.candidateVersionId,
    baselineVersionId: input.baselineVersionId,
    datasetId: input.datasetId,
    datasetHash: input.datasetHash,
    splitGroup: input.splitGroup,
    scorecard: {
      totalCases: 0,
      completedCases: 0,
      fixedCount: 0,
      regressedCount: 0,
      unchangedCount: 0,
      criticalRegressions: 0,
      candidateExactProductHit: 0,
      baselineExactProductHit: 0,
      deltaExactProductHit: 0,
    },
    promotionGateVerdict: {
      allowed: false,
      reasons: ['evaluation in progress'],
      complete: false,
    },
    status: 'running',
    createdAt,
    completedAt: null,
  };
}

export function insertEvaluationCase(
  workspaceId: string,
  input: {
    evaluationId: string;
    benchmarkExampleId: string;
    productSku: string;
    candidateRunId: string;
    baselineRunId: string;
    candidateOutcome: string;
    baselineOutcome: string;
    comparison: Record<string, unknown>;
    deltaClass: EvaluationDeltaClass;
    criticalRegression: boolean;
    status: 'pending' | 'completed' | 'failed';
  },
): AgentEvaluationCase {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.query(`
    INSERT INTO agent_evaluation_cases (
      id, evaluation_id, workspace_id, benchmark_example_id, product_sku,
      candidate_run_id, baseline_run_id, candidate_outcome, baseline_outcome,
      comparison_json, delta_class, critical_regression, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.evaluationId,
    workspaceId,
    input.benchmarkExampleId,
    input.productSku,
    input.candidateRunId,
    input.baselineRunId,
    input.candidateOutcome,
    input.baselineOutcome,
    JSON.stringify(input.comparison),
    input.deltaClass,
    input.criticalRegression ? 1 : 0,
    input.status,
    createdAt,
  );

  return {
    id,
    evaluationId: input.evaluationId,
    workspaceId,
    benchmarkExampleId: input.benchmarkExampleId,
    productSku: input.productSku,
    candidateRunId: input.candidateRunId,
    baselineRunId: input.baselineRunId,
    candidateOutcome: input.candidateOutcome,
    baselineOutcome: input.baselineOutcome,
    comparison: input.comparison,
    deltaClass: input.deltaClass,
    criticalRegression: input.criticalRegression,
    status: input.status,
    createdAt,
  };
}

export function completeEvaluationSnapshot(
  workspaceId: string,
  evaluationId: string,
  scorecard: AgentEvaluationSnapshot['scorecard'],
  promotionGateVerdict: AgentEvaluationSnapshot['promotionGateVerdict'],
  status: 'passed' | 'failed' | 'cancelled',
): AgentEvaluationSnapshot {
  const db = getDb();
  const completedAt = now();

  db.query(`
    UPDATE agent_evaluation_snapshots
    SET scorecard_json = ?, promotion_gate_verdict_json = ?, status = ?, completed_at = ?
    WHERE workspace_id = ? AND id = ?
  `).run(
    JSON.stringify(scorecard),
    JSON.stringify(promotionGateVerdict),
    status,
    completedAt,
    workspaceId,
    evaluationId,
  );

  return getEvaluationSnapshot(workspaceId, evaluationId)!;
}

export function getEvaluationSnapshot(workspaceId: string, evaluationId: string): AgentEvaluationSnapshot | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM agent_evaluation_snapshots WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, evaluationId) as Record<string, any> | undefined;

  if (!row) return null;
  return mapSnapshotRow(row);
}

export function listEvaluationSnapshots(workspaceId: string, limit = 50): AgentEvaluationSnapshot[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM agent_evaluation_snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(workspaceId, limit) as Record<string, any>[];

  return rows.map(mapSnapshotRow);
}

export function getEvaluationCases(workspaceId: string, evaluationId: string): AgentEvaluationCase[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM agent_evaluation_cases WHERE workspace_id = ? AND evaluation_id = ? ORDER BY created_at ASC')
    .all(workspaceId, evaluationId) as Record<string, any>[];

  return rows.map(mapCaseRow);
}

export function getEvaluationWithCases(
  workspaceId: string,
  evaluationId: string,
): { snapshot: AgentEvaluationSnapshot; cases: AgentEvaluationCase[] } | null {
  const snapshot = getEvaluationSnapshot(workspaceId, evaluationId);
  if (!snapshot) return null;
  const cases = getEvaluationCases(workspaceId, evaluationId);
  return { snapshot, cases };
}
