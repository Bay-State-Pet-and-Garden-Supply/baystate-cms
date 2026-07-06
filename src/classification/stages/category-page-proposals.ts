/**
 * Category Page Proposal Stage
 *
 * Thin wrapper around the shared curation target engine. Proposes
 * which existing store Category Pages the product should be assigned to.
 *
 * Only runs when a `page` curation target is enabled. Disabled page
 * targets return succeeded with empty proposals (not abstained) to
 * avoid noisy reviewable_abstention proposals.
 *
 * Dependencies: Evidence from evidence_extraction stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets } from '../curation-target-resolver';
import { processPageTarget } from '../curation-target-processor';

export const categoryPageProposalsStage: StageDefinition = {
  name: 'category_page_proposals',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction', 'primary_product_type_proposal'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const config = loadClassificationConfig(context.workspacePath);
    const resolved = resolveEnabledTargets(config, context.workspaceId);

    // If page assignment is not an enabled curation target, return
    // succeeded with empty proposals (not abstained).
    if (resolved.pages.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Page assignment is not enabled as a curation target.',
        },
      };
    }

    // Target exists but no store pages available
    if (resolved.pages[0].options.length === 0) {
      return {
        status: 'abstained',
        reason: 'No store pages available. Sync pages from ShopSite or configure them manually.',
      };
    }

    // Delegate to shared processor for the first page target
    const result = await processPageTarget(resolved.pages[0], input, context);

    if (result.proposals.length === 0) {
      return {
        status: 'abstained',
        reason: `No category page matches found: ${result.message}`,
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: result.proposals,
        abstained: false,
        message: result.message,
      },
    };
  },
};
