/**
 * AgentLabPolicies — flags panel + per-run policy snapshot inspector (PI-7).
 */

import React, { useEffect, useState } from 'react';
import {
  listPiRuns,
  type PiRunRow,
  type ProductIntelligenceFlags,
} from '../../product-intelligence-api';
import { AgentPolicySummary } from './AgentPolicySummary';

interface Props {
  flags: ProductIntelligenceFlags;
  onSelectRun: (runId: string) => void;
}

export function AgentLabPolicies({ flags, onSelectRun }: Props) {
  const [runs, setRuns] = useState<PiRunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    listPiRuns({ limit: 20 })
      .then((res) => setRuns(res.runs))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, []);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 },
    title: { fontSize: 16, fontWeight: 600, color: '#111827', marginBottom: 12 },
    flagRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
    flagName: { fontSize: 13, fontFamily: 'monospace', color: '#374151' },
    flagVal: { fontSize: 13, fontWeight: 600, fontFamily: 'monospace' },
    select: { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, marginBottom: 12 },
    note: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 8 },
    openBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, marginTop: 10 },
    empty: { fontSize: 13, color: '#9ca3af', padding: 12 },
  };

  return (
    <div>
      <div style={styles.card}>
        <h2 style={styles.title}>Feature flags</h2>
        {(Object.entries(flags) as Array<[string, boolean]>).map(([key, val]) => (
          <div key={key} style={styles.flagRow}>
            <span style={styles.flagName}>{key}:</span>
            <span style={{ ...styles.flagVal, color: val ? '#16a34a' : '#9ca3af' }}>{String(val)}</span>
          </div>
        ))}
      </div>

      <div style={styles.card}>
        <h2 style={styles.title}>Policy snapshots</h2>
        <p style={styles.note}>Policy snapshots are captured per run — open a run to inspect its immutable policy.</p>
        {loading && <p style={styles.empty}>Loading…</p>}
        {!loading && runs.length === 0 && <p style={styles.empty}>No runs yet. Run a research run to capture a policy snapshot.</p>}
        {!loading && runs.length > 0 && (
          <>
            <select
              style={styles.select}
              value={selectedRunId ?? ''}
              onChange={(e) => setSelectedRunId(e.target.value || null)}
            >
              <option value="">— Select a run —</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.executor} · {run.status} · {new Date(run.startedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            {selectedRun && (
              <>
                <AgentPolicySummary run={selectedRun} />
                <button style={styles.openBtn} onClick={() => onSelectRun(selectedRun.id)}>
                  Open run in inspector →
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}