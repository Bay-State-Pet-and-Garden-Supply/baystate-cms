/**
 * Epic #46 — Processing view (Phase 5).
 *
 * Batch Workspace tab: products being handled automatically. This is a
 * progress/visibility surface — the primary human action is NONE. Items
 * refresh live via the batch SSE stream so rows that leave 'processing'
 * disappear automatically.
 *
 * Contract export (cross-agent): `ProcessingView({ batchId })`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchWorkState, OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState, subscribeBatchEvents } from '../../../onboarding-work-api';
import { groupByActivity } from './processing-logic';
import { ProcessingList } from './ProcessingList';
import './processing.css';

const PAGE_SIZE = 100;

interface ProcessingViewProps {
  batchId: string;
}

type LoadState = 'loading' | 'ready' | 'error';

export function ProcessingView({ batchId }: ProcessingViewProps) {
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const loadedRef = useRef(false);

  const loadPage = useCallback(async (offset: number) => {
    setState('loading');
    setError(null);
    try {
      const payload: BatchWorkState = await getBatchWorkState(batchId, {
        category: 'processing',
        limit: PAGE_SIZE,
        offset,
      });
      // Replace on first page; append on "load more".
      setItems((prev) => (offset === 0 ? payload.items : [...prev, ...payload.items]));
      setTotal(payload.total);
      offsetRef.current = offset + payload.items.length;
      loadedRef.current = true;
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processing items');
      setState('error');
    }
  }, [batchId]);

  // Initial load + SSE-driven refresh. SSE replaces the first page so items
  // that left 'processing' disappear and new ones appear automatically.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadPage(0);
      if (cancelled) return;
    })();
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (!cancelled) void loadPage(0);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [batchId, loadPage]);

  const hasMore = items.length < total;

  if (state === 'error') {
    return (
      <div className="pw-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline" onClick={() => void loadPage(0)}>
          Retry
        </button>
      </div>
    );
  }

  if (state === 'loading' && !loadedRef.current && items.length === 0) {
    return <div className="pw-loading">Loading processing items…</div>;
  }

  return (
    <div>
      <ProcessingList groups={groupByActivity(items)} />
      {hasMore ? (
        <button
          type="button"
          className="btn btn-outline pw-load-more"
          onClick={() => void loadPage(offsetRef.current)}
          disabled={state === 'loading'}
        >
          {state === 'loading' ? 'Loading…' : `Load more (${items.length} of ${total})`}
        </button>
      ) : null}
    </div>
  );
}
