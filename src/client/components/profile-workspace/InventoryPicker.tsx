// story: e07s02 + oracle picker S1
import { useEffect, useState, useCallback } from 'react';
import { templateAwarePrefix } from '../../../onboarding/template-clustering';

type PickerItem = { url: string; title: string; cluster: string; lastSeen: string };
type Props = { domain: string; onPick: (url: string) => void };

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
  if (!prefix) return `All · ${count}`;
  return `${prefix} · ${count} pages`;
}

export function InventoryPicker({ domain, onPick }: Props): React.ReactElement {
  const [query, setQuery] = useState('');
  const [cluster, setCluster] = useState('');
  const [items, setItems] = useState<PickerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [clusters, setClusters] = useState<Array<{ prefix: string; count: number }>>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [advancedUrl, setAdvancedUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const loadClusters = useCallback(async () => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`);
      if (!r.ok) return;
      const j = await r.json();
      if (Array.isArray(j.suggested)) setSuggested(j.suggested);
      if (Array.isArray(j.clusters)) setClusters(j.clusters.map((c: { prefix: string; count: number }) => ({ prefix: c.prefix, count: c.count })));
      if (Array.isArray(j.suite)) setConfirmed(j.suite);
    } catch {}
  }, [domain]);

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

  useEffect(() => { void loadClusters(); void fetchPicker('', '', 1); }, [loadClusters, fetchPicker]);
  useEffect(() => { debouncedFetch(query, cluster); }, [query, cluster, debouncedFetch]);

  async function verifyAndCapture(url: string): Promise<boolean> {
    setStatus(`Verifying ${url}…`);
    try {
      const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
      if (head && head.status === 404) return false;
    } catch {}
    setStatus(`Capturing ${url}…`);
    try {
      const cap = await fetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, runtime: 'rendered' }) });
      if (!cap.ok) {
        const t = await cap.text();
        setStatus(`Capture failed: ${t}`);
        return true;
      }
    } catch (e) {
      setStatus(String(e));
      return true;
    }
    setStatus(null);
    return true;
  }

  async function handlePick(url: string): Promise<void> {
    const ok = await verifyAndCapture(url);
    if (!ok) {
      setStatus(`404 — trying next in ${cluster || 'same cluster'}…`);
      const sameCluster = templateAwarePrefix(new URL(url).pathname);
      const fallback = items.find((it) => it.url !== url && it.cluster === sameCluster) ?? items.find((it) => it.url !== url);
      if (fallback) {
        setStatus(`404 — fallback to ${fallback.url}`);
        onPick(fallback.url);
        void verifyAndCapture(fallback.url);
        return;
      }
      setStatus('No fallback found');
      return;
    }
    onPick(url);
  }

  function sameDomain(url: string): boolean {
    try { return new URL(url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, ''); } catch { return false; }
  }

  return (
    <div style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 700, color: 'var(--color-ledger-charcoal)' }}>Test page picker</div>
      {clusters.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {clusters.map((c) => (
            <button key={c.prefix} type="button" onClick={() => setCluster(c.prefix)} style={{ padding: '4px 8px', borderRadius: 999, border: cluster === c.prefix ? '1px solid var(--color-uniform-green)' : '1px solid var(--color-card-border)', background: cluster === c.prefix ? 'var(--color-feed-bag-cream)' : 'white', fontSize: 12, cursor: 'pointer' }}>
              {clusterLabel(c.prefix, c.count)}
            </button>
          ))}
          {cluster && <button type="button" onClick={() => setCluster('')} style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--color-uniform-green)', cursor: 'pointer' }}>Clear</button>}
        </div>
      )}
      {suggested.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {suggested.map((u) => (
            <button key={u} type="button" onClick={() => void handlePick(u)} style={{ padding: '4px 8px', border: '1px solid var(--color-corner-gold)', borderRadius: 6, fontSize: 12, background: 'var(--color-white-surface)', cursor: 'pointer' }}>
              Template · {new URL(u).pathname.slice(0, 24)}
            </button>
          ))}
        </div>
      )}
      {confirmed.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {confirmed.slice(0, 6).map((u) => (
            <span key={u} style={{ padding: '2px 6px', borderRadius: 999, background: 'var(--color-feed-bag-cream)', fontSize: 11, border: '1px solid var(--color-card-border)' }}>{u.slice(0, 40)}</span>
          ))}
        </div>
      )}
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all found pages (url/title/path)" style={{ padding: '6px 8px', border: '1px solid var(--color-card-border)', borderRadius: 6, fontSize: 12 }} />
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((it) => (
          <button key={it.url} type="button" onClick={() => void handlePick(it.url)} style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid var(--color-card-border)', borderRadius: 6, background: 'white', cursor: 'pointer' }}>
            <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</div>
            <div style={{ fontSize: 11, color: 'var(--color-mulch-brown)', display: 'flex', gap: 8 }}><span>{it.cluster}</span><span>last checked {new Date(it.lastSeen).toLocaleDateString()}</span></div>
            <div style={{ fontSize: 11, color: 'var(--color-mulch-brown)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.url}</div>
          </button>
        ))}
        {items.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-mulch-brown)' }}>No results</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-mulch-brown)' }}><span>Total {total}</span><span>Page {page}</span></div>
      {status && <div style={{ fontSize: 12, color: 'var(--color-uniform-green)' }}>{status}</div>}
      <details>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Advanced — Enter another URL</summary>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={advancedUrl} onChange={(e) => setAdvancedUrl(e.target.value)} placeholder="https://example.com/product/..." style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--color-card-border)', borderRadius: 6, fontSize: 12 }} />
          <button type="button" onClick={() => { if (!advancedUrl.startsWith('http')) { setStatus('URL must start with http'); return; } if (!sameDomain(advancedUrl)) { setStatus('Same-domain only (ad hoc)'); return; } void handlePick(advancedUrl); }} style={{ padding: '6px 10px', fontSize: 12, background: 'var(--color-uniform-green)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Use</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-mulch-brown)', marginTop: 4 }}>Ad hoc URLs are same-domain verified and marked ad hoc.</div>
      </details>
    </div>
  );
}
