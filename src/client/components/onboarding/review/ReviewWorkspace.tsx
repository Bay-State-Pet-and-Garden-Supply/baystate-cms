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
import {
  completeReviewStage,
  getItemDetail,
  submitDecisions,
  updateItem,
  type ItemDetailResponse,
} from '../../../onboarding-api';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';
import {
  applyQueueFilters,
  distinctBrands,
  distinctFamilies,
  findNextQueuedItem,
  findNextReviewTarget,
  findPreviousReviewTarget,
  formatReviewProgress,
  hasActiveQueueFilters,
  pruneQueueSelection,
  reviewProgress,
  reviewableSelectionIds,
  selectAllVisible,
  sortForReview,
  toggleQueueSelection,
  warningInfoFromDetail,
  type ReviewQueueFilters,
} from './review-logic';
import type { ReviewDraft, ReviewInspectorItem } from './review-types';
import { ReviewQueue } from './ReviewQueue';
import { ReviewIdentityPanel } from './ReviewIdentityPanel';
import { ReviewMediaPanel } from './ReviewMediaPanel';
import { ReviewListingPanel } from './ReviewListingPanel';
import { ReviewClassificationPanel } from './ReviewClassificationPanel';
import { ReviewWarningsPanel } from './ReviewWarningsPanel';
import { ReviewActions } from './ReviewActions';
import './review.css';

const QUEUE_PAGE_SIZE = 500;
const ENRICH_CHUNK = 6;
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

  // ── Lightbox ────────────────────────────────────────────────────────────
  const [lightbox, setLightbox] = useState<{ url: string; caption: string } | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneIds = useRef<Set<string>>(new Set());
  const queueVersionRef = useRef(0);

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
      return;
    }
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
  const handleLooksGood = useCallback(async () => {
    if (!currentWorkState) return;
    const id = currentWorkState.itemId;
    const blocking = warningInfoFromDetail(currentInspector?.detail ?? {}).blocked;
    if (blocking) {
      setActionError('This product has blocking warnings. Resolve them before marking it reviewed.');
      return;
    }
    setBusyItemIds(prev => new Set(prev).add(id));
    setActionError(null);
    try {
      await completeReviewStage([id]);
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
      setActionError(err instanceof Error ? err.message : 'Failed to save review');
    } finally {
      setBusyItemIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [currentWorkState, currentInspector, items, loadQueue]);

  const moveTo = useCallback((direction: 'next' | 'previous') => {
    setCurrentItemId(prevId => {
      if (direction === 'next') {
        return findNextQueuedItem(filteredItems, prevId)?.itemId ?? prevId;
      }
      return findPreviousReviewTarget(filteredItems, prevId)?.itemId ?? prevId;
    });
  }, [filteredItems]);

  // ── Edit lifecycle ───────────────────────────────────────────────────────
  const beginEdit = useCallback(() => {
    if (!currentInspector) return;
    const item = currentInspector.detail?.item;
    const ext = currentInspector.detail?.extraction ?? item?.extractionData ?? null;
    setDraft({
      curatedTitle: item?.curationData?.curatedTitle ?? ext?.title ?? currentInspector.workState.name ?? '',
      curatedDescription: item?.curationData?.curatedDescription ?? ext?.description ?? '',
      searchKeywords: item?.curationData?.searchKeywords ?? ext?.searchKeywords ?? '',
      brandHint: currentInspector.workState.brand ?? item?.brandHint ?? ext?.brand ?? '',
    });
    setSaveError(null);
    setEditing(true);
  }, [currentInspector]);

  const handleSaveEdit = useCallback(async () => {
    if (!currentInspector || !draft) return;
    const id = currentInspector.workState.itemId;
    setBusyItemIds(prev => new Set(prev).add(id));
    setSaveError(null);
    try {
      await updateItem(id, {
        curation_data: {
          curatedTitle: draft.curatedTitle.trim() || null,
          curatedDescription: draft.curatedDescription.trim() || null,
          searchKeywords: draft.searchKeywords.trim() || null,
        },
        brandHint: draft.brandHint.trim() || null,
      });
      setEditedIds(prev => new Set(prev).add(id));
      setEditing(false);
      setDraft(null);
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
  }, [currentInspector, draft, ensureDetails, loadQueue]);

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
      if (editing) return;
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
          moveTo('next');
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
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
  }, [lightbox, editing, moveTo, handleLooksGood, currentItemId]);

  const busy = currentWorkState ? busyItemIds.has(currentWorkState.itemId) : false;

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
      <FilterBar
        filters={filters}
        onChange={setFilters}
        facets={facets}
        progress={progress}
        total={total}
        shownCount={loadedCount}
      />

      {actionError && (
        <div role="alert" className="rv-error-banner">
          {actionError}
        </div>
      )}

      <div className="rv-body">
        <div className="rv-queue-pane">
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
                className="btn btn-primary btn-sm"
                disabled={bulkBusy || reviewableSelected === 0}
                onClick={() => setBulkConfirmOpen(true)}
              >
                Mark reviewed ({reviewableSelected})
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
              emptyMessage={queueEmptyMessage}
              onSelect={setCurrentItemId}
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
              <ReviewMediaPanel
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                onOpenLightbox={(url, caption) => setLightbox({ url, caption })}
              />
              <ReviewListingPanel
                detail={currentInspector.detail}
                editing={editing}
                draft={draft ?? { curatedTitle: '', curatedDescription: '', searchKeywords: '', brandHint: '' }}
                onDraftChange={setDraft}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={() => {
                  setEditing(false);
                  setDraft(null);
                  setSaveError(null);
                }}
                saving={busy}
                saveError={saveError}
              />
              <ReviewClassificationPanel
                detail={currentInspector.detail}
                onDecision={handleDecision}
                busyDecisionId={busyDecisionId}
              />
              <ReviewWarningsPanel detail={currentInspector.detail} />
              <ReviewActions
                workState={currentInspector.workState}
                detail={currentInspector.detail}
                busy={busy}
                editing={editing}
                allReviewed={allReviewed}
                shortcutKey="G"
                onLooksGood={() => void handleLooksGood()}
                onPrevious={() => moveTo('previous')}
                onNext={() => moveTo('next')}
                onToggleEdit={() => (editing ? (setEditing(false), setDraft(null)) : beginEdit())}
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

      <Legend />

      {lightbox && (
        <Lightbox url={lightbox.url} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

// ─── Filter bar + progress ----------------------------------------------------

function FilterBar({
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
  const toggle = (key: keyof ReviewQueueFilters, value: boolean) =>
    onChange({ ...filters, [key]: filters[key] ? undefined : value });

  return (
    <div className="rv-header">
      <div className="rv-progress" role="status" aria-label="Review progress">
        <span className="rv-progress-main">{formatReviewProgress(progress)}</span>
        <span className="rv-progress-sub">
          {progress.remaining} remaining
          {total > shownCount ? ` · showing first ${shownCount}` : ''}
        </span>
        <span className="rv-progress-track" aria-hidden="true">
          <span className="rv-progress-fill" style={{ width: `${pct}%` }} />
        </span>
      </div>

      <div className="rv-filters" role="group" aria-label="Queue filters">
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
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Shortcut legend ──────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="rv-legend" aria-hidden="true">
      <span>
        <kbd>G</kbd> Looks Good &amp; Next
      </span>
      <span>
        <kbd>←</kbd> <kbd>→</kbd> previous / next product
      </span>
      <span>
        <kbd>Esc</kbd> close product / image
      </span>
    </div>
  );
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