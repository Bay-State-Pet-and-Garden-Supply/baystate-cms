import React, { useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerCompareResult } from '../../store-manager-api';
import { comparisonWarning } from '../../store-manager-history-logic';

interface RunComparisonProps {
  open: boolean;
  onClose: () => void;
  /** Optional preselected run (from the inspector). */
  preselectedRunId?: string;
}

/**
 * Run Comparison — deterministic deltas ONLY over compatible immutable
 * artifacts. Incompatible kinds/versions show a clear non-comparable reason;
 * the model never judges raw historical payloads.
 */
export function RunComparison({ open, onClose, preselectedRunId }: RunComparisonProps) {
  const [runIdA, setRunIdA] = useState(preselectedRunId ?? '');
  const [runIdB, setRunIdB] = useState('');
  const [result, setResult] = useState<StoreManagerCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const compare = async () => {
    if (!runIdA.trim() || !runIdB.trim()) {
      setError('Provide two run ids to compare.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const api = await import('../../store-manager-api');
      setResult(await api.compareStoreManagerRuns(runIdA.trim(), runIdB.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 12, fontFamily: fonts.body, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 15 }}>Compare Runs</strong>
        <button type="button" onClick={onClose} aria-label="Close Compare Runs" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          aria-label="Run A id"
          value={runIdA}
          onChange={(e) => setRunIdA(e.target.value)}
          placeholder="Run A id"
          style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
        />
        <input
          aria-label="Run B id"
          value={runIdB}
          onChange={(e) => setRunIdB(e.target.value)}
          placeholder="Run B id"
          style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
        />
        <button type="button" onClick={() => void compare()} disabled={busy} className="btn btn-primary" style={{ fontSize: 12, padding: '4px 10px' }}>
          {busy ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {error ? <div style={{ color: '#8b1e2d', marginBottom: 8 }}>{error}</div> : null}

      {result && (
        <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 10, background: '#fffdf7' }}>
          {result.comparable ? (
            <div>
              <div style={{ marginBottom: 6 }}>
                Comparable {result.kind} artifacts — <strong>{result.runIdA}</strong> vs <strong>{result.runIdB}</strong>
              </div>
              {result.delta && result.delta.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Comparison deltas">
                  <thead>
                    <tr style={{ textAlign: 'left', color: colors.mulchBrown, fontSize: 12 }}>
                      <th style={{ padding: '4px 6px' }}>Field</th>
                      <th style={{ padding: '4px 6px' }}>Before (A)</th>
                      <th style={{ padding: '4px 6px' }}>After (B)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.delta.map((d, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${colors.cardBorder}` }}>
                        <td style={{ padding: '4px 6px' }}>{d.field}</td>
                        <td style={{ padding: '4px 6px' }}>{d.before ?? '—'}</td>
                        <td style={{ padding: '4px 6px' }}>{d.after ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ color: colors.mulchBrown }}>No deterministic deltas between these runs.</div>
              )}
            </div>
          ) : (
            <div style={{ color: '#8a6116' }}>
              <strong>Not comparable:</strong> {comparisonWarning(result)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
