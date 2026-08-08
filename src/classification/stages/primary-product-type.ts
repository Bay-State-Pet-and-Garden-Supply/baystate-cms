/**
 * Primary Product Type Proposal Stage
 *
 * Thin wrapper around the shared curation target engine. Loads the
 * classification config, resolves enabled targets, and delegates
 * product type matching to the shared processor.
 *
 * Product Type is ONLY processed when it is explicitly enabled as
 * a curation target — never inferred as internal context.
 *
 * Dependencies: Evidence from evidence_extraction stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processProductTypeTarget } from '../curation-target-processor';

export const primaryProductTypeStage: StageDefinition = {
  name: 'primary_product_type_proposal',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    // If Product Type is not an enabled curation target, return succeeded
    // with empty proposals (NOT abstained, to avoid noisy reviewable_abstention).
    if (resolved.productTypes.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Product Type is not enabled as a curation target.',
        },
      };
    }

    // Target exists but has no options configured
    if (resolved.productTypes[0].options.length === 0) {
      return {
        status: 'abstained',
        reason: 'No product type options configured. Add product types in store/classification/product-types.json.',
      };
    }

    // Delegate to shared processor
    const result = await processProductTypeTarget(resolved.productTypes[0], input, context);

    if (result.proposals.length === 0) {
      return {
        status: 'abstained',
        reason: `No confident product type match found: ${result.message}`,
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
