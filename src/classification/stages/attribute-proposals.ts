/**
 * Product Attribute Proposals Stage
 *
 * Thin wrapper around the shared curation target engine. Processes
 * only enabled product-field curation targets through the shared
 * resolver → matcher → ranker → proposal builder pipeline.
 *
 * Product Type profile filtering is optional: if Product Type is an
 * enabled target and a selected proposal exists with a profile, only
 * product-field targets matching profile attributes are processed.
 * Otherwise, all enabled product-field targets are processed.
 *
 * Dependencies: attribute_applicability stage.
 */
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets } from '../curation-target-resolver';
import { processProductFieldTarget } from '../curation-target-processor';
import { selectPrimaryProductTypeProposal } from '../proposal-selection';
import { getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';

export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const config = loadClassificationConfig(context.workspacePath);
    const resolved = resolveEnabledTargets(config, context.workspaceId);

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

    // Determine which attribute IDs are profile-filtered.
    // Only applies when Product Type target is enabled AND a selected
    // Product Type proposal exists with a profile. Otherwise, all
    // enabled product-field targets are processed.
    let profileAttributeIds: Set<string> | null = null;

    if (resolved.productTypes.length > 0) {
      const typeSelection = selectPrimaryProductTypeProposal(input);
      const selectedType = typeSelection.proposal;
      if (selectedType?.targetId) {
        const profiles = getCachedAttributeProfiles(context.workspaceId);
        const profile = profiles.find(p => p.productTypeId === selectedType.targetId);
        if (profile && profile.attributes.length > 0) {
          profileAttributeIds = new Set(profile.attributes.map(a => a.attributeId));
        }
      }
    }

    // Filter resolved fields by profile if applicable
    const targetsToProcess = profileAttributeIds
      ? resolved.productFields.filter(t => t.attribute && profileAttributeIds!.has(t.attribute.id))
      : resolved.productFields;

    if (targetsToProcess.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: profileAttributeIds
            ? 'No enabled product-field targets match the selected Product Type profile.'
            : 'No enabled product-field targets available.',
        },
      };
    }

    // Process each target through the shared engine
    const allProposals: ClassificationProposal[] = [];
    const messages: string[] = [];

    for (const target of targetsToProcess) {
      const result = await processProductFieldTarget(target, input, context);
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
