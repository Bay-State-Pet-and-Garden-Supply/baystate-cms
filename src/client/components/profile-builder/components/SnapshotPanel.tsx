/**
 * SnapshotPanel — product URL input, capture button, snapshot status.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';

interface SnapshotPanelProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 999,
    background: bg,
    color: fg,
  };
}

const s: Record<string, React.CSSProperties> = {
  panel: { padding: 16, background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  label: { fontSize: 13, fontWeight: 500, color: '#4b5563', whiteSpace: 'nowrap' },
  input: {
    flex: 1,
    padding: '8px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  primaryBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  disabledBtn: {
    background: '#9ca3af',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    whiteSpace: 'nowrap',
  },
  errorBox: {
    padding: '8px 12px',
    background: '#fee2e2',
    border: '1px solid #fecaca',
    borderRadius: 6,
    color: '#991b1b',
    fontSize: 13,
    marginBottom: 8,
  },
  summary: { fontSize: 12, color: '#6b7280', display: 'flex', gap: 16, flexWrap: 'wrap' },
};

export function SnapshotPanel({ state, controller }: SnapshotPanelProps) {
  const { draft, snapshot, requests } = state;
  const isBusy = requests.snapshot.loading;
  const hasUrl = !!draft.productUrl.trim();

  return (
    <div style={s.panel}>
      <div style={s.row}>
        <span style={s.label}>Product URL</span>
        <input
          type="text"
          style={s.input}
          value={draft.productUrl}
          onChange={(e) => controller.setProductUrl(e.target.value)}
          placeholder="https://example.com/products/..."
        />
        <button
          type="button"
          style={isBusy || !hasUrl ? s.disabledBtn : s.primaryBtn}
          onClick={controller.captureSnapshot}
          disabled={isBusy || !hasUrl}
        >
          {isBusy ? 'Capturing…' : 'Capture Snapshot'}
        </button>
      </div>

      {requests.snapshot.error && <div style={s.errorBox}>{requests.snapshot.error}</div>}

      {snapshot && (
        <div style={s.summary}>
          <span>
            <strong>Final URL:</strong>{' '}
            {snapshot.finalUrl ? (
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {snapshot.finalUrl.length > 60 ? snapshot.finalUrl.slice(0, 60) + '…' : snapshot.finalUrl}
              </span>
            ) : (
              draft.productUrl
            )}
          </span>
          <span>Runtime: <span style={badgeStyle('#e0f2fe', '#0369a1')}>{draft.runtime}</span></span>
          {snapshot.warnings && snapshot.warnings.length > 0 && (
            <span style={badgeStyle('#fef3c7', '#92400e')}>
              {snapshot.warnings.length} warning{snapshot.warnings.length > 1 ? 's' : ''}
            </span>
          )}
          {snapshot.imageCandidates && snapshot.imageCandidates.length > 0 && (
            <span style={badgeStyle('#f3f4f6', '#374151')}>
              {snapshot.imageCandidates.length} image candidates
            </span>
          )}
          {snapshot.jsonLd && snapshot.jsonLd.length > 0 && (
            <span style={badgeStyle('#f3f4f6', '#374151')}>
              {snapshot.jsonLd.length} JSON-LD
            </span>
          )}
        </div>
      )}
    </div>
  );
}
