/**
 * Store Manager bulk-review pure client derivation (operations console,
 * Issue 8).
 *
 * Pure functions only — no fetch, no hooks, no React. All new bulk-review UI
 * derivation lives here (the dirty store-manager-logic.ts is untouched).
 */

import type {
  StoreManagerBulkReviewBatchDetail,
  StoreManagerBulkReviewGroup,
  StoreManagerBulkReviewItem,
} from './store-manager-api';

export const BULK_REVIEW_KIND_LABEL: Record<string, string> = {
  casing: 'Casing',
  whitespace: 'Whitespace',
  separator: 'Separator',
};

export function bulkReviewKindLabel(kind: string): string {
  return BULK_REVIEW_KIND_LABEL[kind] ?? kind;
}

export function bulkReviewBatchStatusLabel(status: string): string {
  if (status === 'applied') return 'Applied (staged)';
  if (status === 'denied') return 'Denied';
  return 'Pending review';
}

export function bulkReviewBatchStatusTone(status: string): string {
  if (status === 'applied') return '#2f5d3a';
  if (status === 'denied') return '#8a6116';
  return '#8b1e2d';
}

/** e.g. "ProductField24 · 80 proposals · 37 SKUs" */
export function bulkReviewGroupTitle(group: {
  field: string;
  normalizationKind: string;
  proposalCount: number;
  distinctSkuCount: number;
}): string {
  return `${group.field} · ${bulkReviewKindLabel(group.normalizationKind)} · ${group.proposalCount} proposals · ${group.distinctSkuCount} SKUs`;
}

export function bulkReviewDiffLine(summary: {
  affectedSkuCount: number;
  proposalCount: number;
  networkActivity: string;
}): string {
  const network = summary.networkActivity === 'none' ? 'no network activity' : summary.networkActivity;
  return `${summary.proposalCount} proposals affecting ${summary.affectedSkuCount} distinct SKUs (${network})`;
}

export interface BulkReviewItemRow {
  proposalId: string;
  field: string;
  oldValue: string;
  newValue: string;
  skuCount: number;
  skuSample: string[];
  skuSampleTruncated: boolean;
  decision: string;
  statusLabel: string;
  changeSetItemRef: string | null;
}

/** Per-item drill-down rows (bounded SKU sample per item). */
export function renderBulkReviewItems(items: StoreManagerBulkReviewItem[]): BulkReviewItemRow[] {
  return items.map((item) => {
    const sample = item.affectedSkus.slice(0, 5);
    return {
      proposalId: item.proposalId,
      field: item.field,
      oldValue: item.oldValue,
      newValue: item.newValue,
      skuCount: item.affectedSkus.length,
      skuSample: sample,
      skuSampleTruncated: item.affectedSkus.length > sample.length,
      decision: item.decision,
      statusLabel: item.decision === 'pending' ? 'Pending' : item.decision === 'applied' ? 'Applied' : 'Denied',
      changeSetItemRef: item.changeSetItemRef,
    };
  });
}

export function bulkReviewExclusionSummary(exclusions: Array<{ reason: string }>): string {
  if (exclusions.length === 0) return 'No exclusions.';
  const byReason = new Map<string, number>();
  for (const e of exclusions) {
    byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  }
  const parts = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${count}× ${reason}`);
  return parts.length > 0 ? parts.join('; ') : 'No exclusions.';
}

/** A batch is actionable only when pending AND fresh against current sources. */
export function isBulkReviewBatchActionable(detail: StoreManagerBulkReviewBatchDetail): boolean {
  if (detail.batch.status !== 'pending') return false;
  if (detail.stale) return false;
  return detail.items.length > 0;
}

export function bulkReviewActionabilityNote(detail: StoreManagerBulkReviewBatchDetail): string | null {
  if (detail.batch.status !== 'pending') {
    return `This batch is already ${bulkReviewBatchStatusLabel(detail.batch.status)}.`;
  }
  if (detail.stale) {
    return `Stale: ${detail.staleReason ?? 'source state changed'}. Create a fresh preview before acting.`;
  }
  if (detail.items.length === 0) return 'This batch contains no items.';
  return null;
}

/**
 * Objective sent to the Manager chat when the operator chooses "Approve exact
 * batch". The runtime model resolves this to the bulk_apply_stored_proposals
 * tool; the standard approval card shows the exact diff before anything runs.
 */
export function bulkReviewApproveObjective(batchId: string, field: string): string {
  return `Apply bulk review batch ${batchId} for ${field} exactly as previewed (deterministic ${field} normalization, staged into the active Change Set only).`;
}

/** Guard: the UI never offers "apply" wording on denied/applied batches. */
export function bulkReviewBatchStatusActionLabel(detail: StoreManagerBulkReviewBatchDetail): string | null {
  if (detail.batch.status !== 'pending') return null;
  return detail.stale ? 'Refresh preview' : 'Send to Manager review';
}
