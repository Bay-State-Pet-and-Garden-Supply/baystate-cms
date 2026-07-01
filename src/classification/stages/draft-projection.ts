import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import { getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';

/**
 * Product Draft Projection Stage
 *
 * Produces a preview of the final product draft fields that would result
 * from applying all accepted proposals. This includes:
 * - Accepted field assignments mapped to Catalog Fields
 * - Accepted category page assignments
 *
 * This is the final classification stage before product draft creation.
 * No actual product files are modified — this is a preview only.
 */
export const productDraftProjectionStage: StageDefinition = {
  name: 'product_draft_projection',
  requires: ['category_page_proposals', 'product_attribute_proposals'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const accepted = input.acceptedProposals;

    // Collect accepted field assignments
    const fieldAssignments: Record<string, unknown> = {};
    const mappings = getCachedAttributeMappings(context.workspaceId);

    for (const proposal of accepted) {
      if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;

      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping || mapping.isStale) {
        // Skipped draft assignment — mapping missing or stale
        continue;
      }

      const value = proposal.proposedValue;
      const format = mapping.serialization?.format ?? 'direct';
      if (format === 'direct') {
        fieldAssignments[mapping.catalogField] = value;
      } else {
        // Use configured serialization format
        const sep = mapping.serialization?.separator ?? ', ';
        const prefix = mapping.serialization?.prefix ?? '';
        const suffix = mapping.serialization?.suffix ?? '';
        const values = Array.isArray(value) ? value : [value];
        fieldAssignments[mapping.catalogField] = `${prefix}${values.join(sep)}${suffix}`;
      }
    }

    // Collect accepted category page assignments
    const pageAssignments: string[] = [];
    for (const proposal of accepted) {
      if (proposal.proposalType === 'category_page' && proposal.targetId) {
        pageAssignments.push(proposal.targetId);
      }
    }

    const proposalId = randomUUID();
    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [
          {
            id: proposalId,
            runId: context.runId,
            productSku: input.sku,
            proposalType: 'field_assignment',
            targetId: 'product_draft_projection',
            proposedValue: {
              fieldAssignments,
              pageAssignments,
              acceptedProposalCount: accepted.length,
            },
            confidence: 1,
            evidenceIds: [],
            status: 'pending',
            isBulkAcceptable: false,
            isStale: false,
            stalenessReason: null,
            createdAt: new Date().toISOString(),
          },
        ],
        abstained: false,
      },
    };
  },
};
