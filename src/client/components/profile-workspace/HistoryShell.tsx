// story: e06s01 — history shell (empty-state now, immutable versions populated in e06s04)
export function HistoryShell({ versions = [] }: { versions?: Array<{ id: string }> }): React.ReactElement {
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
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, borderLeft: '2px solid var(--color-uniform-green)', paddingLeft: 'var(--space-2)' }}>
        {versions.map((v) => (
          <li key={v.id} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)', padding: '6px 0', borderBottom: '1px solid var(--color-card-border)' }}>{v.id}</li>
        ))}
      </ul>
    </section>
  );
}
