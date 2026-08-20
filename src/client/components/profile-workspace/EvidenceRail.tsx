// story: e06s01 — evidence rail placeholder (shell)
export function EvidenceRail(): React.ReactElement {
  return (
    <aside aria-label="Evidence">
      <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', marginBottom: 'var(--space-2)' }}>Evidence</div>
        <div style={{ aspectRatio: '16 / 9', background: 'var(--color-feed-bag-cream)', border: '1px dashed var(--color-card-border)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-body)', fontSize: '0.8rem', marginBottom: 'var(--space-2)' }}>Screenshot preview</div>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <div><dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>JSON-LD</dt><dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '6px 8px', borderRadius: 'var(--radius-sm)' }}>{`{ "@type": "Product" }`}</dd></div>
          <div><dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Signals</dt><dd style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-mulch-brown)' }}>Selected product preview, screenshot, JSON-LD signals — populated in e06s02+.</dd></div>
        </dl>
      </div>
    </aside>
  );
}
