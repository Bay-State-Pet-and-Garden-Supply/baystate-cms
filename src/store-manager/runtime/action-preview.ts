/**
 * Store Manager action-preview runtime helpers (operations console, Issue 7).
 *
 * Every persistent action is preceded by a fresh deterministic action diff
 * (`previewDiff` on the adapter) whose hash the operator approves. At
 * dispatch the registry recomputes the preview and refuses `stale_preview`
 * when the recomputed hash disagrees with the approval-bound diff hash —
 * no mutation authority is consumed on drift.
 *
 * This module is provider-neutral: it only builds/hashes diffs and detects
 * staleness. Adapter-specific preview computation lives on the adapters.
 */

import { hashCanonicalJson } from '../../shared/stable-id';
import {
  computeActionDiffHash,
  StoreManagerActionDiffSchema,
  type StoreManagerActionDiff,
} from '../../shared/schemas/store-manager-diff';
import type { StoreManagerAdapterContext, StoreManagerToolAdapter } from './contracts';

export interface BuildActionDiffInput {
  toolName: string;
  toolVersion: number;
  riskClass: StoreManagerActionDiff['riskClass'];
  workspaceId: string;
  scopeHash: string | null;
  affectedSkuCount: number;
  affectedSkus: string[];
  beforeAfter?: StoreManagerActionDiff['beforeAfter'];
  filesTouched?: StoreManagerActionDiff['filesTouched'];
  changeSet?: StoreManagerActionDiff['changeSet'];
  networkActivity?: StoreManagerActionDiff['networkActivity'];
  evidenceRefs?: string[];
  stateHashes?: Record<string, string>;
  now?: () => Date;
}

/**
 * Build a bounded, validated action diff. Affected SKUs are truncated at the
 * schema bound with an explicit flag; unknown dimensions are typed values
 * (`networkActivity.kind === 'unknown'`, `changeSet: null`), never omitted.
 * Returns null when the assembled shape fails the strict schema (fail closed
 * rather than emitting a malformed preview).
 */
export function buildStoreManagerActionDiff(input: BuildActionDiffInput): StoreManagerActionDiff | null {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const boundedSkus = input.affectedSkus.slice(0, 200);
  const candidate = {
    schemaVersion: 1 as const,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    riskClass: input.riskClass,
    workspaceId: input.workspaceId,
    scopeHash: input.scopeHash,
    affectedSkuCount: input.affectedSkuCount,
    affectedSkus: boundedSkus,
    affectedSkusTruncated: input.affectedSkus.length > 200,
    beforeAfter: (input.beforeAfter ?? []).slice(0, 50),
    filesTouched: (input.filesTouched ?? []).slice(0, 100),
    changeSet: input.changeSet ?? null,
    networkActivity: input.networkActivity ?? { kind: 'unknown', note: 'Adapter did not estimate network activity.' },
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 50),
    stateHashes: input.stateHashes ?? {},
    generatedAt: now,
  };
  // The content hash must be stable across time: generatedAt is excluded so
  // the checkpoint-time diff and the dispatch-time recompute match whenever
  // the underlying catalog state is unchanged.
  const { generatedAt: _generatedAt, ...stableFields } = candidate;
  const diff = { ...candidate, diffHash: computeActionDiffHash(stableFields) };
  const parsed = StoreManagerActionDiffSchema.safeParse(diff);
  return parsed.success ? parsed.data : null;
}

/**
 * Compute the deterministic preview diff for a persistent adapter.
 * Returns null when the adapter has no preview provider (should not happen:
 * the registry refuses persistent adapters without one) or when the diff
 * fails validation.
 */
export async function computeAdapterPreviewDiff(
  adapter: StoreManagerToolAdapter,
  input: Record<string, unknown>,
  ctx: StoreManagerAdapterContext,
): Promise<StoreManagerActionDiff | null> {
  if (!adapter.previewDiff) return null;
  try {
    const diff = await adapter.previewDiff(input, ctx);
    if (!diff) return null;
    const parsed = StoreManagerActionDiffSchema.safeParse(diff);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Compare the recomputed preview with the approval-bound diff hash. Returns
 * 'fresh' on match, 'stale' on mismatch, and 'unbound' when no approval-bound
 * hash was recorded for this tool call (fresh deterministic preview at
 * dispatch is then authoritative for chat; playbook checkpoints always bind).
 */
export function checkDiffStaleness(
  recomputed: StoreManagerActionDiff | null,
  boundDiffHash: string | null | undefined,
): 'fresh' | 'stale' | 'unbound' {
  if (recomputed === null) return 'stale'; // fail closed: no valid fresh preview
  if (boundDiffHash === undefined || boundDiffHash === null) return 'unbound';
  return recomputed.diffHash === boundDiffHash ? 'fresh' : 'stale';
}

/** Generate a deterministic tool-call id for a playbook step execution. */
export function playbookToolCallId(runId: string, stepId: string): string {
  return `pb-${hashCanonicalJson({ runId, stepId }).slice(0, 24)}`;
}
