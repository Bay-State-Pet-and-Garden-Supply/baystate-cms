import { getDb } from '../db/connection';

export type ReviewCompletionGateResult =
  | { ok: true; proposalCount: number }
  | { ok: false; code: string; reason: string };

export interface ReviewCompletionGateInput {
  workspaceId: string;
  onboardingItemId: string;
  productSku: string;
  activeRunId: string;
}

/**
 * Read-only, fail-closed validation for completing Review on a classified item.
 * Only decisions belonging to proposals in the item's exact active run count.
 */
export function validateReviewCompletionGate(
  input: ReviewCompletionGateInput,
): ReviewCompletionGateResult {
  const db = getDb();
  const run = db.query(
    `SELECT status, workspace_id, onboarding_item_id, product_sku
     FROM classification_runs
     WHERE id = ?`,
  ).get(input.activeRunId) as {
    status: string;
    workspace_id: string;
    onboarding_item_id: string | null;
    product_sku: string;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Classification run ${input.activeRunId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Classification run belongs to a different workspace.' };
  }
  if (run.onboarding_item_id !== input.onboardingItemId) {
    return { ok: false, code: 'item_mismatch', reason: 'Classification run is not linked to this exact onboarding item.' };
  }
  if (run.product_sku !== input.productSku) {
    return {
      ok: false,
      code: 'sku_mismatch',
      reason: `Classification run SKU "${run.product_sku}" does not match item UPC "${input.productSku}".`,
    };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return {
      ok: false,
      code: 'run_not_completed',
      reason: `Classification run has status "${run.status}". Only completed runs can be reviewed.`,
    };
  }

  const proposals = db.query(
    `SELECT p.id, p.status,
            EXISTS(
              SELECT 1 FROM classification_proposal_decisions d
              WHERE d.proposal_id = p.id
            ) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ?`,
  ).all(input.activeRunId) as Array<{
    id: string;
    status: string;
    has_decision: number;
  }>;

  if (proposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals in the classification run.' };
  }

  const decidedStatuses = new Set(['accepted', 'rejected', 'deferred']);
  const unresolved = proposals.filter(proposal =>
    !decidedStatuses.has(proposal.status) || Number(proposal.has_decision) !== 1,
  );
  if (unresolved.length > 0) {
    return {
      ok: false,
      code: 'unresolved_proposals',
      reason: `${unresolved.length} proposal(s) are pending, stale, or missing a recorded decision: ${unresolved.map(p => p.id).join(', ')}.`,
    };
  }

  return { ok: true, proposalCount: proposals.length };
}
