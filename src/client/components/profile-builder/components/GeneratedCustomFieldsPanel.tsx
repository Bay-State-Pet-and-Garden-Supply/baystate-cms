/**
 * GeneratedCustomFieldsPanel — displays pending custom-field proposals
 * from the generation service.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';

interface Props {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const sectionStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 12,
  background: '#faf5ff',
  borderRadius: 8,
  border: '2px solid #e9d5ff',
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#6b21a8',
  margin: '0 0 8px',
};

const cardStyle: React.CSSProperties = {
  padding: 8,
  marginBottom: 6,
  background: '#fff',
  borderRadius: 6,
  border: '1px solid #e5e7eb',
};

const fieldLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#111827',
  marginBottom: 2,
};

const selectorStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: 'monospace',
  color: '#1e293b',
  wordBreak: 'break-all',
  marginBottom: 4,
};

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#6b7280',
  marginBottom: 4,
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const warnStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#92400e',
  background: '#fef3c7',
  padding: '3px 8px',
  borderRadius: 4,
  marginBottom: 4,
};

const previewStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#374151',
  fontStyle: 'italic',
  marginBottom: 4,
  wordBreak: 'break-all',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 4,
};

const acceptBtn: React.CSSProperties = {
  background: '#7c3aed',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const rejectBtn: React.CSSProperties = {
  background: 'none',
  color: '#6b7280',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

function qualityBadge(q: string): React.CSSProperties {
  const base: React.CSSProperties = { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, textTransform: 'uppercase' };
  switch (q) {
    case 'high': return { ...base, background: '#dcfce7', color: '#166534' };
    case 'medium': return { ...base, background: '#dbeafe', color: '#1e40af' };
    case 'low': return { ...base, background: '#fef3c7', color: '#92400e' };
    default: return { ...base, background: '#fee2e2', color: '#991b1b' };
  }
}

export function GeneratedCustomFieldsPanel({ state, controller }: Props) {
  const pending = state.generation.customFieldSuggestions.filter(
    (s) => s.decision === 'pending' && !s.addedToDraft && !state.customFieldOrder.includes(s.key),
  );

  if (pending.length === 0) return null;

  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>Suggested custom fields</div>
      {pending.map((s) => (
        <div key={s.key} style={cardStyle}>
          <div style={fieldLabel}>{s.label}</div>
          <div style={selectorStyle}>{s.selector}</div>
          <div style={metaStyle}>
            <span style={qualityBadge(s.quality)}>{s.quality}</span>
            <span>{s.validation.matchedCount} match{s.validation.matchedCount !== 1 ? 'es' : ''}</span>
            {s.explanation && <span style={{ color: '#6b7280' }}>· {s.explanation}</span>}
          </div>
          {s.preview?.text && <div style={previewStyle}>Preview: {s.preview.text}</div>}
          {s.preview?.values && s.preview.values.length > 0 && (
            <div style={previewStyle}>Values: {s.preview.values.slice(0, 3).join(', ')}{s.preview.values.length > 3 ? ` +${s.preview.values.length - 3} more` : ''}</div>
          )}
          {s.warnings.length > 0 && (
            <div style={warnStyle}>
              {s.warnings.map((w, i) => <div key={i}>{w.message}</div>)}
            </div>
          )}
          <div style={actionsStyle}>
            <button type="button" style={acceptBtn} onClick={() => controller.acceptCustomFieldSuggestion(s.key)}>
              Add field
            </button>
            <button type="button" style={rejectBtn} onClick={() => controller.rejectCustomFieldSuggestion(s.key)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
