// ---------------------------------------------------------------------------
// Store Manager run-history pure client derivation (operations console,
// Issue 7). All new pure derivation lives here — the protected dirty
// src/client/store-manager-logic.ts is never touched.
// ---------------------------------------------------------------------------

import type {
  StoreManagerActionDiff,
  StoreManagerCompareResult,
  StoreManagerHistoryRun,
  StoreManagerRunHistoryDetail,
} from './store-manager-api';

export const TERMINAL_STATUS_LABELS: Record<string, string> = {
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
  policy_denied: 'Denied by policy',
  deadline_exceeded: 'Deadline exceeded',
  unavailable: 'Model unavailable',
};

export const ENTRYPOINT_LABELS: Record<string, string> = {
  chat: 'Chat',
  command: 'Command',
  schedule: 'Scheduled run',
  event: 'Event trigger',
  playbook: 'Playbook step',
  replay: 'Replay',
  plan_preview: 'Plan preview',
};

export function terminalStatusLabel(status: string | null): string {
  if (!status) return 'In progress';
  return TERMINAL_STATUS_LABELS[status] ?? status;
}

export function entrypointLabel(entrypoint: string): string {
  return ENTRYPOINT_LABELS[entrypoint] ?? entrypoint;
}

/** Bounded one-line run summary for history lists. */
export function runSummary(run: StoreManagerHistoryRun): string {
  const objective = run.objective.length > 90 ? `${run.objective.slice(0, 90)}…` : run.objective;
  return `${entrypointLabel(run.entrypoint)} — ${objective}`;
}

export interface DiffRenderRow {
  field: string;
  before: string;
  after: string;
  affectedCount?: number;
}

/** Deterministic rows for the diff-first approval UI. */
export function diffRenderRows(diff: StoreManagerActionDiff | null): DiffRenderRow[] {
  if (!diff) return [];
  return diff.beforeAfter.map((row) => ({
    field: row.field,
    before: row.before,
    after: row.after,
    affectedCount: row.affectedCount,
  }));
}

export function diffNetworkSummary(diff: StoreManagerActionDiff | null): string {
  if (!diff) return 'Unknown';
  switch (diff.networkActivity.kind) {
    case 'none':
      return 'None (no network activity)';
    case 'bounded':
      return `${diff.networkActivity.requestCount} bounded request${diff.networkActivity.requestCount === 1 ? '' : 's'}${diff.networkActivity.note ? ` — ${diff.networkActivity.note}` : ''}`;
    case 'unknown':
      return `Unknown — ${diff.networkActivity.note}`;
  }
}

export function diffAffectedSkuText(diff: StoreManagerActionDiff | null): string {
  if (!diff) return 'Unknown';
  const truncated = diff.affectedSkusTruncated ? ' (truncated list)' : '';
  return `${diff.affectedSkuCount} SKU${diff.affectedSkuCount === 1 ? '' : 's'} affected${truncated}`;
}

export function comparisonWarning(result: StoreManagerCompareResult): string | null {
  if (result.comparable) return null;
  return result.reason ?? 'These runs cannot be compared (incompatible artifacts).';
}

export function replayWarning(detail: StoreManagerRunHistoryDetail): string | null {
  const lineage = (detail.run.lineage ?? {}) as { replayOfRunId?: string };
  if (!lineage.replayOfRunId) {
    return null;
  }
  return 'Replay runs against the CURRENT catalog state with a new immutable policy. It never reuses approvals and records the new lineage.';
}

export function modelCallSummary(detail: StoreManagerRunHistoryDetail): string {
  const call = detail.modelCall;
  if (!call) return 'No model call recorded for this run.';
  const tokens = [call.promptTokens, call.completionTokens]
    .filter((v): v is number => typeof v === 'number')
    .join(' / ');
  const cost = typeof call.estimatedApiCostUsd === 'number' ? ` — $${call.estimatedApiCostUsd.toFixed(4)}` : '';
  return `${call.provider}/${call.model} (${call.locality}) — ${tokens} tokens${cost}`;
}
