/**
 * AgentRunList — table of PI runs with refresh and launch (PI-7).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { listPiRuns, type PiRunRow, type PiRunStatus } from '../../product-intelligence-api';
import { AgentRunLauncher } from './AgentRunLauncher';

interface Props {
  onSelect: (runId: string) => void;
}

export function AgentRunList({ onSelect }: Props) {
  const [runs, setRuns] = useState<PiRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLauncher, setShowLauncher] = useState(false);
  const [filter, setFilter] = useState<'all' | 'blocked' | 'profile' | 'identity' | 'review-ready'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listPiRuns({ limit: 50 });
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 },
    btnRow: { display: 'flex', gap: 8, marginBottom: 16 },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    secondaryBtn: { background: '#fff', border: '1px solid #d1d5db', color: '#4b5563', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    table: { width: '100%', borderCollapse: 'collapse' as const },
    th: { textAlign: 'left', fontSize: 13, fontWeight: 600, color: '#374151', padding: '8px 12px', borderBottom: '1px solid #e5e7eb' },
    td: { fontSize: 13, color: '#4b5563', padding: '8px 12px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
    row: { cursor: 'pointer' },
    empty: { padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 14 },
    error: { color: '#dc2626', fontSize: 14, marginBottom: 12 },
  };

  const statusPill = (status: PiRunStatus): React.CSSProperties => {
    const base: React.CSSProperties = { display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8 };
    switch (status) {
      case 'running':
        return { ...base, background: '#eff6ff', color: '#2563eb' };
      case 'completed':
        return { ...base, background: '#f0fdf4', color: '#16a34a' };
      case 'failed':
        return { ...base, background: '#fef2f2', color: '#dc2626' };
      case 'cancelled':
        return { ...base, background: '#f3f4f6', color: '#6b7280' };
      default:
        return base;
    }
  };

  const formatDuration = (run: PiRunRow): string => {
    if (!run.completedAt) return run.status === 'running' ? '…' : '-';
    const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };

  if (showLauncher) {
    return (
      <AgentRunLauncher
        onCreated={(runId) => {
          setShowLauncher(false);
          onSelect(runId);
        }}
        onCancel={() => setShowLauncher(false)}
      />
    );
  }

  const filteredRuns = runs.filter((run) => {
    if (filter === 'all') return true;
    if (filter === 'blocked') return run.status === 'failed';
    if (filter === 'profile') return run.errorCode?.includes('profile') === true;
    if (filter === 'identity') return run.errorCode?.includes('identity') === true;
    return run.status === 'completed';
  });

  return (
    <div>
      <div style={styles.btnRow}>
        <label style={{ fontSize: 13, alignSelf: 'center' }}>Filter <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All</option><option value="blocked">Blocked</option><option value="profile">Profile</option><option value="identity">Identity</option><option value="review-ready">Review ready</option></select></label>
        <button style={styles.primaryBtn} onClick={refresh}>↻ Refresh</button>
        <button style={styles.primaryBtn} onClick={() => setShowLauncher(true)}>+ New run</button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
      {loading && <p style={{ color: '#6b7280', fontSize: 14 }}>Loading…</p>}
      <div style={styles.card}>
        {filteredRuns.length === 0 ? (
          <div style={styles.empty}>No runs yet. Click "New run" to start product research.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Started</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Executor</th>
                <th style={styles.th}>Mode</th>
                <th style={styles.th}>Duration</th>
                <th style={styles.th}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((run) => (
                <tr
                  key={run.id}
                  style={styles.row}
                  onClick={() => onSelect(run.id)}
                >
                  <td style={styles.td}>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}</td>
                  <td style={styles.td}><span style={statusPill(run.status)}>{run.status}</span></td>
                  <td style={styles.td}>{run.executor}</td>
                  <td style={styles.td}>{run.mode}</td>
                  <td style={styles.td}>{formatDuration(run)}</td>
                  <td style={styles.td}>{run.actualCost != null ? `$${run.actualCost.toFixed(4)}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}