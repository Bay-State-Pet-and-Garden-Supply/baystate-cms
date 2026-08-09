/**
 * Attribute Applicability Stage
 *
 * Determines which Product Attributes from the attribute profile apply to the
 * current product, given the enabled curation target configuration.
 *
 * Applicability is evaluated deterministically and has explicit states
 * (see `applicability-evaluator.ts` for the pure evaluation logic):
 *
 * - `applicable` — the attribute may produce decision-eligible proposals.
 * - `not_applicable` — the attribute is not part of the accepted type's profile.
 * - `unknown` — the attribute is type-gated but no reviewed (accepted)
 *   Primary Product Type exists yet. Pending guesses never unlock gating.
 *
 * Rules:
 * - Universal attributes are applicable without any Product Type.
 * - Profile attributes require a reviewed Product Type.
 * - Conditions are evaluated only against accepted/reviewed facts; a
 *   condition whose fact is missing or whose shape is unrecognized evaluates
 *   to `unknown` (fail closed).
 *
 * Dependencies: primary_product_type_proposal stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { getReviewedPrimaryProductTypeId } from '../proposal-selection';
import { evaluateAttributeApplicability, type ApplicabilityState, type ApplicabilityInput, type AttributeApplicability } from '../applicability-evaluator';

export type { ApplicabilityState, AttributeApplicability };
export { evaluateAttributeApplicability };
export type { ApplicabilityInput };

/**
 * Evaluate applicability for every product-field curation target in scope.
 * Returns evaluations keyed by attribute id plus the metadata payload used by
 * the applicability stage and the attribute proposals stage.
 */
function evaluateTargetApplicability(
  resolvedProductFields: Array<{ attribute?: ProductAttributeConfig }>,
  options: {
    typeTargetEnabled: boolean;
    acceptedTypeId: string | null;
    profile: { attributes: Array<{ attributeId: string; applicabilityConditions?: unknown[] }> } | null;
    reviewedFacts: import('../reviewed-facts').ReviewedFact[];
  },
): AttributeApplicability[] {
  const profileAttributeIds = options.profile
    ? new Set(options.profile.attributes.map(entry => entry.attributeId))
    : null;

  return resolvedProductFields
    .filter(target => target.attribute)
    .map(target => {
      const attribute = target.attribute!;
      const profileEntry = options.profile?.attributes.find(
        entry => entry.attributeId === attribute.id,
      );
      return evaluateAttributeApplicability({
        attribute,
        profileAttributeIds,
        conditions: profileEntry?.applicabilityConditions ?? [],
        acceptedTypeId: options.acceptedTypeId,
        typeTargetEnabled: options.typeTargetEnabled,
        reviewedFacts: options.reviewedFacts,
      });
    });
}

export const attributeApplicabilityStage: StageDefinition = {
  name: 'attribute_applicability',
  requires: ['primary_product_type_proposal'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    const typeTargetEnabled = resolved.productTypes.length > 0;

    if (resolved.productFields.length === 0 && !typeTargetEnabled) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'No curation targets enabled; applicability not evaluated.',
          metadata: { applicability: [] },
        },
      };
    }

    const acceptedTypeId = getReviewedPrimaryProductTypeId(input, context.snapshot);

    const profiles = context.snapshot
      ? context.snapshot.attributeProfiles
      : getCachedAttributeProfiles(context.workspaceId);
    const profile = acceptedTypeId
      ? profiles.find(p => p.productTypeId === acceptedTypeId)
      : null;

    const evaluations = evaluateTargetApplicability(
      resolved.productFields,
      {
        typeTargetEnabled,
        acceptedTypeId,
        profile: profile ?? null,
        reviewedFacts: context.snapshot?.reviewedFacts ?? [],
      },
    );

    const applicableCount = evaluations.filter(evaluation => evaluation.state === 'applicable').length;
    const unknownCount = evaluations.filter(evaluation => evaluation.state === 'unknown').length;
    const notApplicableCount = evaluations.filter(evaluation => evaluation.state === 'not_applicable').length;

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [],
        abstained: false,
        message:
          `${applicableCount} attributes applicable, ${unknownCount} blocked (no reviewed Product Type or undecided condition), ` +
          `${notApplicableCount} not applicable for ${acceptedTypeId ?? '(no reviewed type)'}.`,
        metadata: {
          applicability: evaluations,
          acceptedTypeId,
          typeTargetEnabled,
        },
      },
    };
  },
};
