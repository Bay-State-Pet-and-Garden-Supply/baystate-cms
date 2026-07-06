/**
 * Attribute Applicability Stage
 *
 * Determines which Product Attributes from the attribute profile apply
 * to the current product, given the enabled curation target configuration.
 *
 * Product Type is NEVER inferred as internal context. If Product Type is
 * not an enabled curation target, profile filtering is skipped and all
 * selected product-field targets proceed without gating.
 *
 * If Product Type IS an enabled target, uses provisional selection
 * (accepted proposals first, then best pending proposal) so attribute
 * applicability works on first-pass curation before human review.
 *
 * Dependencies: primary_product_type_proposal stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets } from '../curation-target-resolver';
import { selectPrimaryProductTypeProposal } from '../proposal-selection';

export const attributeApplicabilityStage: StageDefinition = {
  name: 'attribute_applicability',
  requires: ['primary_product_type_proposal'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const config = loadClassificationConfig(context.workspacePath);
    const resolved = resolveEnabledTargets(config, context.workspaceId);

    // If Product Type is not an enabled curation target, skip profile gating.
    // All selected product-field targets proceed without a profile filter.
    if (resolved.productTypes.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'No Product Type target enabled; profile filtering not applied.',
        },
      };
    }

    // Product Type IS enabled — find the selected proposal (accepted or provisional)
    const typeSelection = selectPrimaryProductTypeProposal(input);
    const selectedType = typeSelection.proposal;

    if (!selectedType || !selectedType.targetId) {
      return {
        status: 'abstained',
        reason: 'No selected Primary Product Type proposal available. Ensure a primary_product_type_proposal stage runs before this one and produces a proposal.',
      };
    }

    // Find the attribute profile for this product type
    const profiles = getCachedAttributeProfiles(context.workspaceId);
    const profile = profiles.find(p => p.productTypeId === selectedType.targetId);

    if (!profile || profile.attributes.length === 0) {
      return {
        status: 'abstained',
        reason: `No attribute profile found for product type "${selectedType.targetId}". Configure an attribute profile in store/classification/attribute-profiles.json.`,
      };
    }

    // All attributes in the profile are applicable (no conditions implemented yet)
    const applicable = profile.attributes.map(a => ({
      attributeId: a.attributeId,
      required: a.required,
      cardinality: a.cardinality,
    }));

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [],
        abstained: false,
        message: `${applicable.length} attributes applicable for product type "${selectedType.targetId}" (${typeSelection.source}).`,
      },
    };
  },
};
