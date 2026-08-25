/**
 * GeneratedCustomFieldsPanel — displays pending custom-field proposals
 * from the generation service (General Store).
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import { colors, fonts, rounded } from '../../../theme';

interface Props {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const sectionStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 14,
  background: colors.feedBagCream,
  borderRadius: rounded.lg,
  border: `1px solid ${colors.cardBorder}`,
  borderLeft: `4px solid ${colors.cornerCalloutGold}`,
};

const titleStyle: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: '0.9375rem',
  fontWeight: 700,
  color: colors.ledgerCharcoal,
  margin: '0 0 10px',
};

const cardStyle: React.CSSProperties = {
  padding: 12,
  marginBottom: 8,
  background: colors.whiteSurface,
  borderRadius: rounded.sm,
  border: `1px solid ${colors.cardBorder}`,
  boxShadow: '0 1px 2px rgba(33, 20, 20, 0.04)',
};

const fieldLabel: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: 13,
  fontWeight: 700,
  color: colors.ledgerCharcoal,
  marginBottom: 4,
};

const selectorStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: fonts.mono,
  color: colors.ledgerCharcoal,
  wordBreak: 'break-all',
  marginBottom: 6,
  background: colors.feedBagCream,
  padding: '4px 8px',
  borderRadius: rounded.sm,
  border: `1px solid ${colors.cardBorder}`,
};

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: fonts.body,
  color: colors.mulchBrown,
  marginBottom: 6,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const warnStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.ledgerCharcoal,
  background: 'rgba(246, 219, 18, 0.2)',
  border: `1px solid ${colors.mutedGold}`,
  padding: '4px 8px',
  borderRadius: rounded.sm,
  marginBottom: 6,
};

const previewStyle: React.CSSProperties = {
  fontSize: 12,
  color: colors.ledgerCharcoal,
  fontStyle: 'italic',
  marginBottom: 6,
  wordBreak: 'break-all',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 6,
};

const acceptBtn: React.CSSProperties = {
  background: colors.uniformGreen,
  color: colors.feedBagCream,
  border: 'none',
  borderRadius: rounded.sm,
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(20, 83, 45, 0.15)',
};

const rejectBtn: React.CSSProperties = {
  background: colors.whiteSurface,
  color: colors.mulchBrown,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: rounded.sm,
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  cursor: 'pointer',
};

function qualityBadge(q: string): React.CSSProperties {
  const base: React.CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: rounded.full, textTransform: 'uppercase', letterSpacing: '0.04em' };
  switch (q) {
    case 'high': return { ...base, background: 'rgba(22, 132, 77, 0.15)', color: colors.seedlingGreen, border: `1px solid ${colors.seedlingGreen}44` };
    case 'medium': return { ...base, background: 'rgba(20, 83, 45, 0.12)', color: colors.uniformGreen, border: `1px solid ${colors.uniformGreen}44` };
    case 'low': return { ...base, background: 'rgba(246, 219, 18, 0.3)', color: colors.ledgerCharcoal, border: `1px solid ${colors.mutedGold}` };
    default: return { ...base, background: 'rgba(118, 12, 25, 0.1)', color: colors.signetBurgundy, border: `1px solid ${colors.signetBurgundy}44` };
  }
}

export function GeneratedCustomFieldsPanel({ state, controller }: Props) {
  const pending = state.generation.customFieldSuggestions.filter(
    (s) => s.decision === 'pending' && !s.addedToDraft && !state.customFieldOrder.includes(s.key),
  );

  if (pending.length === 0) return null;

  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>Suggested Custom Fields</div>
      {pending.map((s) => (
        <div key={s.key} style={cardStyle}>
          <div style={fieldLabel}>{s.label}</div>
          <div style={selectorStyle}>{s.selector}</div>
          <div style={metaStyle}>
            <span style={qualityBadge(s.quality)}>{s.quality}</span>
            <span>{s.validation.matchedCount} match{s.validation.matchedCount !== 1 ? 'es' : ''}</span>
            {s.explanation && <span>· {s.explanation}</span>}
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

