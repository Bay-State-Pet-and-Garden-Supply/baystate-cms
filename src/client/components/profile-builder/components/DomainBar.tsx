/**
 * DomainBar — domain input, active profile badge, runtime toggle, reset (General Store).
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import { colors, fonts, rounded } from '../../../theme';

interface DomainBarProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: fonts.body,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    border: 'none',
    cursor: 'pointer',
    background: active ? colors.uniformGreen : colors.whiteSurface,
    color: active ? colors.feedBagCream : colors.mulchBrown,
    transition: 'all 150ms ease',
  };
}

const s: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    flexWrap: 'wrap',
    boxShadow: '0 1px 4px rgba(33, 20, 20, 0.05)',
  },
  label: { fontFamily: fonts.body, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mulchBrown, whiteSpace: 'nowrap' },
  input: {
    padding: '7px 12px',
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 13,
    fontFamily: fonts.mono,
    color: colors.ledgerCharcoal,
    background: colors.whiteSurface,
    width: 220,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 10px',
    borderRadius: rounded.full,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  toggleGroup: {
    display: 'flex',
    gap: 0,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    overflow: 'hidden',
  },
  resetBtn: {
    background: colors.whiteSurface,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '6px 14px',
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    color: colors.mulchBrown,
  },
};

export function DomainBar({ state, controller }: DomainBarProps) {
  const { draft, activeProfile } = state;
  const hasProfile = Boolean(activeProfile);

  return (
    <div style={s.bar}>
      <span style={s.label}>Domain</span>
      <input
        type="text"
        style={s.input}
        value={draft.domain}
        onChange={(e) => controller.setDomain(e.target.value)}
        placeholder="e.g. acmepet.com"
      />

      {hasProfile && (
        <span style={{ ...s.badge, background: 'rgba(22, 132, 77, 0.12)', color: colors.seedlingGreen, border: `1px solid ${colors.seedlingGreen}44` }}>
          ✓ Active Profile
          {activeProfile!.updatedAt && (
            <span style={{ fontWeight: 400, marginLeft: 4, fontFamily: fonts.mono }}>
              ({new Date(activeProfile!.updatedAt).toLocaleDateString()})
            </span>
          )}
        </span>
      )}
      {!hasProfile && draft.domain && (
        <span style={{ ...s.badge, background: colors.feedBagCream, color: colors.mulchBrown, border: `1px solid ${colors.cardBorder}` }}>
          No Profile
        </span>
      )}

      <span style={s.label}>Runtime</span>
      <div style={s.toggleGroup}>
        <button
          type="button"
          style={toggleBtnStyle(draft.runtime === 'static')}
          onClick={() => controller.setRuntime('static')}
        >
          Static
        </button>
        <button
          type="button"
          style={toggleBtnStyle(draft.runtime === 'rendered')}
          onClick={() => controller.setRuntime('rendered')}
        >
          Rendered
        </button>
      </div>

      <button type="button" style={s.resetBtn} onClick={controller.resetDraft}>
        Reset
      </button>
    </div>
  );
}

