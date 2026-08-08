/**
 * Product Attribute Proposals Stage
 *
 * Thin wrapper around the shared curation target engine. Processes
 * only enabled product-field curation targets through the shared
 * resolver → matcher → ranker → proposal builder pipeline.
 *
 * Gating (identical to the applicability stage):
 * - A pending (unreviewed) Primary Product Type guess produces NO
 *   decision-eligible type-gated attribute proposals.
 * - Universal attributes proceed without a Product Type.
 * - Profile attributes require a reviewed (accepted) Product Type and
 *   membership in that type's profile.
 * - When no product_type target is enabled, attributes are un-gated.
 *
 * Per-Product-Type cardinality comes from the accepted type's profile
 * (not a global target selectionMode) and is passed to the shared
 * processor so multi-value proposals use validated field-specific shapes.
 *
 * Dependencies: attribute_applicability stage.
 */
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processProductFieldTarget } from '../curation-target-processor';
import { getReviewedPrimaryProductTypeId } from '../proposal-selection';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';
import { evaluateAttributeApplicability } from './attribute-applicability';

export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    // If no enabled product-field targets exist, return succeeded (not abstained)
    if (resolved.productFields.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'No product-field curation targets are enabled.',
        },
      };
    }

    const typeTargetEnabled = resolved.productTypes.length > 0;
    const acceptedTypeId = getReviewedPrimaryProductTypeId(input, context.snapshot);

    const profiles = context.snapshot
      ? context.snapshot.attributeProfiles
      : getCachedAttributeProfiles(context.workspaceId);
    const profile = acceptedTypeId
      ? profiles.find(p => p.productTypeId === acceptedTypeId)
      : null;
    const profileAttributeIds = profile
      ? new Set(profile.attributes.map(entry => entry.attributeId))
      : null;

    // Only targets whose applicability is 'applicable' may produce
    // decision-eligible proposals. Unknown (pending type) and not_applicable
    // targets are withheld.
    const gated: Array<{ target: (typeof resolved.productFields)[number]; cardinality: 'single' | 'multiple' }> = [];

    for (const target of resolved.productFields) {
      if (!target.attribute) continue;
      const attribute = target.attribute;
      const profileEntry = profile?.attributes.find(entry => entry.attributeId === attribute.id);
      const evaluation = evaluateAttributeApplicability({
        attribute,
        profileAttributeIds,
        conditions: profileEntry?.applicabilityConditions ?? [],
        acceptedTypeId,
        typeTargetEnabled,
        reviewedFacts: context.snapshot?.reviewedFacts ?? [],
      });
      if (evaluation.state !== 'applicable') continue;

      // Per-Product-Type cardinality wins over the global target mode when a
      // profile entry exists; otherwise the target's own selection mode.
      const cardinality = profileEntry?.cardinality ?? target.config.selectionMode ?? 'single';
      gated.push({ target, cardinality });
    }

    if (gated.length === 0) {
      const blockedReason = acceptedTypeId === null && typeTargetEnabled
        ? 'No reviewed Primary Product Type; type-gated attribute proposals are withheld until the type is accepted.'
        : 'No applicable product-field targets for the accepted Product Type.';
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: blockedReason,
          metadata: { gated: true, acceptedTypeId, typeTargetEnabled },
        },
      };
    }

    // Process each applicable target through the shared engine
    const allProposals: ClassificationProposal[] = [];
    const messages: string[] = [];

    for (const { target, cardinality } of gated) {
      const result = await processProductFieldTarget(target, input, context, { cardinality });
      allProposals.push(...result.proposals);
      if (result.message) messages.push(result.message);
    }

    if (allProposals.length === 0) {
      return {
        status: 'abstained',
        reason: messages.length > 0
          ? `No attribute value matches found: ${messages.join('; ')}`
          : 'No attribute value matches found from available evidence.',
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: allProposals,
        abstained: false,
      },
    };
  },
};
