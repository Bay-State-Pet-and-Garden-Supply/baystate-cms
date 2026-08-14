/**
 * Store Manager image-repair tool adapter (epic #42, #40).
 *
 * Thin adapter only: all network/filesystem/decode/SQL capability lives in the
 * hardened `store-manager-image-repair` service (#36), shared with the Change
 * Set Review UI route so chat cannot drift from or bypass the boundaries.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../runtime/contracts';
import { okResult, policyDenied, errorResult } from '../runtime/contracts';
import { buildStoreManagerActionDiff } from '../runtime/action-preview';
import type { StoreManagerActionDiff } from '../../shared/schemas/store-manager-diff';
import { repairChangeSetImagesForWorkspace } from '../../server/services/store-manager-image-repair';
import { getChangeSetWithItemsForWorkspace } from '../../db/repositories/change-set-repo';

/** Deterministic preview: approved Change Set + item count => expected network/file activity. */
function previewRepairImages(changeSetId: string, ctx: { workspaceId: string; pinnedScope?: unknown }): StoreManagerActionDiff | null {
  const detail = getChangeSetWithItemsForWorkspace(ctx.workspaceId, changeSetId);
  const changeSet = detail?.changeSet ?? null;
  const skus = (detail?.items ?? []).map((i) => i.sku).filter((s): s is string => typeof s === 'string');
  return buildStoreManagerActionDiff({
    toolName: repairApprovedChangeSetImagesAdapter.name,
    toolVersion: repairApprovedChangeSetImagesAdapter.version,
    riskClass: 'network_filesystem_repair',
    workspaceId: ctx.workspaceId,
    scopeHash: ctx.pinnedScope && typeof ctx.pinnedScope === 'object' && ctx.pinnedScope !== null && 'kind' in ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
    affectedSkuCount: skus.length,
    affectedSkus: skus.slice(0, 200),
    filesTouched: skus.slice(0, 100).map((sku) => ({
      path: `products/images/${sku}.jpg`,
      note: 'derived: per-SKU image writes under the products/images root',
    })),
    changeSet: changeSet
      ? {
          id: changeSet.id,
          currentState: changeSet.status,
          expectedState: 'approved',
          itemCount: skus.length,
        }
      : { currentState: null, expectedState: 'approved' },
    networkActivity: {
      kind: 'bounded',
      hosts: [],
      requestCount: skus.length,
      note: 'one fetch per affected SKU from the original onboarding extraction URLs (resolved at execution)',
    },
    evidenceRefs: changeSet ? [`change_set:${changeSet.id}`] : [],
  });
}

export const repairApprovedChangeSetImagesAdapter: StoreManagerToolAdapter = {
  name: 'repair_approved_change_set_images',
  version: 1,
  description:
    'Re-download and normalize product images for an approved change set from the original onboarding extraction data. Use when an export images ZIP is empty because files were lost from disk. The change set must be approved and belong to the current workspace.',
  promptGuidelines:
    'Privileged network + filesystem repair. Requires operator approval and an approved Change Set; report per-SKU outcomes exactly as returned.',
  inputSchema: z.object({
    changeSetId: z.string().describe('The UUID of the approved change set to repair images for'),
  }),
  riskClass: 'network_filesystem_repair',
  sideEffects:
    'outbound network downloads and image file writes under the workspace products/images root',
  requiresApproval: true,
  stateTransition: 'Change Set images re-downloaded into workspace (filesystem write)',
  allowedPhases: ['approve'] as const,
  scopeSummary: (input) => `re-download images for Change Set ${String(input.changeSetId ?? '?')}`,
  previewDiff: async ({ changeSetId }, ctx) => previewRepairImages(String(changeSetId), ctx),
  execute: async ({ changeSetId }, ctx): Promise<StoreManagerToolResult> => {
    const result = await repairChangeSetImagesForWorkspace({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      changeSetId: String(changeSetId),
    });
    if (result.status === 'not_found') {
      return policyDenied('not_found', result.error);
    }
    if (result.status === 'policy_denied') {
      return policyDenied('not_in_workspace', result.error);
    }
    if (result.status === 'error') {
      return errorResult('repair_failed', result.error);
    }
    return okResult(result.summary);
  },
};

export const IMAGE_REPAIR_TOOL_ADAPTERS = [repairApprovedChangeSetImagesAdapter] as const;
