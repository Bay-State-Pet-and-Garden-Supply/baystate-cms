// ---------------------------------------------------------------------------
// Manager Inbox service (operations console, Issue 3)
//
// Reconciliation is the single deterministic upsert path: it re-derives the
// authoritative candidate set, inserts new findings, refreshes still-present
// findings (acknowledgement retained), resolves disappeared findings, and
// re-opens previously resolved findings whose fingerprint changed. Cached
// counts are NEVER the authority — opening an item re-reads current state.
// The model has no tool path here; only operators via API routes.
// ---------------------------------------------------------------------------

import {
  collectInboxCandidates,
  type InboxCandidate,
  type InboxCollectorContext,
} from './store-manager-inbox-collectors';
import {
  getInboxItem,
  getInboxItemByDedupeKey,
  insertInboxItem,
  updateInboxItemContent,
  reopenInboxItem,
  resolveInboxItemAsDisappeared,
  acknowledgeInboxItem,
  resolveInboxItem,
  listInboxItems,
  type InboxCandidateInput,
} from '../../db/repositories/store-manager-inbox-repo';
import type {
  StoreManagerInboxItem,
  StoreManagerInboxLifecycle,
  StoreManagerInboxOpenResult,
} from '../../shared/schemas/store-manager-inbox';

function candidateToInput(candidate: InboxCandidate): InboxCandidateInput {
  return {
    kind: candidate.kind,
    dedupeKey: candidate.dedupeKey,
    severity: candidate.severity,
    title: candidate.title,
    summary: candidate.summary,
    scopeJson: JSON.stringify(candidate.scope),
    count: candidate.count,
    sourceRefsJson: JSON.stringify(candidate.sourceRefs),
    fingerprint: candidate.fingerprint,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
  };
}

export interface ReconcileInboxResult {
  inserted: number;
  refreshed: number;
  reopened: number;
  resolved: number;
  items: StoreManagerInboxItem[];
}

/**
 * Reconcile the inbox against the current authoritative state. Idempotent:
 * repeated scans converge to the same rows. Never mutates onboarding or any
 * catalog source.
 */
export function reconcileInbox(
  workspaceId: string,
  ctx: InboxCollectorContext = {},
): ReconcileInboxResult {
  const candidates = collectInboxCandidates(workspaceId, ctx);
  const byDedupe = new Map(candidates.map((c) => [c.dedupeKey, c]));
  const current = listInboxItems(workspaceId, { limit: 200 });

  let inserted = 0;
  let refreshed = 0;
  let reopened = 0;
  let resolved = 0;

  for (const row of current) {
    const candidate = byDedupe.get(row.dedupeKey);
    if (!candidate) {
      // Finding disappeared from the authoritative source.
      if (row.lifecycle === 'open' || row.lifecycle === 'acknowledged') {
        if (resolveInboxItemAsDisappeared(workspaceId, row.id)) resolved += 1;
      }
      byDedupe.delete(row.dedupeKey);
      continue;
    }
    if (candidate.fingerprint === row.fingerprint) {
      if (row.lifecycle === 'resolved' && row.resolvedReason === 'disappeared') {
        // The finding disappeared and then reappeared identically — a NEW
        // occurrence. Re-open so the operator sees it again.
        if (reopenInboxItem(workspaceId, row.id, candidateToInput(candidate))) reopened += 1;
      } else {
        // Same finding: keep lifecycle (acknowledgement retained), refresh timestamps.
        if (updateInboxItemContent(workspaceId, row.id, candidateToInput(candidate))) refreshed += 1;
      }
    } else if (row.lifecycle === 'resolved' || row.lifecycle === 'superseded') {
      // Reappeared with a new fingerprint → re-open (stays auditable).
      if (reopenInboxItem(workspaceId, row.id, candidateToInput(candidate))) reopened += 1;
    } else {
      // Changed finding while open/acknowledged: refresh content, keep lifecycle.
      if (updateInboxItemContent(workspaceId, row.id, candidateToInput(candidate))) refreshed += 1;
    }
    byDedupe.delete(candidate.dedupeKey);
  }

  for (const candidate of byDedupe.values()) {
    insertInboxItem(workspaceId, candidateToInput(candidate));
    inserted += 1;
  }

  return {
    inserted,
    refreshed,
    reopened,
    resolved,
    items: listInboxItems(workspaceId, { limit: 200 }),
  };
}

/**
 * Open an Inbox item and re-validate it against the CURRENT authoritative
 * source. A stale item stays auditable but is flagged `isCurrent: false` and
 * must never be treated as current authority or used to approve work.
 */
export function openInboxItem(workspaceId: string, itemId: string): StoreManagerInboxOpenResult | null {
  const item = getInboxItem(workspaceId, itemId);
  if (!item) return null;
  const currentCandidate = collectInboxCandidates(workspaceId).find((c) => c.dedupeKey === item.dedupeKey) ?? null;
  const current: StoreManagerInboxItem | null = currentCandidate
    ? {
        id: item.id,
        workspaceId,
        kind: currentCandidate.kind,
        dedupeKey: currentCandidate.dedupeKey,
        severity: currentCandidate.severity,
        title: currentCandidate.title,
        summary: currentCandidate.summary,
        scope: currentCandidate.scope,
        count: currentCandidate.count,
        sourceRefs: currentCandidate.sourceRefs,
        fingerprint: currentCandidate.fingerprint,
        lifecycle: item.lifecycle,
        sourceUpdatedAt: currentCandidate.sourceUpdatedAt,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        acknowledgedAt: item.acknowledgedAt,
        resolvedAt: item.resolvedAt,
        supersededAt: item.supersededAt,
        resolvedReason: item.resolvedReason,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }
    : null;
  return {
    item,
    current,
    isCurrent: !!currentCandidate && currentCandidate.fingerprint === item.fingerprint,
  };
}

/** Operator acknowledge (open → acknowledged). No catalog effect. */
export function acknowledgeInboxItemForWorkspace(workspaceId: string, itemId: string): StoreManagerInboxItem | null {
  if (!getInboxItem(workspaceId, itemId)) return null;
  acknowledgeInboxItem(workspaceId, itemId);
  return getInboxItem(workspaceId, itemId);
}

/** Operator resolve (open/acknowledged → resolved). No catalog effect. */
export function resolveInboxItemForWorkspace(workspaceId: string, itemId: string): StoreManagerInboxItem | null {
  if (!getInboxItem(workspaceId, itemId)) return null;
  resolveInboxItem(workspaceId, itemId);
  return getInboxItem(workspaceId, itemId);
}

export function listInboxItemsForWorkspace(
  workspaceId: string,
  opts: { lifecycle?: StoreManagerInboxLifecycle | null; limit?: number } = {},
): StoreManagerInboxItem[] {
  return listInboxItems(workspaceId, opts);
}

/** Find an open/acknowledged item by dedupe key (notification linking). */
export function findActiveInboxItemByDedupeKey(workspaceId: string, dedupeKey: string): StoreManagerInboxItem | null {
  const row = getInboxItemByDedupeKey(workspaceId, dedupeKey);
  if (!row) return null;
  return row.lifecycle === 'open' || row.lifecycle === 'acknowledged' ? row : null;
}
