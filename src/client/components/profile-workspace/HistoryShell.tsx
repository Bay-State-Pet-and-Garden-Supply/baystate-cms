// story: e06s01, e08 history — immutable versions with provenance/artifact/diffs/rollback (collapsed below Test/Activate)
export function HistoryShell({ versions = [] }: { versions?: Array<{ id: string; version?: number; approver?: string; reason?: string; provenance?: { provider: string; model: string; configId?: string }; artifactHashes?: string[]; createdAt?: string }> }): React.ReactElement {
  if (versions.length === 0) {
    return (
      <section aria-label="History" style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', margin: '0 0 var(--space-2)' }}>History</h3>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', textAlign: 'center', padding: 'var(--space-3)', borderTop: '2px dotted var(--color-corner-gold)', borderBottom: '1px solid var(--color-card-border)', background: 'var(--color-feed-bag-cream)', borderRadius: 'var(--radius-sm)' }}>No versions yet — first activation will create an immutable entry with actor/model/config, diffs, activation/rollback events.</div>
      </section>
    );
  }
  return (
    <section aria-label="History" style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', margin: '0 0 var(--space-2)' }}>History</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, borderLeft: '2px solid var(--color-uniform-green)', paddingLeft: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {versions.map((v) => (
          <li key={v.id} style={{ padding: '8px 10px', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-feed-bag-cream)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--color-ledger-charcoal)' }}>v{v.version ?? '?'} · {v.id.slice(0, 8)}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-mulch-brown)' }}>{v.approver ?? '—'} · {v.reason ?? '—'}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-mulch-brown)' }}>{v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}</span>
            </div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-ledger-charcoal)', wordBreak: 'break-all' }}>{v.provenance ? `${v.provenance.provider}/${v.provenance.model}${v.provenance.configId ? ` · ${v.provenance.configId.slice(0, 8)}` : ''}` : ''} {v.artifactHashes?.length ? `· hashes ${v.artifactHashes.slice(0, 3).join(', ')}${v.artifactHashes.length > 3 ? ` +${v.artifactHashes.length - 3}` : ''}` : ''}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
