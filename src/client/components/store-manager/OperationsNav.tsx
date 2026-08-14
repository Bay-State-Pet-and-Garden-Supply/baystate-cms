import React, { useRef } from 'react';
import { colors, fonts } from '../../theme';

/**
 * Operations console (Issue 9) — accessible console navigation.
 *
 * Server-owned views only: Chat, Inbox, Schedules, Triggers, Playbooks,
 * Bulk Review, History, Preferences. Views that are feature-flagged off or
 * frozen by the kill switch are shown disabled (aria-disabled) so the UI
 * never hides capability without explanation. Keyboard: the buttons are
 * natively tabbable; ArrowLeft/ArrowRight/Home/End move focus between them
 * (roving tabindex). No automatic action anywhere — navigation is the only
 * effect.
 */
export type OperationsViewId =
  | 'chat'
  | 'inbox'
  | 'schedules'
  | 'triggers'
  | 'playbooks'
  | 'bulk'
  | 'history'
  | 'preferences';

export interface OperationsViewDescriptor {
  id: OperationsViewId;
  label: string;
  icon: string;
  /** Why the view is disabled (feature flag off / kill switch), if any. */
  disabledReason?: string;
}

export interface OperationsNavProps {
  views: OperationsViewDescriptor[];
  activeView: OperationsViewId;
  onNavigate: (view: OperationsViewId) => void;
  /** True when the global kill switch is on (labels disabled views). */
  killSwitch?: boolean;
}

const VIEW_IDS: OperationsViewId[] = [
  'chat',
  'inbox',
  'schedules',
  'triggers',
  'playbooks',
  'bulk',
  'history',
  'preferences',
];

export function OperationsNav({ views, activeView, onNavigate, killSwitch = false }: OperationsNavProps) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const moveFocus = (fromIndex: number, delta: number) => {
    const enabled = views
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => !v.disabledReason);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((e) => e.i >= fromIndex) >= 0
      ? enabled.findIndex((e) => e.i === fromIndex)
      : -1;
    let targetIndex = -1;
    if (delta === -Infinity) {
      targetIndex = enabled[0]?.i ?? -1;
    } else if (delta === Infinity) {
      targetIndex = enabled[enabled.length - 1]?.i ?? -1;
    } else {
      const base = current >= 0 ? current : 0;
      const next = (base + delta + enabled.length) % enabled.length;
      targetIndex = enabled[next]?.i ?? -1;
    }
    buttonRefs.current[VIEW_IDS[targetIndex]]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveFocus(index, 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveFocus(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveFocus(index, -Infinity);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveFocus(index, Infinity);
    }
  };

  return (
    <nav aria-label="Store Manager operations console" role="navigation" data-testid="operations-nav">
      <div
        role="toolbar"
        aria-label="Operations console views"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {views.map((view, index) => {
          const disabled = view.disabledReason !== undefined;
          const active = view.id === activeView && !disabled;
          return (
            <button
              key={view.id}
              ref={(el) => {
                buttonRefs.current[view.id] = el;
              }}
              type="button"
              aria-current={active ? 'page' : undefined}
              aria-disabled={disabled ? true : undefined}
              aria-label={disabled && view.disabledReason ? `${view.label} — ${view.disabledReason}` : view.label}
              title={disabled && view.disabledReason ? view.disabledReason : view.label}
              onClick={() => {
                if (!disabled) onNavigate(view.id);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: '2rem',
                padding: '0 12px',
                fontSize: '0.75rem',
                fontFamily: fonts.body,
                fontWeight: active ? 700 : 500,
                borderRadius: 6,
                border: `1px solid ${active ? colors.seedlingGreen : colors.cardBorder}`,
                background: active ? colors.seedlingGreen : colors.whiteSurface,
                color: active ? '#FFFFFF' : colors.ledgerCharcoal,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
                outlineOffset: 2,
              }}
            >
              <span aria-hidden="true">{view.icon}</span>
              {view.label}
            </button>
          );
        })}
      </div>
      {killSwitch ? (
        <p
          role="note"
          style={{ fontSize: '11px', color: colors.mulchBrown, margin: '6px 0 0', fontStyle: 'italic' }}
        >
          🛑 Kill switch on — new runs, claims, and resumes are frozen. History and Inbox remain readable.
        </p>
      ) : null}
    </nav>
  );
}
