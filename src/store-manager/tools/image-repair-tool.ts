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
import { repairChangeSetImagesForWorkspace } from '../../server/services/store-manager-image-repair';

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
