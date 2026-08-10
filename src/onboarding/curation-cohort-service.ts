/**
 * Curation cohort service (issue #30, PR2 — candidate cohort formation +
 * readiness).
 *
 * Responsibilities:
 * - `refreshCandidateCohorts(workspaceId, batchId)` — idempotently refresh the
 *   batch's candidate cohorts (grouping + supersede-on-change in the repo) and
 *   transition their status to `waiting`/`ready` from the extraction
 *   completeness contract.
 * - `evaluateCohortReadiness(...)` — the "Extraction completeness contract":
 *   source finalized + extraction completed + PI import done + evidence hash
 *   computed (packaging OCR is informational and non-blocking in this round;
 *   it finalizes lazily inside per-SKU curation and gates at PR3). Failed
 *   members produce a deterministic `blocked` state instead of a wait.
 * - `getDerivedCohortStateForItem(item, items?)` — derived "Waiting for N
 *   family members to finish Extraction" state for the Pipeline Board;
 *   callers may pass the already-loaded batch items to avoid an extra load.
 * - `transitionCohortToReadyIfComplete(...)` — ready transition only; no
 *   claiming/execution yet (PR3).
 *
 * Items stay in `curation / pending` while siblings wait; `needs_input` is
 * never used for sibling waiting (issue #30, "Curation readiness barrier").
 */
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import {
  refreshCandidateCohorts as repoRefreshCandidateCohorts,
  listCohortsByBatch,
  getCohortById,
  getCohortMembers,
  getActiveCohortForItem,
  updateCohortStatus,
  computeExtractionHash,
} from '../db/repositories/curation-cohort-repo';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import {
  GROUPING_VERSION,
} from '../shared/schemas/cohorts';
import type {
  CohortWaitingOnItem,
  CurationCohort,
  CurationCohortMember,
  CurationCohortView,
  DerivedCohortStateForItem,
  ReadinessState,
} from '../shared/schemas/cohorts';

export { GROUPING_VERSION };

// ─── Item-level extraction readiness (completeness contract) ──────────────────

export interface ItemExtractionReadiness {
  ready: boolean;
  /** Derived state: `blocked` when the member failed in a pipeline stage. */
  state: ReadinessState;
  blockedReason: string | null;
  sourceFinalized: boolean;
  extractionCompleted: boolean;
  ocrSettled: boolean;
  piImported: boolean;
  extractionHashComputed: boolean;
}

/**
 * A member counts as Curation-ready only when its semantic evidence is stable
 * enough to freeze (issue #30, "Extraction completeness contract"):
 * - selected source state finalized — a persisted `source_url` AND Discovery
 *   completion (advanced past discovery, or `discovery/completed`); a
 *   `sourcingDecision` is the distributor-evidence path, not the ordinary
 *   spreadsheet-import path;
 * - extraction stage completed (or the item advanced beyond extraction);
 * - a Product Intelligence import, when attached, is present;
 * - a current source/evidence hash can be computed.
 *
 * Packaging OCR is informational, not blocking, in this round: OCR finalizes
 * lazily during per-SKU curation and must not gate candidate readiness until
 * PR3 pulls OCR forward (`ocrSettled` is reported for visibility only). A
 * member that failed in Discovery/Extraction/Curation is deterministically
 * `blocked` (never a wait).
 */
export function evaluateItemReadiness(item: OnboardingItem): ItemExtractionReadiness {
  const extractionCompleted = hasCompletedExtraction(item);
  const ocrSettled = isOcrSettled(item);
  const piImported = isPiImportComplete(item);
  const sourceFinalized = isSourceFinalized(item);
  const extractionHashComputed = computeExtractionHash(item) != null;
  const blocked = isFailedMember(item);
  const ready = sourceFinalized && extractionCompleted && piImported && extractionHashComputed;
  const state: ReadinessState = blocked ? 'blocked' : ready ? 'ready' : 'waiting';
  return {
    ready,
    state,
    blockedReason: ready ? null : blocked ? buildMemberFailedReason(item) : buildBlockedReason({ sourceFinalized, extractionCompleted, piImported, extractionHashComputed }),
    sourceFinalized,
    extractionCompleted,
    ocrSettled,
    piImported,
    extractionHashComputed,
  };
}

/**
 * Canonical "selected source state finalized" check:
 * - ordinary spreadsheet path: a persisted `source_url` plus Discovery
 *   completion (the item advanced past discovery, or it is still in discovery
 *   with `discovery/completed`);
 * - distributor-evidence path: a `sourcingDecision` present (alternative).
 */
function isSourceFinalized(item: OnboardingItem): boolean {
  const discoveryFinalized = item.stage !== 'discovery' || item.stageStatus === 'completed';
  return (Boolean(item.sourceUrl) && discoveryFinalized) || item.sourcingDecision != null;
}

/** A member that failed inside Discovery/Extraction/Curation is deterministically
 *  blocked, not waiting (issue #30 round-2 F5). */
function isFailedMember(item: OnboardingItem): boolean {
  return ['discovery', 'extraction', 'curation'].includes(item.stage) && item.stageStatus === 'failed';
}

function buildMemberFailedReason(item: OnboardingItem): string {
  return `Member failed (SKU: ${item.upc ?? ''})`;
}

/** Extraction is complete when the item finished the extraction stage — i.e. it
 *  is `extraction / completed`, or it has advanced to a later stage (which is
 *  only possible from a completed extraction) and still carries extraction data.
 *  The worker refresh runs right after extraction completes AND during curation
 *  polling, so cohorts must stay stable after items advance. */
function hasCompletedExtraction(item: OnboardingItem): boolean {
  if (item.stage === 'extraction') {
    return item.stageStatus === 'completed' && item.extractionData != null;
  }
  return ['curation', 'review', 'promotion'].includes(item.stage) && item.extractionData != null;
}

/** OCR is settled when structured OCR data exists or the OCR attempt reached a
 *  terminal outcome (`succeeded | disabled | failed | no_image`). `no_image`
 *  is terminal — there is no package image to OCR. `skipped` stays unsettled:
 *  it can represent an unperformed operation and is under scrutiny for PR3's
 *  evidence freeze. OCR remains informational (non-blocking) for candidate
 *  readiness in this round. */
function isOcrSettled(item: OnboardingItem): boolean {
  const extractionData = item.extractionData;
  if (!extractionData) return false;
  if (extractionData.packagingOcrData) return true;
  const status = extractionData.ocrOutcome?.status;
  if (!status) return false;
  return status === 'succeeded' || status === 'disabled' || status === 'failed' || status === 'no_image';
}

/** A PI import, when attached, is complete when every evidence entry carries a
 *  run id + result hash + import record id. Nothing attached → trivially done. */
function isPiImportComplete(item: OnboardingItem): boolean {
  const evidence = item.extractionData?.productIntelligenceEvidence ?? [];
  if (evidence.length === 0) return true;
  return evidence.every(entry => Boolean(entry.runId && entry.resultHash && entry.importRecordId));
}

function buildBlockedReason(checks: {
  sourceFinalized: boolean;
  extractionCompleted: boolean;
  piImported: boolean;
  extractionHashComputed: boolean;
}): string {
  const parts: string[] = [];
  if (!checks.sourceFinalized) parts.push('selected source not finalized');
  if (!checks.extractionCompleted) parts.push('extraction not completed');
  if (!checks.piImported) parts.push('Product Intelligence import not completed');
  if (!checks.extractionHashComputed) parts.push('evidence hash not computed');
  return parts.join('; ');
}

// ─── Cohort readiness ──────────────────────────────────────────────────────────

export interface CohortReadinessEvaluation {
  /** Persisted-status mapping: `ready` when every member is ready, otherwise `waiting`. */
  status: 'ready' | 'waiting';
  /** Derived UI state: `blocked` when any member failed (issue #30 round-2 F5). */
  state: ReadinessState;
  blockedReason: string | null;
  waitingOn: CohortWaitingOnItem[];
  readyCount: number;
  memberCount: number;
}

export function evaluateCohortReadiness(
  _cohort: CurationCohort,
  members: CurationCohortMember[],
  items: OnboardingItem[],
): CohortReadinessEvaluation {
  const itemsById = new Map(items.map(item => [item.id, item]));
  const readinessByMember = new Map<string, ItemExtractionReadiness>();
  const notReady = members.filter(member => {
    const item = itemsById.get(member.onboardingItemId);
    const readiness: ItemExtractionReadiness = item
      ? evaluateItemReadiness(item)
      : {
          ready: false,
          state: 'waiting',
          blockedReason: 'member item not found',
          sourceFinalized: false,
          extractionCompleted: false,
          ocrSettled: false,
          piImported: false,
          extractionHashComputed: false,
        };
    readinessByMember.set(member.onboardingItemId, readiness);
    return !readiness.ready;
  });

  const blockedMembers = members.filter(member => readinessByMember.get(member.onboardingItemId)?.state === 'blocked');

  const waitingOn = notReady
    .map(member => {
      const item = itemsById.get(member.onboardingItemId);
      return {
        itemId: member.onboardingItemId,
        upc: item?.upc ?? member.productSku ?? '',
        name: item?.name ?? '',
      };
    });

  const state: ReadinessState = blockedMembers.length > 0 ? 'blocked' : notReady.length === 0 ? 'ready' : 'waiting';
  const blockedReason = state === 'blocked'
    ? buildBlockedMembersReason(blockedMembers, itemsById)
    : notReady.length === 0
      ? null
      : `Waiting for ${notReady.length} family member${notReady.length === 1 ? '' : 's'} to finish Extraction`;

  return {
    status: notReady.length === 0 ? 'ready' : 'waiting',
    state,
    blockedReason,
    waitingOn,
    readyCount: members.length - notReady.length,
    memberCount: members.length,
  };
}

/** Deterministic blocked text for one or more failed members. */
function buildBlockedMembersReason(blockedMembers: CurationCohortMember[], itemsById: Map<string, OnboardingItem>): string {
  return blockedMembers
    .map(member => {
      const item = itemsById.get(member.onboardingItemId);
      const sku = item?.upc ?? member.productSku ?? member.onboardingItemId;
      return `Member failed (SKU: ${sku})`;
    })
    .join('; ');
}

// ─── Refresh / transition ──────────────────────────────────────────────────────

/**
 * Idempotently refresh candidate cohorts for a batch and align their status to
 * the current extraction completeness contract. Safe to call on every
 * extraction completion and on every curation poll. Returns the active
 * candidate cohorts for the batch.
 */
export function refreshCandidateCohorts(workspaceId: string, batchId: string): CurationCohort[] {
  const items = listItemsByBatch(batchId);
  const cohorts = repoRefreshCandidateCohorts(workspaceId, batchId, items);
  for (const cohort of cohorts) {
    // Candidate states (forming/waiting/ready) are re-aligned to the current
    // evidence. Execution states (running/completed/failed/conflicted) and
    // superseded rows are never rewritten here — PR3+ owns them.
    if (!['forming', 'waiting', 'ready'].includes(cohort.status)) continue;
    const members = getCohortMembers(cohort.id);
    const evaluation = evaluateCohortReadiness(cohort, members, items);
    if (evaluation.status === 'ready') {
      updateCohortStatus(cohort.id, 'ready', { blockedReason: null });
    } else {
      updateCohortStatus(cohort.id, 'waiting', { blockedReason: evaluation.blockedReason ?? null });
    }
  }
  return listCohortsByBatch(batchId);
}

/**
 * Transition a cohort to `ready` when every member's extraction evidence is
 * complete. No claiming or execution happens here — that is PR3+.
 *
 * Guard: only `forming | waiting` cohorts may move to `ready`. Running,
 * completed, failed, conflicted, and superseded cohorts are never moved back
 * to `ready` (issue #30 round-2 F6).
 *
 * @returns true when the cohort was transitioned to `ready`.
 */
export function transitionCohortToReadyIfComplete(cohortId: string): boolean {
  const cohort = getCohortById(cohortId);
  if (!cohort) return false;
  if (cohort.status !== 'forming' && cohort.status !== 'waiting') return false;
  const members = getCohortMembers(cohortId);
  const items = listItemsByBatch(cohort.batchId);
  const evaluation = evaluateCohortReadiness(cohort, members, items);
  if (evaluation.status === 'ready') {
    updateCohortStatus(cohortId, 'ready', { blockedReason: null });
    return true;
  }
  return false;
}

// ─── Derived per-item / cohort state (API + UI) ───────────────────────────────

export function getDerivedCohortStateForItem(item: OnboardingItem, items?: OnboardingItem[]): DerivedCohortStateForItem {
  const cohort = getActiveCohortForItem(item.id);
  if (!cohort) {
    return {
      cohortId: null,
      groupKey: null,
      groupLabel: null,
      status: null,
      state: null,
      blockedReason: null,
      waitingOn: [],
      memberCount: 0,
      readyCount: 0,
    };
  }
  // Callers that already loaded the batch items pass them in (per-item callers
  // should not re-load the whole batch for readiness alone); fall back to a
  // full batch load otherwise so existing call sites keep working.
  const batchItems = items ?? listItemsByBatch(item.batchId);
  const members = getCohortMembers(cohort.id);
  const evaluation = evaluateCohortReadiness(cohort, members, batchItems);
  return {
    cohortId: cohort.id,
    groupKey: cohort.groupKey,
    groupLabel: cohort.groupLabel,
    status: cohort.status,
    state: evaluation.state,
    blockedReason: evaluation.blockedReason,
    // All family members still producing evidence — the "Waiting for N family
    // members to finish Extraction" state (a member's own pending extraction
    // is part of the family wait).
    waitingOn: evaluation.waitingOn,
    memberCount: evaluation.memberCount,
    readyCount: evaluation.readyCount,
  };
}

/**
 * Build the API view for one active candidate cohort: per-member extraction
 * readiness plus cohort-level derived waiting state.
 */
export function buildCohortView(cohort: CurationCohort, items: OnboardingItem[]): CurationCohortView {
  const members = getCohortMembers(cohort.id);
  const itemsById = new Map(items.map(item => [item.id, item]));
  const evaluation = evaluateCohortReadiness(cohort, members, items);

  const memberViews = members.map(member => {
    const item = itemsById.get(member.onboardingItemId);
    const readiness = item
      ? evaluateItemReadiness(item)
      : { ready: false, state: 'waiting' as const, blockedReason: 'member item not found' };
    return {
      onboardingItemId: member.onboardingItemId,
      productSku: member.productSku,
      normalizedBrand: member.normalizedBrand,
      normalizedNameStem: member.normalizedNameStem,
      extractionHash: member.extractionHash,
      ordinal: member.ordinal,
      item: {
        id: member.onboardingItemId,
        upc: item?.upc ?? member.productSku ?? '',
        name: item?.name ?? '',
      },
      ready: readiness.ready,
      state: readiness.state,
      blockedReason: readiness.ready ? null : readiness.blockedReason,
      waitingOn: evaluation.waitingOn.filter(entry => entry.itemId !== member.onboardingItemId),
    };
  });

  return {
    cohort,
    members: memberViews,
    status: cohort.status,
    state: evaluation.state,
    blockedReason: evaluation.blockedReason,
    memberCount: evaluation.memberCount,
    readyCount: evaluation.readyCount,
    waitingOn: evaluation.waitingOn,
  };
}

/**
 * List active candidate cohort views for a batch (used by
 * `GET /api/onboarding/batches/:id/cohorts`).
 */
export function listCandidateCohortViews(batchId: string): CurationCohortView[] {
  const items = listItemsByBatch(batchId);
  return listCohortsByBatch(batchId).map(cohort => buildCohortView(cohort, items));
}
