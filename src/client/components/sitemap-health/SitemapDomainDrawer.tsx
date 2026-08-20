import React, { useState, useEffect } from 'react';
import {
  getSitemapDomainDetail,
  getSitemapDomainUrls,
  refreshSitemapDomain,
  testSitemapLookup,
  deleteSitemapUrl,
  deleteSitemapUrls,
} from '../../onboarding-api';
import type {
  SitemapDomainDetailResponse,
  BrandUrlsListResponse,
  SitemapTestLookupResponse,
  BrandUrlItem,
} from '../../../shared/schemas/onboarding';
import { colors } from '../../theme';

interface SitemapDomainDrawerProps {
  domain: string;
  onClose: () => void;
  onRefreshComplete?: () => void;
}

export function SitemapDomainDrawer({ domain, onClose, onRefreshComplete }: SitemapDomainDrawerProps) {
  const [activeTab, setActiveTab] = useState<'urls' | 'sandbox' | 'history'>('urls');
  const [detail, setDetail] = useState<SitemapDomainDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // URLs tab state
  const [urlsData, setUrlsData] = useState<BrandUrlsListResponse | null>(null);
  const [urlSearch, setUrlSearch] = useState('');
  const [pageTypeFilter, setPageTypeFilter] = useState<string>('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [pageOffset, setPageOffset] = useState(0);
  const [urlsLoading, setUrlsLoading] = useState(false);

  // URL deletion state
  const [selectedUrlIds, setSelectedUrlIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  // Sandbox tab state
  const [testUpc, setTestUpc] = useState('');
  const [testName, setTestName] = useState('');
  const [testSku, setTestSku] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<SitemapTestLookupResponse | null>(null);

  const loadDetail = async () => {
    try {
      setLoading(true);
      const data = await getSitemapDomainDetail(domain);
      setDetail(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadUrls = async (offset = pageOffset) => {
    try {
      setUrlsLoading(true);
      const data = await getSitemapDomainUrls(domain, {
        search: urlSearch.trim() || undefined,
        page_type: pageTypeFilter || undefined,
        active: activeOnly,
        limit: 50,
        offset,
      });
      setUrlsData(data);
    } catch (err) {
      console.error('Failed to load URLs:', err);
    } finally {
      setUrlsLoading(false);
    }
  };

  useEffect(() => {
    loadDetail();
  }, [domain]);

  useEffect(() => {
    if (activeTab === 'urls') {
      loadUrls(0);
      setPageOffset(0);
      setSelectedUrlIds(new Set());
    }
  }, [activeTab, urlSearch, pageTypeFilter, activeOnly]);

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      await refreshSitemapDomain(domain);
      await loadDetail();
      if (activeTab === 'urls') await loadUrls();
      onRefreshComplete?.();
    } catch (err) {
      alert(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDeleteSingle = async (item: BrandUrlItem) => {
    const confirmMsg = `Remove this URL from the index?\n\n${item.url}`;
    if (!window.confirm(confirmMsg)) return;

    try {
      setDeletingIds((prev) => new Set(prev).add(item.id));
      await deleteSitemapUrl(domain, item.id);
      setSelectedUrlIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      await loadUrls();
      await loadDetail();
      onRefreshComplete?.();
    } catch (err) {
      alert(`Failed to delete URL: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedUrlIds.size === 0) return;
    const confirmMsg = `Are you sure you want to remove ${selectedUrlIds.size} selected URLs from the index?`;
    if (!window.confirm(confirmMsg)) return;

    try {
      setBatchDeleting(true);
      const idsToDelete = Array.from(selectedUrlIds);
      await deleteSitemapUrls(domain, idsToDelete);
      setSelectedUrlIds(new Set());
      await loadUrls();
      await loadDetail();
      onRefreshComplete?.();
    } catch (err) {
      alert(`Failed to delete selected URLs: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBatchDeleting(false);
    }
  };

  const handleToggleSelectAllVisible = () => {
    if (!urlsData || urlsData.urls.length === 0) return;
    const visibleIds = urlsData.urls.map((u) => u.id);
    const allSelected = visibleIds.every((id) => selectedUrlIds.has(id));

    if (allSelected) {
      setSelectedUrlIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedUrlIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.add(id);
        return next;
      });
    }
  };

  const handleToggleSelectRow = (id: string) => {
    setSelectedUrlIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRunTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testUpc.trim() && !testName.trim() && !testSku.trim()) return;
    try {
      setTesting(true);
      const res = await testSitemapLookup(domain, {
        upc: testUpc.trim() || undefined,
        name: testName.trim() || undefined,
        sku: testSku.trim() || undefined,
      });
      setTestResults(res);
    } catch (err) {
      alert(`Test lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const allVisibleSelected =
    Boolean(urlsData && urlsData.urls.length > 0 && urlsData.urls.every((u) => selectedUrlIds.has(u.id)));

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '840px',
        maxWidth: '92vw',
        background: '#ffffff',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 24px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#f8fafc',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600, color: '#0f172a' }}>
              {domain}
            </h2>
            {detail && (
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  background:
                    detail.summary.status === 'healthy'
                      ? '#dcfce7'
                      : detail.summary.status === 'stale'
                      ? '#fef3c7'
                      : detail.summary.status === 'error'
                      ? '#fee2e2'
                      : '#f1f5f9',
                  color:
                    detail.summary.status === 'healthy'
                      ? '#166534'
                      : detail.summary.status === 'stale'
                      ? '#92400e'
                      : detail.summary.status === 'error'
                      ? '#991b1b'
                      : '#475569',
                }}
              >
                {detail.summary.status}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
            <span style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 500 }}>Mapped Brands:</span>
            {detail?.summary.brandAssociations && detail.summary.brandAssociations.length > 0 ? (
              detail.summary.brandAssociations.map((b) => (
                <span
                  key={b.id || b.brandName}
                  style={{
                    fontSize: '0.75rem',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: '#e0f2fe',
                    color: '#0369a1',
                    border: '1px solid #bae6fd',
                    fontWeight: 600,
                  }}
                >
                  🏷️ {b.brandName}
                </span>
              ))
            ) : (
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: '#fef3c7',
                  color: '#92400e',
                  border: '1px dashed #fcd34d',
                  fontWeight: 500,
                }}
              >
                ⚠️ No brands mapped to this domain
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              padding: '6px 14px',
              fontSize: '0.85rem',
              fontWeight: 500,
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              cursor: refreshing ? 'not-allowed' : 'pointer',
              opacity: refreshing ? 0.7 : 1,
            }}
          >
            {refreshing ? 'Refreshing...' : '↻ Refresh Sitemap'}
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #e2e8f0',
          padding: '0 24px',
          background: '#ffffff',
        }}
      >
        {(['urls', 'sandbox', 'history'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '12px 18px',
              fontSize: '0.9rem',
              fontWeight: activeTab === tab ? 600 : 500,
              color: activeTab === tab ? '#2563eb' : '#64748b',
              borderBottom: activeTab === tab ? '2px solid #2563eb' : '2px solid transparent',
              background: 'none',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
              cursor: 'pointer',
            }}
          >
            {tab === 'urls' && `URL Inventory (${detail?.summary.activeUrlsCount ?? 0})`}
            {tab === 'sandbox' && 'Test Matcher Sandbox'}
            {tab === 'history' && 'Refresh History'}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading && <div style={{ color: '#64748b' }}>Loading domain details...</div>}
        {error && <div style={{ color: '#dc2626' }}>Error: {error}</div>}

        {!loading && activeTab === 'urls' && (
          <div>
            {/* Search and filters */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Search URL, title, or brand..."
                value={urlSearch}
                onChange={(e) => setUrlSearch(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: '180px',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.85rem',
                }}
              />
              <select
                value={pageTypeFilter}
                onChange={(e) => setPageTypeFilter(e.target.value)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.85rem',
                }}
              >
                <option value="">All Page Types</option>
                <option value="product">Products only</option>
                <option value="category">Categories</option>
                <option value="article">Articles</option>
                <option value="other">Other</option>
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: '#475569' }}>
                <input
                  type="checkbox"
                  checked={activeOnly}
                  onChange={(e) => setActiveOnly(e.target.checked)}
                />
                Active only
              </label>
            </div>

            {/* Batch actions bar */}
            {selectedUrlIds.size > 0 && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  marginBottom: '12px',
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '6px',
                }}
              >
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#991b1b' }}>
                  {selectedUrlIds.size} URL{selectedUrlIds.size > 1 ? 's' : ''} selected
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setSelectedUrlIds(new Set())}
                    style={{
                      padding: '4px 10px',
                      fontSize: '0.8rem',
                      background: '#ffffff',
                      color: '#475569',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    Deselect All
                  </button>
                  <button
                    onClick={handleDeleteSelected}
                    disabled={batchDeleting}
                    style={{
                      padding: '4px 12px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      background: '#dc2626',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: batchDeleting ? 'not-allowed' : 'pointer',
                      opacity: batchDeleting ? 0.7 : 1,
                    }}
                  >
                    {batchDeleting ? 'Removing...' : `🗑️ Delete Selected (${selectedUrlIds.size})`}
                  </button>
                </div>
              </div>
            )}

            {/* URLs Table */}
            {urlsLoading ? (
              <div style={{ color: '#64748b', padding: '20px 0' }}>Loading URLs...</div>
            ) : !urlsData || urlsData.urls.length === 0 ? (
              <div style={{ color: '#94a3b8', padding: '20px 0', textAlign: 'center' }}>
                No URLs found matching your filter criteria.
              </div>
            ) : (
              <div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#475569', background: '#f8fafc' }}>
                      <th style={{ padding: '10px 8px', width: '36px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={handleToggleSelectAllVisible}
                          title="Select / Deselect all visible URLs"
                        />
                      </th>
                      <th style={{ padding: '10px 8px' }}>URL / Enriched Metadata</th>
                      <th style={{ padding: '10px 8px', width: '120px' }}>Brand</th>
                      <th style={{ padding: '10px 8px', width: '85px' }}>Type</th>
                      <th style={{ padding: '10px 8px', width: '95px' }}>Lastmod</th>
                      <th style={{ padding: '10px 8px', width: '90px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {urlsData.urls.map((u: BrandUrlItem) => {
                      const isSelected = selectedUrlIds.has(u.id);
                      const isDeleting = deletingIds.has(u.id);
                      const domainBrand = detail?.summary.brandAssociations?.[0]?.brandName;

                      return (
                        <tr
                          key={u.id}
                          style={{
                            borderBottom: '1px solid #f1f5f9',
                            background: isSelected ? '#eff6ff' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelectRow(u.id)}
                            />
                          </td>
                          <td style={{ padding: '10px 8px' }}>
                            <a
                              href={u.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: '#2563eb',
                                textDecoration: 'none',
                                fontWeight: 500,
                                wordBreak: 'break-all',
                              }}
                            >
                              {u.url}
                            </a>
                            {(u.title || u.upc || u.sku || u.brand) && (
                              <div
                                style={{
                                  fontSize: '0.75rem',
                                  color: '#64748b',
                                  marginTop: '4px',
                                  display: 'flex',
                                  gap: '8px',
                                  flexWrap: 'wrap',
                                }}
                              >
                                {u.title && <span>Title: <strong>{u.title}</strong></span>}
                                {u.brand && (
                                  <span>
                                    Brand: <strong style={{ color: '#166534' }}>{u.brand}</strong>
                                  </span>
                                )}
                                {u.upc && (
                                  <span>
                                    UPC: <code style={{ background: '#f1f5f9', padding: '1px 4px', borderRadius: '3px' }}>{u.upc}</code>
                                  </span>
                                )}
                                {u.sku && (
                                  <span>
                                    SKU: <code style={{ background: '#f1f5f9', padding: '1px 4px', borderRadius: '3px' }}>{u.sku}</code>
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '10px 8px' }}>
                            {u.brand ? (
                              <span
                                style={{
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  fontSize: '0.75rem',
                                  fontWeight: 600,
                                  background: '#f0fdf4',
                                  color: '#166534',
                                  border: '1px solid #bbf7d0',
                                  display: 'inline-block',
                                }}
                              >
                                🏷️ {u.brand}
                              </span>
                            ) : domainBrand ? (
                              <span
                                title="Assigned via domain mapping"
                                style={{
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  fontSize: '0.75rem',
                                  fontWeight: 500,
                                  background: '#f8fafc',
                                  color: '#475569',
                                  border: '1px solid #e2e8f0',
                                  display: 'inline-block',
                                }}
                              >
                                {domainBrand}
                              </span>
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '10px 8px' }}>
                            <span
                              style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                background: u.pageType === 'product' ? '#eff6ff' : '#f1f5f9',
                                color: u.pageType === 'product' ? '#1d4ed8' : '#475569',
                              }}
                            >
                              {u.pageType}
                            </span>
                          </td>
                          <td style={{ padding: '10px 8px', color: '#64748b', fontSize: '0.8rem' }}>
                            {u.lastmod ? new Date(u.lastmod).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                            <button
                              onClick={() => handleDeleteSingle(u)}
                              disabled={isDeleting}
                              title="Remove URL from index"
                              style={{
                                padding: '3px 8px',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                background: '#fee2e2',
                                color: '#991b1b',
                                border: '1px solid #fecaca',
                                borderRadius: '4px',
                                cursor: isDeleting ? 'not-allowed' : 'pointer',
                                opacity: isDeleting ? 0.5 : 1,
                              }}
                            >
                              {isDeleting ? '...' : '🗑️ Remove'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Pagination */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
                  <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
                    Showing {pageOffset + 1}–{Math.min(pageOffset + 50, urlsData.total)} of {urlsData.total}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      disabled={pageOffset === 0}
                      onClick={() => {
                        const nextOffset = Math.max(0, pageOffset - 50);
                        setPageOffset(nextOffset);
                        loadUrls(nextOffset);
                      }}
                      style={{
                        padding: '4px 10px',
                        fontSize: '0.8rem',
                        border: '1px solid #cbd5e1',
                        borderRadius: '4px',
                        background: '#ffffff',
                        cursor: pageOffset === 0 ? 'not-allowed' : 'pointer',
                        opacity: pageOffset === 0 ? 0.5 : 1,
                      }}
                    >
                      Previous
                    </button>
                    <button
                      disabled={pageOffset + 50 >= urlsData.total}
                      onClick={() => {
                        const nextOffset = pageOffset + 50;
                        setPageOffset(nextOffset);
                        loadUrls(nextOffset);
                      }}
                      style={{
                        padding: '4px 10px',
                        fontSize: '0.8rem',
                        border: '1px solid #cbd5e1',
                        borderRadius: '4px',
                        background: '#ffffff',
                        cursor: pageOffset + 50 >= urlsData.total ? 'not-allowed' : 'pointer',
                        opacity: pageOffset + 50 >= urlsData.total ? 0.5 : 1,
                      }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}


        {!loading && activeTab === 'sandbox' && (
          <div>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: 0 }}>
              Simulate how the local URL finder matches product identifiers against this domain's persistent index.
            </p>

            <form onSubmit={handleRunTest} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                    UPC / GTIN
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 038100130839"
                    value={testUpc}
                    onChange={(e) => setTestUpc(e.target.value)}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                    Distributor / Mfr SKU
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. KONG-T1"
                    value={testSku}
                    onChange={(e) => setTestSku(e.target.value)}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                  Product Name / Title
                </label>
                <input
                  type="text"
                  placeholder="e.g. Purina Pro Plan Puppy Chicken & Rice"
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button
                  type="submit"
                  disabled={testing}
                  style={{
                    padding: '8px 16px',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    background: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: testing ? 'not-allowed' : 'pointer',
                  }}
                >
                  {testing ? 'Testing...' : '⚡ Test Match'}
                </button>
              </div>
            </form>

            {testResults && (
              <div style={{ marginTop: '20px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '0.95rem', fontWeight: 600, color: '#0f172a' }}>
                  Match Results ({testResults.candidates.length})
                </h4>

                {testResults.candidates.length === 0 ? (
                  <div style={{ padding: '16px', background: '#fffbeb', border: '1px solid #fef3c7', borderRadius: '6px', color: '#92400e', fontSize: '0.85rem' }}>
                    No candidates matched from the local index for this query.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {testResults.candidates.map((cand, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '14px',
                          border: '1px solid #e2e8f0',
                          borderRadius: '6px',
                          background: cand.confidence >= 0.85 ? '#f0fdf4' : '#ffffff',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <a
                            href={cand.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#2563eb', fontWeight: 600, fontSize: '0.9rem', textDecoration: 'none' }}
                          >
                            {cand.url}
                          </a>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: '12px',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              background: cand.confidence >= 0.85 ? '#bbf7d0' : '#f1f5f9',
                              color: cand.confidence >= 0.85 ? '#166534' : '#475569',
                            }}
                          >
                            {(cand.confidence * 100).toFixed(0)}% Confidence
                          </span>
                        </div>

                        {cand.title && (
                          <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: '6px' }}>
                            Enriched Title: <strong>{cand.title}</strong>
                          </div>
                        )}

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                          <span style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#e2e8f0', borderRadius: '4px' }}>
                            Method: {cand.sourceMethod}
                          </span>
                          {cand.signals.upcMatched && (
                            <span style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#dcfce7', color: '#166534', borderRadius: '4px' }}>
                              ✓ UPC Matched
                            </span>
                          )}
                          {cand.signals.skuMatched && (
                            <span style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#dcfce7', color: '#166534', borderRadius: '4px' }}>
                              ✓ SKU Matched
                            </span>
                          )}
                          {cand.signals.tokenOverlapRatio > 0 && (
                            <span style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#eff6ff', color: '#1e40af', borderRadius: '4px' }}>
                              Token Overlap: {(cand.signals.tokenOverlapRatio * 100).toFixed(0)}%
                            </span>
                          )}
                          {cand.signals.patternMatched && (
                            <span style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#f3e8ff', color: '#6b21a8', borderRadius: '4px' }}>
                              Pattern Matched
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!loading && activeTab === 'history' && (
          <div>
            {!detail?.history || detail.history.length === 0 ? (
              <div style={{ color: '#94a3b8', padding: '20px 0', textAlign: 'center' }}>
                No refresh history recorded yet for this domain.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#475569' }}>
                    <th style={{ padding: '8px' }}>Timestamp</th>
                    <th style={{ padding: '8px' }}>Status</th>
                    <th style={{ padding: '8px' }}>URLs Observed</th>
                    <th style={{ padding: '8px' }}>Added / Inactivated</th>
                    <th style={{ padding: '8px' }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.history.map((h) => (
                    <tr key={h.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '10px 8px' }}>
                        {new Date(h.completedAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <span
                          style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            background: h.status === 'success' ? '#dcfce7' : '#fee2e2',
                            color: h.status === 'success' ? '#166534' : '#991b1b',
                          }}
                        >
                          {h.status}
                        </span>
                        {h.errorMessage && (
                          <div style={{ fontSize: '0.75rem', color: '#dc2626', marginTop: '2px' }}>
                            {h.errorMessage}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        {h.totalUrlsObserved} ({h.productUrlsEligible} products)
                      </td>
                      <td style={{ padding: '10px 8px', color: '#475569' }}>
                        +{h.addedCount} / -{h.inactivatedCount}
                      </td>
                      <td style={{ padding: '10px 8px', color: '#64748b' }}>
                        {(h.durationMs / 1000).toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
