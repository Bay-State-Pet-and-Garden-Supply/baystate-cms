/**
 * SnapshotPanel — product URL input, capture button, snapshot status (General Store).
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import { colors, fonts, rounded } from '../../../theme';

interface SnapshotPanelProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: rounded.full,
    background: bg,
    color: fg,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    border: `1px solid ${fg}33`,
  };
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    padding: 16,
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    boxShadow: '0 1px 4px rgba(33, 20, 20, 0.05)',
  },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' },
  label: { fontFamily: fonts.body, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mulchBrown, whiteSpace: 'nowrap' },
  input: {
    flex: 1,
    minWidth: 260,
    padding: '8px 12px',
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 13,
    fontFamily: fonts.mono,
    color: colors.ledgerCharcoal,
    background: colors.whiteSurface,
  },
  primaryBtn: {
    background: colors.uniformGreen,
    color: colors.feedBagCream,
    border: 'none',
    borderRadius: rounded.sm,
    padding: '8px 18px',
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 2px rgba(20, 83, 45, 0.15)',
  },
  disabledBtn: {
    background: colors.feedBagCream,
    color: colors.mulchBrown,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '8px 18px',
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'not-allowed',
    whiteSpace: 'nowrap',
    opacity: 0.6,
  },
  errorBox: {
    padding: '8px 12px',
    background: 'rgba(118, 12, 25, 0.08)',
    border: `1px solid ${colors.signetBurgundy}`,
    borderRadius: rounded.sm,
    color: colors.signetBurgundy,
    fontSize: 12,
    fontFamily: fonts.body,
    fontWeight: 600,
    marginBottom: 8,
  },
  summary: { fontSize: 11, fontFamily: fonts.body, color: colors.mulchBrown, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' },
};

export function SnapshotPanel({ state, controller }: SnapshotPanelProps) {
  const { draft, snapshot, requests } = state;
  const isBusy = requests.snapshot.loading;
  const hasUrl = Boolean(draft.productUrl.trim());

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
            <strong style={{ color: colors.ledgerCharcoal }}>Final URL:</strong>{' '}
            {snapshot.finalUrl ? (
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal }}>
                {snapshot.finalUrl.length > 60 ? snapshot.finalUrl.slice(0, 60) + '…' : snapshot.finalUrl}
              </span>
            ) : (
              draft.productUrl
            )}
          </span>
          <span>Runtime: <span style={badgeStyle('rgba(20, 83, 45, 0.1)', colors.uniformGreen)}>{draft.runtime}</span></span>
          {snapshot.warnings && snapshot.warnings.length > 0 && (
            <span style={badgeStyle('rgba(246, 219, 18, 0.3)', colors.ledgerCharcoal)}>
              {snapshot.warnings.length} warning{snapshot.warnings.length > 1 ? 's' : ''}
            </span>
          )}
          {snapshot.imageCandidates && snapshot.imageCandidates.length > 0 && (
            <span style={badgeStyle(colors.feedBagCream, colors.mulchBrown)}>
              {snapshot.imageCandidates.length} image candidates
            </span>
          )}
          {snapshot.jsonLd && snapshot.jsonLd.length > 0 && (
            <span style={badgeStyle(colors.feedBagCream, colors.mulchBrown)}>
              {snapshot.jsonLd.length} JSON-LD
            </span>
          )}
        </div>
      )}
    </div>
  );
}

