import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { recordHistoryEvent } from '../db/repositories/classification-run-repo';
import type { ClassificationProposalDecision } from '../shared/types';

const now = () => new Date().toISOString();

export interface ProposalReviewInput {
  workspaceId: string;
  productSku: string;
  runId: string;
  sourceKind: 'onboarding' | 'catalog_product';
  decisions: Array<{
    proposalId: string;
    decision: 'accepted' | 'rejected' | 'deferred';
    reviewerNote?: string | null;
    revisedValue?: unknown;
  }>;
  /** Required for onboarding; null for catalog */
  onboardingItemId?: string;
}

export type ProposalReviewResult =
  | { ok: true; decisions: ClassificationProposalDecision[] }
  | { ok: false; code: string; reason: string };

/**
 * Validate and persist proposal decisions transactionally.
 * Enforces:
 * - Run must exist and belong to the correct workspace/SKU/source
 * - Run must be completed (not running/failed)
 * - Every proposalId must belong to this exact run
 * - For onboarding: run must be linked to the correct onboarding item
 */
export function submitProposalDecisions(input: ProposalReviewInput): ProposalReviewResult {
  const db = getDb();
  const run = db.query(
    `SELECT id, status, workspace_id, product_sku, source_kind, onboarding_item_id
     FROM classification_runs WHERE id = ?`,
  ).get(input.runId) as {
    id: string; status: string; workspace_id: string; product_sku: string;
    source_kind: string; onboarding_item_id: string | null;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Run ${input.runId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Run belongs to a different workspace.' };
  }
  if (run.product_sku !== input.productSku) {
    return { ok: false, code: 'sku_mismatch', reason: `Run SKU "${run.product_sku}" does not match "${input.productSku}".` };
  }
  if (run.source_kind !== input.sourceKind) {
    return { ok: false, code: 'source_mismatch', reason: `Run source "${run.source_kind}" does not match "${input.sourceKind}".` };
  }
  if (input.sourceKind === 'onboarding' && run.onboarding_item_id !== input.onboardingItemId) {
    return { ok: false, code: 'item_mismatch', reason: 'Run is not linked to this onboarding item.' };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return { ok: false, code: 'run_not_completed', reason: `Run status is "${run.status}". Only completed runs accept decisions.` };
  }

  // Validate all proposal IDs belong to this run
  const proposalIds = input.decisions.map(d => d.proposalId);
  const placeholders = proposalIds.map(() => '?').join(',');
  const existingCount = db.query(
    `SELECT COUNT(*) as cnt FROM classification_proposals WHERE id IN (${placeholders}) AND run_id = ?`
  ).get(...proposalIds, input.runId) as { cnt: number };

  if (existingCount.cnt !== proposalIds.length) {
    return { ok: false, code: 'invalid_proposals', reason: 'One or more proposal IDs do not belong to this run.' };
  }

  const decisions: ClassificationProposalDecision[] = [];

  db.transaction(() => {
    for (const d of input.decisions) {
      const newStatus = d.decision === 'accepted' ? 'accepted' : d.decision === 'rejected' ? 'rejected' : 'deferred';

      // If revisedValue provided, update proposed_value_json
      if (d.revisedValue !== undefined) {
        db.run(
          'UPDATE classification_proposals SET proposed_value_json = ? WHERE id = ?',
          [JSON.stringify(d.revisedValue), d.proposalId],
        );
        // Update target_id if it's a page proposal with a pageName
        const proposal = db.query('SELECT proposal_type FROM classification_proposals WHERE id = ?').get(d.proposalId) as { proposal_type: string } | undefined;
        if (proposal?.proposal_type === 'category_page') {
          const rv = d.revisedValue as Record<string, unknown> | undefined;
          if (rv?.pageName) {
            db.run('UPDATE classification_proposals SET target_id = ? WHERE id = ?', [String(rv.pageName), d.proposalId]);
          }
        }
      }

      db.run(
        'UPDATE classification_proposals SET status = ? WHERE id = ?',
        [newStatus, d.proposalId],
      );

      const decision: ClassificationProposalDecision = {
        id: randomUUID(),
        proposalId: d.proposalId,
        decision: d.decision,
        revisedFromId: null,
        reviewerId: null,
        reviewerNote: d.reviewerNote ?? null,
        createdAt: now(),
      };

      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_from_id, reviewer_id, reviewer_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [decision.id, decision.proposalId, decision.decision, decision.revisedFromId, decision.reviewerId, decision.reviewerNote, decision.createdAt],
      );

      decisions.push(decision);
    }
  })();

  // Record history
  try {
    recordHistoryEvent(input.workspaceId, input.productSku, 'decisions_submitted', {
      runId: input.runId,
      sourceKind: input.sourceKind,
      decisionCount: decisions.length,
    });
  } catch {
    // non-blocking
  }

  return { ok: true, decisions };
}
