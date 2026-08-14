/**
 * Store Manager bulk-review tool adapter (operations console, Issue 8).
 *
 * One approval-required bulk stage adapter in the standard registry/policy.
 * It calls the transaction-aware bulk-review service (never direct route
 * mutation, never direct catalog/Git/ShopSite writes). The deterministic
 * previewDiff binds the EXACT persisted batch (header + item digests + diff
 * hash); at dispatch the registry recomputes it and refuses `stale_preview`
 * on any drift, and the service revalidates every item/SKU transactionally —
 * ANY mismatch refuses the whole batch (no partial hidden approval).
 *
 * This module contains no raw SQL, fetch, or filesystem calls (guarded by
 * tests) — everything goes through services/repositories.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult, StoreManagerAdapterContext } from '../runtime/contracts';
import { okResult, policyDenied } from '../runtime/contracts';
import { buildStoreManagerActionDiff } from '../runtime/action-preview';
import type { StoreManagerActionDiff } from '../../shared/schemas/store-manager-diff';
import {
  applyBulkReviewBatch,
  BulkReviewDisabledError,
  BulkReviewError,
} from '../../server/services/store-manager-bulk-review-service';
import {
  findBulkReviewBatch,
  listBulkReviewBatchItems,
} from '../../db/repositories/store-manager-bulk-review-repo';
import { findActiveChangeSet } from '../../db/repositories/change-set-repo';

/** Deterministic pre-approval preview over the IMMUTABLE persisted batch. */
function previewBulkApply(batchId: string, ctx: StoreManagerAdapterContext): StoreManagerActionDiff | null {
  const batch = findBulkReviewBatch(ctx.workspaceId, batchId);
  if (!batch) {
    return buildStoreManagerActionDiff({
      toolName: bulkApplyStoredProposalsAdapter.name,
      toolVersion: bulkApplyStoredProposalsAdapter.version,
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
  const items = listBulkReviewBatchItems(ctx.workspaceId, batchId);
  const skus: string[] = [];
  for (const item of items) {
    for (const sku of item.affectedSkus) skus.push(sku);
  }
  const distinctSkus = [...new Set(skus)];
  const active = findActiveChangeSet(ctx.workspaceId);
  return buildStoreManagerActionDiff({
    toolName: bulkApplyStoredProposalsAdapter.name,
    toolVersion: bulkApplyStoredProposalsAdapter.version,
    riskClass: 'catalog_mutation',
    workspaceId: ctx.workspaceId,
    scopeHash: ctx.pinnedScope ? JSON.stringify(ctx.pinnedScope) : null,
    affectedSkuCount: distinctSkus.length,
    affectedSkus: distinctSkus.slice(0, 200),
    beforeAfter: items.slice(0, 50).map((item) => ({
      field: item.field,
      before: item.oldValue.slice(0, 200),
      after: item.newValue.slice(0, 200),
      affectedCount: item.affectedSkus.length,
    })),
    filesTouched: distinctSkus
      .slice(0, 100)
      .map((sku) => ({ path: `products/${sku}.json`, note: 'draft row' })),
    changeSet: {
      id: active?.id ?? undefined,
      currentState: active?.status ?? null,
      expectedState: 'draft',
      itemCount: active?.id ? undefined : 0,
    },
    networkActivity: { kind: 'none' },
    evidenceRefs: [`bulk:${batchId}`],
    stateHashes: { batchDiff: batch.diffHash ?? 'unknown' },
  });
}

export const bulkApplyStoredProposalsAdapter: StoreManagerToolAdapter = {
  name: 'bulk_apply_stored_proposals',
  version: 1,
  description:
    'Stage one approved homogeneous bulk-review batch (exact preview set) into the active Change Set. Every proposal/SKU is revalidated; any stale or ineligible item refuses the whole batch with zero partial changes.',
  promptGuidelines:
    'Catalog mutation (bulk). State the exact batch id and affected SKU count from the diff; the result stages drafts only — never claim approval, publish, or sync.',
  inputSchema: z.object({
    batchId: z.string().min(1).max(64).describe('The persisted bulk-review batch id to stage.'),
  }),
  riskClass: 'catalog_mutation',
  sideEffects:
    'stages the exact batch preview (one decision + status transition + Change Set item per proposal) into the active Change Set; never approves, publishes, or syncs',
  requiresApproval: true,
  stateTransition:
    'bulk batch (pending) -> proposals staged in Change Set (draft); batch status applied; not approved, not published, not synced',
  allowedPhases: ['approve'] as const,
  supportedScopes: ['product_field'] as const,
  scopeSummary: (input) => `stage bulk review batch ${String(input.batchId ?? '?')} in a Change Set`,
  previewDiff: async ({ batchId }, ctx) => previewBulkApply(String(batchId), ctx),
  execute: async ({ batchId }, ctx): Promise<StoreManagerToolResult> => {
    try {
      const result = applyBulkReviewBatch(
        ctx.workspaceId,
        ctx.workspacePath,
        String(batchId),
        'operator',
        ctx.sessionId,
        { emit: ctx.emit, sessionId: ctx.sessionId, turnId: undefined },
      );
      return okResult(result);
    } catch (err) {
      if (err instanceof BulkReviewDisabledError) {
        return policyDenied('unsupported', err.message);
      }
      if (err instanceof BulkReviewError) {
        if (err.code === 'not_found' || err.code === 'already_decided') {
          return policyDenied('not_found', err.message);
        }
        if (err.code === 'stale' || err.code === 'ineligible' || err.code === 'empty_group') {
          return policyDenied('stale_preview', err.message);
        }
        return policyDenied('invalid_input', err.message);
      }
      return policyDenied('invalid_input', 'Bulk apply failed; no changes were made.');
    }
  },
};

/** All bulk-review adapters in stable registration order. */
export const BULK_REVIEW_TOOL_ADAPTERS: readonly StoreManagerToolAdapter[] = [bulkApplyStoredProposalsAdapter];
