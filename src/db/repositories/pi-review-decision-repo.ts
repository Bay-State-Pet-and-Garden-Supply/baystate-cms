/**
 * PI review decisions (P1-2 review remediation).
 *
 * Append-only durable human review records for Agent Lab runs. Every
 * approve/reject is a new row bound to the exact stored result via
 * result_hash, chained to the previously latest decision through
 * supersedes_decision_id. Only the LATEST decision for a run is
 * authoritative; earlier rows are audit lineage.
 *
 * Replay never clones decisions: a replay is a NEW run that starts
 * unreviewed (the origin's decisions remain lineage for the origin only).
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

const now = () => new Date().toISOString();

export type PiReviewDecisionValue = 'approve' | 'reject';

export interface PiReviewDecisionRow {
  id: string;
  runId: string;
  decision: PiReviewDecisionValue;
  resultHash: string;
  supersedesDecisionId: string | null;
  reviewer: string;
  note: string | null;
  createdAt: string;
}

const ROW_SELECT = `
  SELECT id, run_id AS runId, decision, result_hash AS resultHash,
         supersedes_decision_id AS supersedesDecisionId, reviewer, note, created_at AS createdAt
  FROM pi_review_decisions
`;

function mapRow(row: Record<string, unknown>): PiReviewDecisionRow {
  return {
    id: String(row.id),
    runId: String(row.runId),
    decision: row.decision as PiReviewDecisionValue,
    resultHash: String(row.resultHash),
    supersedesDecisionId: row.supersedesDecisionId ? String(row.supersedesDecisionId) : null,
    reviewer: String(row.reviewer),
    note: row.note ? String(row.note) : null,
    createdAt: String(row.createdAt),
  };
}

export function getLatestReviewDecision(runId: string): PiReviewDecisionRow | undefined {
  const db = getDb();
  const row = db
    .query(`${ROW_SELECT} WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * Append a review decision. When supersedesDecisionId is omitted, the
 * current latest decision for the run becomes the superseded one (the new
 * row's supersedes_decision_id points at it).
 */
export function createReviewDecision(input: {
  runId: string;
  decision: PiReviewDecisionValue;
  resultHash: string;
  reviewer: string;
  note?: string | null;
  supersedesDecisionId?: string | null;
}): PiReviewDecisionRow {
  const db = getDb();
  // Round-3 atomicity: read-latest + insert inside ONE transaction so two
  // concurrent reviews can never fork the append-only chain (each insert
  // sees the linear predecessor and the chain stays a single lineage).
  const insert = db.transaction((): PiReviewDecisionRow => {
    const latest = input.supersedesDecisionId === undefined ? getLatestReviewDecision(input.runId) : undefined;
    const supersedes = input.supersedesDecisionId !== undefined ? input.supersedesDecisionId : (latest?.id ?? null);
    const id = randomUUID();
    db.run(
      `INSERT INTO pi_review_decisions (id, run_id, decision, result_hash, supersedes_decision_id, reviewer, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.runId, input.decision, input.resultHash, supersedes, input.reviewer, input.note ?? null, now()],
    );
    return mapRow(db.query(`${ROW_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>);
  });
  return insert();
}

/** True iff the LATEST decision for the run approves exactly this result hash. */
export function hasApprovalForResult(runId: string, resultHash: string): boolean {
  const latest = getLatestReviewDecision(runId);
  return latest !== undefined && latest.decision === 'approve' && latest.resultHash === resultHash;
}

export function listReviewDecisions(runId: string): PiReviewDecisionRow[] {
  const db = getDb();
  return (db.query(`${ROW_SELECT} WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId) as Record<string, unknown>[]).map(mapRow);
}
