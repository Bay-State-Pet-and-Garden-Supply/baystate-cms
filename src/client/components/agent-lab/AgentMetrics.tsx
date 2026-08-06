/**
 * AgentMetrics — aggregate run metrics (PI-7).
 */

import React, { useEffect, useState } from 'react';
import {
  listPiRuns,
  getPiRun,
  type PiRunRow,
  type PiRunProjection,
} from '../../product-intelligence-api';
import {
  computeMetrics,
  computeToolFailureRates,
  type MetricsResult,
  type ToolFailureRates,
} from '../../agent-lab/logic';

interface Props {
  onOpenRun: (runId: string) => void;
}

export function AgentMetrics({ onOpenRun }: Props) {
  const [runs, setRuns] = useState<PiRunRow[]>([]);
  const [metrics, setMetrics] = useState<MetricsResult | null>(null);
  const [toolRates, setToolRates] = useState<ToolFailureRates | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await listPiRuns({ limit: 20 });
        setRuns(res.runs);
        const projections = new Map<string, PiRunProjection>();
        const results = await Promise.allSettled(
          res.runs.map((r) => getPiRun(r.id)),
        );
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'fulfilled') {
            projections.set(res.runs[i].id, result.value);
          }
        }
        setMetrics(computeMetrics(res.runs, projections));

        // Aggregate tool failure rates across all projections
        const allToolCalls = Array.from(projections.values()).flatMap((p) => p.toolCalls);
        setToolRates(computeToolFailureRates(allToolCalls));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 },
    title: { fontSize: 16, fontWeight: 600, color: '#111827', marginBottom: 16 },
    statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 },
    stat: { background: '#f9fafb', borderRadius: 8, padding: 12 },
    statLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const },
    statValue: { fontSize: 20, fontWeight: 700, color: '#111827', marginTop: 4 },
    note: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 12 },
    sectionTitle: { fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 16, marginBottom: 8 },
    empty: { fontSize: 14, color: '#9ca3af', textAlign: 'center' as const, padding: 20 },
    runRow: { fontSize: 13, color: '#2563eb', cursor: 'pointer', padding: '4px 0' },
  };

  if (loading) {
    return <div style={styles.empty}>Loading metrics…</div>;
  }

  if (error) {
    return <div style={{ ...styles.card, color: '#dc2626' }}>Error: {error}</div>;
  }

  if (!metrics) {
    return <div style={styles.empty}>No data.</div>;
  }

  const formatPct = (val: number): string => `${(val * 100).toFixed(1)}%`;
  const formatMs = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };

  return (
    <div>
      <div style={styles.card}>
        <h2 style={styles.title}>Overview ({metrics.runCount} runs)</h2>
        <div style={styles.statGrid}>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Completed</div>
            <div style={styles.statValue}>{metrics.completed}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Failed</div>
            <div style={styles.statValue}>{metrics.failed}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Running</div>
            <div style={styles.statValue}>{metrics.running}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Cancellation</div>
            <div style={styles.statValue}>{metrics.cancelled}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Completion rate</div>
            <div style={styles.statValue}>{formatPct(metrics.completionRate)}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Failure rate</div>
            <div style={styles.statValue}>{formatPct(metrics.failureRate)}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Abstention rate</div>
            <div style={styles.statValue}>{formatPct(metrics.abstentionRate)}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Avg runtime</div>
            <div style={styles.statValue}>{formatMs(metrics.avgDurationMs)}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Avg cost</div>
            <div style={styles.statValue}>${metrics.avgCostUsd.toFixed(4)}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>Total cost</div>
            <div style={styles.statValue}>${metrics.totalCostUsd.toFixed(4)}</div>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.title}>Tool enforcement</h2>
        {toolRates && toolRates.total > 0 ? (
          <div style={styles.statGrid}>
            <div style={styles.stat}>
              <div style={styles.statLabel}>Total calls</div>
              <div style={styles.statValue}>{toolRates.total}</div>
            </div>
            <div style={styles.stat}>
              <div style={styles.statLabel}>Policy denied</div>
              <div style={styles.statValue}>{toolRates.denied}</div>
            </div>
            <div style={styles.stat}>
              <div style={styles.statLabel}>Budget exceeded</div>
              <div style={styles.statValue}>{toolRates.budgetExceeded}</div>
            </div>
            <div style={styles.stat}>
              <div style={styles.statLabel}>Denial rate</div>
              <div style={styles.statValue}>{formatPct(toolRates.deniedRate)}</div>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: '#9ca3af' }}>No tool calls recorded yet.</p>
        )}
      </div>

      <div style={styles.card}>
        <h2 style={styles.title}>Comparison highlights</h2>
        <p style={styles.note}>Identity accuracy: no labeled data yet.</p>
        <p style={styles.note}>Reviewer correction rate: not tracked yet.</p>
      </div>

      {runs.length > 0 && (
        <div style={styles.card}>
          <h2 style={styles.title}>Recent runs</h2>
          {runs.map((run) => (
            <div key={run.id} style={styles.runRow} onClick={() => onOpenRun(run.id)}>
              {run.executor} · {run.status} · {new Date(run.startedAt).toLocaleString()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}