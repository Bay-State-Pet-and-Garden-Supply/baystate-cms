// story: e06s01 — evidence rail (slightly committed banded skeleton)
export function EvidenceRail(): React.ReactElement {
  return (
    <aside aria-label="Evidence">
      <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', marginBottom: 6, paddingBottom: 8, borderBottom: '2px solid var(--color-corner-gold)', display: 'flex', alignItems: 'center', gap: 8 }}>
          Evidence <span style={{ fontFamily: 'var(--font-body)', fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.08)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>Ledger</span>
        </div>
        <div style={{ aspectRatio: '16 / 9', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-body)', fontSize: '0.8rem', marginBottom: 'var(--space-2)', position: 'relative', overflow: 'hidden' }}>
          <span>Screenshot preview — selected product</span>
          <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'var(--color-corner-gold)' }} aria-hidden="true" />
        </div>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ borderLeft: '2px solid var(--color-uniform-green)', paddingLeft: 8 }}>
            <dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>JSON-LD</dt>
            <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-card-border)' }}>{`{ "@type": "Product", "name": "…" }`}</dd>
          </div>
          <div>
            <dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)', borderBottom: '1px dotted var(--color-corner-gold)', paddingBottom: 4, display: 'inline-block' }}>Signals</dt>
            <dd style={{ margin: '6px 0 0', fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)', lineHeight: 1.5 }}>Selected product preview, screenshot, JSON-LD signals — populated when a product is selected in SuitePanel. No dashed placeholder ships as prod.</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}
