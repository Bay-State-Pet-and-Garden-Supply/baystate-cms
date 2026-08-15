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
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '24px',
        fontFamily: fonts.body,
        boxShadow: '0 1px 3px rgba(33,20,20,0.04)',
        maxWidth: 900,
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: `1px solid ${colors.cardBorder}`, paddingBottom: 16 }}>
        <div>
          <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700, color: colors.ledgerCharcoal, margin: '0 0 4px' }}>Run History</h3>
          <div style={{ fontSize: 12, color: colors.mulchBrown }}>
            Audit log of all Store Manager execution runs, tool dispatches, and terminal outcomes.
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 12, color: colors.ledgerCharcoal, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          Filter by Entrypoint:
          <select
            value={entrypoint}
            onChange={(e) => {
              setEntrypoint(e.target.value);
              setCursor(null);
            }}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: rounded.md,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.whiteSurface,
              color: colors.ledgerCharcoal,
            }}
          >
            <option value="">All Entrypoints</option>
            {['chat', 'command', 'schedule', 'event', 'playbook', 'replay', 'plan_preview'].map((kind) => (
              <option key={kind} value={kind}>
                {entrypointLabel(kind)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div style={{ color: colors.signetBurgundy, background: '#fee2e2', padding: '10px 14px', borderRadius: rounded.md, fontSize: 12, margin: '12px 0' }}>{error}</div> : null}

      {runs.length === 0 && !loading ? (
        <div style={{ color: colors.mulchBrown, textAlign: 'center', padding: '32px 16px', fontSize: 13, fontStyle: 'italic' }}>
          No execution runs recorded yet.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                onClick={() => onSelectRun(run.runId)}
                className="btn"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  alignItems: 'center',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.md,
                  padding: '12px 16px',
                  background: colors.whiteSurface,
                  fontSize: 13,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = colors.uniformGreen;
                  e.currentTarget.style.background = colors.feedBagCream;
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = colors.cardBorder;
                  e.currentTarget.style.background = colors.whiteSurface;
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden', flex: 1 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: colors.ledgerCharcoal }}>
                    {runSummary(run)}
                  </span>
                  <span style={{ fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.mono }}>
                    Run ID: {run.runId} · {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                <span
                  style={{
                    color: STATUS_COLOR[run.terminalStatus ?? ''] ?? colors.mulchBrown,
                    fontSize: 12,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    padding: '3px 8px',
                    borderRadius: rounded.sm,
                    background: colors.feedBagCream,
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
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button type="button" onClick={() => void load(false)} disabled={loading} className="btn btn-outline" style={{ fontSize: 12, padding: '6px 16px' }}>
            {loading ? 'Loading…' : 'Load more runs'}
          </button>
        </div>
      )}
    </div>
  );
}
