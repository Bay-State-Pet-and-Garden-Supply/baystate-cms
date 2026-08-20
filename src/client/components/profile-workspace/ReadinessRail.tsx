// story: e06s01
import type { ReadinessState } from '../../../onboarding/profile-readiness';

export function ReadinessRail({ state }: { state: ReadinessState }): React.ReactElement {
  return (
    <nav aria-label="Readiness" style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)', marginBottom: 'var(--space-2)' }}>{state.overall}</div>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {state.steps.map((s, idx) => {
          const isActive = s.status === 'active';
          const isDone = s.status === 'complete';
          const isBlocked = s.status === 'blocked';
          return (
            <li key={s.id} aria-current={isActive ? 'step' : undefined} style={{ minHeight: 56, display: 'flex', alignItems: 'center', gap: 'var(--space-1)', padding: '0 var(--space-1)', borderLeft: isActive ? '3px solid var(--color-corner-gold)' : isDone ? '3px solid var(--color-seedling-green)' : isBlocked ? '3px solid var(--color-signet-burgundy)' : '3px solid transparent', background: isActive ? 'var(--color-white-surface)' : 'transparent', borderRadius: 'var(--radius-sm)', marginBottom: 2 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-mulch-brown)', minWidth: 28, fontVariantNumeric: 'tabular-nums' }}>{String(idx + 1).padStart(2, '0')}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: isDone ? 'var(--color-seedling-green)' : isBlocked ? 'var(--color-signet-burgundy)' : 'var(--color-ledger-charcoal)', flex: 1 }}>{s.label}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: isActive ? 'var(--color-ledger-charcoal)' : isDone ? 'var(--color-seedling-green)' : isBlocked ? 'var(--color-signet-burgundy)' : 'var(--color-mulch-brown)', background: isDone ? 'rgba(22,132,77,0.1)' : isBlocked ? 'rgba(118,12,25,0.08)' : 'transparent', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>{isDone ? '✓' : isBlocked ? '!' : s.status}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
