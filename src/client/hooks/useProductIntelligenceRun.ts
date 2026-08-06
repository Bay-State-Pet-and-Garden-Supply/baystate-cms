/**
 * useProductIntelligenceRun — fetch a run projection on runId change (PI-7).
 */

import { useCallback, useEffect, useState } from 'react';
import { getPiRun, type PiRunProjection } from '../product-intelligence-api';

export interface UseRunResult {
  run: PiRunProjection | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useProductIntelligenceRun(runId: string | null): UseRunResult {
  const [projection, setProjection] = useState<PiRunProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!runId) {
      setProjection(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getPiRun(runId)
      .then((proj) => {
        setProjection(proj);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setProjection(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [runId, refreshKey]);

  return { run: projection, error, loading, refresh };
}