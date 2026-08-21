// story: e08 tracer + history — evidence inspector bound to selected sample/cell (real screenshotRef/dom/jsonLd/provenance/hash)
type CaptureLite = { dom: string; screenshotBase64?: string; screenshotRef?: string; runtime: string; hash: string; capturedAt: string; url: string; provenance?: { provider: string; model: string }; jsonLd?: string } | null;
type MatrixCellLite = { field: string; extracted?: string | null; expected?: string; provenance?: string; artifactHash?: string; failureReason?: string | null } | null;
export function EvidenceRail({ capture, matrixCell }: { capture?: CaptureLite; matrixCell?: MatrixCellLite }): React.ReactElement {
  const cell = matrixCell ?? null;
  return (
    <aside aria-label="Evidence">
      <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', marginBottom: 6, paddingBottom: 8, borderBottom: '2px solid var(--color-corner-gold)', display: 'flex', alignItems: 'center', gap: 8 }}>
          Evidence <span style={{ fontFamily: 'var(--font-body)', fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.08)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>Ledger</span>
        </div>
        <div style={{ aspectRatio: '16 / 9', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-body)', fontSize: '0.8rem', marginBottom: 'var(--space-2)', position: 'relative', overflow: 'hidden' }}>
          {capture?.screenshotBase64 || capture?.screenshotRef ? <img src={capture.screenshotBase64 ? `data:image/png;base64,${capture.screenshotBase64}` : capture.screenshotRef!} alt="capture" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span>{capture ? 'Captured — no screenshot' : 'Select a sample or failed cell to inspect'}</span>}
          <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'var(--color-corner-gold)' }} aria-hidden="true" />
        </div>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {cell && (
            <div style={{ borderLeft: '2px solid var(--color-signet-burgundy)', paddingLeft: 8 }}>
              <dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Cell — {cell.field}</dt>
              <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: '#fee2e2', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid #fca5a5', wordBreak: 'break-all' }}>expected {String(cell.expected ?? '—')} · extracted {String(cell.extracted ?? '—')} · {cell.provenance ?? ''} · {cell.artifactHash ?? ''} {cell.failureReason ? `· ${cell.failureReason}` : ''}</dd>
            </div>
          )}
          <div style={{ borderLeft: '2px solid var(--color-uniform-green)', paddingLeft: 8 }}>
            <dt style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>{capture?.jsonLd ? 'JSON-LD' : 'Capture'}</dt>
            <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-card-border)', wordBreak: 'break-all' }}>{capture ? `${capture.hash} · ${capture.runtime} · ${new Date(capture.capturedAt).toLocaleString()} — ${capture.url}${capture.provenance ? ` · ${capture.provenance.provider}/${capture.provenance.model}` : ''}` : 'No capture selected — pick a product in picker'}</dd>
            {capture?.jsonLd && <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-ledger-charcoal)', background: 'var(--color-white-surface)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-card-border)', maxHeight: 80, overflow: 'auto' }}>{capture.jsonLd.slice(0, 600)}</dd>}
            {capture?.dom && !capture.jsonLd && <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-mulch-brown)', maxHeight: 60, overflow: 'hidden' }}>{capture.dom.slice(0, 300)}…</dd>}
          </div>
          {!capture && !cell && <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-mulch-brown)', border: '1px dashed var(--color-card-border)', padding: 8, borderRadius: 'var(--radius-sm)' }}>Select a sample or click a failed matrix cell to inspect screenshot, DOM snippet, and provenance.</div>}
        </dl>
      </div>
    </aside>
  );
}
