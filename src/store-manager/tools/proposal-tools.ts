/**
 * Store Manager proposal/persistent tool adapters (epic #42, #40).
 *
 * Persistent adapters call workspace-scoped services only (the #35 repo owns
 * all proposal SQL). They never touch the database, network, or filesystem
 * directly. All expected conditions (foreign id, not found, denied) return
 * structured outcomes instead of throwing.
 */

import { z } from 'zod';
import type {
  StoreManagerToolAdapter,
  StoreManagerToolResult,
} from '../runtime/contracts';
import { okResult, policyDenied, errorResult } from '../runtime/contracts';
import {
  generateDeterministicProposals,
  applyProposal,
  dismissProposal,
  ProposalNotFoundError,
} from '../../server/services/product-field-refactor-service';

export const storeProductFieldNormalizationProposalsAdapter: StoreManagerToolAdapter = {
  name: 'store_product_field_normalization_proposals',
  version: 1,
  description:
    'Generate deterministic normalization proposals for a custom ProductField and store them as proposals (status "proposed"). Catalog is unchanged.',
  promptGuidelines:
    'Persistent proposal write. State that proposals are stored for review; do not claim they are applied, approved, or published.',
  inputSchema: z.object({
    field: z.string().describe('ProductField name, e.g. ProductField24'),
  }),
  riskClass: 'proposal_write',
  sideEffects: 'creates stored normalization proposals (DB rows, status "proposed") for the requested field',
  requiresApproval: true,
  stateTransition: 'stored proposal created (status: proposed); catalog unchanged',
  allowedPhases: ['approve'] as const,
  scopeSummary: (input) => `store normalization proposals for ${String(input.field ?? '?')}`,
  execute: async ({ field }, ctx): Promise<StoreManagerToolResult> => {
    const proposals = generateDeterministicProposals(ctx.workspaceId, String(field));
    return okResult({ success: true, proposalCount: proposals.length });
  },
};

export const stageStoredProposalInChangeSetAdapter: StoreManagerToolAdapter = {
  name: 'stage_stored_proposal_in_change_set',
  version: 1,
  description:
    'Stage a stored proposal by its UUID, applying its value updates for all affected products inside the active Change Set (draft only). The proposal must belong to the current workspace.',
  promptGuidelines:
    'Catalog mutation. The result stages draft changes in a Change Set; it is NOT approval, publication, or sync.',
  inputSchema: z.object({
    proposalId: z.string().describe('The UUID of the stored proposal to stage'),
  }),
  riskClass: 'catalog_mutation',
  sideEffects:
    'stages proposal value updates for affected products into the active Change Set (draft only; no catalog/workspace write)',
  requiresApproval: true,
  stateTransition:
    'stored proposal -> staged in Change Set (draft changes); not approved, not published, not synced',
  allowedPhases: ['approve'] as const,
  scopeSummary: (input) => `stage stored proposal ${String(input.proposalId ?? '?')} in a Change Set`,
  execute: async ({ proposalId }, ctx): Promise<StoreManagerToolResult> => {
    try {
      const res = applyProposal(ctx.workspaceId, ctx.workspacePath, String(proposalId));
      return okResult({ success: true, changeSetId: res.changeSetId });
    } catch (err) {
      if (err instanceof ProposalNotFoundError) {
        return policyDenied('not_found', 'Proposal not found in this workspace.');
      }
      return errorResult('apply_failed', err instanceof Error ? err.message : 'Failed to stage proposal.');
    }
  },
};

export const dismissStoredProposalAdapter: StoreManagerToolAdapter = {
  name: 'dismiss_stored_proposal',
  version: 1,
  description:
    'Dismiss a stored proposal by its UUID so it will not be suggested or applied. The proposal must belong to the current workspace.',
  promptGuidelines: 'Persistent proposal write; catalog unchanged.',
  inputSchema: z.object({
    proposalId: z.string().describe('The UUID of the stored proposal to dismiss'),
  }),
  riskClass: 'proposal_write',
  sideEffects: 'marks a stored proposal dismissed (DB status change)',
  requiresApproval: true,
  stateTransition: 'stored proposal -> dismissed; catalog unchanged',
  allowedPhases: ['approve'] as const,
  scopeSummary: (input) => `dismiss stored proposal ${String(input.proposalId ?? '?')}`,
  execute: async ({ proposalId }, ctx): Promise<StoreManagerToolResult> => {
    try {
      dismissProposal(ctx.workspaceId, String(proposalId));
      return okResult({ success: true });
    } catch (err) {
      if (err instanceof ProposalNotFoundError) {
        return policyDenied('not_found', 'Proposal not found in this workspace.');
      }
      return errorResult('dismiss_failed', err instanceof Error ? err.message : 'Failed to dismiss proposal.');
    }
  },
};

/** All persistent proposal adapters in stable registration order. */
export const PROPOSAL_TOOL_ADAPTERS: StoreManagerToolAdapter[] = [
  storeProductFieldNormalizationProposalsAdapter,
  stageStoredProposalInChangeSetAdapter,
  dismissStoredProposalAdapter,
];
