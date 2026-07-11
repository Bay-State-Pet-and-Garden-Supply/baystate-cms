import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';

/**
 * Product Draft Projection Stage
 *
 * Produces a preview of the final product draft fields that would result
 * from applying all accepted (or, before review, all pending) proposals.
 * This includes:
 * - Field assignments mapped to Catalog Fields (accepted first, then pending)
 * - Category page assignments (accepted first, then pending)
 *
 * This is the final classification stage before product draft creation.
 * No actual product files are modified — this is a preview only.
 *
 * IMPORTANT: This stage does NOT persist proposals. The projection is
 * returned as stage output metadata and consumed by the Review UI.
 * The downstream `draft-promoter.ts` reads accepted proposals directly
 * from the classification_proposals table via `getAcceptedProposals()`.
 */
export const productDraftProjectionStage: StageDefinition = {
  name: 'product_draft_projection',
  requires: ['category_page_proposals', 'product_attribute_proposals'],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const accepted = input.acceptedProposals;
    const allProposals = input.allProposals;
    const mappings = getCachedAttributeMappings(context.workspaceId);

    // Build a set of target IDs already covered by accepted proposals
    // so we don't double-count when including pending ones.
    const acceptedTargetIds = new Set(
      accepted
        .filter(p => p.proposalType === 'field_assignment' && p.targetId)
        .map(p => p.targetId!),
    );

    // Collect field assignments from accepted proposals first,
    // then supplement with pending proposals for preview.
    const fieldAssignments: Record<string, unknown> = {};
    const pendingSupplement: Array<{ targetId: string; value: unknown; confidence: number }> = [];

    // Helper to build a catalog field value from a proposal
    const applyMapping = (proposal: any, mapping: any): unknown => {
      const value = proposal.proposedValue;
      const format = mapping.serialization?.format ?? 'direct';
      if (format === 'direct') return value;
      const sep = mapping.serialization?.separator ?? ', ';
      const prefix = mapping.serialization?.prefix ?? '';
      const suffix = mapping.serialization?.suffix ?? '';
      const values = Array.isArray(value) ? value : [value];
      return `${prefix}${values.join(sep)}${suffix}`;
    };

    // Process accepted proposals
    for (const proposal of accepted) {
      if (proposal.proposalType !== 'field_assignment' || !proposal.targetId) continue;
      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping || mapping.isStale) continue;
      fieldAssignments[mapping.catalogField] = applyMapping(proposal, mapping);
    }

    // Supplement with pending proposals for preview (not yet reviewed)
    for (const proposal of allProposals) {
      if (
        proposal.proposalType !== 'field_assignment' ||
        !proposal.targetId ||
        acceptedTargetIds.has(proposal.targetId)
      ) continue;
      if (proposal.status !== 'pending' || proposal.isStale) continue;

      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping || mapping.isStale) continue;

      // Don't override an accepted value; only add if not already set
      if (fieldAssignments[mapping.catalogField] === undefined) {
        fieldAssignments[mapping.catalogField] = applyMapping(proposal, mapping);
        pendingSupplement.push({ targetId: proposal.targetId, value: proposal.proposedValue, confidence: proposal.confidence });
      }
    }

    // Collect accepted category page assignments, then supplement with pending
    const pageAssignments: string[] = [];
    for (const proposal of accepted) {
      if (proposal.proposalType === 'category_page' && proposal.targetId) {
        pageAssignments.push(proposal.targetId);
      }
    }

    const pendingPageAssignments: string[] = [];
    if (pageAssignments.length === 0) {
      for (const proposal of allProposals) {
        if (proposal.proposalType !== 'category_page' || !proposal.targetId) continue;
        if (proposal.status !== 'pending' || proposal.isStale) continue;
        pendingPageAssignments.push(proposal.targetId);
      }
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [],  // No synthetic proposals — projection is metadata-only
        abstained: false,
        message: `${Object.keys(fieldAssignments).length} field assignments, ${
          pendingPageAssignments.length > 0 ? pendingPageAssignments.length : pageAssignments.length
        } page assignments projected.`,
        metadata: {
          projection: {
            fieldAssignments,
            pageAssignments:
              pendingPageAssignments.length > 0
                ? pendingPageAssignments
                : pageAssignments,
            acceptedProposalCount: accepted.length,
            pendingSupplementCount: pendingSupplement.length,
            hasAcceptedAssignments: accepted.length > 0,
            selectionMode:
              accepted.length > 0 ? 'accepted' : 'provisional_preview',
            pendingSupplement,
          },
        },
      },
    };
  },
};
