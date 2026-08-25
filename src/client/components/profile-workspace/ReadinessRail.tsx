// story: e06s01 — readiness rail (56px modules, Gold active, help ghost)
// story: e06-polish — Mara help, overall · X/6 steps
import React, { useState } from 'react';
import type { ReadinessState } from '../../../onboarding/profile-readiness';
import { colors, fonts, rounded } from '../../theme';

export function ReadinessRail({
  state,
  mode = 'horizontal',
}: {
  state: ReadinessState;
  mode?: 'horizontal' | 'rail';
}): React.ReactElement {
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const doneCount = state.steps.filter((s) => s.status === 'complete').length;
  const isAllReady = doneCount === state.steps.length;

  return (
    <nav
      aria-label="Readiness"
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: 16,
        boxShadow: '0 1px 4px rgba(33, 20, 20, 0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: collapsed ? 0 : 12,
          paddingBottom: collapsed ? 0 : 10,
          borderBottom: collapsed ? 'none' : `2px solid ${isAllReady ? colors.seedlingGreen : colors.cornerCalloutGold}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: colors.feedBagCream,
              color: colors.mulchBrown,
              padding: '3px 8px',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            Readiness Gate
          </span>
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: 13,
              fontWeight: 700,
              color: isAllReady ? colors.seedlingGreen : colors.ledgerCharcoal,
            }}
          >
            {state.overall}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              fontWeight: 700,
              color: isAllReady ? colors.seedlingGreen : colors.mulchBrown,
              background: colors.feedBagCream,
              padding: '3px 8px',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {doneCount}/{state.steps.length} Verified
          </span>

          <button
            type="button"
            aria-label="What is Readiness?"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((v) => !v)}
            style={{
              background: helpOpen ? colors.feedBagCream : 'transparent',
              color: colors.mulchBrown,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.sm,
              width: 22,
              height: 22,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: fonts.body,
              fontWeight: 700,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ?
          </button>

          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            style={{
              background: colors.feedBagCream,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.sm,
              padding: '3px 8px',
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              color: colors.mulchBrown,
              cursor: 'pointer',
            }}
          >
            {collapsed ? '▼ Show Steps' : '▲ Hide Steps'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Progress Track */}
          <div
            style={{
              height: 4,
              width: '100%',
              background: colors.feedBagCream,
              borderRadius: rounded.full,
              overflow: 'hidden',
              marginBottom: 12,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${(doneCount / state.steps.length) * 100}%`,
                background: isAllReady ? colors.seedlingGreen : colors.uniformGreen,
                transition: 'width 300ms ease',
              }}
            />
          </div>

          {helpOpen && (
            <div
              style={{
                fontFamily: fonts.body,
                fontSize: 12,
                color: colors.ledgerCharcoal,
                background: colors.feedBagCream,
                border: `1px solid ${colors.cardBorder}`,
                borderLeft: `3px solid ${colors.uniformGreen}`,
                borderRadius: rounded.sm,
                padding: '8px 10px',
                marginBottom: 12,
                lineHeight: 1.4,
              }}
            >
              Readiness tracks 6 quality verification steps before profile activation can release blocked items.
            </div>
          )}

          <ol
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: mode === 'horizontal' ? 'grid' : 'flex',
              gridTemplateColumns: mode === 'horizontal' ? 'repeat(auto-fit, minmax(180px, 1fr))' : undefined,
              flexDirection: mode === 'rail' ? 'column' : undefined,
              gap: 8,
            }}
          >
            {state.steps.map((s, idx) => {
              const isActive = s.status === 'active';
              const isDone = s.status === 'complete';
              const isBlocked = s.status === 'blocked';

              let statusBg = 'transparent';
              let statusFg: string = colors.mulchBrown;
              let statusText: string = s.status;

              if (isDone) {
                statusBg = 'rgba(22, 132, 77, 0.1)';
                statusFg = colors.seedlingGreen;
                statusText = '✓ Pass';
              } else if (isBlocked) {
                statusBg = 'rgba(118, 12, 25, 0.1)';
                statusFg = colors.signetBurgundy;
                statusText = '! Block';
              } else if (isActive) {
                statusBg = 'rgba(246, 219, 18, 0.25)';
                statusFg = colors.ledgerCharcoal;
                statusText = 'Active';
              }

              return (
                <li
                  key={s.id}
                  aria-current={isActive ? 'step' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    padding: '8px 10px',
                    borderRadius: rounded.sm,
                    background: isActive ? colors.feedBagCream : colors.whiteSurface,
                    border: `1px solid ${isActive ? colors.cardBorder : colors.cardBorder}`,
                    borderLeft: `3px solid ${isActive ? colors.cornerCalloutGold : isDone ? colors.seedlingGreen : isBlocked ? colors.signetBurgundy : colors.cardBorder}`,
                    transition: 'all 150ms ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        fontWeight: 700,
                        color: isDone ? colors.seedlingGreen : colors.mulchBrown,
                      }}
                    >
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span
                      style={{
                        fontFamily: fonts.body,
                        fontSize: 11,
                        fontWeight: isActive || isDone ? 700 : 500,
                        color: isDone ? colors.ledgerCharcoal : isBlocked ? colors.signetBurgundy : colors.ledgerCharcoal,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={s.label}
                    >
                      {s.label}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: fonts.body,
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: statusFg,
                      background: statusBg,
                      padding: '2px 5px',
                      borderRadius: rounded.sm,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {statusText}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </nav>
  );
}

