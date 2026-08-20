// story: e07s02 + oracle picker S1 — polished General Store (Operate)
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
  if (!prefix) return `All · ${count.toLocaleString()}`;
  return `${prefix} · ${count.toLocaleString()} pages`;
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
    setStatus(`Verifying ${new URL(url).pathname}…`);
    try {
      const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
      if (head && head.status === 404) return false;
    } catch {}
    setStatus(`Capturing ${new URL(url).hostname.replace(/^www\./, '')}…`);
    try {
      const cap = await fetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, runtime: 'rendered' }) });
      if (!cap.ok) {
        const t = await cap.text();
        setStatus(`Capture failed — ${t.slice(0, 80)}`);
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
      setStatus(`404 — trying next in ${cluster || 'same template'}…`);
      const sameCluster = templateAwarePrefix(new URL(url).pathname);
      const fallback = items.find((it) => it.url !== url && it.cluster === sameCluster) ?? items.find((it) => it.url !== url);
      if (fallback) {
        setStatus(`404 — fallback to ${new URL(fallback.url).pathname}`);
        onPick(fallback.url);
        void verifyAndCapture(fallback.url);
        return;
      }
      setStatus('No fallback — pick another template');
      return;
    }
    onPick(url);
  }

  function sameDomain(url: string): boolean {
    try { return new URL(url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, ''); } catch { return false; }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--color-card-border)', background: 'var(--color-white-surface)' }}>
      {/* Header — label hierarchy, generous top, tight below */}
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ledger-charcoal)]" style={{ fontFamily: 'var(--font-body)' }}>Test page picker</div>
        <div className="text-[11px] tabular-nums text-[var(--color-mulch-brown)]">{total.toLocaleString()} found</div>
      </div>

      {/* Clusters — Operate: scanable chips, Uniform Green owns selection */}
      {clusters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {clusters.map((c) => {
            const active = cluster === c.prefix;
            return (
              <button
                key={c.prefix}
                type="button"
                onClick={() => setCluster(c.prefix)}
                aria-pressed={active}
                className="rounded-full border px-3 py-1.5 text-xs font-medium transition-[background,border-color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-uniform-green)]"
                style={{
                  borderColor: active ? 'var(--color-uniform-green)' : 'var(--color-card-border)',
                  background: active ? 'var(--color-uniform-green)' : 'var(--color-white-surface)',
                  color: active ? 'var(--color-feed-bag-cream)' : 'var(--color-ledger-charcoal)',
                  boxShadow: active ? '0 1px 2px rgba(20,83,45,0.12)' : 'none',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <span className="tabular-nums">{clusterLabel(c.prefix, c.count)}</span>
              </button>
            );
          })}
          {cluster && (
            <button type="button" onClick={() => setCluster('')} className="bg-transparent px-2 py-1.5 text-xs font-medium text-[var(--color-uniform-green)] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-uniform-green)]">
              Clear
            </button>
          )}
        </div>
      )}

      {/* Suggested templates — one per cluster, Gold whispers (earned) */}
      {suggested.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="w-full text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-mulch-brown)]">Suggested templates</span>
          {suggested.map((u) => {
            let label = u;
            try { label = new URL(u).pathname; } catch {}
            return (
              <button
                key={u}
                type="button"
                onClick={() => void handlePick(u)}
                className="group flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-left shadow-sm transition-[box-shadow,transform,border-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-[1px] hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-uniform-green)]"
                style={{ borderColor: 'var(--color-card-border)' }}
                title={u}
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-corner-gold)] group-hover:bg-[var(--color-muted-gold)]" aria-hidden />
                <span className="max-w-[18ch] truncate text-xs font-semibold text-[var(--color-ledger-charcoal)]" style={{ fontFamily: 'var(--font-body)' }}>{label.slice(0, 28)}</span>
                <span className="hidden text-[11px] tabular-nums text-[var(--color-mulch-brown)] sm:inline">· verify &amp; capture</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Confirmed — pinned evidence, Feed Bag Cream */}
      {confirmed.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-mulch-brown)]">Confirmed</span>
          {confirmed.slice(0, 6).map((u) => {
            let p = u;
            try { p = new URL(u).pathname; } catch {}
            return (
              <span key={u} className="rounded-full border bg-[var(--color-feed-bag-cream)] px-2.5 py-1 text-[11px] tabular-nums" style={{ borderColor: 'var(--color-card-border)', color: 'var(--color-ledger-charcoal)' }} title={u}>
                {p.slice(0, 28)}
              </span>
            );
          })}
          {confirmed.length > 6 && <span className="text-[11px] tabular-nums text-[var(--color-mulch-brown)]">+{confirmed.length - 6} more</span>}
        </div>
      )}

      {/* Search — Operate: fast, legible, focus is Uniform Green */}
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-mulch-brown)]">Search all found pages</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search url, title, or /products path…"
          className="w-full rounded-md border bg-white px-3 py-2 text-sm placeholder:text-[var(--color-mulch-brown)]/70 focus:border-[var(--color-uniform-green)] focus:outline-none focus:ring-2 focus:ring-[var(--color-uniform-green)]/20"
          style={{ borderColor: 'var(--color-card-border)', fontFamily: 'var(--font-body)' }}
        />
      </label>

      {/* List — tight group (4px), generous outer separation, hover fully Operate */}
      <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--color-card-border) transparent' }}>
        {items.map((it) => (
          <button
            key={it.url}
            type="button"
            onClick={() => void handlePick(it.url)}
            className="group flex flex-col gap-1 rounded-md border bg-white px-3 py-2.5 text-left shadow-sm transition-[background,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-[var(--color-uniform-green)]/30 hover:bg-[var(--color-feed-bag-cream)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-uniform-green)]"
            style={{ borderColor: 'var(--color-card-border)' }}
          >
            <div className="truncate text-sm font-semibold leading-tight text-[var(--color-ledger-charcoal)] group-hover:text-[var(--color-uniform-green)]" style={{ fontFamily: 'var(--font-body)' }}>{it.title || new URL(it.url).pathname}</div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
              <span className="rounded-full bg-[var(--color-feed-bag-cream)] px-2 py-0.5 text-[var(--color-ledger-charcoal)]" style={{ border: '1px solid var(--color-card-border)' }}>{it.cluster}</span>
              <span className="text-[var(--color-mulch-brown)]">last checked {new Date(it.lastSeen).toLocaleDateString()}</span>
            </div>
            <div className="truncate text-xs tabular-nums text-[var(--color-mulch-brown)]/80">{it.url}</div>
          </button>
        ))}
        {items.length === 0 && (
          <div className="rounded-md border border-dashed bg-[var(--color-feed-bag-cream)]/60 px-3 py-8 text-center" style={{ borderColor: 'var(--color-card-border)' }}>
            <div className="text-sm font-medium text-[var(--color-ledger-charcoal)]">No results</div>
            <div className="mt-1 text-xs text-[var(--color-mulch-brown)]">Try a different term, clear the cluster filter, or use Advanced for an ad hoc URL.</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-2 text-[11px] tabular-nums" style={{ borderColor: 'var(--color-card-border)', color: 'var(--color-mulch-brown)' }}>
        <span>{total.toLocaleString()} total · {clusters.length} templates</span><span>Page {page}</span>
      </div>

      {status && <div className="rounded-md bg-[var(--color-feed-bag-cream)] px-3 py-2 text-xs font-medium text-[var(--color-uniform-green)]" role="status">{status}</div>}

      {/* Advanced — collapsed, same-domain guard, earned Gold only on action */}
      <details className="group rounded-md border bg-[var(--color-feed-bag-cream)]/40 px-3 py-2 open:bg-white" style={{ borderColor: 'var(--color-card-border)' }}>
        <summary className="cursor-pointer list-none text-xs font-semibold text-[var(--color-ledger-charcoal)] marker:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-uniform-green)]">Advanced — Enter another URL <span className="ml-2 text-[11px] font-normal normal-case tracking-normal text-[var(--color-mulch-brown)]">same-domain, verified, marked ad hoc</span></summary>
        <div className="mt-3 flex gap-2">
          <input
            value={advancedUrl}
            onChange={(e) => setAdvancedUrl(e.target.value)}
            placeholder="https://example.com/product/..."
            className="flex-1 rounded-md border bg-white px-3 py-2 text-sm focus:border-[var(--color-uniform-green)] focus:outline-none focus:ring-2 focus:ring-[var(--color-uniform-green)]/20"
            style={{ borderColor: 'var(--color-card-border)' }}
          />
          <button
            type="button"
            onClick={() => { if (!advancedUrl.startsWith('http')) { setStatus('URL must start with http'); return; } if (!sameDomain(advancedUrl)) { setStatus('Same-domain only — ad hoc URLs stay within this domain'); return; } void handlePick(advancedUrl); }}
            className="rounded-md bg-[var(--color-uniform-green)] px-4 py-2 text-xs font-semibold text-white shadow-sm transition-[background,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-[var(--color-shadow-pine)] active:translate-y-[1px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-uniform-green)]"
          >
            Use
          </button>
        </div>
        <div className="mt-2 text-[11px] leading-relaxed text-[var(--color-mulch-brown)]">Ad hoc URLs are verified and captured like any template page, but are marked ad hoc — they don’t change your confirmed suite until you confirm them.</div>
      </details>
    </div>
  );
}
