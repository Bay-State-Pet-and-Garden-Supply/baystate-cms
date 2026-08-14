/**
 * Store Manager Change Set read adapters (operations console, Issue 2).
 *
 * Read-only, workspace-scoped Change Set inspection for the runtime registry.
 * No raw SQL, fetch, or filesystem access here — the adapter calls the
 * workspace-scoped repository helper and returns bounded structured data.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../runtime/contracts';
import { okResult, noResult, policyDenied } from '../runtime/contracts';
import { getChangeSetWithItemsForWorkspace } from '../../db/repositories/change-set-repo';

const MAX_ITEMS = 200;

export const getChangeSetDetailAdapter: StoreManagerToolAdapter = {
  name: 'getChangeSetDetail',
  version: 1,
  description:
    'Inspect a workspace Change Set: state, title, created/approved timestamps, affected SKU count, and a bounded item summary (sku, operation, validation status).',
  promptGuidelines:
    'Use before any stage/repair decision involving a Change Set. Reads are workspace-scoped; a foreign id returns no_result.',
  inputSchema: z.object({
    changeSetId: z.string().min(1).max(200).optional(),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: ['change_set'] as const,
  scopeSummary: (input) =>
    `Change Set ${typeof input.changeSetId === 'string' && input.changeSetId ? input.changeSetId : '(pinned)'}`,
  execute: async ({ changeSetId }, ctx): Promise<StoreManagerToolResult> => {
    const pinned = ctx.pinnedScope?.kind === 'change_set' ? ctx.pinnedScope.changeSetId : undefined;
    const id =
      typeof changeSetId === 'string' && changeSetId.trim() ? changeSetId : pinned;
    if (!id) {
      return policyDenied(
        'invalid_input',
        'getChangeSetDetail requires a changeSetId or a pinned change_set scope.',
      );
    }
    if (pinned && id !== pinned) {
      return policyDenied(
        'unsupported',
        'getChangeSetDetail cannot read a Change Set outside the pinned change_set scope.',
      );
    }
    const detail = getChangeSetWithItemsForWorkspace(ctx.workspaceId, id);
    if (!detail) {
      return noResult('Change Set not found in this workspace.', { changeSetId: id });
    }
    const { changeSet, items } = detail;
    const summary = items
      .slice(0, MAX_ITEMS)
      .map((item) => ({
        sku: item.sku,
        operation: item.operation,
        validationStatus: item.validationStatus,
      }));
    return okResult({
      changeSet: {
        id: changeSet.id,
        title: changeSet.title,
        status: changeSet.status,
        createdAt: changeSet.createdAt,
        updatedAt: changeSet.updatedAt,
        approvedAt: changeSet.approvedAt,
      },
      itemCount: items.length,
      truncated: items.length > MAX_ITEMS,
      items: summary,
    });
  },
};

export const CHANGE_SET_READ_TOOL_ADAPTERS: StoreManagerToolAdapter[] = [getChangeSetDetailAdapter];
