import { getDb } from '../db/connection';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { isUniversalAttribute } from './applicability-evaluator';

export type ReviewCompletionGateResult =
  | { ok: true; proposalCount: number }
  | { ok: false; code: string; reason: string };

/**
 * Fail-closed type-gating check shared by both gates.
 *
 * When a run is bound to a resolvable M4+ runtime snapshot that enables a
 * product_type curation target, review may only complete if a reviewed
 * (accepted) Primary Product Type exists — either as an accepted type decision
 * in the same run or as a compatible reviewed fact carried in the snapshot.
 * Type-gated field assignments (any non-universal attribute) must never pass
 * review without a reviewed type.
 *
 * Legacy runs (unresolvable or absent config snapshot) skip the check.
 */
function assertReviewedProductTypeForRun(options: {
  runId: string;
  workspaceId: string;
  configSnapshotHash: string | null;
  reviewableProposals: Array<{ id: string; proposalType: string; targetId: string | null }>;
}): ReviewCompletionGateResult | null {
  const { runId, workspaceId, configSnapshotHash } = options;

  // Snapshot is the only place that proves the config's type-gating intent.
  const snapshot = configSnapshotHash
    ? getRuntimeSnapshotByHash(workspaceId, configSnapshotHash)
    : null;
  if (!snapshot) return null;

  const typeTargetEnabled = snapshot.curationTargets.some(
    target => target.kind === 'product_type' && (target.enabled || target.mandatory),
  );
  if (!typeTargetEnabled) return null;

  // In-run accepted type decision.
  const acceptedTypeDecision = getDb().query(
    `SELECT 1 FROM classification_proposals p
     JOIN classification_proposal_decisions d ON d.proposal_id = p.id AND d.superseded_at IS NULL
     WHERE p.run_id = ? AND p.proposal_type = 'primary_product_type' AND d.decision = 'accepted'
     LIMIT 1`,
  ).get(runId);
  const reviewedTypeFact = snapshot.reviewedFacts.some(
    fact => fact.proposalType === 'primary_product_type',
  );
  if (acceptedTypeDecision || reviewedTypeFact) return null;

  // Any non-universal field assignment in this run is type-gated. Unknown
  // attributes fail closed.
  const gatedFieldProposal = options.reviewableProposals.some(proposal => {
    if (proposal.proposalType !== 'field_assignment') return false;
    const attribute = snapshot.attributes.find(candidate => candidate.id === proposal.targetId);
    if (!attribute) return true;
    return !isUniversalAttribute(attribute);
  });
  if (!gatedFieldProposal) return null;

  return {
    ok: false,
    code: 'type_gated_without_reviewed_type',
    reason: 'Type-gated attribute proposals cannot complete review without a reviewed (accepted) Primary Product Type.',
  };
}

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
    `SELECT status, workspace_id, onboarding_item_id, product_sku, config_snapshot_hash
     FROM classification_runs
     WHERE id = ?`,
  ).get(input.activeRunId) as {
    status: string;
    workspace_id: string;
    onboarding_item_id: string | null;
    product_sku: string;
    config_snapshot_hash: string | null;
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

  // PR9 C3 (issue #30, DECISION-C): cohort SEMANTIC validation gate. A
  // member whose committed curation data carries
  // `semanticValidation.status === 'blocked'` is NOT review-ready
  // (blocked-not-destroyed — the curationData + proposals stay intact for the
  // Review UX, PR10). Corrupt curation data JSON fails closed (never
  // review-ready). Absent key ('passed' or legacy items) proceeds unchanged.
  {
    const curationRow = db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(input.onboardingItemId) as { curation_data_json: string | null } | undefined;
    if (curationRow?.curation_data_json) {
      let parsedCuration: unknown;
      try {
        parsedCuration = JSON.parse(String(curationRow.curation_data_json));
      } catch {
        return {
          ok: false,
          code: 'semantic_validation_blocked',
          reason: 'Curation data is corrupt; the item cannot be review-ready.',
        };
      }
      const semanticValidation =
        parsedCuration && typeof parsedCuration === 'object'
          ? (parsedCuration as Record<string, unknown>).semanticValidation
          : undefined;
      if (
        semanticValidation &&
        typeof semanticValidation === 'object' &&
        (semanticValidation as { status?: unknown }).status === 'blocked'
      ) {
        const findings = (semanticValidation as { findings?: Array<{ message?: unknown }> }).findings;
        const firstMessage =
          Array.isArray(findings) && findings.length > 0 && typeof findings[0]?.message === 'string'
            ? findings[0].message
            : 'A hard cohort semantic validation finding blocks this item.';
        return {
          ok: false,
          code: 'semantic_validation_blocked',
          reason: firstMessage,
        };
      }
    }
  }

  const proposals = db.query(
    `SELECT p.id, p.status, p.proposal_type, p.target_id,
            EXISTS(
              SELECT 1 FROM classification_proposal_decisions d
              WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
            ) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ?`,
  ).all(input.activeRunId) as Array<{
    id: string;
    status: string;
    proposal_type: string;
    target_id: string | null;
    has_decision: number;
  }>;

  if (proposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals in the classification run.' };
  }

  const pendingOrStale = proposals.filter(p => p.status === 'pending' || p.status === 'stale');
  if (pendingOrStale.length > 0) {
    return {
      ok: false,
      code: 'pending_proposals',
      reason: `Classification run has ${pendingOrStale.length} pending or stale proposal(s) that require review.`,
    };
  }

  const missingDecisions = proposals.filter(p => p.status !== 'reviewable_abstention' && !p.has_decision);
  if (missingDecisions.length > 0) {
    return {
      ok: false,
      code: 'missing_decisions',
      reason: `Classification run has ${missingDecisions.length} proposal(s) without a durable decision row.`,
    };
  }

  const typeGate = assertReviewedProductTypeForRun({
    runId: input.activeRunId,
    workspaceId: input.workspaceId,
    configSnapshotHash: run.config_snapshot_hash,
    reviewableProposals: proposals.map(p => ({
      id: p.id,
      proposalType: p.proposal_type,
      targetId: p.target_id,
    })),
  });
  if (typeGate) return typeGate;

  return { ok: true, proposalCount: proposals.length };
}

// ─── Catalog Product Review Completion Gate ──────────────────────────────────

export interface CatalogReviewCompletionGateInput {
  workspaceId: string;
  productSku: string;
  runId: string;
}

/**
 * Read-only validation for completing review on a catalog product run.
 * Checks workspace/SKU ownership and run completion status.
 */
export function validateCatalogReviewCompletionGate(
  input: CatalogReviewCompletionGateInput,
): ReviewCompletionGateResult {
  const db = getDb();
  const run = db.query(
    `SELECT status, workspace_id, product_sku, source_kind, config_snapshot_hash
     FROM classification_runs WHERE id = ?`,
  ).get(input.runId) as {
    status: string; workspace_id: string; product_sku: string; source_kind: string; config_snapshot_hash: string | null;
  } | undefined;

  if (!run) {
    return { ok: false, code: 'run_not_found', reason: `Run ${input.runId} not found.` };
  }
  if (run.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Run belongs to a different workspace.' };
  }
  if (run.source_kind !== 'catalog_product') {
    return { ok: false, code: 'source_mismatch', reason: 'Run is not a catalog product run.' };
  }
  if (run.product_sku !== input.productSku) {
    return { ok: false, code: 'sku_mismatch', reason: `Run SKU "${run.product_sku}" does not match "${input.productSku}".` };
  }
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    return { ok: false, code: 'run_not_completed', reason: `Run status is "${run.status}".` };
  }

  const reviewableProposals = db.query(
    `SELECT p.id, p.status, p.proposal_type, p.target_id,
            EXISTS(
              SELECT 1 FROM classification_proposal_decisions d
              WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
            ) AS has_decision
     FROM classification_proposals p
     WHERE p.run_id = ? AND p.proposal_type != 'reviewable_abstention'`,
  ).all(input.runId) as Array<{ id: string; status: string; proposal_type: string; target_id: string | null; has_decision: number }>;

  if (reviewableProposals.length === 0) {
    return { ok: false, code: 'no_proposals', reason: 'No reviewable proposals.' };
  }

  const pendingOrStale = reviewableProposals.filter(p => p.status === 'pending' || p.status === 'stale');
  if (pendingOrStale.length > 0) {
    return {
      ok: false,
      code: 'pending_proposals',
      reason: `Catalog classification run has ${pendingOrStale.length} pending or stale proposal(s) that require review.`,
    };
  }

  const missingDecisions = reviewableProposals.filter(p => !p.has_decision);
  if (missingDecisions.length > 0) {
    return {
      ok: false,
      code: 'missing_decisions',
      reason: `Catalog classification run has ${missingDecisions.length} proposal(s) without a durable decision row.`,
    };
  }

  const typeGate = assertReviewedProductTypeForRun({
    runId: input.runId,
    workspaceId: input.workspaceId,
    configSnapshotHash: run.config_snapshot_hash,
    reviewableProposals: reviewableProposals.map(p => ({
      id: p.id,
      proposalType: p.proposal_type,
      targetId: p.target_id,
    })),
  });
  if (typeGate) return typeGate;

  return { ok: true, proposalCount: reviewableProposals.length };
}
