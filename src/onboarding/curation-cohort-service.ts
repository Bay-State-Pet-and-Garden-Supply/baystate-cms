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
 *   source finalized + extraction completed + OCR settled + PI import done +
 *   evidence hash computed.
 * - `getDerivedCohortStateForItem(item)` — derived "Waiting for N family
 *   members to finish Extraction" state for the Pipeline Board.
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
} from '../shared/schemas/cohorts';

export { GROUPING_VERSION };

// ─── Item-level extraction readiness (completeness contract) ──────────────────

export interface ItemExtractionReadiness {
  ready: boolean;
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
 * - selected source state finalized (`sourcingDecision` present);
 * - extraction stage completed (or the item advanced beyond extraction);
 * - packaging OCR outcome settled (`packagingOcrData` present, or
 *   `ocrOutcome.status` in `succeeded | disabled | failed` — failed OCR still
 *   counts as settled, only unresolved OCR blocks);
 * - a Product Intelligence import, when attached, is present;
 * - a current source/evidence hash can be computed.
 */
export function evaluateItemReadiness(item: OnboardingItem): ItemExtractionReadiness {
  const extractionCompleted = hasCompletedExtraction(item);
  const ocrSettled = isOcrSettled(item);
  const piImported = isPiImportComplete(item);
  const sourceFinalized = item.sourcingDecision != null;
  const extractionHashComputed = computeExtractionHash(item) != null;
  const ready = sourceFinalized && extractionCompleted && ocrSettled && piImported && extractionHashComputed;
  return {
    ready,
    blockedReason: ready ? null : buildBlockedReason({ sourceFinalized, extractionCompleted, ocrSettled, piImported, extractionHashComputed }),
    sourceFinalized,
    extractionCompleted,
    ocrSettled,
    piImported,
    extractionHashComputed,
  };
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
 *  terminal outcome (`succeeded | disabled | failed`). `skipped`/`no_image`
 *  are treated as unresolved. */
function isOcrSettled(item: OnboardingItem): boolean {
  const extractionData = item.extractionData;
  if (!extractionData) return false;
  if (extractionData.packagingOcrData) return true;
  const status = extractionData.ocrOutcome?.status;
  if (!status) return false;
  return status === 'succeeded' || status === 'disabled' || status === 'failed';
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
  ocrSettled: boolean;
  piImported: boolean;
  extractionHashComputed: boolean;
}): string {
  const parts: string[] = [];
  if (!checks.sourceFinalized) parts.push('sourcing decision not finalized');
  if (!checks.extractionCompleted) parts.push('extraction not completed');
  if (!checks.ocrSettled) parts.push('packaging OCR not settled');
  if (!checks.piImported) parts.push('Product Intelligence import not completed');
  if (!checks.extractionHashComputed) parts.push('evidence hash not computed');
  return parts.join('; ');
}

// ─── Cohort readiness ──────────────────────────────────────────────────────────

export interface CohortReadinessEvaluation {
  status: 'ready' | 'waiting';
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
  const notReady = members.filter(member => {
    const item = itemsById.get(member.onboardingItemId);
    if (!item) return true;
    return !evaluateItemReadiness(item).ready;
  });

  const waitingOn = notReady
    .map(member => {
      const item = itemsById.get(member.onboardingItemId);
      return {
        itemId: member.onboardingItemId,
        upc: item?.upc ?? member.productSku ?? '',
        name: item?.name ?? '',
      };
    });

  return {
    status: notReady.length === 0 ? 'ready' : 'waiting',
    blockedReason:
      notReady.length === 0
        ? null
        : `Waiting for ${notReady.length} family member${notReady.length === 1 ? '' : 's'} to finish Extraction`,
    waitingOn,
    readyCount: members.length - notReady.length,
    memberCount: members.length,
  };
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
    if (cohort.status !== 'forming' && cohort.status !== 'waiting') continue;
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
 * @returns true when the cohort was transitioned to `ready`.
 */
export function transitionCohortToReadyIfComplete(cohortId: string): boolean {
  const cohort = getCohortById(cohortId);
  if (!cohort) return false;
  const members = getCohortMembers(cohortId);
  const items = listItemsByBatch(cohort.batchId);
  const evaluation = evaluateCohortReadiness(cohort, members, items);
  if (evaluation.status === 'ready' && cohort.status !== 'ready') {
    updateCohortStatus(cohortId, 'ready', { blockedReason: null });
    return true;
  }
  return false;
}

// ─── Derived per-item / cohort state (API + UI) ───────────────────────────────

export function getDerivedCohortStateForItem(item: OnboardingItem): DerivedCohortStateForItem {
  const cohort = getActiveCohortForItem(item.id);
  if (!cohort) {
    return {
      cohortId: null,
      groupKey: null,
      groupLabel: null,
      status: null,
      blockedReason: null,
      waitingOn: [],
      memberCount: 0,
      readyCount: 0,
    };
  }
  const items = listItemsByBatch(item.batchId);
  const members = getCohortMembers(cohort.id);
  const evaluation = evaluateCohortReadiness(cohort, members, items);
  return {
    cohortId: cohort.id,
    groupKey: cohort.groupKey,
    groupLabel: cohort.groupLabel,
    status: cohort.status,
    blockedReason: cohort.status === 'ready' ? null : evaluation.blockedReason,
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
  const notReadyIds = new Set(evaluation.waitingOn.map(entry => entry.itemId));

  const memberViews = members.map(member => {
    const item = itemsById.get(member.onboardingItemId);
    const readiness = item ? evaluateItemReadiness(item) : { ready: false, blockedReason: 'member item not found' };
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
      blockedReason: readiness.ready ? null : readiness.blockedReason,
      waitingOn: evaluation.waitingOn.filter(entry => entry.itemId !== member.onboardingItemId && notReadyIds.has(entry.itemId)),
    };
  });

  return {
    cohort,
    members: memberViews,
    status: cohort.status,
    blockedReason: cohort.status === 'ready' ? null : evaluation.blockedReason,
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
