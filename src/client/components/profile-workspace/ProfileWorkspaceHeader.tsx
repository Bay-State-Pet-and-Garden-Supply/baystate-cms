// story: e06s01
import type { DomainProfileState } from '../../../db/repositories/domain-profile-state-repo';

export function ProfileWorkspaceHeader({ state }: { state: DomainProfileState }): React.ReactElement {
  const domain = state?.domain || '';
  const brandAssociations = Array.isArray(state?.brandAssociations) ? state.brandAssociations : [];
  const activeVersion = state?.activeVersion ?? null;
  const freshness = state?.freshness ?? null;
  const blockedCount = state?.blockedCount ?? 0;
  const productCount = state?.productCount ?? 0;

  return (
    <header style={{ background: 'var(--color-white-surface)', borderBottom: '1px solid var(--color-card-border)', padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', borderRadius: 'var(--radius-lg)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)', display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 400, letterSpacing: 0, textTransform: 'none', color: 'var(--color-ledger-charcoal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>{brandAssociations.length ? brandAssociations.join(' · ') : 'No brands mapped'}</span>
        <span aria-hidden="true" style={{ color: 'var(--color-card-border)' }}>·</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{domain || '—'}</span>
      </div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.625rem', fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.2, color: 'var(--color-ledger-charcoal)', margin: '6px 0 14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{domain ? `${domain} · Profile` : 'Domain Profile'}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-2)', borderTop: '1px solid var(--color-card-border)', paddingTop: 'var(--space-2)' }}>
        <div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Products</div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{productCount}</div></div>
        <div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Blocked</div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: blockedCount > 0 ? 'var(--color-signet-burgundy)' : 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{blockedCount}</div></div>
        <div style={{ borderTop: '3px solid var(--color-uniform-green)', paddingTop: 6, marginTop: -6 }}><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Freshness</div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-ledger-charcoal)' }}>{freshness ?? '—'}</div></div>
        <div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Active version</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-ledger-charcoal)' }}>{activeVersion ?? 'Not configured'}</div></div>
      </div>
    </header>
  );
}
