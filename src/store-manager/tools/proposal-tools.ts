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
  StoreManagerAdapterContext,
} from '../runtime/contracts';
import { okResult, policyDenied, errorResult } from '../runtime/contracts';
import { buildStoreManagerActionDiff } from '../runtime/action-preview';
import type { StoreManagerActionDiff } from '../../shared/schemas/store-manager-diff';
import {
  generateDeterministicProposals,
  applyProposal,
  dismissProposal,
  findExactSkusWithFieldValue,
  ProposalNotFoundError,
} from '../../server/services/product-field-refactor-service';
import { generateProductFieldAuditReport } from '../../server/services/catalog-insight-service';
import { findProposalById } from '../../db/repositories/catalog-health-proposal-repo';
import { findActiveChangeSet } from '../../db/repositories/change-set-repo';
import { recordReviewDecision } from '../../db/repositories/store-manager-history-repo';

/**
 * Deterministic preview for `store_product_field_normalization_proposals`:
 * derives the candidate set from the read-only audit report WITHOUT persisting
 * anything (execution re-derives it inside the same workspace-scoped path).
 */
function previewNormalizationProposals(
  field: string,
  ctx: StoreManagerAdapterContext,
): StoreManagerActionDiff | null {
  const report = generateProductFieldAuditReport(ctx.workspaceId, field);
  const affected = new Set<string>();
  let candidateCount = 0;
  const beforeAfter: StoreManagerActionDiff['beforeAfter'] = [];

  // 1. Casing duplicates: every non-canonical value proposes renaming to the
  //    highest-frequency value (mirrors generateDeterministicProposals).
  for (const group of report.casingDuplicates) {
    const sorted = [...group.values].sort((a, b) => b.frequency - a.frequency);
    const canonical = sorted[0];
    for (let i = 1; i < sorted.length; i += 1) {
      candidateCount += 1;
      for (const sku of sorted[i].skus) affected.add(sku);
      if (beforeAfter.length < 50) {
        beforeAfter.push({
          field,
          before: sorted[i].value.slice(0, 200),
          after: canonical.value.slice(0, 200),
          affectedCount: sorted[i].skus.length,
        });
      }
    }
  }
  // 2. Near duplicates with a 3x frequency consensus.
  for (const pair of report.nearDuplicates) {
    if (pair.frequencyA >= 3 * pair.frequencyB) {
      candidateCount += 1;
      for (const sku of findExactSkusWithFieldValue(field, pair.valueB)) affected.add(sku);
      if (beforeAfter.length < 50) {
        beforeAfter.push({ field, before: pair.valueB.slice(0, 200), after: pair.valueA.slice(0, 200), affectedCount: pair.frequencyB });
      }
    } else if (pair.frequencyB >= 3 * pair.frequencyA) {
      candidateCount += 1;
      for (const sku of findExactSkusWithFieldValue(field, pair.valueA)) affected.add(sku);
      if (beforeAfter.length < 50) {
        beforeAfter.push({ field, before: pair.valueA.slice(0, 200), after: pair.valueB.slice(0, 200), affectedCount: pair.frequencyA });
      }
    }
  }
  // 3. Leading/trailing whitespace.
  for (const suspicious of report.suspiciousValues) {
    if (suspicious.reasons.includes('Leading or trailing whitespace')) {
      const trimmed = suspicious.value.trim();
      if (trimmed !== suspicious.value) {
        candidateCount += 1;
        for (const sku of suspicious.skus) affected.add(sku);
        if (beforeAfter.length < 50) {
          beforeAfter.push({ field, before: suspicious.value.slice(0, 200), after: trimmed.slice(0, 200), affectedCount: suspicious.frequency });
        }
      }
    }
  }

  return buildStoreManagerActionDiff({
    toolName: storeProductFieldNormalizationProposalsAdapter.name,
    toolVersion: storeProductFieldNormalizationProposalsAdapter.version,
    riskClass: 'proposal_write',
    workspaceId: ctx.workspaceId,
    scopeHash: ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
    affectedSkuCount: affected.size,
    affectedSkus: [...affected].slice(0, 200),
    beforeAfter,
    changeSet: null,
    networkActivity: { kind: 'none' },
    evidenceRefs: [`audit:${field}`],
  });
}

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
  supportedScopes: ['product_field'] as const,
  scopeSummary: (input) => `store normalization proposals for ${String(input.field ?? '?')}`,
  previewDiff: async ({ field }, ctx) => previewNormalizationProposals(String(field), ctx),
  execute: async ({ field }, ctx): Promise<StoreManagerToolResult> => {
    const proposals = generateDeterministicProposals(ctx.workspaceId, String(field));
    return okResult({ success: true, proposalCount: proposals.length });
  },
};

function previewStageProposal(proposalId: string, ctx: StoreManagerAdapterContext): StoreManagerActionDiff | null {
  const proposal = findProposalById(ctx.workspaceId, proposalId);
  if (!proposal) {
    return buildStoreManagerActionDiff({
      toolName: stageStoredProposalInChangeSetAdapter.name,
      toolVersion: stageStoredProposalInChangeSetAdapter.version,
      riskClass: 'catalog_mutation',
      workspaceId: ctx.workspaceId,
      scopeHash: ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
      affectedSkuCount: 0,
      affectedSkus: [],
      changeSet: null,
      networkActivity: { kind: 'none' },
      evidenceRefs: [],
    });
  }
  const active = findActiveChangeSet(ctx.workspaceId);
  return buildStoreManagerActionDiff({
    toolName: stageStoredProposalInChangeSetAdapter.name,
    toolVersion: stageStoredProposalInChangeSetAdapter.version,
    riskClass: 'catalog_mutation',
    workspaceId: ctx.workspaceId,
    scopeHash: ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
    affectedSkuCount: proposal.affectedSkus.length,
    affectedSkus: proposal.affectedSkus.slice(0, 200),
    beforeAfter: [
      {
        field: proposal.field,
        before: proposal.oldValue.slice(0, 200),
        after: proposal.newValue.slice(0, 200),
        affectedCount: proposal.affectedSkus.length,
      },
    ],
    filesTouched: [],
    changeSet: {
      id: proposal.changeSetId ?? active?.id ?? undefined,
      currentState: active?.status ?? proposal.changeSetId ?? null,
      expectedState: 'draft',
      itemCount: active?.id ? 0 : undefined,
    },
    networkActivity: { kind: 'none' },
    evidenceRefs: [`proposal:${proposal.id}`],
  });
}

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
  previewDiff: async ({ proposalId }, ctx) => previewStageProposal(String(proposalId), ctx),
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

function previewDismissProposal(proposalId: string, ctx: StoreManagerAdapterContext): StoreManagerActionDiff | null {
  const proposal = findProposalById(ctx.workspaceId, proposalId);
  return buildStoreManagerActionDiff({
    toolName: dismissStoredProposalAdapter.name,
    toolVersion: dismissStoredProposalAdapter.version,
    riskClass: 'proposal_write',
    workspaceId: ctx.workspaceId,
    scopeHash: ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
    affectedSkuCount: 0,
    affectedSkus: [],
    beforeAfter: proposal
      ? [{ field: proposal.field, before: `status: ${proposal.status}`, after: 'status: dismissed', affectedCount: 0 }]
      : [],
    changeSet: null,
    networkActivity: { kind: 'none' },
    evidenceRefs: proposal ? [`proposal:${proposal.id}`] : [],
  });
}

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
  previewDiff: async ({ proposalId }, ctx) => previewDismissProposal(String(proposalId), ctx),
  execute: async ({ proposalId }, ctx): Promise<StoreManagerToolResult> => {
    try {
      dismissProposal(ctx.workspaceId, String(proposalId));
      // Durable review decision for the bounded history query (Issue 7).
      const proposal = findProposalById(ctx.workspaceId, String(proposalId));
      recordReviewDecision({
        workspaceId: ctx.workspaceId,
        proposalId: String(proposalId),
        field: proposal?.field ?? 'unknown',
        decision: 'dismissed',
        actor: 'store_manager_agent',
        runId: ctx.sessionId,
      });
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
