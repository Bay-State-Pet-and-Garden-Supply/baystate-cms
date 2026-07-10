/**
 * DomainBar — domain input, active profile badge, runtime toggle, reset.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';

interface DomainBarProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    background: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#374151',
  };
}

const s: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    background: '#f9fafb',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    flexWrap: 'wrap',
  },
  label: { fontSize: 13, fontWeight: 500, color: '#4b5563', whiteSpace: 'nowrap' },
  input: {
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'monospace',
    width: 240,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 10px',
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  toggleGroup: {
    display: 'flex',
    gap: 0,
    border: '1px solid #d1d5db',
    borderRadius: 6,
    overflow: 'hidden',
  },
  resetBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#6b7280',
  },
  profileInfo: { fontSize: 12, color: '#6b7280', marginLeft: 'auto' },
};

export function DomainBar({ state, controller }: DomainBarProps) {
  const { draft, activeProfile } = state;
  const hasProfile = !!activeProfile;

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
        <span style={{ ...s.badge, background: '#dcfce7', color: '#166534', border: '1px solid #16a34a' }}>
          ✓ Active Profile
          {activeProfile!.updatedAt && (
            <span style={{ fontWeight: 400, marginLeft: 4 }}>
              {new Date(activeProfile!.updatedAt).toLocaleDateString()}
            </span>
          )}
        </span>
      )}
      {!hasProfile && draft.domain && (
        <span style={{ ...s.badge, background: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db' }}>
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
