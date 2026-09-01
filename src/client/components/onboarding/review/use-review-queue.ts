/**
 * Hook for managing the cursor-paginated Review Queue.
 * Consumes GET /api/onboarding/batches/:id/review-queue.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBatchReviewQueue } from '../../../onboarding-work-api';
import type {
  ReviewQueuePage,
  ReviewQueueRow,
  ReviewQueueCounts,
  ProjectionHealth,
} from '../../../../shared/schemas/onboarding-review-queue';
import type { ReviewQueueFilters } from './review-logic';

export interface UseReviewQueueOptions {
  batchId: string;
  filters?: ReviewQueueFilters;
  pageSize?: number;
}

export interface UseReviewQueueResult {
  rows: ReviewQueueRow[];
  counts: ReviewQueueCounts | null;
  projectionHealth: ProjectionHealth;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadQueue: (opts?: { silent?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  optimisticUpdateRow: (itemId: string, updates: Partial<ReviewQueueRow>) => void;
  optimisticRemoveRow: (itemId: string) => void;
}

const DEFAULT_PAGE_SIZE = 50;

const DEFAULT_PROJECTION_HEALTH: ProjectionHealth = {
  status: 'healthy',
  version: '1.0.0',
  computedAt: new Date().toISOString(),
  issues: [],
};

export function useReviewQueue({
  batchId,
  filters,
  pageSize = DEFAULT_PAGE_SIZE,
}: UseReviewQueueOptions): UseReviewQueueResult {
  const [rows, setRows] = useState<ReviewQueueRow[]>([]);
  const [counts, setCounts] = useState<ReviewQueueCounts | null>(null);
  const [projectionHealth, setProjectionHealth] = useState<ProjectionHealth>(DEFAULT_PROJECTION_HEALTH);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestVersionRef = useRef(0);

  const loadQueue = useCallback(
    async (opts?: { silent?: boolean }) => {
      const version = ++requestVersionRef.current;
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const page: ReviewQueuePage = await getBatchReviewQueue(batchId, {
          ...filters,
          limit: pageSize,
        });
        if (version !== requestVersionRef.current) return;
        setRows(page.rows);
        setCounts(page.counts);
        setProjectionHealth(page.projectionHealth);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (version !== requestVersionRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load review queue');
      } finally {
        if (version === requestVersionRef.current) {
          setLoading(false);
        }
      }
    },
    [batchId, filters, pageSize],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getBatchReviewQueue(batchId, {
        ...filters,
        cursor: nextCursor,
        limit: pageSize,
      });
      const seen = new Set(rows.map(r => r.itemId));
      const newRows = page.rows.filter(r => !seen.has(r.itemId));
      setRows(prev => [...prev, ...newRows]);
      setNextCursor(page.nextCursor);
      setCounts(page.counts);
      setProjectionHealth(page.projectionHealth);
    } catch (err) {
      console.warn('[useReviewQueue] Load more failed:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [batchId, filters, nextCursor, loadingMore, pageSize, rows]);

  const optimisticUpdateRow = useCallback(
    (itemId: string, updates: Partial<ReviewQueueRow>) => {
      setRows(prev => prev.map(r => (r.itemId === itemId ? { ...r, ...updates } : r)));
    },
    [],
  );

  const optimisticRemoveRow = useCallback((itemId: string) => {
    setRows(prev => prev.filter(r => r.itemId !== itemId));
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  return {
    rows,
    counts,
    projectionHealth,
    nextCursor,
    hasMore: Boolean(nextCursor),
    loading,
    loadingMore,
    error,
    loadQueue,
    loadMore,
    optimisticUpdateRow,
    optimisticRemoveRow,
  };
}
