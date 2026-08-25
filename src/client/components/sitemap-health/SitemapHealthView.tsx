import React, { useState, useEffect } from 'react';
import {
  getSitemapsOverview,
  refreshSitemapDomain,
  addSitemapDomain,
  deleteSitemapDomain,
} from '../../onboarding-api';
import type {
  SitemapsOverviewResponse,
  DomainSitemapSummary,
} from '../../../shared/schemas/onboarding';
import { SitemapDomainDrawer } from './SitemapDomainDrawer';
import { normalizeBrandHubDomain } from '../../../onboarding/brand-hub/normalizeDomain';
import { getBrandHubProfileBuilderTarget } from '../../../onboarding/brand-hub/navigation';

type SitemapHealthViewProps = {
  onEditProfile?: (domain: string) => void;
};

export function SitemapHealthView({ onEditProfile }: SitemapHealthViewProps = {}) {
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingDomain, setDeletingDomain] = useState<string | null>(null);

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

  const handleDeleteDomain = async (domain: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = window.confirm(
      `Are you sure you want to remove site "${domain}" and all its indexed URLs from Sitemaps?\n\nThis will remove its sitemap cache, telemetry, and indexed URLs.`,
    );
    if (!confirmed) return;

    try {
      setDeletingDomain(domain);
      await deleteSitemapDomain(domain);
      if (selectedDomain === domain) setSelectedDomain(null);
      await loadData();
    } catch (err) {
      alert(`Failed to remove site ${domain}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingDomain(null);
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
          onClick={() => setShowAddModal(true)}
          style={{
            padding: '8px 14px',
            fontSize: '0.85rem',
            background: '#16a34a',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span>+</span> Add Site
        </button>

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
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {dom.brandAssociations && dom.brandAssociations.length > 0 ? (
                          dom.brandAssociations.map((b) => (
                            <span
                              key={b.id || b.brandName}
                              style={{
                                fontSize: '0.72rem',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                background: '#e0f2fe',
                                color: '#0369a1',
                                border: '1px solid #bae6fd',
                                fontWeight: 600,
                              }}
                            >
                              🏷️ {b.brandName && b.brandName === b.brandName.toLowerCase() ? b.brandName.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : b.brandName}
                            </span>
                          ))
                        ) : (
                          <span
                            style={{
                              fontSize: '0.72rem',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: '#f8fafc',
                              color: '#94a3b8',
                              border: '1px dashed #cbd5e1',
                            }}
                          >
                            Unassigned brand
                          </span>
                        )}
                      </div>
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
                        <span style={{ fontWeight: 600, color: '#0f172a' }}>
                          {(dom.localHitRate * 100).toFixed(0)}%
                        </span>
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
                        {onEditProfile && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const target = getBrandHubProfileBuilderTarget(dom.domain);
                              if (target) onEditProfile(target);
                            }}
                            style={{
                              padding: '4px 8px',
                              fontSize: '0.75rem',
                              borderRadius: '4px',
                              background: '#fefce8',
                              color: '#854d0e',
                              border: '1px solid #fde68a',
                              cursor: 'pointer',
                              fontWeight: 600,
                            }}
                          >
                            ✏️ Profile
                          </button>
                        )}
                        <button
                          onClick={(e) => handleDeleteDomain(dom.domain, e)}
                          disabled={deletingDomain === dom.domain}
                          title="Remove site and all indexed URLs"
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            borderRadius: '4px',
                            background: '#fef2f2',
                            color: '#dc2626',
                            border: '1px solid #fecaca',
                            cursor: deletingDomain === dom.domain ? 'not-allowed' : 'pointer',
                            opacity: deletingDomain === dom.domain ? 0.6 : 1,
                          }}
                        >
                          {deletingDomain === dom.domain ? '...' : '🗑️ Remove'}
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

      {/* Add Site Modal */}
      {showAddModal && (
        <AddSiteModal
          onClose={() => setShowAddModal(false)}
          onSuccess={(newDomain) => {
            setShowAddModal(false);
            loadData();
            setSelectedDomain(newDomain);
          }}
        />
      )}

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

interface AddSiteModalProps {
  onClose: () => void;
  onSuccess: (domain: string) => void;
}

function AddSiteModal({ onClose, onSuccess }: AddSiteModalProps) {
  const [domain, setDomain] = useState('');
  const [brandName, setBrandName] = useState('');
  const [productUrlPattern, setProductUrlPattern] = useState('');
  const [fetchNow, setFetchNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain.trim()) {
      setError('Domain is required');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const normalizedDomain = normalizeBrandHubDomain(domain);
      if (!normalizedDomain) {
        setError('Domain is required');
        setSaving(false);
        return;
      }
      const res = await addSitemapDomain({
        domain: normalizedDomain,
        brandName: brandName.trim() || undefined,
        productUrlPattern: productUrlPattern.trim() || undefined,
        fetchNow,
      });
      onSuccess(res.domain);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#ffffff',
          borderRadius: '10px',
          padding: '24px',
          width: '480px',
          maxWidth: '90vw',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600, color: '#0f172a' }}>Add Brand Site / Sitemap</h3>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', fontSize: '1.2rem', cursor: 'pointer', color: '#94a3b8' }}
          >
            ✕
          </button>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: '6px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', fontSize: '0.85rem', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
              Site Domain / URL <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. frommfamily.com or https://frommfamily.com/sitemap.xml"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '3px' }}>
              Accepts bare domain or sitemap XML URL. Standard sitemap paths will be discovered automatically.
            </div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
              Brand Name (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. Fromm Family Foods"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '3px' }}>
              Maps this brand to the domain for onboarding discovery & catalog matches.
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
              Product URL Pattern Filter (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. /products/ or /shop/"
              value={productUrlPattern}
              onChange={(e) => setProductUrlPattern(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#334155', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={fetchNow}
                onChange={(e) => setFetchNow(e.target.checked)}
              />
              <span>Fetch and index sitemap immediately</span>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                background: '#ffffff',
                color: '#475569',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 500,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: 'none',
                background: '#16a34a',
                color: '#ffffff',
                cursor: saving ? 'not-allowed' : 'pointer',
                fontSize: '0.85rem',
                fontWeight: 600,
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Adding & Fetching...' : '+ Add Site'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
