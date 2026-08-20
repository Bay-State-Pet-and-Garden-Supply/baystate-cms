// story: e06s02 — guided upstream panel showing candidate vs confirmed + waiver
import { useEffect, useState } from 'react';

type Inventory = { candidateCount: number; confirmedCount: number; freshness: string | null };
type SuiteResp = { suite: string[]; inventory: Inventory };

export function SuitePanel({ domain }: { domain: string }) {
  const [data, setData] = useState<SuiteResp | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) return;
    fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (json && typeof json === 'object' && 'suite' in json && 'inventory' in json) {
          setData(json as SuiteResp);
        } else {
          setError(json?.error ? String(json.error) : 'Invalid representative suite data');
        }
      })
      .catch((e) => setError(String(e)));
  }, [domain]);

  if (!domain) return null;
  if (error) return <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-signet-burgundy)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)' }}>{error}</div>;
  if (!data || !data.inventory || !Array.isArray(data.suite)) {
    return <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)' }}>Loading inventory…</div>;
  }

  const candidateCount = data.inventory.candidateCount ?? 0;
  const needWaiver = candidateCount < 3 && data.suite.length < 3;

  return (
    <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)', overflow: 'hidden' }}>
      <div style={{ background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', padding: '10px var(--space-2)', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Upstream — Sitemap inventory</div>
      <div style={{ padding: 'var(--space-2)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Candidate</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{candidateCount}</div></div>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Confirmed</div><div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', fontVariantNumeric: 'tabular-nums' }}>{data.suite.length}</div></div>
          <div style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Freshness</div><div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)' }}>{data.inventory.freshness ?? 'unknown'}</div></div>
        </div>
        {needWaiver && (
          <div style={{ marginBottom: 'var(--space-2)', padding: '10px 12px', background: 'rgba(118,12,25,0.06)', border: '1px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-sm)' }}>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-signet-burgundy)', margin: 0 }}>Waiver required (&lt;3 product URLs)</p>
            <input
              style={{ marginTop: 8, width: '100%', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-body)', fontSize: '0.8rem', boxSizing: 'border-box' }}
              placeholder="Reason for waiver"
              value={waiverReason}
              onChange={(e) => setWaiverReason(e.target.value)}
            />
            <button
              style={{ marginTop: 8, padding: '6px 12px', background: 'var(--color-signet-burgundy)', color: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-burgundy-dark)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' }}
              onClick={async () => {
                const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/waiver`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reason: waiverReason, actor: 'operator' }),
                });
                if (!res.ok) setError(await res.text());
                else location.reload();
              }}
            >
              Create waiver
            </button>
          </div>
        )}
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.suite.map((u) => (
            <li key={u} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
