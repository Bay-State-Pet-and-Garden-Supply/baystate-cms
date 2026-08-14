import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerHistoryRun } from '../../store-manager-api';
import { runSummary, terminalStatusLabel, entrypointLabel } from '../../store-manager-history-logic';

interface RunHistoryProps {
  open: boolean;
  onClose: () => void;
  onSelectRun: (runId: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  success: '#2f5d3a',
  failed: '#8b1e2d',
  cancelled: colors.mulchBrown,
  policy_denied: '#8a6116',
  deadline_exceeded: '#8a6116',
  unavailable: '#8a6116',
};

/**
 * Run History — every Manager run is inspectable. Lists runs with objective,
 * entrypoint, terminal outcome, and artifact count; clicking opens the run
 * inspector. Never exposes chain of thought or raw prompts.
 */
export function RunHistory({ open, onClose, onSelectRun }: RunHistoryProps) {
  const [runs, setRuns] = useState<StoreManagerHistoryRun[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entrypoint, setEntrypoint] = useState<string>('');

  const load = useCallback(
    async (reset = false) => {
      if (!open) return;
      setLoading(true);
      setError(null);
      try {
        const api = await import('../../store-manager-api');
        const page = await api.fetchStoreManagerRuns({
          after: reset ? null : cursor,
          limit: 30,
        });
        setRuns((prev) => (reset ? page.runs : [...prev, ...page.runs]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load run history.');
      } finally {
        setLoading(false);
      }
    },
    [open, cursor],
  );

  useEffect(() => {
    if (open) {
      setCursor(null);
      setRuns([]);
      void load(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entrypoint]);

  if (!open) return null;

  return (
    <div style={{ padding: 12, fontFamily: fonts.body }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 15 }}>Run History</strong>
        <button type="button" onClick={onClose} aria-label="Close Run History" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
      </div>

      <label style={{ fontSize: 12, color: colors.mulchBrown }}>
        Entrypoint
        <select
          value={entrypoint}
          onChange={(e) => {
            setEntrypoint(e.target.value);
            setCursor(null);
          }}
          style={{ marginLeft: 8, fontSize: 12, padding: '2px 6px' }}
        >
          <option value="">All</option>
          {['chat', 'command', 'schedule', 'event', 'playbook', 'replay', 'plan_preview'].map((kind) => (
            <option key={kind} value={kind}>
              {entrypointLabel(kind)}
            </option>
          ))}
        </select>
      </label>

      {error ? <div style={{ color: '#8b1e2d', margin: '8px 0' }}>{error}</div> : null}

      {runs.length === 0 && !loading ? (
        <div style={{ color: colors.mulchBrown, marginTop: 12 }}>No runs recorded yet.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0' }}>
          {runs.map((run) => (
            <li key={run.runId} style={{ marginBottom: 6 }}>
              <button
                type="button"
                onClick={() => onSelectRun(run.runId)}
                className="btn"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  alignItems: 'center',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.md,
                  padding: '8px 10px',
                  background: '#fffdf7',
                  fontSize: 13,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {runSummary(run)}
                </span>
                <span
                  style={{
                    color: STATUS_COLOR[run.terminalStatus ?? ''] ?? colors.mulchBrown,
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {terminalStatusLabel(run.terminalStatus)} · {run.artifactCount} artifact{run.artifactCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button type="button" onClick={() => void load(false)} disabled={loading} className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px', marginTop: 4 }}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
