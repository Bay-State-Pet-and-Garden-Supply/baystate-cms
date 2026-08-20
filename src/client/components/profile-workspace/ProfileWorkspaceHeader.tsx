// story: e06s01
import type { DomainProfileState } from '../../../db/repositories/domain-profile-state-repo';

export function ProfileWorkspaceHeader({ state }: { state: DomainProfileState }): React.ReactElement {
  const { domain, brandAssociations, activeVersion, freshness, blockedCount, productCount } = state;
  return (
    <header style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: 12, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>
        {brandAssociations.length ? brandAssociations.join(', ') : 'No brands'} / {domain || '—'}
      </div>
      <h2 style={{ margin: '4px 0' }}>{domain}</h2>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#374151' }}>
        <span>brandAssociations: {brandAssociations.join(', ') || '—'}</span>
        <span>activeVersion: {activeVersion ?? 'Not configured'}</span>
        <span>freshness: {freshness ?? '—'}</span>
        <span>blockedCount: {blockedCount}</span>
        <span>productCount: {productCount}</span>
      </div>
    </header>
  );
}
