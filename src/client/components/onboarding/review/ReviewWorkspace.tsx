/**
 * Epic #46 — Rapid Review workspace (Phase 6).
 *
 * Batch Workspace tab: the primary human QA surface. Every Curation-complete
 * product must be reviewed before approval. Dense queue (left) + persistent
 * inspector (right); `Looks Good & Next` marks the product durably reviewed
 * and immediately opens the next unreviewed product — hundreds of items
 * without returning to the board.
 *
 * Server is the source of truth: queue + progress come from the work-state
 * projection; durable review writes go through `completeReviewStage`; edits
 * through `updateItem` (which invalidates durable review server-side);
 * proposal decisions through `submitDecisions`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getBatchWorkState,
  subscribeBatchEvents,
} from '../../../onboarding-work-api';
import { completeReviewStage, getItemDetail, moveToPreviousStage, submitDecisions, updateItem, updateItemMedia, type ItemDetailResponse } from '../../../onboarding-api';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';
import {
  activeFilterChips,
  applyQueueFilters,
  countActiveQueueFilters,
  distinctBrands,
  distinctFamilies,
  findNextQueuedItem,
  findNextReviewTarget,
  findPreviousReviewTarget,
  formatReviewProgress,
  hasActiveQueueFilters,
  removeFilterChip,
  countGateBlockedItems,
  buildLegacyListingUpdatePayload,
  pruneQueueSelection,
  reviewProgress,
  reviewableSelectionIds,
  selectAllVisible,
  sortForReview,
  toggleGroupSelection,
  toggleQueueSelection,
  warningInfoFromDetail,
  type ReviewQueueFilters,
} from './review-logic';
import type { ReviewDraft, ReviewInspectorItem } from './review-types';
import type { SourceType, ReviewCompletenessWarningCode, MediaSelectionRequest } from '../../../../shared/schemas/onboarding';
import { getOnboardingFeatureFlags } from '../../../onboarding-feature-flags';
import { buildListingUpdatePayload } from './review-editability';
import {
  applyServerBlockers,
  deriveReadiness,
  diffEffectiveValues,
  effectiveGateValues,
  fieldBlockerCodes,
  focusJumpTarget,
  isDraftDirty,
  jumpTargetFor,
  parseBlockersFromRejection,
  type EffectiveGateValues,
  type GateValueDiffRow,
} from './review-readiness';
import { ReviewQueue } from './ReviewQueue';
import { ReviewIdentityPanel } from './ReviewIdentityPanel';
import { ReviewPagesPanel } from './ReviewPagesPanel';
import { ReviewListingPanel } from './ReviewListingPanel';
import { ReviewClassificationPanel } from './ReviewClassificationPanel';
import { ReviewWarningsPanel } from './ReviewWarningsPanel';
import { ReviewReadinessPanel } from './ReviewReadinessPanel';
import { ReviewConfirmStep, shouldOpenConfirmStep } from './ReviewConfirmStep';
import { ReviewActions } from './ReviewActions';
import './review.css';

const QUEUE_PAGE_SIZE = 500;
const ENRICH_CHUNK = 24;
const REFRESH_DEBOUNCE_MS = 900;

export interface ReviewWorkspaceProps {
  batchId: string;
}

export function ReviewWorkspace({ batchId }: ReviewWorkspaceProps) {
  // ── Queue state (server projection) ─────────────────────────────────────
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [total, setTotal] = useState(0);
  const [reviewedTotal, setReviewedTotal] = useState(0);
  const [optimisticReviewed, setOptimisticReviewed] = useState(0);
  const [queueState, setQueueState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [queueError, setQueueError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Filters / facets ────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ReviewQueueFilters>({});

  // ── Bulk review selection (epic #46 follow-up, phase 4) ─────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);


  // ── Session tracking ────────────────────────────────────────────────────
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [warnedIds, setWarnedIds] = useState<Set<string>>(() => new Set());

  // ── Current inspector item ──────────────────────────────────────────────
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [details, setDetails] = useState<Map<string, ItemDetailResponse>>(() => new Map());
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(() => new Map());
  const [inflight, setInflight] = useState<Set<string>>(() => new Set());

  // ── Actions ─────────────────────────────────────────────────────────────
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set());
  const [busyDecisionId, setBusyDecisionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [allReviewed, setAllReviewed] = useState(false);

  // ── Editing state ───────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── V2 review surface state (e10s02/e10s03; inert while flag off) ──────
  // Flag computed once per mount — Vite env flags are static per build.
  const v2 = useMemo(() => getOnboardingFeatureFlags().reviewUiV2, []);
  /** Pre-edit seed of the active draft — dirty detection base. */
  const draftSeedRef = useRef<ReviewDraft | null>(null);
  /** First-edit effective gate values per item id (confirm-step baseline). */
  const baselineRef = useRef<Map<string, EffectiveGateValues>>(new Map());
  /** Structured blocker codes from a rejected review-complete call. */
  const [rejectedBlockers, setRejectedBlockers] = useState<string[] | null>(null);
  /** Pending confirm-step diff (open ⇒ modal visible). */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<GateValueDiffRow[]>([]);
  const [confirmWarnings, setConfirmWarnings] = useState<
    ReviewCompletenessWarningCode[]
  >([]);

  // ── Lightbox ────────────────────────────────────────────────────────────
  const [lightbox, setLightbox] = useState<{ url: string; caption: string } | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneIds = useRef<Set<string>>(new Set());
  const queueVersionRef = useRef(0);
  /** Set by keyboard navigation so the active row receives DOM focus
   *  (visible :focus-visible ring follows arrow-key selection). */
  const keyboardNavRef = useRef(false);

  // Keyboard focus follow: after an arrow-key selection, move DOM focus to the
  // active queue row so the focus ring and screen-reader position track it.
  useEffect(() => {
    if (!keyboardNavRef.current || !currentItemId) return;
    keyboardNavRef.current = false;
    document.getElementById(currentItemId)?.focus();
  }, [currentItemId]);

  // ── Queue loading ───────────────────────────────────────────────────────
  const loadQueue = useCallback(
    async (opts?: { silent?: boolean }) => {
      const generation = ++queueVersionRef.current;
      if (!opts?.silent) setQueueState('loading');
      setQueueError(null);
      try {
        const [all, reviewed] = await Promise.all([
          getBatchWorkState(batchId, { category: 'ready_for_review', limit: QUEUE_PAGE_SIZE }),
          getBatchWorkState(batchId, {
            category: 'ready_for_review',
            reviewState: 'reviewed',
            limit: 1,
          }),
        ]);
        if (generation !== queueVersionRef.current) return;
        setItems(all.items);
        setTotal(all.total);
        setReviewedTotal(reviewed.total);
        setOptimisticReviewed(0);
        setQueueState('ready');
        doneIds.current = new Set<string>();
      } catch (err) {
        if (generation !== queueVersionRef.current) return;
        setQueueError(err instanceof Error ? err.message : 'Failed to load review queue');
        setQueueState('error');
      }
    },
    [batchId],
  );

  // Load the next page of the server-projection queue and append (audit M7).
  // The base set is all `ready_for_review` items; client-side filters remain
  // applied over the loaded pool. `total` is server-authoritative.
  const loadMoreQueue = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getBatchWorkState(batchId, {
        category: 'ready_for_review',
        limit: QUEUE_PAGE_SIZE,
        offset: items.length,
      });
      const seen = new Set(items.map(i => i.itemId));
      const added = res.items.filter(i => !seen.has(i.itemId));
      if (added.length > 0) {
        setItems(prev => [...prev, ...added]);
      }
      setTotal(res.total);
    } catch (err) {
      // Non-fatal: the loaded pool is already usable; counts stay intact.
      console.warn('[ReviewWorkspace] Load-more failed:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [batchId, items, loadingMore]);

  // Initial load + reselect on batch change.
  useEffect(() => {
    setCurrentItemId(null);
    setDetails(new Map());
    setDetailErrors(new Map());
    setInflight(new Set());
    setEditedIds(new Set());
    setWarnedIds(new Set());
    setEditing(false);
    setDraft(null);
    setAllReviewed(false);
    doneIds.current = new Set<string>();
    void loadQueue();
  }, [loadQueue]);

  // SSE-driven refresh (debounced) — counts + queue stay live.
  useEffect(() => {
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadQueue({ silent: true });
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [batchId, loadQueue]);

  // Dirty-draft guard (impeccable polish): an unsaved edit draft must never
  // die silently to a tab close/refresh. Item-switching within the workspace
  // is already guarded by selectItem → attemptCancelEdit; the SSE refresh
  // path only replaces queue rows and never evicts the actively-edited
  // item's detail cache, so the open draft cannot be clobbered by it.
  const draftDirty = v2 && editing && isDraftDirty(draftSeedRef.current, draft);
  useEffect(() => {
    if (!draftDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome requires returnValue; legacy convention.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draftDirty]);

  // ── Enrichment: load item details for queue rows in parallel chunks ─────
  const sortedAll = useMemo(() => sortForReview(items), [items]);

  const ensureDetails = useCallback(
    async (ids: string[]) => {
      const missing = ids.filter(id => {
        if (details.has(id) || detailErrors.has(id) || inflight.has(id)) return false;
        return true;
      });
      if (missing.length === 0) return;
      setInflight(prev => new Set([...prev, ...missing]));
      for (let i = 0; i < missing.length; i += ENRICH_CHUNK) {
        const chunk = missing.slice(i, i + ENRICH_CHUNK);
        const results = await Promise.all(
          chunk.map(async id => {
            try {
              return { id, detail: await getItemDetail(id), error: null as string | null };
            } catch (err) {
              return { id, detail: null as ItemDetailResponse | null, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );
        setDetails(prev => {
          const next = new Map(prev);
          for (const r of results) if (r.detail) next.set(r.id, r.detail);
          return next;
        });
        setDetailErrors(prev => {
          const next = new Map(prev);
          for (const r of results) if (r.error) next.set(r.id, r.error);
          return next;
        });
        // Recompute warned ids from the enriched cache.
        setWarnedIds(prevWarned => {
          const next = new Set(prevWarned);
          for (const r of results) {
            if (r.detail) {
              const info = warningInfoFromDetail(r.detail);
              if (info.blocked || info.messages.length > 0) next.add(r.id);
              else next.delete(r.id);
            }
          }
          return next;
        });
      }
      setInflight(prev => {
        const next = new Set(prev);
        for (const id of missing) next.delete(id);
        return next;
      });
    },
    [details, detailErrors, inflight],
  );

  // Enrich the visible (filtered) queue.
  useEffect(() => {
    if (items.length === 0) return;
    void ensureDetails(items.map(i => i.itemId));
  }, [items, ensureDetails]);

  // Immediate detail load when the current item changes.
  useEffect(() => {
    if (!currentItemId) {
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      return;
    }
    // V2: per-item confirm/rejection state never leaks across items.
    setRejectedBlockers(null);
    setConfirmOpen(false);
    setPendingDiff([]);
    setActionError(null);
    void ensureDetails([currentItemId]);
  }, [currentItemId, ensureDetails]);

  // Auto-select the first unreviewed item once the queue is ready.
  useEffect(() => {
    if (queueState !== 'ready' || currentItemId) return;
    if (sortedAll.length === 0) {
      // Nothing to review yet (or all items already reviewed) — the queue
      // pane shows the friendly empty state; do not claim 'all reviewed'.
      setAllReviewed(false);
      return;
    }
    const target = findNextReviewTarget(sortedAll, null, doneIds.current);
    if (target) setCurrentItemId(target.itemId);
    else setAllReviewed(true);
  }, [queueState, sortedAll.length]);

  // ── Derived view ─────────────────────────────────────────────────────────
  const filteredItems = useMemo(
    () => applyQueueFilters(sortedAll, filters, { editedIds, warnedIds }),
    [sortedAll, filters, editedIds, warnedIds],
  );

  // Prune the bulk-review selection whenever the queue reloads.
  useEffect(() => {
    setSelectedIds(prev => pruneQueueSelection(prev, items.map(i => i.itemId)));
  }, [items]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // GPT review (MEDIUM): the modal count and the submitted payload must be
  // the SAME set — only selected ids that are unreviewed AND in the visible
  // (filtered) queue are submitted.
  const reviewableSelectedIds = useMemo(
    () => reviewableSelectionIds(selectedIds, filteredItems),
    [selectedIds, filteredItems],
  );
  const reviewableSelected = reviewableSelectedIds.length;

  const handleBulkReview = useCallback(async () => {
    if (reviewableSelectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkNotice(null);
    try {
      const res = await completeReviewStage(reviewableSelectedIds);
      setBulkNotice(
        `${res.count} product${res.count === 1 ? '' : 's'} marked reviewed` +
          (res.classifiedCount !== undefined && res.legacyCount !== undefined
            ? ` (${res.classifiedCount} classified, ${res.legacyCount} legacy)`
            : ''),
      );
      setSelectedIds([]);
      await loadQueue();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      setBulkConfirmOpen(false);
    }
  }, [reviewableSelectedIds, bulkBusy, loadQueue]);

  const progress = useMemo(() => {
    const base = reviewProgress(items, { total, reviewedTotal: reviewedTotal + optimisticReviewed });
    return base;
  }, [items, total, reviewedTotal, optimisticReviewed]);

  const currentWorkState = useMemo(
    () => (currentItemId ? items.find(i => i.itemId === currentItemId) ?? null : null),
    [items, currentItemId],
  );
  const currentInspector: ReviewInspectorItem | null = useMemo(() => {
    if (!currentWorkState) return null;
    return {
      workState: currentWorkState,
      detail: details.get(currentWorkState.itemId) ?? null,
      detailError: detailErrors.get(currentWorkState.itemId) ?? null,
    };
  }, [currentWorkState, details, detailErrors]);

  const facets = useMemo(
    () => ({ brands: distinctBrands(sortedAll), families: distinctFamilies(sortedAll) }),
    [sortedAll],
  );

  // ── Actions ──────────────────────────────────────────────────────────────
  const approveCurrentItem = useCallback(async () => {
    if (!currentWorkState) return;
    const id = currentWorkState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await completeReviewStage([id]);
      // Structured rejection codes consumed — the live snapshot was accurate.
      setRejectedBlockers(null);
      // Optimistic durable state: the item is now reviewed server-side.
      doneIds.current.add(id);
      setItems(prev => prev.map(i => (i.itemId === id ? { ...i, reviewState: 'reviewed' } : i)));
      setOptimisticReviewed(prev => prev + 1);
      const next = findNextReviewTarget(sortForReview(items.map(i => (i.itemId === id ? { ...i, reviewState: 'reviewed' } : i))), id, doneIds.current);
      if (next) {
        setCurrentItemId(next.itemId);
      } else {
        setAllReviewed(true);
        setCurrentItemId(null);
      }
      void loadQueue({ silent: true });
    } catch (err) {
      // e10s03 stale-snapshot handling: structured blocker codes from the
      // authoritative gate are merged into the readiness panel so the
      // reviewer sees exactly which checks now block.
      const codes = v2 ? parseBlockersFromRejection(err, id) : [];
      if (codes.length > 0) {
        setRejectedBlockers(codes);
        setActionError(`Review completion rejected — mandatory checks failed: ${codes.join(', ')}.`);
      } else {
        setActionError(err instanceof Error ? err.message : 'Failed to save review');
      }
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, items, loadQueue, v2]);

  /**
   * Looks Good entry point. V2 order of guards: completeness blockers →
   * blocking warnings → confirm step (only when session-edited AND at least
   * one gate value changed; clean passes short-circuit straight to approve).
   */
  const handleLooksGood = useCallback(async () => {
    if (!currentWorkState) return;
    // Always-editable guard: unsaved draft values are NOT what approval would
    // persist — force an explicit Save (or Cancel) before the gate runs.
    if (v2 && editing && isDraftDirty(draftSeedRef.current, draft)) {
      setActionError('You have unsaved edits — click “Save edits” (or Cancel) before marking reviewed.');
      return;
    }
    const id = currentWorkState.itemId;
    const detail = currentInspector?.detail ?? null;

    if (v2) {
      const readiness = deriveReadiness(detail, currentWorkState);
      const merged = rejectedBlockers
        ? applyServerBlockers(readiness, rejectedBlockers)
        : readiness;
      if (merged.blockers.length > 0) {
        setActionError(
          `Blocked — ${merged.blockers.length} mandatory check${merged.blockers.length === 1 ? '' : 's'} incomplete. Fix them in the readiness checklist first.`,
        );
        return;
      }
    }

    const blocking = warningInfoFromDetail(detail ?? {}).blocked;
    if (blocking) {
      setActionError('This product has blocking warnings. Resolve them before marking it reviewed.');
      return;
    }

    // Confirm step: only for session-edited items with a real value change.
    if (v2) {
      const baseline = baselineRef.current.get(id) ?? null;
      const diff = diffEffectiveValues(
        baseline,
        effectiveGateValues(detail, currentWorkState),
      );
      if (shouldOpenConfirmStep(id, editedIds, diff)) {
        const warnings = deriveReadiness(detail, currentWorkState).warnings;
        setPendingDiff(diff);
        setConfirmWarnings(warnings);
        setConfirmOpen(true);
        return;
      }
    }

    await approveCurrentItem();
  }, [currentWorkState, currentInspector, v2, rejectedBlockers, editedIds, approveCurrentItem]);

  // ── Edit lifecycle ───────────────────────────────────────────────────────
  const beginEdit = useCallback(() => {
    if (!currentInspector) return;
    const id = currentInspector.workState.itemId;
    const item = currentInspector.detail?.item;
    const ext = currentInspector.detail?.extraction ?? item?.extractionData ?? null;
    const cur = item?.curationData;
    const sizeAttr = (ext?.variantAttributes as Record<string, any> | undefined)?.size;
    const seeded: ReviewDraft = {
      curatedTitle: cur?.curatedTitle ?? currentInspector.workState.curatedTitle ?? ext?.title ?? currentInspector.workState.name ?? '',
      brandHint: currentInspector.workState.brand ?? item?.brandHint ?? ext?.brand ?? '',
      // Explicit branches: a '' literal in a ?? chain short-circuits every
      // later fallback, which previously made sizeAttr/workState.weight
      // unreachable when extraction weight was absent.
      curatedWeight:
        cur?.curatedWeight != null && cur.curatedWeight !== ''
          ? cur.curatedWeight
          : ext?.weight != null && ext.weight !== ''
            ? String(ext.weight)
            : typeof sizeAttr === 'string' && sizeAttr !== ''
              ? sizeAttr
              : currentInspector.workState.weight ?? '',
      curatedDescription: cur?.curatedDescription ?? currentInspector.workState.description ?? ext?.description ?? '',
      searchKeywords: cur?.searchKeywords ?? ext?.searchKeywords ?? '',
      // V2: seed price/quantity so the full-field form edits the promotable
      // values (official-page only — distributor rows render them locked/RO).
      ...(v2
        ? {
            price: item?.price ?? '',
            quantity: typeof item?.quantity === 'number' ? String(item.quantity) : '',
          }
        : {}),
    };
    // V2: capture the pre-edit baseline ONCE per session per item so the
    // confirm step diffs against the values before ANY edit this session.
    if (v2 && !baselineRef.current.has(id)) {
      baselineRef.current.set(
        id,
        effectiveGateValues(currentInspector.detail, currentInspector.workState),
      );
    }
    draftSeedRef.current = v2 ? { ...seeded } : null;
    setDraft(seeded);
    setSaveError(null);
    setEditing(true);
  }, [currentInspector, v2]);

  /** Cancel/revert editing. V2 fields are ALWAYS live inputs, so Cancel
   * reverts the draft to its seeded values and stays in the form; legacy
   * mode exits back to the read-only tree. */
  const attemptCancelEdit = useCallback((): boolean => {
    if (v2 && isDraftDirty(draftSeedRef.current, draft)) {
      if (!window.confirm('Discard unsaved changes?')) return false;
    }
    setSaveError(null);
    if (v2) {
      if (draftSeedRef.current) setDraft({ ...draftSeedRef.current });
      return true;
    }
    setEditing(false);
    setDraft(null);
    draftSeedRef.current = null;
    return true;
  }, [v2, draft]);

  /** Guarded item selection: V2 prompts before discarding unsaved edits. */
  const selectItem = useCallback(
    (itemId: string) => {
      if (editing && itemId !== currentItemId) {
        if (!attemptCancelEdit()) return;
      }
      setCurrentItemId(itemId);
    },
    [editing, currentItemId, attemptCancelEdit],
  );

  const moveTo = useCallback(
    (direction: 'next' | 'previous') => {
      const target =
        direction === 'next'
          ? findNextQueuedItem(filteredItems, currentItemId)
          : findPreviousReviewTarget(filteredItems, currentItemId);
      const targetId = target?.itemId ?? null;
      if (targetId === null || targetId === currentItemId) return;
      // V2 dirty guard: navigating away with unsaved edits prompts first.
      selectItem(targetId);
    },
    [filteredItems, currentItemId, selectItem],
  );

  const handleSaveEdit = useCallback(async () => {
    if (!currentInspector || !draft) return;
    const id = currentInspector.workState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setSaveError(null);
    try {
      // V2: the editability matrix builds the payload — the quantity key
      // appears ONLY for official-page items; distributor payloads omit it
      // entirely (server guards + upstream inventory authority). Price is
      // sent for both source types (adjudication — item.price is the only
      // promotion price authority). Flag off ⇒ the pre-epic legacy payload
      // PLUS curatedWeight write-back (V1 renders a Weight editor, so its
      // value must persist); benign vs. instant rollback — convertToLbs is
      // idempotent and the same consequential-invalidation path fires.
      // SourceType derivation PARITY with ReviewListingPanel (post-review fix):
      // falls back to workState so an unloaded/failed detail fetch can never
      // downgrade a distributor row to official-page payload semantics.
      const sourceType: SourceType =
        currentInspector.detail?.item.sourceType === 'distributor_record'
          ? 'distributor_record'
          : ((currentInspector.workState.sourceType as SourceType) ?? 'official_page');
      await updateItem(
        id,
        v2
          ? buildListingUpdatePayload(draft, sourceType)
          : buildLegacyListingUpdatePayload(draft),
      );
      setEditedIds(prev => new Set(prev).add(id));
      setEditing(false);
      setDraft(null);
      draftSeedRef.current = null;
      // Server invalidates durable review on consequential edits; the queue
      // refresh will flip the item back to unreviewed. Reload detail eagerly.
      setDetails(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      void ensureDetails([id]);
      void loadQueue({ silent: true });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentInspector, draft, ensureDetails, loadQueue, v2]);

  // ── V2 always-editable seeding ─────────────────────────────────────────
  // There is no read-only state to return to under V2: the listing fields are
  // live text inputs for the item's whole visit. Seed the draft as soon as a
  // detail is available, and reseed from refreshed server data after each
  // save (handleSaveEdit clears the draft, this effect re-seeds it).
  useEffect(() => {
    if (!v2 || editing || !currentInspector?.detail) return;
    beginEdit();
  }, [v2, editing, currentInspector, beginEdit]);

  // ── e10s04 media selection ─────────────────────────────────────────────
  // Persist the reviewer media selection via the dedicated endpoint (server
  // validates candidate-set union + distributor constraints and performs the
  // consequential-edit invalidation), then refresh detail/queue exactly like
  // handleSaveEdit so readiness + carousel reflect the saved selection.
  const handleSaveMedia = useCallback(async (selection: MediaSelectionRequest) => {
    if (!currentInspector) return;
    const id = currentInspector.workState.itemId;
    await updateItemMedia(id, selection);
    setDetails(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    void ensureDetails([id]);
    void loadQueue({ silent: true });
  }, [currentInspector, ensureDetails, loadQueue]);

  // ── Classification decisions ─────────────────────────────────────────────
  const handleDecision = useCallback(
    async (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => {
      if (!currentInspector) return;
      const id = currentInspector.workState.itemId;
      setBusyDecisionId(proposal.id);
      try {
        await submitDecisions(id, [{ proposalId: proposal.id, decision }]);
        // Reload the detail to reflect the resolved proposal.
        setDetails(prev => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        await ensureDetails([id]);
      } finally {
        setBusyDecisionId(null);
      }
    },
    [currentInspector, ensureDetails],
  );

  const handleUpdatePages = useCallback(
    async (nextPages: string[], correction?: { pageId: string; activePageImportHash: string }) => {
      if (!currentInspector) return;
      const id = currentInspector.workState.itemId;
      const curation = currentInspector.detail?.item?.curationData ?? {};
      setBusyItemIds(prev => new Set(prev).add(id));
      try {
        await updateItem(id, {
          curation_data: {
            ...curation,
            suggestedPages: nextPages,
            // e09 round-3 FIX 1 (adjudication #10): when the reviewer added a
            // VERIFIED page, persist the manual-selection correction record so
            // the review completion gate can resolve an abstained durable
            // Category Page decision. Additive optional key — absent otherwise.
            ...(correction
              ? {
                  correctedCategoryPage: {
                    pageId: correction.pageId,
                    activePageImportHash: correction.activePageImportHash,
                    correctedAt: new Date().toISOString(),
                  },
                }
              : {}),
          },
        });
        setDetails(prev => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        await ensureDetails([id]);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyItemIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [currentInspector, ensureDetails],
  );

  const handleSendToCuration = useCallback(async () => {
    if (!currentWorkState) return;
    // Always-editable guard: sending back discards the draft — require an
    // explicit Save/Cancel decision first.
    if (v2 && editing && isDraftDirty(draftSeedRef.current, draft)) {
      setActionError('You have unsaved edits — click “Save edits” (or Cancel) before sending back to curation.');
      return;
    }
    const id = currentWorkState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await moveToPreviousStage([id]);
      setItems(prev => prev.filter(i => i.itemId !== id));
      const remaining = items.filter(i => i.itemId !== id);
      const next = findNextReviewTarget(sortForReview(remaining), id, doneIds.current);
      if (next) {
        setCurrentItemId(next.itemId);
      } else {
        setCurrentItemId(null);
      }
      void loadQueue({ silent: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send item back to Curation');
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, items, loadQueue]);

  const handleBulkSendToCuration = useCallback(async () => {
    if (selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await moveToPreviousStage(selectedIds);
      setBulkNotice(`${res.moved} item${res.moved === 1 ? '' : 's'} sent back to Curation`);
      setSelectedIds([]);
      await loadQueue();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }, [selectedIds, bulkBusy, loadQueue]);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (lightbox) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setLightbox(null);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!workspaceRef.current?.contains(target ?? document.body)) return;
      if (editing) {
        // V2: Escape cancels editing with a dirty-confirm guard (WCAG —
        // never lose edits silently). Focus inside a field returns early
        // above, so this fires when focus is outside the inputs.
        if (e.key === 'Escape') {
          e.preventDefault();
          attemptCancelEdit();
        }
        return;
      }
      // Escape closes the inspector selection when no lightbox is open (the
      // lightbox branch above already handled Esc there). Functional update
      // keeps this fresh without re-binding on every selection change.
      if (e.key === 'Escape') {
        if (currentItemId !== null) {
          e.preventDefault();
          setCurrentItemId(prev => (prev !== null ? null : prev));
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          keyboardNavRef.current = true;
          moveTo('next');
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          keyboardNavRef.current = true;
          moveTo('previous');
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          void handleLooksGood();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightbox, editing, moveTo, handleLooksGood, currentItemId, attemptCancelEdit]);

  const busy = currentWorkState ? busyItemIds.has(currentWorkState.itemId) : false;

  // ── V2 readiness + jump-to-fix (inert while flag off) ──────────────────
  const readiness = useMemo(
    () =>
      v2 && currentInspector
        ? deriveReadiness(currentInspector.detail, currentInspector.workState)
        : null,
    [v2, currentInspector],
  );
  const mergedReadiness = useMemo(() => {
    if (!v2 || !readiness) return null;
    return rejectedBlockers ? applyServerBlockers(readiness, rejectedBlockers) : readiness;
  }, [v2, readiness, rejectedBlockers]);

  /** Jump-to-fix: enter edit mode for field targets, then move focus. */
  const jumpToFix = useCallback(
    (code: string) => {
      const targetId = jumpTargetFor(code);
      if (!targetId) return;
      const isFieldTarget = targetId.startsWith('rv-edit-');
      if (isFieldTarget && !editing) {
        beginEdit();
      }
      // Wait a frame so edit inputs mount before focus moves.
      requestAnimationFrame(() => {
        focusJumpTarget(targetId);
      });
    },
    [editing, beginEdit],
  );

  /** Bulk-review gating: count selected reviewable items blocked by the gate. */
  const selectedBlockedCount = useMemo(() => {
    if (!v2) return 0;
    return countGateBlockedItems(reviewableSelectedIds, id => {
      const ws = items.find(i => i.itemId === id);
      if (!ws) return null;
      return { detail: details.get(id) ?? null, workState: ws };
    });
  }, [v2, reviewableSelectedIds, items, details]);

  const loadedCount = filteredItems.length;
  const filtersTotal = filteredItems.length;

  // Filters change → always keep a valid selection.
  useEffect(() => {
    if (!currentItemId) return;
    if (filteredItems.some(i => i.itemId === currentItemId)) return;
    const target = findNextReviewTarget(filteredItems, null, doneIds.current);
    setCurrentItemId(target?.itemId ?? null);
  }, [filteredItems]);

  const queueEmptyMessage =
    queueState === 'loading'
      ? 'Loading review queue…'
      : filtersTotal === 0 && hasActiveQueueFilters(filters)
        ? 'No products match the current filters.'
        : 'Nothing to review yet — automation is still working.';

  return (
    <div className="rv-workspace" ref={workspaceRef}>
      {actionError && (
        <div role="alert" className="rv-error-banner">
          {actionError}
        </div>
      )}

      <div className="rv-body">
        <div className="rv-queue-pane">
          <QueueHeader
            filters={filters}
            onChange={setFilters}
            facets={facets}
            progress={progress}
            total={total}
            shownCount={loadedCount}
          />
          {(selectedIds.length > 0 || filters.sourceType === 'distributor_record') && (
            <div className="rv-bulk-bar" role="region" aria-label="Bulk review">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={bulkBusy || filteredItems.length === 0}
                onClick={() =>
                  setSelectedIds(prev =>
                    prev.length === filteredItems.length ? [] : selectAllVisible(filteredItems.map(i => i.itemId)),
                  )
                }
              >
                {selectedIds.length === filteredItems.length && filteredItems.length > 0
                  ? 'Clear selection'
                  : `Select all shown (${filteredItems.length})`}
              </button>
              <span className="rv-bulk-count">
                {selectedIds.length} selected · {reviewableSelected} reviewable
              </span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={bulkBusy || selectedIds.length === 0}
                onClick={() => void handleBulkSendToCuration()}
                title="Send selected items back to Curation stage"
              >
                ↩ Send to Curation ({selectedIds.length})
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={bulkBusy || reviewableSelected === 0 || selectedBlockedCount > 0}
                title={
                  selectedBlockedCount > 0
                    ? `${selectedBlockedCount} of ${reviewableSelected} selected products are missing mandatory fields — fix or deselect them first`
                    : 'Open the confirmation for the selected products'
                }
                onClick={() => setBulkConfirmOpen(true)}
              >
                {selectedBlockedCount > 0
                  ? `Mark reviewed (${reviewableSelected} · ${selectedBlockedCount} blocked)`
                  : `Mark reviewed (${reviewableSelected})`}
              </button>
            </div>
          )}
          {bulkNotice && (
            <div className="rv-bulk-notice" role="status">
              ✓ {bulkNotice}
            </div>
          )}
          {bulkError && (
            <div className="rv-error-banner" role="alert">
              {bulkError}
            </div>
          )}
          {bulkConfirmOpen && (
            <div className="rv-modal-backdrop" role="presentation" onMouseDown={() => setBulkConfirmOpen(false)}>
              <div
                className="rv-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm bulk review"
                onMouseDown={e => e.stopPropagation()}
              >
                <h3 className="rv-modal-title">Mark {reviewableSelected} product{reviewableSelected === 1 ? '' : 's'} reviewed?</h3>
                <p className="rv-modal-body">
                  These products will be durably marked reviewed and moved to the approval
                  queue. Approving never exports anything — export stays a separate step.
                </p>
                <div className="rv-modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setBulkConfirmOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={bulkBusy}
                    onClick={() => void handleBulkReview()}
                  >
                    {bulkBusy ? 'Reviewing…' : `Mark reviewed (${reviewableSelected})`}
                  </button>
                </div>
              </div>
            </div>
          )}
          {queueState === 'error' ? (
            <div className="rv-state-note" role="alert">
              Could not load the review queue: {queueError}
            </div>
          ) : (
            <ReviewQueue
              items={filteredItems}
              currentItemId={currentItemId}
              details={details}
              warnedIds={warnedIds}
              editedIds={editedIds}
              selectedIds={selectedSet}
              onToggleSelected={itemId =>
                setSelectedIds(prev => toggleQueueSelection(prev, itemId))
              }
              onToggleFamilySelected={itemIds =>
                setSelectedIds(prev => toggleGroupSelection(prev, itemIds))
              }
              emptyMessage={queueEmptyMessage}
              onSelect={selectItem}
            />
          )}
          {queueState === 'ready' && total > items.length ? (
            <div className="rv-load-more">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void loadMoreQueue()}
                disabled={loadingMore}
              >
                {loadingMore
                  ? 'Loading more…'
                  : `Load more (${items.length} of ${total} shown)`}
              </button>
            </div>
          ) : null}
        </div>

        <div className="rv-inspector-pane" tabIndex={-1} aria-label="Review inspector">
          {currentInspector ? (
            <div className="rv-inspector-inner">
              {currentInspector.detailError && (
                <div className="rv-error-banner" role="alert">
                  Detail could not be loaded: {currentInspector.detailError}
                </div>
              )}
              <ReviewIdentityPanel workState={currentInspector.workState} detail={currentInspector.detail} />
              <ReviewListingPanel
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                editing={editing}
                draft={draft ?? { curatedTitle: '', brandHint: '', curatedWeight: '', curatedDescription: '', searchKeywords: '' }}
                onDraftChange={setDraft}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => {
                  attemptCancelEdit();
                }}
                showSaveActions={!v2 || draftDirty}
                saving={busy}
                savingMedia={busy}
                saveError={saveError}
                onOpenLightbox={(url, caption) => setLightbox({ url, caption })}
                v2={v2}
                onSaveMedia={v2 ? handleSaveMedia : undefined}
                blockedCodesByField={
                  v2 && mergedReadiness ? fieldBlockerCodes(mergedReadiness.blockers) : undefined
                }
              />
              <ReviewPagesPanel
                detail={currentInspector.detail}
                onUpdatePages={handleUpdatePages}
              />
              <ReviewClassificationPanel
                detail={currentInspector.detail}
                onDecision={handleDecision}
                busyDecisionId={busyDecisionId}
              />
              <ReviewWarningsPanel detail={currentInspector.detail} />
              {v2 && (
                <ReviewReadinessPanel
                  detail={currentInspector.detail}
                  workState={currentInspector.workState}
                  readiness={mergedReadiness ?? undefined}
                  onJumpRequest={jumpToFix}
                />
              )}
              <ReviewActions
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                busy={busy}
                editing={editing}
                allReviewed={allReviewed}
                shortcutKey="G"
                blockers={v2 ? mergedReadiness?.blockers : undefined}
                onLooksGood={() => void handleLooksGood()}
                onPrevious={() => moveTo('previous')}
                onNext={() => moveTo('next')}
                onToggleEdit={v2 ? undefined : () => (editing ? attemptCancelEdit() : beginEdit())}
                onSendToCuration={() => void handleSendToCuration()}
              />
            </div>
          ) : (
            <div className="rv-state-note">
              {allReviewed
                ? 'All products reviewed — ready for bulk approval in the Approved tab.'
                : 'Select a product from the queue to inspect it.'}
            </div>
          )}
        </div>
      </div>

      <KeyboardLegend />

      {lightbox && (
        <Lightbox url={lightbox.url} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}

      {v2 && (
        <ReviewConfirmStep
          open={confirmOpen}
          diffRows={pendingDiff}
          warnings={confirmWarnings}
          busy={busy}
          onApprove={() => {
            setConfirmOpen(false);
            void approveCurrentItem();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Queue header + progress --------------------------------------------------

function QueueHeader({
  filters,
  onChange,
  facets,
  progress,
  total,
  shownCount,
}: {
  filters: ReviewQueueFilters;
  onChange: (f: ReviewQueueFilters) => void;
  facets: { brands: string[]; families: { cohortId: string; label: string }[] };
  progress: ReturnType<typeof reviewProgress>;
  total: number;
  shownCount: number;
}) {
  const pct = progress.total > 0 ? Math.round((progress.reviewedCount / progress.total) * 100) : 0;

  return (
    <div className="rv-queue-header">
      <div className="rv-queue-header-top">
        <div className="rv-progress" role="status" aria-label="Review progress">
          <span className="rv-progress-main">{formatReviewProgress(progress)}</span>
          <span className="rv-progress-sub">
            {progress.remaining} remaining
            {total > shownCount ? ` · showing ${shownCount}` : ''}
          </span>
        </div>

        <FilterControls filters={filters} onChange={onChange} facets={facets} />
      </div>
      <div className="rv-progress-track" aria-hidden="true">
        <div className="rv-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}

// ─── Collapsed filter controls (impeccable polish) ───────────────────────────

const LEGEND_DISMISS_KEY = 'rv-shortcuts-dismissed';

/**
 * Collapsed filter surface: one trigger with an active-count badge opens a
 * popover holding all six controls; applied filters remain visible as
 * removable chips. All filter capabilities and their pure logic are unchanged.
 */
function FilterControls({
  filters,
  onChange,
  facets,
}: {
  filters: ReviewQueueFilters;
  onChange: (f: ReviewQueueFilters) => void;
  facets: { brands: string[]; families: { cohortId: string; label: string }[] };
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeCount = countActiveQueueFilters(filters);
  const chips = activeFilterChips(filters, {
    familyLabel: facets.families.find(f => f.cohortId === filters.familyCohortId)?.label,
  });

  // Close on outside click or Escape (Escape must not bubble into the
  // workspace's item-navigation Esc handler).
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown, true); // capture: beats workspace handler
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const toggle = (key: keyof ReviewQueueFilters, value: boolean) =>
    onChange({ ...filters, [key]: filters[key] ? undefined : value });

  return (
    <div className="rv-filters" role="group" aria-label="Queue filters" ref={containerRef}>
      <button
        type="button"
        className="rv-filter-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(prev => !prev)}
      >
        <span aria-hidden="true">☰</span> Filters
        {activeCount > 0 && (
          <span className="rv-filter-count" aria-label={`${activeCount} active filters`}>
            {activeCount}
          </span>
        )}
      </button>

      {chips.length > 0 && (
        <span className="rv-filter-chips">
          {chips.map(chip => (
            <button
              key={chip.key}
              type="button"
              className="rv-filter-chip-remove"
              onClick={() => onChange(removeFilterChip(filters, chip.key))}
              title={`Remove ${chip.label} filter`}
            >
              {chip.label} ✕
            </button>
          ))}
        </span>
      )}

      {open && (
        <div className="rv-filter-popover">
          <div className="rv-filter-popover-row">
            <button
              type="button"
              className={`rv-chip${filters.reviewStates?.includes('unreviewed') ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.reviewStates?.includes('unreviewed') ?? false}
              onClick={() =>
                onChange(
                  filters.reviewStates?.includes('unreviewed')
                    ? { ...filters, reviewStates: undefined }
                    : { ...filters, reviewStates: ['unreviewed'] },
                )
              }
            >
              Unreviewed
            </button>
            <button
              type="button"
              className={`rv-chip${filters.reviewStates?.includes('reviewed') ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.reviewStates?.includes('reviewed') ?? false}
              onClick={() =>
                onChange(
                  filters.reviewStates?.includes('reviewed')
                    ? { ...filters, reviewStates: undefined }
                    : { ...filters, reviewStates: ['reviewed'] },
                )
              }
            >
              Reviewed
            </button>
          </div>
          <div className="rv-filter-popover-row">
            <button
              type="button"
              className={`rv-chip rv-chip-warning${filters.warningsOnly ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.warningsOnly ?? false}
              onClick={() => toggle('warningsOnly', !filters.warningsOnly)}
            >
              ⚠ Warnings
            </button>
            <button
              type="button"
              className={`rv-chip${filters.editedOnly ? ' rv-chip-active' : ''}`}
              aria-pressed={filters.editedOnly ?? false}
              onClick={() => toggle('editedOnly', !filters.editedOnly)}
            >
              Edited during review
            </button>
          </div>

          {facets.families.length > 0 && (
            <select
              className="rv-select"
              aria-label="Filter by family"
              value={filters.familyCohortId ?? ''}
              onChange={e => onChange({ ...filters, familyCohortId: e.target.value || undefined })}
            >
              <option value="">All families</option>
              {facets.families.map(f => (
                <option key={f.cohortId} value={f.cohortId}>
                  {f.label}
                </option>
              ))}
            </select>
          )}

          {facets.brands.length > 0 && (
            <select
              className="rv-select"
              aria-label="Filter by brand"
              value={filters.brand ?? ''}
              onChange={e => onChange({ ...filters, brand: e.target.value || undefined })}
            >
              <option value="">All brands</option>
              {facets.brands.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}

          <select
            className="rv-select"
            aria-label="Filter by source"
            value={filters.sourceType ?? 'all'}
            onChange={e =>
              onChange({ ...filters, sourceType: (e.target.value || 'all') as 'official_page' | 'distributor_record' | 'all' })
            }
          >
            <option value="all">Any source</option>
            <option value="distributor_record">Distributor record</option>
            <option value="official_page">Official page</option>
          </select>

          {hasActiveQueueFilters(filters) && (
            <button type="button" className="rv-chip" onClick={() => onChange({})}>
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shortcut legend (dismissible — persisted) ──────────────────────────────

/** Pure read of the persisted dismissal so tests can exercise it without jsdom
 *  localStorage flakiness leaking between cases. */
export function isLegendDismissed(store: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return store.getItem(LEGEND_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissLegend(store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(LEGEND_DISMISS_KEY, '1');
  } catch {
    /* storage unavailable — legend simply reappears next mount */
  }
}

export function KeyboardLegend() {
  const [dismissed, setDismissed] = useState(() => isLegendDismissed());

  if (dismissed) {
    return (
      <button
        type="button"
        className="rv-legend-reopen"
        aria-label="Show keyboard shortcuts"
        onClick={() => {
          dismissLegendRestore();
          setDismissed(false);
        }}
        title="Show keyboard shortcuts"
      >
        ⌨ Shortcuts
      </button>
    );
  }

  return (
    <div className="rv-legend">
      <span aria-hidden="true">
        <kbd>G</kbd> Looks Good &amp; Next
      </span>
      <span aria-hidden="true">
        <kbd>←</kbd> <kbd>→</kbd> previous / next product
      </span>
      <span aria-hidden="true">
        <kbd>Esc</kbd> close product / image
      </span>
      <button
        type="button"
        className="rv-legend-dismiss"
        aria-label="Hide keyboard shortcuts"
        title="Hide shortcuts"
        onClick={() => {
          dismissLegend();
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function dismissLegendRestore(): void {
  try {
    localStorage.removeItem(LEGEND_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

function Lightbox({ url, caption, onClose }: { url: string; caption: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="rv-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Product image"
      onKeyDown={handleKey}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="rv-lightbox-close"
        aria-label="Close image"
        onClick={onClose}
      >
        ✕
      </button>
      <img src={url} alt={caption} className="rv-lightbox-img" onClick={e => e.stopPropagation()} />
      <div className="rv-lightbox-caption">{caption}</div>
    </div>
  );
}