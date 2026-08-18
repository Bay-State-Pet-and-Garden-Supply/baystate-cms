import React, { useState, useEffect } from 'react';
import { getSitemapsOverview, refreshSitemapDomain } from '../../onboarding-api';
import type {
  SitemapsOverviewResponse,
  DomainSitemapSummary,
} from '../../../shared/schemas/onboarding';
import { SitemapDomainDrawer } from './SitemapDomainDrawer';

export function SitemapHealthView() {
  const [data, setData] = useState<SitemapsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);

  // Selected domain for drawer
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [refreshingDomains, setRefreshingDomains] = useState<Set<string>>(new Set());

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await getSitemapsOverview({
        status: statusFilter || undefined,
        attention: attentionOnly || undefined,
        search: search.trim() || undefined,
      });
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [statusFilter, attentionOnly, search]);

  const handleRefreshSingle = async (domain: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setRefreshingDomains((prev) => new Set(prev).add(domain));
      await refreshSitemapDomain(domain);
      await loadData();
    } catch (err) {
      alert(`Refresh failed for ${domain}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshingDomains((prev) => {
        const next = new Set(prev);
        next.delete(domain);
        return next;
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Metric Cards Banner */}
      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
          }}
        >
          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
              Total Brand Domains
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>
              {data.totals.totalDomains}
            </div>
          </div>

          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#166534', fontWeight: 600, textTransform: 'uppercase' }}>
              Healthy Sitemaps
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#16a34a', marginTop: '4px' }}>
              {data.totals.healthyCount}
            </div>
          </div>

          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#92400e', fontWeight: 600, textTransform: 'uppercase' }}>
              Needs Attention
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: data.totals.needsAttentionCount > 0 ? '#d97706' : '#64748b', marginTop: '4px' }}>
              {data.totals.needsAttentionCount}
            </div>
          </div>

          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
              Indexed Product URLs
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#2563eb', marginTop: '4px' }}>
              {data.totals.totalProductUrls.toLocaleString()}
            </div>
          </div>

          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
              Local Hit Rate
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>
              {(data.totals.overallLocalHitRate * 100).toFixed(0)}%
            </div>
          </div>

          <div style={{ background: '#ffffff', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
              Serper Calls Avoided
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#16a34a', marginTop: '4px' }}>
              {data.totals.totalSerperCallsAvoided}
            </div>
          </div>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          background: '#ffffff',
          padding: '16px',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="text"
          placeholder="Filter by domain or brand name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: '220px',
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            fontSize: '0.85rem',
          }}
        />

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            fontSize: '0.85rem',
          }}
        >
          <option value="">All Health Statuses</option>
          <option value="healthy">Healthy</option>
          <option value="stale">Stale (&gt;14d)</option>
          <option value="missing">Missing / Unfetched</option>
          <option value="error">Error</option>
          <option value="blocked">Blocked</option>
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: '#475569' }}>
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(e) => setAttentionOnly(e.target.checked)}
          />
          Needs Attention only
        </label>

        <button
          onClick={loadData}
          style={{
            padding: '8px 14px',
            fontSize: '0.85rem',
            background: '#f1f5f9',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          ↻ Refresh Overview
        </button>
      </div>

      {/* Domain Table */}
      <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
        {loading && <div style={{ padding: '24px', color: '#64748b' }}>Loading sitemaps...</div>}
        {error && <div style={{ padding: '24px', color: '#dc2626' }}>Error: {error}</div>}

        {!loading && data && data.domains.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center', color: '#94a3b8' }}>
            No brand domains match the current filters.
          </div>
        )}

        {!loading && data && data.domains.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#475569' }}>
                <th style={{ padding: '12px 16px' }}>Domain & Mapped Brands</th>
                <th style={{ padding: '12px 16px', width: '110px' }}>Health</th>
                <th style={{ padding: '12px 16px', width: '120px' }}>URLs (Active/Prod)</th>
                <th style={{ padding: '12px 16px', width: '110px' }}>Local Hit Rate</th>
                <th style={{ padding: '12px 16px', width: '150px' }}>Last Refreshed</th>
                <th style={{ padding: '12px 16px', width: '130px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.domains.map((dom: DomainSitemapSummary) => {
                const isRefreshing = refreshingDomains.has(dom.domain);

                return (
                  <tr
                    key={dom.domain}
                    onClick={() => setSelectedDomain(dom.domain)}
                    style={{
                      borderBottom: '1px solid #f1f5f9',
                      cursor: 'pointer',
                      background: dom.needsAttention ? '#fffdfa' : '#ffffff',
                    }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>{dom.domain}</div>
                      {dom.brandAssociations && dom.brandAssociations.length > 0 && (
                        <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                          {dom.brandAssociations.map((b) => b.brandName).join(', ')}
                        </div>
                      )}
                      {dom.attentionReasons && dom.attentionReasons.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                          {dom.attentionReasons.map((reason) => (
                            <span
                              key={reason}
                              style={{
                                fontSize: '0.7rem',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: '#fef3c7',
                                color: '#92400e',
                                fontWeight: 500,
                              }}
                            >
                              ⚠ {reason.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    <td style={{ padding: '12px 16px' }}>
                      <span
                        style={{
                          padding: '3px 8px',
                          borderRadius: '12px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          background:
                            dom.status === 'healthy'
                              ? '#dcfce7'
                              : dom.status === 'stale'
                              ? '#fef3c7'
                              : dom.status === 'error'
                              ? '#fee2e2'
                              : dom.status === 'blocked'
                              ? '#f3e8ff'
                              : '#f1f5f9',
                          color:
                            dom.status === 'healthy'
                              ? '#166534'
                              : dom.status === 'stale'
                              ? '#92400e'
                              : dom.status === 'error'
                              ? '#991b1b'
                              : dom.status === 'blocked'
                              ? '#6b21a8'
                              : '#475569',
                        }}
                      >
                        {dom.status}
                      </span>
                    </td>

                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{dom.activeUrlsCount}</span>
                      <span style={{ color: '#64748b' }}> / {dom.productUrlsCount} prod</span>
                    </td>

                    <td style={{ padding: '12px 16px' }}>
                      {dom.totalLookups > 0 ? (
                        <div>
                          <span style={{ fontWeight: 600, color: '#0f172a' }}>
                            {(dom.localHitRate * 100).toFixed(0)}%
                          </span>
                          <div style={{ fontSize: '0.75rem', color: '#16a34a' }}>
                            {dom.serperCallsAvoided} saved
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>

                    <td style={{ padding: '12px 16px', color: '#64748b' }}>
                      {dom.lastRefreshedAt ? (
                        <div>
                          <div>{new Date(dom.lastRefreshedAt).toLocaleDateString()}</div>
                          {dom.lastRefreshDurationMs && (
                            <div style={{ fontSize: '0.75rem' }}>
                              {(dom.lastRefreshDurationMs / 1000).toFixed(1)}s
                            </div>
                          )}
                        </div>
                      ) : (
                        <span>Never</span>
                      )}
                    </td>

                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={(e) => handleRefreshSingle(dom.domain, e)}
                          disabled={isRefreshing}
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            borderRadius: '4px',
                            background: '#eff6ff',
                            color: '#1d4ed8',
                            border: '1px solid #bfdbfe',
                            cursor: isRefreshing ? 'not-allowed' : 'pointer',
                            opacity: isRefreshing ? 0.6 : 1,
                          }}
                        >
                          {isRefreshing ? '...' : '↻ Refresh'}
                        </button>
                        <button
                          onClick={() => setSelectedDomain(dom.domain)}
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            borderRadius: '4px',
                            background: '#f8fafc',
                            color: '#334155',
                            border: '1px solid #cbd5e1',
                            cursor: 'pointer',
                          }}
                        >
                          Inspect →
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Slide-over Domain Drawer */}
      {selectedDomain && (
        <SitemapDomainDrawer
          domain={selectedDomain}
          onClose={() => setSelectedDomain(null)}
          onRefreshComplete={loadData}
        />
      )}
    </div>
  );
}
