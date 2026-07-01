import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';

/**
 * Attribute Applicability Stage
 *
 * Determines which Product Attributes from the attribute profile apply
 * to the current product, given the accepted Primary Product Type and
 * any attribute applicability conditions.
 *
 * Dependencies: Primary Product Type must be accepted/reviewed.
 */
export const attributeApplicabilityStage: StageDefinition = {
  name: 'attribute_applicability',
  requires: ['primary_product_type_proposal'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    // Find the accepted Primary Product Type proposal
    const acceptedType = input.acceptedProposals.find(
      p => p.proposalType === 'primary_product_type' && p.status === 'accepted',
    );

    if (!acceptedType || !acceptedType.targetId) {
      return {
        status: 'abstained',
        reason: 'No accepted Primary Product Type. Review and accept a product type before attribute classification can proceed.',
      };
    }

    // Find the attribute profile for this product type
    const profiles = getCachedAttributeProfiles(context.workspaceId);
    const profile = profiles.find(p => p.productTypeId === acceptedType.targetId);

    if (!profile || profile.attributes.length === 0) {
      return {
        status: 'abstained',
        reason: `No attribute profile found for product type "${acceptedType.targetId}". Configure an attribute profile in store/classification/attribute-profiles.json.`,
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
        message: `${applicable.length} attributes applicable for product type "${acceptedType.targetId}".`,
      },
    };
  },
};
