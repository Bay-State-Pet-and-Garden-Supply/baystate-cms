/**
 * AgentRunComparison — compare button + metrics grid (PI-7).
 */

import React, { useState } from 'react';
import { comparePiRun, type PiRunProjection, type PiComparisonRow } from '../../product-intelligence-api';
import { formatComparisonRow } from '../../agent-lab/logic';

interface Props {
  projection: PiRunProjection;
}

export function AgentRunComparison({ projection }: Props) {
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestComparison, setLatestComparison] = useState<PiComparisonRow | null>(null);

  const handleCompare = async () => {
    setComparing(true);
    setError(null);
    try {
      const res = await comparePiRun(projection.run.id, 'legacy', 'current_pipeline');
      setLatestComparison(res.comparison);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    btn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginTop: 12 },
    metric: { background: '#f9fafb', borderRadius: 6, padding: 8 },
    metricLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const },
    metricValue: { fontSize: 14, fontWeight: 600, color: '#111827', marginTop: 2 },
    error: { fontSize: 13, color: '#dc2626', marginTop: 8 },
    note: { fontSize: 12, color: '#6b7280', marginTop: 8, lineHeight: 1.5 },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 16, marginBottom: 8 },
  };

  const renderMetrics = (row: PiComparisonRow) => {
    const metrics = formatComparisonRow(row);
    return (
      <div style={styles.grid}>
        {metrics.map((m) => (
          <div key={m.label} style={styles.metric}>
            <div style={styles.metricLabel}>{m.label}</div>
            <div style={styles.metricValue}>{m.value}</div>
          </div>
        ))}
      </div>
    );
  };

  const isRunning = projection.run.status === 'running';

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Comparison</h3>
      <p style={styles.note}>
        Captures this Pi run's metrics against the baseline (currently the 'legacy' pipeline, which
        reports 'unavailable' outcomes). Labeled cross-pipeline comparison data arrives with the
        metrics work in a later issue.
      </p>
      <button style={styles.btn} disabled={comparing || isRunning} onClick={handleCompare}>
        {comparing ? 'Comparing…' : 'Compare (capture metrics snapshot)'}
      </button>
      {isRunning && (
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
          Compare is disabled while run is active.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
      {latestComparison && (
        <div>
          <div style={styles.sectionTitle}>Latest comparison</div>
          {renderMetrics(latestComparison)}
        </div>
      )}
      {projection.comparisons.length > 0 && (
        <div>
          <div style={styles.sectionTitle}>History ({projection.comparisons.length})</div>
          {projection.comparisons.map((c) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {c.baselineType} · {new Date(c.createdAt).toLocaleString()}
              </span>
              {renderMetrics(c)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}