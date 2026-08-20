// story: e06s02 — guided upstream panel showing Found on site vs You confirmed + waiver
// story: e06-polish — P0 overload (3 preview), P1 waiver inline, Mara plain language, help ghost
import { useEffect, useState } from 'react';

type Inventory = { candidateCount: number; confirmedCount: number; freshness: string | null };
type SuiteResp = { suite: string[]; inventory: Inventory };

function getDomainPath(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

export function SuitePanel({ domain }: { domain: string }) {
  const [data, setData] = useState<SuiteResp | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [waiverSuccess, setWaiverSuccess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!domain) return;
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (json && typeof json === 'object' && 'suite' in json && 'inventory' in json) {
        setData(json as SuiteResp);
        setError(null);
      } else {
        setError(json?.error ? String(json.error) : 'Invalid representative suite data');
      }
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void load();
  }, [domain]);

  if (!domain) return null;
  if (error)
    return (
      <div role="alert" style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-signet-burgundy)', background: 'var(--color-white-surface)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)' }}>
        {error}{' '}
        <button type="button" onClick={() => { setError(null); void load(); }} style={{ marginLeft: 8, background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: '0.75rem', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  if (!data || !data.inventory || !Array.isArray(data.suite)) {
    return <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)' }}>Loading inventory…</div>;
  }

  const candidateCount = data.inventory.candidateCount ?? 0;
  const needWaiver = candidateCount < 3 && data.suite.length < 3;
  const preview = data.suite.slice(0, 3);
  const remaining = data.suite.length - preview.length;
  const waiverValid = waiverReason.trim().length >= 8;

  const handleWaiver = async () => {
    if (!waiverValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/waiver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: waiverReason, actor: 'operator' }), // TODO: use auth actor when available
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || 'Waiver failed');
      } else {
        setWaiverSuccess(`Waiver recorded — "${waiverReason.trim()}"`);
        setWaiverReason('');
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)', overflow: 'hidden' }}>
      <div style={{ background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', padding: '10px var(--space-2)', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Upstream — Sitemap inventory</span>
        <button
          type="button"
          aria-label="What is Found vs Confirmed?"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((v) => !v)}
          style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--color-feed-bag-cream)', border: '1px solid rgba(250,249,242,0.4)', borderRadius: 'var(--radius-sm)', width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
        >
          ?
        </button>
      </div>
      {helpOpen && (
        <div style={{ padding: '8px var(--space-2)', background: 'var(--color-feed-bag-cream)', borderBottom: '1px solid var(--color-card-border)', fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)', lineHeight: 1.5 }}>
          <strong>Found on site</strong> = URLs discovered in sitemap &nbsp;·&nbsp; <strong>You confirmed</strong> = you marked as real products. Need 3 confirmed to activate — <a href="/docs/adr" style={{ color: 'var(--color-uniform-green)', fontWeight: 600 }}>docs/adr</a>
        </div>
      )}
      {waiverSuccess && <div role="status" style={{ margin: 'var(--space-2) var(--space-2) 0', padding: '8px 12px', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)' }}><span style={{ background: 'var(--color-signet-burgundy)', color: 'var(--color-feed-bag-cream)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontSize: '0.7rem', fontWeight: 600, marginRight: 8 }}>Waiver</span>{waiverSuccess}</div>}
      <div style={{ padding: 'var(--space-2)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Found on site</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{candidateCount}</div>
          </div>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>You confirmed</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{data.suite.length}</div>
          </div>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Freshness</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)' }}>{data.inventory.freshness ?? 'unknown'}</div>
          </div>
        </div>
        {needWaiver && (
          <div style={{ marginBottom: 'var(--space-2)', padding: '10px 12px', background: 'var(--color-white-surface)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-sm)', boxShadow: '0 1px 2px rgba(118,12,25,0.08)' }}>
            <p style={{ fontFamily: 'var(--font-display)', fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', margin: 0, borderBottom: '1px dotted var(--color-corner-gold)', paddingBottom: 6 }}>Ledger entry — waiver required (&lt;3 product URLs)</p>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', color: 'var(--color-mulch-brown)', margin: '6px 0 0' }}>Signet Burgundy ledger, not amber — slightly committed per brief.</p>
            <input
              aria-invalid={waiverReason.length > 0 && !waiverValid}
              aria-describedby="waiver-help"
              placeholder="Reason for waiver (min 8 characters)"
              value={waiverReason}
              onChange={(e) => setWaiverReason(e.target.value)}
              style={{ marginTop: 8, width: '100%', border: `1px solid ${waiverReason.length > 0 && !waiverValid ? 'var(--color-signet-burgundy)' : 'var(--color-card-border)'}`, borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-body)', fontSize: '0.8rem', boxSizing: 'border-box', outlineOffset: 2 }}
            />
            <div id="waiver-help" style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', color: waiverReason.length > 0 && !waiverValid ? 'var(--color-signet-burgundy)' : 'var(--color-mulch-brown)', marginTop: 4 }}>{waiverReason.length > 0 && !waiverValid ? 'Keep typing — 8 characters minimum.' : 'You confirmed is short; record why.'}</div>
            <button
              disabled={!waiverValid || submitting}
              onClick={handleWaiver}
              style={{ marginTop: 8, padding: '6px 12px', background: waiverValid ? 'var(--color-signet-burgundy)' : 'var(--color-feed-bag-cream)', color: waiverValid ? 'var(--color-feed-bag-cream)' : 'var(--color-mulch-brown)', border: waiverValid ? '1px solid var(--color-burgundy-dark)' : '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: waiverValid && !submitting ? 'pointer' : 'not-allowed', opacity: waiverValid ? 1 : 0.7 }}
            >
              {submitting ? 'Recording…' : 'Create waiver'}
            </button>
          </div>
        )}
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {preview.map((u) => (
            <li key={u} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, alignItems: 'center', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: 6 }}>
              <div style={{ aspectRatio: '16 / 9', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-body)', fontSize: '0.6rem', color: 'var(--color-mulch-brown)' }}>16:9</div>
              <span title={u} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getDomainPath(u)}</span>
            </li>
          ))}
        </ul>
        {remaining > 0 && !expanded && (
          <button type="button" onClick={() => setExpanded(true)} style={{ marginTop: 10, background: 'transparent', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', cursor: 'pointer', borderBottom: '2px solid var(--color-corner-gold)' }}>
            +{remaining} more — expand in place
          </button>
        )}
        {expanded && data.suite.length > 3 && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--color-card-border)', paddingTop: 10 }}>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.suite.slice(3).map((u) => (
                <li key={u} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getDomainPath(u)}</li>
              ))}
            </ul>
            <button type="button" onClick={() => setExpanded(false)} style={{ marginTop: 8, background: 'transparent', border: 'none', fontFamily: 'var(--font-body)', fontSize: '0.75rem', color: 'var(--color-mulch-brown)', cursor: 'pointer', textDecoration: 'underline' }}>
              Collapse
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
