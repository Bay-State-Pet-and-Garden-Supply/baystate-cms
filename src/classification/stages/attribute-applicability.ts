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
 * - `not_applicable` — the attribute is not part of the effective type's profile.
 * - `unknown` — the attribute is type-gated but neither a reviewed (accepted)
 *   Primary Product Type nor a cohort Execution Product Type exists yet.
 *   Pending guesses never unlock gating.
 *
 * Rules (PR5 effective type):
 * - Universal attributes are applicable without any Product Type.
 * - Profile attributes are gated by the EFFECTIVE Curation Product Type
 *   (`getEffectiveCurationProductType`): the reviewed (accepted) Primary
 *   Product Type first, the frozen cohort Execution Product Type as fallback
 *   (reviewed override precedence; the execution type never beats a reviewed
 *   fact). The profile is resolved from the frozen runtime snapshot only —
 *   never from the live config cache when an execution type is present.
 * - Conditions are evaluated only against accepted/reviewed facts; a
 *   condition whose fact is missing or whose shape is unrecognized evaluates
 *   to `unknown` (fail closed).
 * - Flag OFF / legacy runs never carry a `cohortExecutionType`, so this stage
 *   gates exactly as today (reviewed type or none).
 *
 * Dependencies: primary_product_type_proposal stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { getEffectiveCurationProductType } from '../effective-curation-type';
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
    // PR5 fail-closed guard (architecture pillar 2): the effective-type path
    // resolves profiles/targets EXCLUSIVELY from the frozen runtime snapshot.
    // An execution type with a missing snapshot would silently fall back to
    // the live config cache — never allowed.
    if (context.cohortExecutionType !== undefined && context.snapshot === undefined) {
      throw new Error(
        'effective-type path requires the frozen runtime snapshot; live config is never read with an execution type',
      );
    }

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

    const { effectiveTypeId, source } = getEffectiveCurationProductType(input, context);

    const profiles = context.snapshot
      ? context.snapshot.attributeProfiles
      : getCachedAttributeProfiles(context.workspaceId);
    const profile = effectiveTypeId
      ? profiles.find(p => p.productTypeId === effectiveTypeId)
      : null;

    const evaluations = evaluateTargetApplicability(
      resolved.productFields,
      {
        typeTargetEnabled,
        acceptedTypeId: effectiveTypeId,
        profile: profile ?? null,
        reviewedFacts: context.snapshot?.reviewedFacts ?? [],
      },
    );

    const applicableCount = evaluations.filter(evaluation => evaluation.state === 'applicable').length;
    const unknownCount = evaluations.filter(evaluation => evaluation.state === 'unknown').length;
    const notApplicableCount = evaluations.filter(evaluation => evaluation.state === 'not_applicable').length;

    // Byte-identical legacy message for `none`/reviewed sources; a source-aware
    // suffix is appended ONLY when the effective type came from the cohort
    // execution type (additive, flag-OFF runs never see it).
    const sourceSuffix =
      source === 'execution' ? ' (driven by cohort execution Product Type.)' : '';

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [],
        abstained: false,
        message:
          `${applicableCount} attributes applicable, ${unknownCount} blocked (no reviewed Product Type or undecided condition), ` +
          `${notApplicableCount} not applicable for ${effectiveTypeId ?? '(no reviewed type)'}.` +
          sourceSuffix,
        metadata: {
          applicability: evaluations,
          acceptedTypeId: effectiveTypeId,
          typeTargetEnabled,
          effectiveTypeId,
          effectiveTypeSource: source,
        },
      },
    };
  },
};
