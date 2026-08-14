import React from 'react';
import { colors, fonts, rounded } from '../../theme';

/**
 * Operations console (Issue 9) — shared empty/disabled state.
 *
 * Rendered when a console view has nothing to show or is not available:
 * feature-flag off ("inert by default"), kill switch ("history stays
 * inspectable; new runs are frozen"), or plain empty. It NEVER offers an
 * automatic action or a "trust this" shortcut — state changes happen through
 * the normal reviewed surfaces (Settings, environment flags).
 */
export type OperationsEmptyReason = 'flag-off' | 'kill-switch' | 'empty';

export interface OperationsEmptyStateProps {
  reason: OperationsEmptyReason;
  title: string;
  description: string;
  icon?: string;
}

const ICONS: Record<OperationsEmptyReason, string> = {
  'flag-off': '🚩',
  'kill-switch': '🛑',
  empty: '🗂',
};

export function OperationsEmptyState({ reason, title, description, icon }: OperationsEmptyStateProps) {
  return (
    <div
      role="status"
      data-testid={`operations-empty-${reason}`}
      aria-live="polite"
      style={{
        margin: 'auto',
        maxWidth: 560,
        textAlign: 'center',
        padding: '40px 28px',
        backgroundColor: colors.whiteSurface,
        borderRadius: rounded.lg,
        border: `1px solid ${colors.cardBorder}`,
        boxShadow: '0 1px 3px rgba(33,20,20,0.04)',
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 8 }} aria-hidden="true">
        {icon ?? ICONS[reason]}
      </div>
      <h3 style={{ fontSize: '18px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, margin: '0 0 8px' }}>
        {title}
      </h3>
      <p style={{ color: colors.mulchBrown, fontSize: '13px', margin: 0, lineHeight: 1.6 }}>{description}</p>
    </div>
  );
}
