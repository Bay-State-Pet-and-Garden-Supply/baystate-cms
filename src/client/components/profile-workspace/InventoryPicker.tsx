// story: e07s02 + oracle picker S1 — General Store (Operate)
import React, { useEffect, useState, useCallback } from 'react';
import { templateAwarePrefix } from '../../../onboarding/template-clustering';
import { getExtractorProfiles } from '../../onboarding-api';
import { colors, fonts, rounded } from '../../theme';

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
  const [showAll, setShowAll] = useState(true);
  const [storedPattern, setStoredPattern] = useState<string | null>(null);
  const clusters = (suiteResp?.clusters ?? []) as Array<{ prefix: string; count: number }>;
  const suggested = (suiteResp?.suggested ?? []) as string[];
  const confirmed = (suiteResp?.suite ?? []) as string[];

  const fetchPicker = useCallback(async (q: string, cl: string, p: number) => {
    const params = new URLSearchParams();
    if (q) params.set('query', q);
    if (cl) params.set('cluster', cl);
    params.set('page', String(p));
    params.set('limit', '10');
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
  useEffect(() => {
    let cancelled = false;
    getExtractorProfiles().then((r) => {
      if (cancelled) return;
      const found = (r.extractorProfiles as Array<{ domain: string; sitemapProductUrlPattern?: string | null }>).find((p) => p.domain === domain || p.domain === domain.replace(/^www\./, '') || domain.includes(p.domain));
      const raw = found?.sitemapProductUrlPattern;
      if (raw) {
        try {
          const path = raw.startsWith('http') ? new URL(raw).pathname : raw;
          const seg = path.split('/').filter(Boolean)[0];
          const pref = seg ? `/${seg}` : path;
          const normalized = templateAwarePrefix(pref.startsWith('/') ? `https://x${pref}/x` : `https://x/${pref}/x`);
          if (normalized) setStoredPattern(normalized);
          else setStoredPattern(pref);
        } catch { setStoredPattern(raw); }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [domain]);

  useEffect(() => {
    if (!cluster) {
      if (storedPattern) { setCluster(storedPattern); return; }
      if (clusters.length > 0) {
        const productCluster = clusters.find((c) => c.prefix.includes('product')) ?? clusters[0];
        if (productCluster) setCluster(productCluster.prefix);
      }
    }
  }, [clusters, cluster, storedPattern]);

  async function handlePick(url: string): Promise<void> {
    setStatus(`Picked ${new URL(url).pathname} — confirming…`);
    try { await onPick(url); setStatus(null); } catch (e) { setStatus(String(e)); }
  }

  function sameDomain(url: string): boolean {
    try { return new URL(url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, ''); } catch { return false; }
  }

  return (
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Discovered Pages
          </div>
          <div style={{ fontFamily: fonts.display, fontSize: '1.125rem', fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>
            Test Page Picker
          </div>
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.mulchBrown }}>
          {total.toLocaleString()} pages found
        </div>
      </div>

      {clusters.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {clusters.map((c) => {
            const active = cluster === c.prefix;
            return (
              <button
                key={c.prefix}
                type="button"
                onClick={() => setCluster(c.prefix)}
                aria-pressed={active}
                style={{
                  padding: '5px 12px',
                  borderRadius: rounded.full,
                  border: `1px solid ${active ? colors.uniformGreen : colors.cardBorder}`,
                  background: active ? colors.uniformGreen : colors.whiteSurface,
                  color: active ? colors.feedBagCream : colors.ledgerCharcoal,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: active ? '0 1px 2px rgba(20,83,45,0.15)' : 'none',
                  transition: 'all 150ms ease',
                }}
              >
                <span>{clusterLabel(c.prefix, c.count)}</span>
              </button>
            );
          })}
          {cluster && (
            <button
              type="button"
              onClick={() => setCluster('')}
              style={{
                padding: '4px 8px',
                background: 'none',
                border: 'none',
                color: colors.uniformGreen,
                fontFamily: fonts.body,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {suggested.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ width: '100%', fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Suggested Templates
          </span>
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
                  borderRadius: rounded.sm,
                  border: `1px solid ${colors.cardBorder}`,
                  background: colors.whiteSurface,
                  boxShadow: '0 1px 2px rgba(33,20,20,0.05)',
                  cursor: 'pointer',
                  transition: 'all 150ms ease',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.cornerCalloutGold, flexShrink: 0 }} aria-hidden />
                <span style={{ maxWidth: '22ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: fonts.body, fontSize: 12, fontWeight: 600, color: colors.ledgerCharcoal }}>
                  {label.slice(0, 32)}
                </span>
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>
                  · capture & verify
                </span>
              </button>
            );
          })}
        </div>
      )}

      {confirmed.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Confirmed Reps:
          </span>
          {confirmed.slice(0, 6).map((u) => {
            let p = u;
            try { p = new URL(u).pathname; } catch {}
            return (
              <span
                key={u}
                title={u}
                style={{
                  padding: '3px 9px',
                  borderRadius: rounded.full,
                  background: colors.feedBagCream,
                  border: `1px solid ${colors.cardBorder}`,
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  color: colors.ledgerCharcoal,
                }}
              >
                {p.slice(0, 24)}
              </span>
            );
          })}
          {confirmed.length > 6 && <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown }}>+{confirmed.length - 6} more</span>}
        </div>
      )}

      {!showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            width: '100%',
            padding: '10px 14px',
            borderRadius: rounded.sm,
            border: `1px dashed ${colors.cardBorder}`,
            background: colors.feedBagCream,
            fontFamily: fonts.body,
            fontSize: 12,
            fontWeight: 600,
            color: colors.mulchBrown,
            cursor: 'pointer',
          }}
        >
          Show all {total.toLocaleString()} pages — filtered to {cluster || '/products'} ({items.length} shown)
        </button>
      )}

      {showAll && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.mulchBrown }}>
              Search Filtered Pages
            </span>
            <button
              type="button"
              onClick={() => setShowAll(false)}
              style={{
                background: 'none',
                border: 'none',
                color: colors.uniformGreen,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Collapse
            </button>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by URL path or page title…"
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: rounded.sm,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.whiteSurface,
                fontFamily: fonts.body,
                fontSize: 13,
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => {
                e.target.style.borderColor = colors.uniformGreen;
                e.target.style.boxShadow = '0 0 0 2px rgba(20,83,45,0.12)';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = colors.cardBorder;
                e.target.style.boxShadow = 'none';
              }}
            />
          </label>

          <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}>
            {items.map((it) => (
              <button
                key={it.url}
                type="button"
                onClick={() => void handlePick(it.url)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: rounded.sm,
                  border: `1px solid ${colors.cardBorder}`,
                  background: colors.whiteSurface,
                  boxShadow: '0 1px 2px rgba(33,20,20,0.04)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.feedBagCream;
                  e.currentTarget.style.borderColor = colors.uniformGreen;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.whiteSurface;
                  e.currentTarget.style.borderColor = colors.cardBorder;
                }}
              >
                <div style={{ fontFamily: fonts.body, fontSize: 13, fontWeight: 600, lineHeight: 1.3, color: colors.ledgerCharcoal, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {it.title || new URL(it.url).pathname}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={{ padding: '2px 7px', borderRadius: rounded.full, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, fontFamily: fonts.mono, fontSize: 10, color: colors.ledgerCharcoal }}>
                    {it.cluster}
                  </span>
                  <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>
                    last checked {new Date(it.lastSeen).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {it.url}
                </div>
              </button>
            ))}
            {items.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', borderRadius: rounded.sm, border: `1px dashed ${colors.cardBorder}`, background: colors.feedBagCream }}>
                <div style={{ fontFamily: fonts.body, fontSize: 13, fontWeight: 600, color: colors.ledgerCharcoal }}>No pages found</div>
                <div style={{ marginTop: 4, fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>Try clearing filters or enter an ad hoc URL below.</div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${colors.cardBorder}`, paddingTop: 8, fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown }}>
            <span>{total.toLocaleString()} total ({clusters.length} template clusters)</span>
            <span>Page {page}</span>
          </div>

          {status && (
            <div style={{ padding: '8px 12px', borderRadius: rounded.sm, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, fontFamily: fonts.body, fontSize: 12, fontWeight: 600, color: colors.uniformGreen }} role="status">
              {status}
            </div>
          )}

          <details style={{ borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, background: colors.feedBagCream, padding: '10px 14px' }}>
            <summary style={{ cursor: 'pointer', fontFamily: fonts.body, fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, listStyle: 'none' }}>
              Advanced — Enter another URL <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: colors.mulchBrown }}>(same-domain verification)</span>
            </summary>
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <input
                value={advancedUrl}
                onChange={(e) => setAdvancedUrl(e.target.value)}
                placeholder="https://example.com/products/specific-item"
                style={{ flex: 1, padding: '7px 10px', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, background: colors.whiteSurface, fontFamily: fonts.mono, fontSize: 12 }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!advancedUrl.startsWith('http')) { setStatus('URL must start with http'); return; }
                  if (!sameDomain(advancedUrl)) { setStatus('Same-domain only — ad hoc URLs stay within this domain'); return; }
                  void handlePick(advancedUrl);
                }}
                style={{
                  padding: '7px 16px',
                  borderRadius: rounded.sm,
                  border: 'none',
                  background: colors.uniformGreen,
                  color: colors.feedBagCream,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(20,83,45,0.15)',
                }}
              >
                Capture URL
              </button>
            </div>
            <div style={{ marginTop: 6, fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>
              Ad hoc URLs are captured and tested on the fly without altering the confirmed suite until saved.
            </div>
          </details>
        </>
      )}
    </div>
  );
}

