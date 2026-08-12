/**
 * Promotion Gate (issue #30 PR11, DECISION-A).
 *
 * Deterministic, read-only validation that runs PER-ITEM inside `promoteItems`
 * BEFORE any proposal/draft work. A member that is semantically blocked, a
 * child of a superseded (or in-flight) parent, or carrying an accepted
 * proposal whose type dependency no longer matches the item's CURRENT
 * effective type never reaches a CMS draft — while every sibling promotes
 * normally.
 *
 * The gate is PURE over its inputs: the caller loads all DB state (the
 * validated active run, the parent cohort run, the accepted proposals, the
 * current effective type id, and the dependency rows) and passes them in; this
 * module never queries.
 *
 * The gate consumes the PR9-review dependency semantics (PR9 C4,
 * DECISION-B): universal-attribute proposals carry NO product-type dependency
 * row, so a PRESENT `execution_product_type` / `reviewed_product_type` row is
 * a truthful type-dependence claim — a proposal whose dependency target no
 * longer equals the item's current effective type is STALE. Decision-level
 * staleness (a superseded `classification_proposal_decisions` row) is ALREADY
 * filtered by `getAcceptedProposals` (`d.superseded_at IS NULL`) and is NOT
 * duplicated here.
 *
 * Legacy items (no curation data / no classification run pointer) pass
 * UNCHANGED — the narrow legacy promotion path stays byte-identical.
 */
import { CohortSemanticValidationSchema } from '../shared/schemas/onboarding';
import type { CurationData } from '../shared/schemas/onboarding';
import type { ClassificationProposal } from '../shared/types';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
import type { CohortRun } from '../shared/schemas/cohorts';
import { getEffectivePrimaryProductTypeId } from './assignment-projection';
import { resolveEffectiveCurationType } from './effective-curation-type';

export type PromotionGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'semantic_validation_blocked'
        | 'semantic_validation_unavailable'
        | 'parent_not_found'
        | 'parent_superseded'
        | 'parent_not_completed'
        | 'stale_proposal';
      reason: string;
    };

/** One dependency row as consumed by the gate (kind + target only). */
export interface PromotionGateDependencyRow {
  dependencyKind: string;
  dependencyTargetId: string | null;
}

export interface PromotionGateInput {
  workspaceId: string;
  itemId: string;
  productSku: string;
  /** The item's committed curation data (null for legacy items). */
  curationData: CurationData | null;
  /** The validated active classification run (null when the item has no run pointer). */
  activeRun: ClassificationRunRow | null;
  /** The parent cohort run when the active run is a cohort child; null otherwise. */
  parentRun: CohortRun | null;
  /** The item's current effective Product Type id (null = no type exists). */
  effectiveTypeId: string | null;
  /** Accepted proposals of the item's active run (decision-level staleness already filtered). */
  acceptedProposals: ClassificationProposal[];
  /** Dependency lookup; the caller loads `classification_proposal_dependencies` rows. */
  dependencyLookup: (proposalId: string) => PromotionGateDependencyRow[];
}

/** A cohort parent is terminal (promotion-eligible) only in these states. */
const PARENT_TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
]);

const SEMANTIC_BLOCKED_DEFAULT = 'A hard cohort semantic validation finding blocks this item.';

function firstFindingMessage(semanticValidation: Record<string, unknown>): string {
  const findings = semanticValidation.findings;
  if (Array.isArray(findings) && findings.length > 0) {
    const first = findings[0] as { message?: unknown } | null | undefined;
    if (first && typeof first.message === 'string' && first.message.length > 0) {
      return first.message;
    }
  }
  return SEMANTIC_BLOCKED_DEFAULT;
}

/**
 * The item's CURRENT effective Product Type id for the staleness check
 * (architecture-report §2.1):
 *
 * - cohort child (`parentRun` present): the frozen parent Execution Product
 *   Type — the parent authority is the current truth (the member's own type
 *   suggestion was validated against it at freeze time);
 * - otherwise: the live accepted `primary_product_type` proposal target
 *   (reviewed truth, reviewed-first precedence via the shared resolver).
 *
 * `null` means no effective type exists — a proposal carrying a present
 * type-dependency is then itself stale (the dependency claims a type that
 * does not exist).
 */
export function resolvePromotionEffectiveTypeId(
  parentRun: CohortRun | null,
  acceptedProposals: ClassificationProposal[],
): string | null {
  if (parentRun) {
    return parentRun.executionProductTypeId ?? null;
  }
  let reviewedTypeId: string | null = null;
  for (const proposal of acceptedProposals) {
    if (proposal.proposalType !== 'primary_product_type') continue;
    const targetId = getEffectivePrimaryProductTypeId(proposal);
    if (targetId) {
      reviewedTypeId = targetId;
      break;
    }
  }
  return resolveEffectiveCurationType(reviewedTypeId, null).effectiveTypeId;
}

/**
 * Fail-closed promotion validation. Deterministic over its inputs; the caller
 * loads the DB state. Returns the FIRST refusal (semantic → parent-currentness
 * → stale-proposal), or `{ ok: true }` when every check passes.
 */
export function validatePromotionGate(input: PromotionGateInput): PromotionGateResult {
  const {
    workspaceId,
    itemId,
    productSku,
    curationData,
    activeRun,
    parentRun,
    effectiveTypeId,
    acceptedProposals,
    dependencyLookup,
  } = input;

  // 1. Legacy: no curation data or no classification run pointer — the narrow
  //    legacy promotion path is byte-identical (no gate).
  if (!curationData || !curationData.classificationRunId) {
    return { ok: true };
  }
  // A present run pointer that failed the caller's ownership validation never
  // reaches the gate (the caller refuses it); defensive fail-closed anyway.
  if (!activeRun) {
    return {
      ok: false,
      code: 'semantic_validation_unavailable',
      reason:
        `Classification run pointer ${curationData.classificationRunId} did not resolve to a validated onboarding run ` +
        `for item ${itemId} (workspace ${workspaceId}); promotion blocked.`,
    };
  }

  // 2. Semantic validation. A `blocked` status refuses with the first finding.
  //    An ACTIVE cohort child additionally fails closed when the committed
  //    payload is missing or malformed (never a silent pass-through).
  const semanticValidation = curationData.semanticValidation;
  if (
    semanticValidation &&
    typeof semanticValidation === 'object' &&
    (semanticValidation as { status?: unknown }).status === 'blocked'
  ) {
    return {
      ok: false,
      code: 'semantic_validation_blocked',
      reason: firstFindingMessage(semanticValidation as Record<string, unknown>),
    };
  }
  if (activeRun.cohortRunId) {
    if (semanticValidation === undefined || semanticValidation === null) {
      return {
        ok: false,
        code: 'semantic_validation_unavailable',
        reason:
          `Committed cohort semantic validation payload is missing for item ${itemId} (SKU ${productSku}); ` +
          'the item cannot promote.',
      };
    }
    const parsed = CohortSemanticValidationSchema.safeParse(semanticValidation);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'semantic_validation_unavailable',
        reason:
          `Committed cohort semantic validation payload is malformed for item ${itemId} (SKU ${productSku}); ` +
          'the item cannot promote.',
      };
    }
  }

  // 3. Parent-currentness for cohort children (defense-in-depth: the re-run
  //    lifecycle already resets members, but a partially-advanced member or an
  //    out-of-band state must never promote).
  if (activeRun.cohortRunId) {
    if (!parentRun) {
      return {
        ok: false,
        code: 'parent_not_found',
        reason: `Cohort parent run ${activeRun.cohortRunId} not found for item ${itemId} (workspace ${workspaceId}).`,
      };
    }
    if (parentRun.status === 'superseded') {
      return {
        ok: false,
        code: 'parent_superseded',
        reason:
          `Cohort parent run ${parentRun.id} was superseded; this item's proposal decisions are historical ` +
          'and cannot promote.',
      };
    }
    if (!PARENT_TERMINAL_STATUSES.has(parentRun.status)) {
      return {
        ok: false,
        code: 'parent_not_completed',
        reason:
          `Cohort parent run ${parentRun.id} has status "${parentRun.status}"; a child cannot promote ` +
          'while its parent is in flight.',
      };
    }
  }

  // 4. Stale proposals: an accepted proposal whose type-dependency target no
  //    longer matches the item's current effective type is STALE (PR9 C4
  //    semantics — universal attributes carry no dependency row and are never
  //    stale by this rule). A present dependency against a MISSING effective
  //    type is itself stale (the dependency claims a type that does not exist).
  for (const proposal of acceptedProposals) {
    for (const dep of dependencyLookup(proposal.id)) {
      if (
        dep.dependencyKind !== 'execution_product_type' &&
        dep.dependencyKind !== 'reviewed_product_type'
      ) {
        continue;
      }
      if (dep.dependencyTargetId !== effectiveTypeId) {
        return {
          ok: false,
          code: 'stale_proposal',
          reason:
            `Accepted proposal ${proposal.id} (SKU ${productSku}) carries a ${dep.dependencyKind} dependency targeting ` +
            `${dep.dependencyTargetId ?? '<none>'}, but the item's current effective type is ` +
            `${effectiveTypeId ?? '<none>'}; the proposal is stale and cannot promote.`,
        };
      }
    }
  }

  return { ok: true };
}
