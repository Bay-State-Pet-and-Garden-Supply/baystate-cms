// story: e07s02 + oracle picker S1 — General Store (Operate) — no Tailwind, inline styles + CSS variables
import { useEffect, useState, useCallback } from 'react';
import { templateAwarePrefix } from '../../../onboarding/template-clustering';

type PickerItem = { url: string; title: string; cluster: string; lastSeen: string };
type SuiteRespLite = { suite: string[]; clusters?: Array<{ prefix: string; count: number }>; suggested?: string[] } | null;
type Props = { domain: string; onPick: (url: string) => void | Promise<void>; suiteResp?: SuiteRespLite; onRefreshSuite?: () => void | Promise<void> };

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  const d = ((...a: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
  return d;
}

export function pickFallback(items: PickerItem[], failedUrl: string): PickerItem | null {
  try {
    const sameCluster = templateAwarePrefix(new URL(failedUrl).pathname);
    const same = items.find((it) => it.url !== failedUrl && it.cluster === sameCluster);
    if (same) return same;
    return items.find((it) => it.url !== failedUrl) ?? null;
  } catch {
    return items.find((it) => it.url !== failedUrl) ?? null;
  }
}

function clusterLabel(prefix: string, count: number): string {
  if (!prefix) return `All · ${count.toLocaleString()}`;
  return `${prefix} · ${count.toLocaleString()} pages`;
}

export function InventoryPicker({ domain, onPick, suiteResp }: Props): React.ReactElement {
  const [query, setQuery] = useState('');
  const [cluster, setCluster] = useState('');
  const [items, setItems] = useState<PickerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [advancedUrl, setAdvancedUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const clusters = (suiteResp?.clusters ?? []) as Array<{ prefix: string; count: number }>;
  const suggested = (suiteResp?.suggested ?? []) as string[];
  const confirmed = (suiteResp?.suite ?? []) as string[];

  const fetchPicker = useCallback(async (q: string, cl: string, p: number) => {
    const params = new URLSearchParams();
    if (q) params.set('query', q);
    if (cl) params.set('cluster', cl);
    params.set('page', String(p));
    params.set('limit', '20');
    const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/inventory-picker?${params}`);
    if (!r.ok) return;
    const j = await r.json();
    setItems(j.items ?? []);
    setTotal(j.total ?? 0);
    setPage(j.page ?? 1);
  }, [domain]);

  const debouncedFetch = useCallback(debounce((q: string, cl: string) => { void fetchPicker(q, cl, 1); }, 300) as unknown as (q: string, cl: string) => void, [fetchPicker]);

  useEffect(() => { void fetchPicker('', '', 1); }, [fetchPicker]);
  useEffect(() => { debouncedFetch(query, cluster); }, [query, cluster, debouncedFetch]);
  // Default to /products (or whatever product pattern is configured) — picker should only show product URLs for testing
  useEffect(() => {
    if (!cluster && clusters.length > 0) {
      const productCluster = clusters.find((c) => c.prefix.includes('product')) ?? clusters[0];
      if (productCluster) setCluster(productCluster.prefix);
    }
  }, [clusters, cluster]);

  async function handlePick(url: string): Promise<void> {
    setStatus(`Picked ${new URL(url).pathname} — confirming…`);
    try { await onPick(url); setStatus(null); } catch (e) { setStatus(String(e)); }
  }

  function sameDomain(url: string): boolean {
    try { return new URL(url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, ''); } catch { return false; }
  }

  return (
    <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--rounded-lg, 8px)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-ledger-charcoal)' }}>Test page picker</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-mulch-brown)' }}>{total.toLocaleString()} found</div>
      </div>

      {clusters.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {clusters.map((c) => {
            const active = cluster === c.prefix;
            return (
              <button
                key={c.prefix}
                type="button"
                onClick={() => setCluster(c.prefix)}
                aria-pressed={active}
                style={{
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: `1px solid ${active ? 'var(--color-uniform-green)' : 'var(--color-card-border)'}`,
                  background: active ? 'var(--color-uniform-green)' : 'var(--color-white-surface)',
                  color: active ? 'var(--color-feed-bag-cream)' : 'var(--color-ledger-charcoal)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: active ? '0 1px 2px rgba(20,83,45,0.12)' : 'none',
                  transition: 'all 200ms cubic-bezier(0.16,1,0.3,1)',
                }}
              >
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{clusterLabel(c.prefix, c.count)}</span>
              </button>
            );
          })}
          {cluster && (
            <button type="button" onClick={() => setCluster('')} style={{ padding: '6px 8px', background: 'none', border: 'none', color: 'var(--color-uniform-green)', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 4 }}>
              Clear
            </button>
          )}
        </div>
      )}

      {suggested.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ width: '100%', fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Suggested templates</span>
          {suggested.map((u) => {
            let label = u;
            try { label = new URL(u).pathname; } catch {}
            return (
              <button
                key={u}
                type="button"
                onClick={() => void handlePick(u)}
                title={u}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 'var(--rounded-md, 6px)',
                  border: '1px solid var(--color-card-border)',
                  background: 'var(--color-white-surface)',
                  boxShadow: 'var(--shadow-sm)',
                  cursor: 'pointer',
                  transition: 'box-shadow 200ms, transform 200ms, border-color 200ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--color-corner-callout-gold, #F6DB12)', flexShrink: 0 }} aria-hidden />
                <span style={{ maxWidth: '18ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-ledger-charcoal)' }}>{label.slice(0, 28)}</span>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-mulch-brown)' }}>· verify & capture</span>
              </button>
            );
          })}
        </div>
      )}

      {confirmed.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Confirmed</span>
          {confirmed.slice(0, 6).map((u) => {
            let p = u;
            try { p = new URL(u).pathname; } catch {}
            return (
              <span key={u} title={u} style={{ padding: '4px 10px', borderRadius: 999, background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-ledger-charcoal)' }}>
                {p.slice(0, 28)}
              </span>
            );
          })}
          {confirmed.length > 6 && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-mulch-brown)' }}>+{confirmed.length - 6} more</span>}
        </div>
      )}

      {!showAll && (
        <button type="button" onClick={() => setShowAll(true)} style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--rounded-md, 6px)', border: '1px dashed var(--color-card-border)', background: 'rgba(250,249,242,0.6)', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-mulch-brown)', cursor: 'pointer' }}>
          Show all {total.toLocaleString()} pages — filtered to {cluster || '/products'} ({items.length} shown)
        </button>
      )}
      {showAll && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Search filtered pages</span>
            <button type="button" onClick={() => setShowAll(false)} style={{ background: 'none', border: 'none', color: 'var(--color-uniform-green)', fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>Collapse</button>
          </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)' }}>Search filtered pages</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search url, title, or /products path…"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--rounded-md, 6px)', border: '1px solid var(--color-card-border)', background: 'var(--color-white-surface)', fontFamily: 'var(--font-body)', fontSize: 14, outline: 'none' }}
          onFocus={(e) => { (e.target as HTMLElement).style.borderColor = 'var(--color-uniform-green)'; (e.target as HTMLElement).style.boxShadow = '0 0 0 2px rgba(20,83,45,0.15)'; }}
          onBlur={(e) => { (e.target as HTMLElement).style.borderColor = 'var(--color-card-border)'; (e.target as HTMLElement).style.boxShadow = 'none'; }}
        />
      </label>

      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 }}>
        {items.map((it) => (
          <button
            key={it.url}
            type="button"
            onClick={() => void handlePick(it.url)}
            style={{
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 'var(--rounded-md, 6px)',
              border: '1px solid var(--color-card-border)',
              background: 'var(--color-white-surface)',
              boxShadow: 'var(--shadow-sm)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              transition: 'background 200ms, border-color 200ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-feed-bag-cream)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(20,83,45,0.3)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-white-surface)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-card-border)'; }}
          >
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: 'var(--color-ledger-charcoal)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title || new URL(it.url).pathname}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-ledger-charcoal)' }}>{it.cluster}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-mulch-brown)' }}>last checked {new Date(it.lastSeen).toLocaleDateString()}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'rgba(107,58,24,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.url}</div>
          </button>
        ))}
        {items.length === 0 && (
          <div style={{ padding: '32px 12px', textAlign: 'center', borderRadius: 'var(--rounded-md, 6px)', border: '1px dashed var(--color-card-border)', background: 'rgba(250,249,242,0.6)' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, color: 'var(--color-ledger-charcoal)' }}>No results</div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-mulch-brown)' }}>Try a different term, clear the cluster filter, or use Advanced for an ad hoc URL.</div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--color-card-border)', paddingTop: 8, fontFamily: 'var(--font-body)', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--color-mulch-brown)' }}>
        <span>{total.toLocaleString()} total · {clusters.length} templates</span><span>Page {page}</span>
      </div>

      {status && <div style={{ padding: '8px 12px', borderRadius: 'var(--rounded-md, 6px)', background: 'var(--color-feed-bag-cream)', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-uniform-green)' }} role="status">{status}</div>}

      <details style={{ borderRadius: 'var(--rounded-md, 6px)', border: '1px solid var(--color-card-border)', background: 'rgba(250,249,242,0.4)', padding: '8px 12px' }}>
        <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700, color: 'var(--color-ledger-charcoal)', listStyle: 'none' }}>Advanced — Enter another URL <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-mulch-brown)' }}>same-domain, verified, marked ad hoc</span></summary>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <input
            value={advancedUrl}
            onChange={(e) => setAdvancedUrl(e.target.value)}
            placeholder="https://example.com/product/..."
            style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--rounded-md, 6px)', border: '1px solid var(--color-card-border)', background: 'var(--color-white-surface)', fontFamily: 'var(--font-body)', fontSize: 14 }}
          />
          <button
            type="button"
            onClick={() => { if (!advancedUrl.startsWith('http')) { setStatus('URL must start with http'); return; } if (!sameDomain(advancedUrl)) { setStatus('Same-domain only — ad hoc URLs stay within this domain'); return; } void handlePick(advancedUrl); }}
            style={{ padding: '8px 16px', borderRadius: 'var(--rounded-md, 6px)', border: 'none', background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-sm)', transition: 'background 200ms, transform 200ms' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-shadow-pine)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-uniform-green)'; }}
          >
            Use
          </button>
        </div>
        <div style={{ marginTop: 8, fontFamily: 'var(--font-body)', fontSize: 11, lineHeight: 1.5, color: 'var(--color-mulch-brown)' }}>Ad hoc URLs are verified and captured like any template page, but are marked ad hoc — they don’t change your confirmed suite until you confirm them.</div>
      </details>
        </>
      )}
    </div>
  );
}
