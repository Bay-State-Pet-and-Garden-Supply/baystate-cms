import React, { useEffect, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerRunHistoryDetail, StoreManagerCompareResult } from '../../store-manager-api';
import {
  terminalStatusLabel,
  entrypointLabel,
  modelCallSummary,
  comparisonWarning,
  replayWarning,
} from '../../store-manager-history-logic';

interface RunInspectorProps {
  runId: string | null;
  onClose: () => void;
  onReplay: (runId: string) => void;
  onCompare: (runIdA: string, runIdB: string) => void;
}

/**
 * Run Inspector — objective, tools/versions/statuses, approvals, evidence,
 * terminal outcome, model/cost, and lineage. Never chain of thought, raw
 * prompts, or credentials.
 */
export function RunInspector({ runId, onClose, onReplay, onCompare }: RunInspectorProps) {
  const [detail, setDetail] = useState<StoreManagerRunHistoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    setDetail(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const api = await import('../../store-manager-api');
        setDetail(await api.fetchStoreManagerRunDetail(runId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load run detail.');
      } finally {
        setLoading(false);
      }
    })();
  }, [runId]);

  if (!runId) return null;

  return (
    <div style={{ padding: 12, fontFamily: fonts.body, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 15 }}>Run {runId.slice(0, 8)}</strong>
        <button type="button" onClick={onClose} aria-label="Close Run Inspector" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
      </div>

      {loading ? <div style={{ color: colors.mulchBrown }}>Loading run detail…</div> : null}
      {error ? <div style={{ color: '#8b1e2d' }}>{error}</div> : null}

      {detail && (
        <div>
          <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 10, background: '#fffdf7', marginBottom: 8 }}>
            <div style={{ marginBottom: 4 }}>
              <strong>Objective:</strong> {detail.run.objective}
            </div>
            <div style={{ marginBottom: 4 }}>
              <strong>Entrypoint:</strong> {entrypointLabel(detail.run.entrypoint)} · <strong>Outcome:</strong> {terminalStatusLabel(detail.run.terminalStatus)}
            </div>
            <div style={{ marginBottom: 4 }}>
              <strong>Model call:</strong> {modelCallSummary(detail)}
            </div>
            <div>
              <strong>Policy:</strong> {detail.run.policyHash.slice(0, 16)}… · <strong>Lineage:</strong> {detail.run.lineage ? JSON.stringify(detail.run.lineage) : 'none'}
            </div>
          </div>

          {detail.artifacts.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 12 }}>Artifacts:</strong>{' '}
              <span style={{ fontSize: 12 }}>
                {detail.artifacts.map((a) => `${a.kind}#${a.schemaVersion}`).join(', ') || 'none'}
              </span>
            </div>
          )}

          {detail.events.length > 0 && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>Events ({detail.events.length})</summary>
              <ul style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12, paddingLeft: 16 }}>
                {detail.events.map((e, i) => (
                  <li key={i}>{(e as { type?: string }).type ?? 'event'}</li>
                ))}
              </ul>
            </details>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => onReplay(runId)}
              className="btn btn-outline"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              Replay against current state
            </button>
            <button
              type="button"
              onClick={() => onCompare(runId, '')}
              className="btn btn-outline"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              Compare…
            </button>
          </div>
          {replayWarning(detail) ? (
            <div style={{ color: colors.mulchBrown, fontSize: 12, marginTop: 6 }}>{replayWarning(detail)}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Small helper reused by RunComparison to render a non-comparable result. */
export function renderComparisonWarning(result: StoreManagerCompareResult): string {
  return comparisonWarning(result) ?? 'Runs compared — no deterministic deltas.';
}
