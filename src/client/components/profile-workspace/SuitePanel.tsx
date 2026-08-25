// story: e06s02 — guided upstream panel showing Found on site vs You confirmed + waiver
// story: e07s02 — conservative clustering + suggested reps + operator override
import React, { useEffect, useState, useCallback } from 'react';
import { colors, fonts, rounded } from '../../theme';

type Inventory = { candidateCount: number; confirmedCount: number; freshness: string | null };
type Cluster = { key: string; prefix: string; count: number; fingerprint: string; suggestedUrl: string };
type SuiteResp = { suite: string[]; inventory: Inventory; clusters?: Cluster[]; suggested?: string[]; filtered?: { count: number; reason: string }; overrides?: unknown[] };
type CatalogItem = { url: string; title: string; cluster: string; lastSeen?: string };

function getDomainPath(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

function isValidCluster(c: unknown): c is Cluster {
  return Boolean(c && typeof c === 'object' && 'prefix' in (c as Record<string, unknown>));
}

function _hasOverride(overrides: unknown[] | undefined, key: string): boolean {
  if (!overrides) return false;
  return overrides.some((o) => (o as Record<string, string>).clusterKey === key);
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  const d = ((...a: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
  return d;
}

export function SuitePanel({
  domain,
  suiteResp: propSuiteResp,
  onRefresh: propRefresh,
  activeUrl,
  onSelectActive,
}: {
  domain: string;
  suiteResp?: SuiteResp | null;
  onRefresh?: () => void | Promise<void>;
  activeUrl?: string | null;
  onSelectActive?: (url: string) => void | Promise<void>;
}) {
  const [data, setData] = useState<SuiteResp | null>(propSuiteResp ?? null);
  const [waiverReason, setWaiverReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [waiverSuccess, setWaiverSuccess] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [overrideInput, setOverrideInput] = useState('');
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCluster, setSelectedCluster] = useState('');
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(false);

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

  const fetchCatalog = useCallback(async (q: string, cl: string, p: number) => {
    if (!domain) return;
    setCatalogLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('query', q);
      if (cl) params.set('cluster', cl);
      params.set('page', String(p));
      params.set('limit', '10');
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/inventory-picker?${params}`);
      if (!r.ok) return;
      const j = await r.json();
      setCatalogItems(j.items ?? []);
      setCatalogTotal(j.total ?? 0);
      setCatalogPage(j.page ?? 1);
    } catch (_err) {
      // Catalog fetch non-fatal
    } finally {
      setCatalogLoading(false);
    }
  }, [domain]);

  const debouncedFetchCatalog = useCallback(
    debounce((q: string, cl: string) => { void fetchCatalog(q, cl, 1); }, 300) as unknown as (q: string, cl: string) => void,
    [fetchCatalog]
  );

  useEffect(() => {
    if (propSuiteResp !== undefined) { setData(propSuiteResp); return; }
    void load();
  }, [domain, propSuiteResp]);

  useEffect(() => {
    if (propSuiteResp !== undefined && propSuiteResp) setData(propSuiteResp);
  }, [propSuiteResp]);

  useEffect(() => {
    void fetchCatalog('', '', 1);
  }, [fetchCatalog]);

  useEffect(() => {
    debouncedFetchCatalog(searchQuery, selectedCluster);
  }, [searchQuery, selectedCluster, debouncedFetchCatalog]);

  if (!domain) return null;
  if (error) {
    return (
      <div
        role="alert"
        style={{
          fontFamily: fonts.body,
          fontSize: '0.875rem',
          color: colors.signetBurgundy,
          background: colors.whiteSurface,
          border: `1px solid ${colors.signetBurgundy}`,
          borderLeft: `4px solid ${colors.signetBurgundy}`,
          borderRadius: rounded.lg,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{error}</span>
        <button
          type="button"
          onClick={() => { setError(null); void load(); }}
          style={{
            background: colors.signetBurgundy,
            color: colors.feedBagCream,
            border: 'none',
            borderRadius: rounded.sm,
            padding: '6px 12px',
            fontFamily: fonts.body,
            fontSize: '0.75rem',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data || !data.inventory || !Array.isArray(data.suite)) {
    return (
      <div style={{ fontFamily: fonts.body, fontSize: '0.875rem', color: colors.mulchBrown, background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, padding: 16 }}>
        Loading inventory…
      </div>
    );
  }

  const candidateCount = data.inventory.candidateCount ?? 0;
  const needWaiver = candidateCount < 3 && data.suite.length < 3;
  const waiverValid = waiverReason.trim().length >= 8;
  const clusters = (data.clusters ?? []).filter(isValidCluster);
  const suggested = data.suggested ?? [];
  const filtered = data.filtered;

  const saveSuite = async (urls: string[]) => {
    const nextUrls = urls.slice(0, 10);
    // Optimistically update local data immediately for instant responsive UI
    setData((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        suite: nextUrls,
        inventory: {
          ...prev.inventory,
          confirmedCount: nextUrls.length,
        },
      };
    });
    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: nextUrls, actor: 'operator' }),
      });
      if (!res.ok) {
        setError(await res.text());
        if (propRefresh) void propRefresh(); else void load();
      } else {
        if (propRefresh) void propRefresh();
        if (nextUrls.length > 0 && (!activeUrl || !nextUrls.includes(activeUrl))) {
          void onSelectActive?.(nextUrls[0]);
        }
      }
    } catch (e) {
      setError(String(e));
      if (propRefresh) void propRefresh(); else void load();
    }
  };

  const toggleUrlInSuite = async (url: string) => {
    const isPresent = data.suite.includes(url);
    const next = isPresent ? data.suite.filter((x) => x !== url) : [...data.suite, url];
    await saveSuite(next);
  };

  const _useSuggested = async () => {
    if (suggested.length === 0) return;
    await saveSuite(suggested.slice(0, 3));
  };

  const handleWaiver = async () => {
    if (!waiverValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/waiver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: waiverReason, actor: 'operator' }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || 'Waiver failed');
      } else {
        setWaiverSuccess(`Waiver recorded — "${waiverReason.trim()}"`);
        setWaiverReason('');
        if (propRefresh) await propRefresh(); else await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const postOverride = async (clusterKey: string, action: string) => {
    setOverrideMsg(null);
    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/cluster-overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterKey, action, actor: 'operator' }),
      });
      if (!res.ok) setError(await res.text());
      else {
        setOverrideMsg(`${action} ${clusterKey} recorded`);
        if (propRefresh) await propRefresh(); else await load();
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const replaceSuggested = async () => {
    if (!overrideInput.startsWith('http')) {
      setError('Replace URL must start with http');
      return;
    }
    await postOverride(overrideInput, 'replace');
    setOverrideInput('');
  };

  return (
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          background: colors.uniformGreen,
          color: colors.feedBagCream,
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            1. Test Pages
          </span>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              background: data.suite.length >= 3 ? colors.seedlingGreen : colors.shadowPine,
              color: colors.feedBagCream,
              padding: '2px 8px',
              borderRadius: rounded.sm,
              border: '1px solid rgba(250,249,242,0.2)',
            }}
          >
            {data.suite.length}/3 Confirmed
          </span>

          {collapsed && data.suite.length > 0 && (
            <span style={{ fontSize: 11, color: colors.feedBagCream, opacity: 0.85, marginLeft: 6 }}>
              ({data.suite.map(getDomainPath).join(', ')})
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            aria-label="What is Test Pages?"
            aria-expanded={helpOpen}
            onClick={(e) => {
              e.stopPropagation();
              setHelpOpen((v) => !v);
            }}
            style={{
              background: 'transparent',
              color: colors.feedBagCream,
              border: '1px solid rgba(250,249,242,0.4)',
              borderRadius: rounded.sm,
              width: 22,
              height: 22,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: fonts.body,
              fontWeight: 700,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ?
          </button>

          <span
            style={{
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              color: colors.feedBagCream,
              background: 'rgba(250,249,242,0.15)',
              padding: '3px 8px',
              borderRadius: rounded.sm,
            }}
          >
            {collapsed ? '▼ Expand' : '▲ Collapse'}
          </span>
        </div>
      </div>

      {!collapsed && (
        <>
          {helpOpen && (
            <div style={{ padding: '10px 16px', background: colors.feedBagCream, borderBottom: `1px solid ${colors.cardBorder}`, fontFamily: fonts.body, fontSize: '0.8125rem', color: colors.ledgerCharcoal, lineHeight: 1.5 }}>
              Select 3 representative product URLs to verify your profile selectors across multiple products.
            </div>
          )}

          {waiverSuccess && (
            <div role="status" style={{ margin: '12px 16px 0', padding: '8px 12px', background: colors.feedBagCream, border: `1px solid ${colors.signetBurgundy}`, borderLeft: `4px solid ${colors.signetBurgundy}`, borderRadius: rounded.sm, fontFamily: fonts.body, fontSize: '0.8125rem', color: colors.ledgerCharcoal }}>
              <span style={{ background: colors.signetBurgundy, color: colors.feedBagCream, padding: '2px 6px', borderRadius: rounded.sm, fontSize: '0.7rem', fontWeight: 700, marginRight: 8, textTransform: 'uppercase' }}>
                Waiver
              </span>
              {waiverSuccess}
            </div>
          )}

          {overrideMsg && (
            <div role="status" style={{ margin: '12px 16px 0', padding: '8px 12px', background: 'rgba(22, 132, 77, 0.08)', border: `1px solid ${colors.seedlingGreen}`, borderRadius: rounded.sm, fontFamily: fonts.body, fontSize: '0.8125rem', color: colors.uniformGreen, fontWeight: 600 }}>
              {overrideMsg}
            </div>
          )}

          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 1. Searchable Product Catalog (Browse all products) */}
        <div style={{ padding: 14, background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
                Search All Product Pages ({catalogTotal.toLocaleString()} found on {domain})
              </div>
              <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.ledgerCharcoal, marginTop: 2 }}>
                Search or filter product pages across the brand's sitemap:
              </div>
            </div>
          </div>

          {/* Search bar & cluster filter chips */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search product title, slug, or path (e.g. shampoo, spray)..."
              style={{
                flex: 1,
                minWidth: 240,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                padding: '8px 12px',
                fontFamily: fonts.body,
                fontSize: 13,
                color: colors.ledgerCharcoal,
                background: colors.whiteSurface,
              }}
            />

            {clusters.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCluster('');
                    void fetchCatalog(searchQuery, '', 1);
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: rounded.full,
                    border: `1px solid ${selectedCluster === '' ? colors.uniformGreen : colors.cardBorder}`,
                    background: selectedCluster === '' ? colors.uniformGreen : colors.feedBagCream,
                    color: selectedCluster === '' ? colors.feedBagCream : colors.ledgerCharcoal,
                    fontFamily: fonts.body,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  All ({catalogTotal})
                </button>
                {clusters.map((c) => {
                  const isSelected = selectedCluster === c.prefix;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => {
                        const next = isSelected ? '' : c.prefix;
                        setSelectedCluster(next);
                        void fetchCatalog(searchQuery, next, 1);
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: rounded.full,
                        border: `1px solid ${isSelected ? colors.uniformGreen : colors.cardBorder}`,
                        background: isSelected ? colors.uniformGreen : colors.feedBagCream,
                        color: isSelected ? colors.feedBagCream : colors.ledgerCharcoal,
                        fontFamily: fonts.mono,
                        fontSize: 11,
                        fontWeight: isSelected ? 700 : 500,
                        cursor: 'pointer',
                      }}
                    >
                      {c.prefix} ({c.count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Product Items List */}
          {catalogLoading ? (
            <div style={{ padding: 16, textAlign: 'center', color: colors.mulchBrown, fontSize: 12 }}>
              Searching product catalog…
            </div>
          ) : catalogItems.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: colors.mulchBrown, fontSize: 12, background: colors.feedBagCream, borderRadius: rounded.sm }}>
              No matching product pages found for "{searchQuery}".
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {catalogItems.map((item) => {
                const isSelected = data.suite.includes(item.url);
                return (
                  <div
                    key={item.url}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '8px 12px',
                      background: isSelected ? 'rgba(22, 132, 77, 0.08)' : colors.feedBagCream,
                      border: `1px solid ${isSelected ? colors.seedlingGreen : colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      transition: 'all 0.1s ease',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => void toggleUrlInSuite(item.url)}
                        style={{ accentColor: colors.uniformGreen, width: 16, height: 16, cursor: 'pointer' }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: fonts.body, fontSize: 13, fontWeight: 600, color: colors.ledgerCharcoal, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.title || getDomainPath(item.url)}
                        </div>
                        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {getDomainPath(item.url)}
                        </div>
                      </div>
                    </label>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => void toggleUrlInSuite(item.url)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: rounded.sm,
                          border: `1px solid ${isSelected ? colors.seedlingGreen : colors.cardBorder}`,
                          background: isSelected ? colors.seedlingGreen : colors.whiteSurface,
                          color: isSelected ? colors.feedBagCream : colors.ledgerCharcoal,
                          fontFamily: fonts.body,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {isSelected ? '✓ In Suite' : '+ Add to Suite'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination and custom URL add */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${colors.cardBorder}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                disabled={catalogPage <= 1 || catalogLoading}
                onClick={() => void fetchCatalog(searchQuery, selectedCluster, catalogPage - 1)}
                style={{
                  padding: '4px 10px',
                  background: colors.feedBagCream,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  fontSize: 11,
                  fontFamily: fonts.body,
                  fontWeight: 600,
                  cursor: catalogPage <= 1 ? 'not-allowed' : 'pointer',
                  opacity: catalogPage <= 1 ? 0.5 : 1,
                }}
              >
                Previous
              </button>
              <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>
                Page {catalogPage} of {Math.max(1, Math.ceil(catalogTotal / 10))}
              </span>
              <button
                type="button"
                disabled={catalogPage * 10 >= catalogTotal || catalogLoading}
                onClick={() => void fetchCatalog(searchQuery, selectedCluster, catalogPage + 1)}
                style={{
                  padding: '4px 10px',
                  background: colors.feedBagCream,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  fontSize: 11,
                  fontFamily: fonts.body,
                  fontWeight: 600,
                  cursor: catalogPage * 10 >= catalogTotal ? 'not-allowed' : 'pointer',
                  opacity: catalogPage * 10 >= catalogTotal ? 0.5 : 1,
                }}
              >
                Next
              </button>
            </div>
          </div>
        </div>

        {/* 2. Confirmed Suite Cards (3 Samples) */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
                Selected Representative Suite ({data.suite.length}/3 products)
              </div>
              {data.suite.length < 3 && (
                <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.signetBurgundy, fontWeight: 600 }}>
                  (Need {3 - data.suite.length} more to reach recommended 3)
                </span>
              )}
            </div>
          </div>

          {data.suite.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', border: `1px dashed ${colors.cardBorder}`, borderRadius: rounded.sm, background: colors.feedBagCream, color: colors.mulchBrown, fontSize: 12 }}>
              No product pages selected yet. Search and checkmark products above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.suite.map((u, idx) => (
                <div
                  key={u}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    background: colors.feedBagCream,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.sm,
                    padding: '8px 12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        fontFamily: fonts.body,
                        fontSize: 10,
                        fontWeight: 700,
                        background: colors.cardBorder,
                        color: colors.mulchBrown,
                        padding: '2px 7px',
                        borderRadius: rounded.sm,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Sample #{idx + 1}
                    </span>
                    <span
                      title={u}
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 12,
                        color: colors.ledgerCharcoal,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getDomainPath(u)}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => void toggleUrlInSuite(u)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: colors.mulchBrown,
                        cursor: 'pointer',
                        padding: '4px 8px',
                        fontSize: 14,
                        fontWeight: 700,
                      }}
                      title="Remove sample from suite"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template Clusters & Overrides */}
        <details style={{ background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, padding: 12 }}>
          <summary style={{ cursor: 'pointer', fontFamily: fonts.body, fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Template Clusters & Advanced Overrides ({clusters.length} clusters)
          </summary>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>
              Clusters: {clusters.map((c) => `${c.prefix} (${c.count})`).join(', ') || 'None'}
              {filtered && filtered.count > 0 && ` · ${filtered.count} filtered as parked`}
            </div>

            {/* Overrides action row */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {clusters.length >= 2 && (
                <button
                  type="button"
                  onClick={() => postOverride(clusters[1].key, 'merge')}
                  style={{
                    padding: '4px 10px',
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.sm,
                    fontFamily: fonts.body,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Merge {clusters[1].prefix} → {clusters[0].prefix}
                </button>
              )}
              {clusters.map((c) => (
                <button
                  key={`split-${c.key}`}
                  type="button"
                  onClick={() => postOverride(c.key, 'split')}
                  style={{
                    padding: '4px 10px',
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.sm,
                    fontFamily: fonts.body,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Split {c.prefix}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input
                placeholder="https://... Replace suggestedUrl"
                value={overrideInput}
                onChange={(e) => setOverrideInput(e.target.value)}
                style={{
                  flex: 1,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  padding: '6px 10px',
                  fontFamily: fonts.mono,
                  fontSize: 12,
                }}
              />
              <button
                type="button"
                onClick={replaceSuggested}
                style={{
                  padding: '6px 12px',
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Replace
              </button>
            </div>
            <div style={{ display: 'none' }}>cluster-overrides</div>
          </div>
        </details>

        {/* Waiver Card */}
        {needWaiver && (
          <div
            style={{
              padding: 14,
              background: colors.whiteSurface,
              border: `1px solid ${colors.signetBurgundy}`,
              borderLeft: `4px solid ${colors.signetBurgundy}`,
              borderRadius: rounded.sm,
              boxShadow: '0 2px 6px rgba(118,12,25,0.08)',
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: '1rem', fontWeight: 700, color: colors.ledgerCharcoal, margin: 0, paddingBottom: 6, borderBottom: `1px dotted ${colors.cornerCalloutGold}` }}>
              Ledger entry — waiver required (&lt;3 product URLs)
            </div>
            <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.mulchBrown, margin: '6px 0 10px' }}>
              Signet Burgundy ledger entry: less than 3 confirmed sample products are available on this domain. Provide an audited operator reason.
            </div>
            <input
              aria-invalid={waiverReason.length > 0 && !waiverValid}
              aria-describedby="waiver-help"
              placeholder="Reason for waiver (min 8 characters)"
              value={waiverReason}
              onChange={(e) => setWaiverReason(e.target.value)}
              style={{
                width: '100%',
                border: `1px solid ${waiverReason.length > 0 && !waiverValid ? colors.signetBurgundy : colors.cardBorder}`,
                borderRadius: rounded.sm,
                padding: '8px 10px',
                fontFamily: fonts.body,
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
            <div id="waiver-help" style={{ fontFamily: fonts.body, fontSize: 11, color: waiverReason.length > 0 && !waiverValid ? colors.signetBurgundy : colors.mulchBrown, marginTop: 4 }}>
              {waiverReason.length > 0 && !waiverValid ? 'Keep typing — 8 characters minimum.' : 'Reason for waiver (minimum 8 characters).'}
            </div>
            <button
              type="button"
              disabled={!waiverValid || submitting}
              onClick={handleWaiver}
              style={{
                marginTop: 10,
                padding: '7px 16px',
                background: waiverValid ? colors.signetBurgundy : colors.feedBagCream,
                color: waiverValid ? colors.feedBagCream : colors.mulchBrown,
                border: waiverValid ? `1px solid ${colors.burgundyDark}` : `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                cursor: waiverValid && !submitting ? 'pointer' : 'not-allowed',
                opacity: waiverValid ? 1 : 0.6,
              }}
            >
              {submitting ? 'Recording…' : 'Create waiver'}
            </button>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}

