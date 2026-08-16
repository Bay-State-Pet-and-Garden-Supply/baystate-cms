/**
 * Epic #46 Phase 4 — Needs Attention queue.
 *
 * The main interactive area while automation is running. Every row answers
 * the four operator questions; the queue groups by attention type and
 * refreshes live via SSE so a resolved blocker disappears automatically.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState, subscribeBatchEvents } from '../../../onboarding-work-api';
import { AttentionRow } from './AttentionRow';
import { DomainBlockerPanel } from './DomainBlockerPanel';
import { groupAttentionItems, getAttentionGroupChip } from './attention-logic';
import './attention.css';

const PAGE_SIZE = 50;

interface AttentionQueueViewProps {
  batchId: string;
  /** Opens the resolution workspace for one item (the shell owns the drawer). */
  onOpenItem?: (itemId: string) => void;
}

type FilterKey = 'all' | string; // 'all' or an attentionReason value

export function AttentionQueueView({ batchId, onOpenItem }: AttentionQueueViewProps): React.ReactElement {
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const mounted = useRef(true);
  const offsetRef = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPage = useCallback(
    async (append: boolean) => {
      const offset = append ? offsetRef.current : 0;
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const res = await getBatchWorkState(batchId, {
          category: 'needs_attention',
          limit: PAGE_SIZE,
          offset,
        });
        if (!mounted.current) return;
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
        offsetRef.current = offset + res.items.length;
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load the attention queue');
      } finally {
        if (mounted.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [batchId],
  );

  const refresh = useCallback(() => {
    void loadPage(false);
  }, [loadPage]);

  // Initial load + live SSE refresh (debounced so bursty worker events
  // coalesce into one re-fetch).
  useEffect(() => {
    mounted.current = true;
    void loadPage(false);
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadPage(false);
      }, 500);
    });
    return () => {
      mounted.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [batchId, loadPage]);

  const handleResolve = useCallback(
    (itemId: string) => {
      if (!onOpenItem) return;
      setResolvingId(itemId);
      // The shell owns navigation; reset the in-flight marker immediately so
      // repeated clicks still work if the shell defers rendering.
      onOpenItem(itemId);
      setTimeout(() => {
        if (mounted.current) setResolvingId(null);
      }, 150);
    },
    [onOpenItem],
  );

  const groups = groupAttentionItems(items);
  const filteredGroups =
    activeFilter === 'all'
      ? groups
      : groups.filter((g) => g.reason === activeFilter || (activeFilter === 'unknown' && g.reason === 'unknown'));

  if (loading) {
    return (
      <div className="attn-queue" role="status" aria-label="Loading attention queue">
        {[0, 1, 2, 3].map((i) => (
          <div className="attn-skeleton" key={i}>
            <div className="attn-skeleton-line" style={{ width: '55%' }} />
            <div className="attn-skeleton-line" style={{ width: '85%' }} />
            <div className="attn-skeleton-line" style={{ width: '40%' }} />
          </div>
        ))}
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="attn-error" role="alert">
        <div style={{ marginBottom: 12 }}>{error}</div>
        <button type="button" className="btn btn-outline" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="attn-empty">
        <div style={{ fontSize: 20, marginBottom: 6 }}>✓</div>
        <strong>Nothing needs your attention.</strong>
        <div style={{ marginTop: 4, color: 'var(--color-mulch-brown)' }}>
          Automation is handling this batch. Blocked products will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="attn-queue">
      <DomainBlockerPanel batchId={batchId} />
      <div className="attn-chips" role="group" aria-label="Filter by attention type">        <button
          type="button"
          className={`attn-chip ${activeFilter === 'all' ? 'attn-chip-active' : ''}`}
          onClick={() => setActiveFilter('all')}
        >
          All <span className="attn-chip-count">{total}</span>
        </button>
        {groups.map((g) => (
          <button
            type="button"
            key={g.reason}
            className={`attn-chip ${activeFilter === g.reason ? 'attn-chip-active' : ''}`}
            onClick={() => setActiveFilter(g.reason)}
          >
            {getAttentionGroupChip(g.reason === 'unknown' ? null : g.reason)}{' '}
            <span className="attn-chip-count">{g.items.length}</span>
          </button>
        ))}
      </div>

      {filteredGroups.length === 0 ? (
        <div className="attn-empty">
          No {activeFilter === 'all' ? '' : 'matching '}items in this filter.
        </div>
      ) : (
        filteredGroups.map((group) => (
          <section className="attn-group" key={group.reason} aria-label={group.label}>
            <header className="attn-group-header">
              <span className="attn-group-title">{group.label}</span>
              <span className="attn-group-count">{group.items.length}</span>
            </header>
            {group.items.map((ws) => (
              <AttentionRow
                key={ws.itemId}
                workState={ws}
                onResolve={handleResolve}
                resolving={resolvingId === ws.itemId}
              />
            ))}
          </section>
        ))
      )}

      {offsetRef.current < total ? (
        <button
          type="button"
          className="btn btn-outline attn-load-more"
          onClick={() => void loadPage(true)}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : `Load more (${total - offsetRef.current} remaining)`}
        </button>
      ) : null}

      {error ? (
        <div className="attn-error" role="alert">
          Refresh failed: {error}
        </div>
      ) : null}
    </div>
  );
}
