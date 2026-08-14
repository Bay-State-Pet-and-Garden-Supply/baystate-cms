/**
 * Store Manager bulk-review service (operations console, Issue 8).
 *
 * Homogeneous deterministic bulk review:
 *  - `deriveBulkReviewGroup`: READ-ONLY server derivation of one homogeneous
 *    group over individually persisted proposals. Group key = {field,
 *    normalizationKind, ruleVersion, evidenceKey} (+ workspace); eligibility
 *    is fail-closed (deterministic casing/whitespace/audit-proven separator,
 *    manualReviewRequired = false, status proposed, bounded).
 *  - `previewBulkReviewBatch`: persists an IMMUTABLE batch header + per-item
 *    snapshots/digests (approval binds the exact set) + the deterministic
 *    diff hash.
 *  - `revalidateBulkReviewBatch`: compares current proposal digests to the
 *    preview digests so the UI can label stale batches.
 *  - `applyBulkReviewBatch`: ONE transaction; revalidates EVERY item and SKU
 *    against current authoritative state; ANY mismatch refuses the whole
 *    batch (rollback, no partial). Staging goes through the existing Change
 *    Set draft path (autosaveDraft) — never direct catalog/Git/ShopSite
 *    writes. Per-item audit: one decision row + one proposal status
 *    transition + one Change Set item reference + one runtime event per item.
 *  - `denyBulkReviewBatch`: per-item denied decisions, zero catalog effect.
 *
 * No network/model/ShopSite calls. The service is DB/repo-only (plus the
 * existing product draft service). Flags gate execution (bulkReviewEnabled &&
 * !killSwitch), mirroring the schedule/playbook posture.
 */

import { getDb } from '../../db/connection';
import { hashCanonicalJson } from '../../shared/stable-id';
import { getStoreManagerFlags } from '../../store-manager/flags';
import {
  BULK_REVIEW_ELIGIBLE_KINDS,
  type BulkReviewEligibleKind,
  type StoreManagerBulkReviewApplyResult,
  type StoreManagerBulkReviewBatch,
  type StoreManagerBulkReviewGroup,
  type StoreManagerBulkReviewItem,
  type StoreManagerBulkReviewPreviewRequest,
  type StoreManagerBulkReviewPreviewResult,
} from '../../shared/schemas/store-manager-bulk-review';
import {
  findProposalById,
  listProposals,
  updateProposalStatus,
  computeProposalDigest,
} from '../../db/repositories/catalog-health-proposal-repo';
import {
  computeBulkReviewGroupKey,
  createBulkReviewBatch,
  findBulkReviewBatch,
  insertBulkReviewDecision,
  listBulkReviewBatchItems,
  updateBulkReviewBatchStatus,
  updateBulkReviewItemDecision,
} from '../../db/repositories/store-manager-bulk-review-repo';
import { createStoreManagerArtifact } from '../../store-manager/runtime/artifacts';
import { createStoreManagerRunArtifact } from '../../db/repositories/store-manager-session-repo';
import { findActiveChangeSet, createChangeSet } from '../../db/repositories/change-set-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { autosaveDraft, getProductWithDraft } from './product-service';
import type { StoreManagerRuntimeEvent } from '../../store-manager/runtime/contracts';

/** Thrown when the bulk-review surface is disabled (flag or kill switch). */
export class BulkReviewDisabledError extends Error {
  constructor(message = 'Bulk review is disabled (flag or kill switch).') {
    super(message);
    this.name = 'BulkReviewDisabledError';
  }
}

/** Structured bulk-review failure. `code` maps to an HTTP status by routes. */
export class BulkReviewError extends Error {
  readonly code:
    | 'not_found'
    | 'already_decided'
    | 'empty_group'
    | 'stale'
    | 'ineligible'
    | 'invalid_request'
    | 'disabled'
    | 'apply_failed';
  constructor(code: BulkReviewError['code'], message: string) {
    super(message);
    this.name = 'BulkReviewError';
    this.code = code;
  }
}

function requireEnabled(): void {
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.bulkReviewEnabled) {
    throw new BulkReviewDisabledError();
  }
}

/** True when a proposal is eligible for homogeneous bulk review. */
export function isBulkReviewEligible(proposal: {
  source: string;
  status: string;
  manualReviewRequired: boolean;
  normalizationKind: string | null;
  ruleVersion: string | null;
  evidenceKey: string | null;
}): boolean {
  if (proposal.source !== 'deterministic') return false;
  if (proposal.status !== 'proposed') return false;
  if (proposal.manualReviewRequired) return false;
  if (!proposal.normalizationKind) return false;
  if (!BULK_REVIEW_ELIGIBLE_KINDS.includes(proposal.normalizationKind as BulkReviewEligibleKind)) {
    return false;
  }
  if (!proposal.ruleVersion) return false;
  if (!proposal.evidenceKey) return false;
  return true;
}

/**
 * READ-ONLY derivation of one homogeneous group. Never persists anything.
 * The group is keyed by {field, normalizationKind, ruleVersion, evidenceKey};
 * every member must be workspace-owned, deterministic, proposed, non-manual,
 * and carry the same rule/evidence identity. Ambiguity (multiple evidence
 * classes under one field) is refused rather than widened.
 */
export function deriveBulkReviewGroup(
  workspaceId: string,
  request: StoreManagerBulkReviewPreviewRequest,
): StoreManagerBulkReviewGroup {
  requireEnabled();
  const maxItems = request.maxItems ?? 200;
  const kindFilter = request.normalizationKind
    ? [request.normalizationKind as BulkReviewEligibleKind]
    : ([...BULK_REVIEW_ELIGIBLE_KINDS] as BulkReviewEligibleKind[]);

  const all = listProposals(workspaceId, { field: request.field, status: 'proposed' });
  const eligible = all.filter(
    (p) => p.source === 'deterministic' && p.status === 'proposed' && !p.manualReviewRequired,
  );

  // Fail closed on ambiguity: refuse to guess which evidence class the caller
  // means. A group must be uniform over the FULL selection.
  const classes = new Map<string, { kind: BulkReviewEligibleKind; ruleVersion: string; evidenceKey: string; count: number }>();
  const exclusions: Array<{ proposalId: string; reason: string }> = [];

  for (const p of eligible) {
    const kind = p.normalizationKind as BulkReviewEligibleKind | null;
    if (!kind || !kindFilter.includes(kind)) {
      exclusions.push({ proposalId: p.id, reason: `normalization kind is not bulk-eligible (${p.normalizationKind ?? 'unknown'})` });
      continue;
    }
    if (!p.ruleVersion || !p.evidenceKey) {
      exclusions.push({ proposalId: p.id, reason: 'missing deterministic rule/evidence metadata' });
      continue;
    }
    if (p.affectedSkus.length === 0) {
      exclusions.push({ proposalId: p.id, reason: 'no affected Product SKUs' });
      continue;
    }
    const key = `${kind}|${p.ruleVersion}|${p.evidenceKey}`;
    const existing = classes.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      classes.set(key, { kind, ruleVersion: p.ruleVersion, evidenceKey: p.evidenceKey, count: 1 });
    }
  }

  if (classes.size === 0) {
    throw new BulkReviewError('empty_group', 'No homogeneous bulk-eligible proposals found for this field.');
  }
  // Uniform evidence class required: one field/kind may hold several rules
  // (e.g. casing + whitespace); each rule+evidence class is its own group.
  let chosen: { kind: BulkReviewEligibleKind; ruleVersion: string; evidenceKey: string; count: number } | null = null;
  if (kindFilter.length === 1 && classes.size === 1) {
    const only = classes.values().next().value;
    if (only) chosen = only;
  } else {
    // Multiple classes: pick deterministically (most items, then stable key)
    // and EXPLICITLY exclude the rest so the operator sees what was refused.
    const ordered = [...classes.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
    chosen = ordered[0][1];
  }
  if (!chosen) {
    throw new BulkReviewError('empty_group', 'No homogeneous bulk-eligible proposals found for this field.');
  }
  const chosenKey = `${chosen.kind}|${chosen.ruleVersion}|${chosen.evidenceKey}`;

  const members: Array<{ id: string; oldValue: string; newValue: string; affectedSkus: string[] }> = [];
  for (const p of all) {
    if (p.source !== 'deterministic' || p.status !== 'proposed') {
      exclusions.push({ proposalId: p.id, reason: p.status === 'proposed' ? `source is ${p.source}` : `status is ${p.status}` });
      continue;
    }
    const key = `${p.normalizationKind ?? ''}|${p.ruleVersion ?? ''}|${p.evidenceKey ?? ''}`;
    if (key === chosenKey) {
      members.push({ id: p.id, oldValue: p.oldValue, newValue: p.newValue, affectedSkus: p.affectedSkus });
    } else if (key !== '||') {
      const kind = p.normalizationKind as BulkReviewEligibleKind | null;
      exclusions.push({
        proposalId: p.id,
        reason:
          kind && !BULK_REVIEW_ELIGIBLE_KINDS.includes(kind)
            ? `manual review required (${kind})`
            : 'different rule/evidence class than the selected group',
      });
    }
  }
  // Legacy/unknown rows (missing metadata) also excluded.
  for (const p of all) {
    if (!p.normalizationKind || !p.ruleVersion || !p.evidenceKey) {
      if (!exclusions.some((e) => e.proposalId === p.id)) {
        exclusions.push({ proposalId: p.id, reason: 'legacy row without deterministic metadata (ineligible)' });
      }
    }
  }
  // Manual-review-required + AI rows excluded.
  for (const p of all) {
    if (p.source === 'ai') {
      if (!exclusions.some((e) => e.proposalId === p.id)) {
        exclusions.push({ proposalId: p.id, reason: 'AI/confidence proposals never enter bulk review' });
      }
    } else if (p.manualReviewRequired && p.normalizationKind && p.ruleVersion && p.evidenceKey) {
      if (!exclusions.some((e) => e.proposalId === p.id)) {
        exclusions.push({ proposalId: p.id, reason: `manual review required (${p.normalizationKind})` });
      }
    }
  }

  // Deterministic order + hard cap. Truncation is explicit (never silent).
  const sorted = members
    .map((m) => {
      const proposal = all.find((p) => p.id === m.id)!;
      return { ...m, digest: computeProposalDigest(proposal) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const truncated = sorted.length > maxItems;
  const selected = sorted.slice(0, maxItems);

  const distinctSkus = new Set<string>();
  for (const m of selected) {
    for (const sku of m.affectedSkus) distinctSkus.add(sku);
  }

  return {
    workspaceId,
    field: request.field,
    normalizationKind: chosen.kind,
    ruleVersion: chosen.ruleVersion,
    evidenceKey: chosen.evidenceKey,
    proposalCount: selected.length,
    distinctSkuCount: distinctSkus.size,
    beforeAfterSamples: selected.slice(0, 50).map((m) => ({
      oldValue: m.oldValue.slice(0, 1000),
      newValue: m.newValue.slice(0, 1000),
      affectedCount: m.affectedSkus.length,
    })),
    exclusions: exclusions.slice(0, 500),
    truncated,
    maxItems,
  };
}

/**
 * Persist one immutable batch preview for a derived group. The diff hash
 * content-addresses the exact item set (approval binds these digests).
 * READ path plus a single immutable write; no catalog effect.
 */
export function previewBulkReviewBatch(
  workspaceId: string,
  request: StoreManagerBulkReviewPreviewRequest,
  createdBy = 'operator',
): StoreManagerBulkReviewPreviewResult {
  requireEnabled();
  const group = deriveBulkReviewGroup(workspaceId, request);
  const items = listProposals(workspaceId, { field: group.field, status: 'proposed' })
    .filter((p) => {
      const key = `${p.normalizationKind ?? ''}|${p.ruleVersion ?? ''}|${p.evidenceKey ?? ''}`;
      return key === `${group.normalizationKind}|${group.ruleVersion}|${group.evidenceKey}`;
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, group.proposalCount);

  const affectedSkus: string[] = [];
  for (const item of items) {
    for (const sku of item.affectedSkus) affectedSkus.push(sku);
  }
  const distinctSkuCount = new Set(affectedSkus).size;

  // Deterministic diff fingerprint over the exact selected set.
  const diffPayload = {
    toolName: 'bulk_apply_stored_proposals',
    toolVersion: 1,
    groupKey: computeBulkReviewGroupKey({
      workspaceId,
      field: group.field,
      normalizationKind: group.normalizationKind,
      ruleVersion: group.ruleVersion,
      evidenceKey: group.evidenceKey,
    }),
    field: group.field,
    normalizationKind: group.normalizationKind,
    ruleVersion: group.ruleVersion,
    evidenceKey: group.evidenceKey,
    proposalIds: items.map((i) => i.id),
    itemDigests: items.map((i) => computeProposalDigest(i)),
    affectedSkuCount: distinctSkuCount,
  };
  const diffHash = hashCanonicalJson(diffPayload);
  const groupKey = diffPayload.groupKey;

  const batch = createBulkReviewBatch({
    workspaceId,
    groupKey,
    field: group.field,
    normalizationKind: group.normalizationKind,
    ruleVersion: group.ruleVersion,
    evidenceKey: group.evidenceKey,
    distinctSkuCount,
    diffHash,
    createdBy,
    items: items.map((i) => ({
      proposalId: i.id,
      field: i.field,
      oldValue: i.oldValue,
      newValue: i.newValue,
      affectedSkus: i.affectedSkus,
      itemDigest: computeProposalDigest(i),
    })),
  });

  const activeChangeSet = findActiveChangeSet(workspaceId);
  return {
    ok: true,
    batch,
    items: listBulkReviewBatchItems(workspaceId, batch.id),
    group,
    diffHash,
    diffSummary: {
      affectedSkuCount: distinctSkuCount,
      proposalCount: items.length,
      beforeAfterSamples: group.beforeAfterSamples,
      filesTouched: items
        .flatMap((i) => i.affectedSkus.slice(0, 100))
        .slice(0, 100)
        .map((sku) => `products/${sku}.json`),
      changeSetCurrentState: activeChangeSet?.status ?? null,
      changeSetExpectedState: 'draft',
      networkActivity: 'none',
    },
  };
}

/**
 * Revalidate a persisted batch against CURRENT proposal digests. Fresh only
 * when every item still exists, is proposed, deterministic, non-manual, same
 * evidence class, and its digest matches. Any drift marks the whole batch
 * stale (the apply path refuses it — the UI never shows a stale batch as
 * actionable).
 */
export function revalidateBulkReviewBatch(
  workspaceId: string,
  batchId: string,
): { fresh: boolean; reason: string | null; currentProposalCount: number } {
  const batch = findBulkReviewBatch(workspaceId, batchId);
  if (!batch) throw new BulkReviewError('not_found', 'Bulk review batch not found in this workspace.');
  if (batch.status !== 'pending') {
    return { fresh: false, reason: `batch is already ${batch.status}`, currentProposalCount: 0 };
  }
  const items = listBulkReviewBatchItems(workspaceId, batchId);
  let currentProposalCount = 0;
  for (const item of items) {
    const proposal = findProposalById(workspaceId, item.proposalId);
    if (!proposal) return { fresh: false, reason: `proposal ${item.proposalId} no longer exists`, currentProposalCount };
    currentProposalCount += 1;
    if (proposal.status !== 'proposed') return { fresh: false, reason: `proposal ${item.proposalId} is ${proposal.status}`, currentProposalCount };
    if (!isBulkReviewEligible(proposal)) return { fresh: false, reason: `proposal ${item.proposalId} is no longer bulk-eligible`, currentProposalCount };
    if (proposal.normalizationKind !== batch.normalizationKind || proposal.ruleVersion !== batch.ruleVersion || proposal.evidenceKey !== batch.evidenceKey) {
      return { fresh: false, reason: `proposal ${item.proposalId} changed rule/evidence class`, currentProposalCount };
    }
    if (computeProposalDigest(proposal) !== item.itemDigest) {
      return { fresh: false, reason: `proposal ${item.proposalId} mapping changed`, currentProposalCount };
    }
  }
  return { fresh: true, reason: null, currentProposalCount };
}

interface BulkReviewRunHooks {
  emit?: (event: StoreManagerRuntimeEvent) => void;
  sessionId?: string;
  turnId?: string;
}

/**
 * Apply one persisted batch to the active Change Set in ONE transaction.
 *
 * Revalidates EVERY item (workspace ownership, status, eligibility, digest,
 * rule/evidence identity) and EVERY affected SKU against current
 * authoritative state BEFORE any draft write. Any mismatch throws and the
 * whole transaction rolls back — no partial hidden approval. Per item: one
 * proposal status transition, one decision row, one Change Set item
 * reference, one runtime event. After commit, an authoritative per-SKU
 * verification diff is produced and stored as a run artifact.
 */
export function applyBulkReviewBatch(
  workspaceId: string,
  workspacePath: string,
  batchId: string,
  actor: string,
  runId?: string,
  hooks?: BulkReviewRunHooks,
): StoreManagerBulkReviewApplyResult {
  requireEnabled();
  const db = getDb();
  const batch = findBulkReviewBatch(workspaceId, batchId);
  if (!batch) throw new BulkReviewError('not_found', 'Bulk review batch not found in this workspace.');
  if (batch.status !== 'pending') {
    throw new BulkReviewError('already_decided', `Bulk review batch is already ${batch.status}.`);
  }
  const items = listBulkReviewBatchItems(workspaceId, batchId);
  if (items.length === 0) throw new BulkReviewError('empty_group', 'Bulk review batch has no items.');

  const nowIso = () => new Date().toISOString();
  const emit = hooks?.emit ?? (() => undefined);

  let result: StoreManagerBulkReviewApplyResult;
  try {
    result = db.transaction(() => {
      // Phase 1: revalidate the FULL set before any side effect.
      for (const item of items) {
        const proposal = findProposalById(workspaceId, item.proposalId);
        if (!proposal) {
          throw new BulkReviewError('stale', `Proposal ${item.proposalId} is missing; batch refused (no changes made).`);
        }
        if (proposal.status !== 'proposed') {
          throw new BulkReviewError('stale', `Proposal ${item.proposalId} is ${proposal.status}; batch refused (no changes made).`);
        }
        if (!isBulkReviewEligible(proposal)) {
          throw new BulkReviewError('ineligible', `Proposal ${item.proposalId} is no longer bulk-eligible; batch refused (no changes made).`);
        }
        if (proposal.normalizationKind !== batch.normalizationKind || proposal.ruleVersion !== batch.ruleVersion || proposal.evidenceKey !== batch.evidenceKey) {
          throw new BulkReviewError('stale', `Proposal ${item.proposalId} changed rule/evidence class; batch refused (no changes made).`);
        }
        if (computeProposalDigest(proposal) !== item.itemDigest) {
          throw new BulkReviewError('stale', `Proposal ${item.proposalId} changed after the preview; refresh and re-approve (no changes made).`);
        }
        for (const sku of proposal.affectedSkus) {
          const productWithDraft = getProductWithDraft(workspaceId, workspacePath, sku);
          if (!productWithDraft.merged && !productWithDraft.approved) {
            throw new BulkReviewError(
              'stale',
              `Proposal ${item.proposalId} references SKU "${sku}" that is not present in the current workspace; batch refused (no changes made).`,
            );
          }
        }
      }

      // Phase 2: stage every item through the existing Change Set draft path.
      let lastChangeSetId = '';
      const itemResults: Array<{ proposalId: string; status: 'applied' | 'skipped'; decisionId: string | null; changeSetItemRef: string | null }> = [];
      for (const item of items) {
        const proposal = findProposalById(workspaceId, item.proposalId)!;
        let modifiedAny = false;
        for (const sku of proposal.affectedSkus) {
          const productWithDraft = getProductWithDraft(workspaceId, workspacePath, sku);
          const currentVal = productWithDraft.merged?.customFields?.[proposal.field];
          if (currentVal === proposal.newValue) continue;
          const res = autosaveDraft(workspaceId, workspacePath, sku, {
            customFields: { [proposal.field]: proposal.newValue },
          });
          lastChangeSetId = res.changeSetId;
          modifiedAny = true;
        }
        // Mark the proposal applied even when all SKUs were already correct.
        let targetChangeSetId = lastChangeSetId;
        if (!targetChangeSetId) {
          const activeCs = findActiveChangeSet(workspaceId);
          if (activeCs) {
            targetChangeSetId = activeCs.id;
          } else {
            const ws = findWorkspace();
            const baseCommit = ws?.baselineCommit ?? 'unknown';
            targetChangeSetId = createChangeSet({ workspaceId, title: `Bulk ${batch.field} (${batch.normalizationKind})`, baseCommit }).id;
          }
        }
        const updated = updateProposalStatus(workspaceId, proposal.id, 'applied', targetChangeSetId);
        if (!updated) {
          throw new BulkReviewError('apply_failed', `Proposal ${proposal.id} could not be updated in the current workspace.`);
        }
        updateBulkReviewItemDecision(workspaceId, batchId, proposal.id, 'applied', actor, targetChangeSetId);
        const decision = insertBulkReviewDecision({
          workspaceId,
          batchId,
          proposalId: proposal.id,
          decision: 'applied',
          actor,
          runId: runId ?? null,
          diffHash: batch.diffHash,
          changeSetItemRef: targetChangeSetId,
        });
        itemResults.push({
          proposalId: proposal.id,
          status: modifiedAny ? 'applied' : 'skipped',
          decisionId: decision.id,
          changeSetItemRef: targetChangeSetId,
        });
        emit({
          version: 1,
          type: 'artifact_created',
          sessionId: hooks?.sessionId ?? 'bulk',
          workspaceId,
          turnId: hooks?.turnId ?? 'bulk',
          createdAt: nowIso(),
          artifactId: `bulk:${batchId}:item:${proposal.id}`,
          kind: 'outcome',
          contentHash: decision.id,
        });
      }

      if (!lastChangeSetId) {
        // Every SKU already had the target value; still bind a Change Set.
        const activeCs = findActiveChangeSet(workspaceId);
        if (activeCs) lastChangeSetId = activeCs.id;
        else {
          const ws = findWorkspace();
          const baseCommit = ws?.baselineCommit ?? 'unknown';
          lastChangeSetId = createChangeSet({ workspaceId, title: `Bulk ${batch.field} (${batch.normalizationKind})`, baseCommit }).id;
        }
      }
      updateBulkReviewBatchStatus(workspaceId, batchId, 'applied');

      const appliedCount = itemResults.filter((r) => r.status === 'applied').length;
      const skippedCount = itemResults.filter((r) => r.status === 'skipped').length;
      return {
        ok: true as const,
        batchId,
        status: 'applied' as const,
        appliedCount,
        skippedCount,
        changeSetId: lastChangeSetId,
        items: itemResults,
        verification: null,
        message: `${appliedCount} applied, ${skippedCount} already correct; Change Set ${lastChangeSetId} staged.`,
      };
    })();
  } catch (err) {
    if (err instanceof BulkReviewError) throw err;
    throw new BulkReviewError('apply_failed', err instanceof Error ? err.message : 'Bulk apply failed; nothing changed.');
  }

  // Phase 3 (post-commit): authoritative per-SKU verification reads.
  const perSku: Array<{ sku: string; status: 'verified' | 'error'; note?: string }> = [];
  const verifiedSkus = new Set<string>();
  for (const item of items) {
    const proposal = findProposalById(workspaceId, item.proposalId);
    if (!proposal) continue;
    for (const sku of proposal.affectedSkus) {
      if (verifiedSkus.has(sku)) continue;
      verifiedSkus.add(sku);
      const productWithDraft = getProductWithDraft(workspaceId, workspacePath, sku);
      const currentVal = productWithDraft.merged?.customFields?.[proposal.field];
      if (currentVal === proposal.newValue) {
        perSku.push({ sku, status: 'verified' });
      } else {
        perSku.push({ sku, status: 'error', note: 'draft does not contain the expected value' });
      }
    }
  }
  const perSkuTruncated = perSku.length > 200;
  const verification = {
    verifiedSkuCount: verifiedSkus.size,
    perSku: perSku.slice(0, 200),
    perSkuTruncated,
    verificationHash: hashCanonicalJson({ batchId, perSku: perSku.slice(0, 200) }),
  };
  // Persist the verification diff as a durable run artifact.
  if (runId) {
    try {
      const artifact = createStoreManagerArtifact({
        runId,
        workspaceId,
        kind: 'verification_diff',
        schemaVersion: 1,
        content: { batchId, toolName: 'bulk_apply_stored_proposals', verification },
      });
      createStoreManagerRunArtifact({
        workspaceId,
        runId,
        kind: artifact.kind,
        schemaVersion: artifact.schemaVersion,
        contentJson: JSON.stringify({ batchId, toolName: 'bulk_apply_stored_proposals', verification }),
        contentHash: artifact.contentHash,
        id: artifact.id,
        createdAt: artifact.createdAt,
      });
      emit({
        version: 1,
        type: 'verification_diff',
        sessionId: hooks?.sessionId ?? 'bulk',
        workspaceId,
        turnId: hooks?.turnId ?? 'bulk',
        createdAt: nowIso(),
        artifactId: artifact.id,
        diffHash: verification.verificationHash,
      });
    } catch {
      // Verification is informational for the operator; a storage failure
      // must never fail-closed a committed Change Set.
    }
  }
  return { ...result, verification };
}

/**
 * Deny one pending batch: records per-item denied decisions and marks the
 * batch denied. Zero catalog effect. Gated by flags like apply.
 */
export function denyBulkReviewBatch(
  workspaceId: string,
  batchId: string,
  actor: string,
  runId?: string,
  reason?: string,
): { batchId: string; status: 'denied'; itemCount: number; reason?: string } {
  requireEnabled();
  const db = getDb();
  const batch = findBulkReviewBatch(workspaceId, batchId);
  if (!batch) throw new BulkReviewError('not_found', 'Bulk review batch not found in this workspace.');
  if (batch.status !== 'pending') {
    throw new BulkReviewError('already_decided', `Bulk review batch is already ${batch.status}.`);
  }
  const items = listBulkReviewBatchItems(workspaceId, batchId);
  db.transaction(() => {
    for (const item of items) {
      updateBulkReviewItemDecision(workspaceId, batchId, item.proposalId, 'denied', actor, null);
      insertBulkReviewDecision({
        workspaceId,
        batchId,
        proposalId: item.proposalId,
        decision: 'denied',
        actor,
        runId: runId ?? null,
        diffHash: batch.diffHash,
        changeSetItemRef: null,
      });
    }
    updateBulkReviewBatchStatus(workspaceId, batchId, 'denied');
  })();
  return { batchId, status: 'denied', itemCount: items.length, ...(reason ? { reason } : {}) };
}

export type { StoreManagerBulkReviewBatch, StoreManagerBulkReviewItem, StoreManagerBulkReviewGroup };
