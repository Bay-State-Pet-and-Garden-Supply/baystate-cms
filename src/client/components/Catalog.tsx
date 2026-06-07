import React, { useState, useEffect } from 'react';
import { listProducts, getConnection, type ProductIndexItem } from '../api';

const STYLE_RULES = `
  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 24px;
    margin-top: 24px;
  }
  .product-card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
    position: relative;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .product-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 20px -8px rgba(0, 0, 0, 0.12), 0 4px 6px -2px rgba(0, 0, 0, 0.04);
    border-color: #cbd5e1;
  }
  .card-image-container {
    height: 180px;
    background: #f8fafc;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-bottom: 1px solid #f1f5f9;
  }
  .card-image {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    transition: transform 0.3s ease;
  }
  .product-card:hover .card-image {
    transform: scale(1.05);
  }
  .card-image-fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #94a3b8;
    padding: 16px;
    text-align: center;
  }
  .card-content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
  .card-sku {
    font-family: monospace;
    font-size: 11px;
    color: #64748b;
    margin-bottom: 4px;
    letter-spacing: 0.5px;
  }
  .card-title {
    font-size: 14px;
    font-weight: 600;
    color: #1e293b;
    line-height: 1.4;
    margin: 0 0 12px 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 38px;
  }
  .card-footer {
    margin-top: auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 12px;
    border-top: 1px dashed #f1f5f9;
  }
  .card-price {
    font-size: 16px;
    font-weight: 700;
    color: #0f172a;
  }
  .card-badge-container {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 10;
  }
  .card-badge-right-container {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 10;
  }
  .card-badge {
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    color: #ffffff;
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  }
  .view-toggle-container {
    display: flex;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    background: #f1f5f9;
    padding: 2px;
  }
  .view-toggle-btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 6px;
    border-radius: 6px;
    transition: all 0.15s ease;
  }
  .view-toggle-btn.active {
    background: #ffffff;
    color: #2563eb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .settings-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    width: 260px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
    padding: 12px;
    z-index: 50;
  }
  .media-url-input {
    flex-grow: 1;
    padding: 8px 12px;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    outline: none;
    transition: all 0.15s ease;
  }
  .media-url-input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }
  .cog-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #ffffff;
    color: #475569;
    cursor: pointer;
    transition: all 0.15s;
  }
  .cog-btn:hover {
    background: #f8fafc;
    border-color: #94a3b8;
    color: #0f172a;
  }
`;

function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = text;
  return txt.value;
}

function ProductImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (error || !src) {
    return (
      <div className="card-image-fallback">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8, color: '#94a3b8' }}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>No Image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      className="card-image"
      onError={() => setError(true)}
    />
  );
}

interface Props {
  onSelectProduct: (sku: string) => void;
  onShowChangeSets: () => void;
}

export function Catalog({ onSelectProduct, onShowChangeSets }: Props) {
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // View settings
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('shopsite_catalog_view_mode') as 'grid' | 'list') || 'grid';
  });
  const [mediaUrl, setMediaUrl] = useState(() => {
    return localStorage.getItem('shopsite_media_url') || '';
  });
  const [showSettings, setShowSettings] = useState(false);

  // Pagination states
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);

  const fetchProducts = async (currentPage: number, currentStatus: string, currentSearch: string, limit: number) => {
    setLoading(true);
    setError('');
    try {
      const offset = (currentPage - 1) * limit;
      const res = await listProducts(currentStatus || undefined, currentSearch || undefined, limit, offset);
      setProducts(res.products);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!localStorage.getItem('shopsite_media_url')) {
      getConnection().then(res => {
        if (res.connection && res.connection.cgiBaseUrl) {
          try {
            const url = new URL(res.connection.cgiBaseUrl);
            const derivedMediaUrl = `${url.protocol}//${url.host}/media/`;
            setMediaUrl(derivedMediaUrl);
            localStorage.setItem('shopsite_media_url', derivedMediaUrl);
          } catch (e) {
            console.error('Failed to parse cgiBaseUrl:', e);
          }
        }
      }).catch(err => {
        console.error('Failed to load connection settings:', err);
      });
    }
  }, []);

  useEffect(() => {
    fetchProducts(page, status, activeSearch, pageSize);
  }, [page, status, activeSearch, pageSize]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(search);
    setPage(1);
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setPage(1);
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  };

  const handlePrevPage = () => {
    if (page > 1) {
      setPage(p => p - 1);
    }
  };

  const handleNextPage = () => {
    if (page < Math.ceil(total / pageSize)) {
      setPage(p => p + 1);
    }
  };

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('shopsite_catalog_view_mode', mode);
  };

  const handleMediaUrlChange = (url: string) => {
    setMediaUrl(url);
    localStorage.setItem('shopsite_media_url', url);
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    title: { fontSize: 24, fontWeight: 600 },
    controlsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' as any },
    searchForm: { display: 'flex', gap: 8, flex: 1, minWidth: 280 },
    rightControls: { display: 'flex', gap: 12, alignItems: 'center' },
    input: { padding: '6px 12px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4, flex: 1 },
    select: { padding: '6px 12px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 },
    button: { padding: '6px 16px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4 },
    table: { width: '100%', borderCollapse: 'collapse' as any },
    th: { textAlign: 'left' as any, padding: '8px 12px', borderBottom: '2px solid #e5e7eb', fontSize: 13, fontWeight: 600, color: '#6b7280' },
    td: { padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontSize: 14, cursor: 'pointer' },
    row: { cursor: 'pointer' },
    badge: { padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff' },
    loading: { textAlign: 'center' as any, padding: 40, color: '#6b7280' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 4, marginBottom: 16 },
    empty: { textAlign: 'center' as any, padding: 40, color: '#9ca3af' },
    navBtn: { padding: '6px 16px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4 },
    pagination: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb', flexWrap: 'wrap', gap: 12 },
    paginationInfo: { fontSize: 14, color: '#6b7280' },
    paginationControls: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    pageBtn: { padding: '6px 12px', fontSize: 14, background: '#fff', border: '1px solid #d1d5db', borderRadius: 4, color: '#374151', minWidth: 80, textAlign: 'center' },
    pageIndicator: { fontSize: 14, color: '#374151', margin: '0 8px' },
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={styles.container}>
      <style>{STYLE_RULES}</style>
      <div style={styles.header}>
        <h1 style={styles.title}>Products</h1>
        <button style={styles.navBtn} onClick={onShowChangeSets}>Change Sets</button>
      </div>

      <div style={styles.controlsRow}>
        <form style={styles.searchForm} onSubmit={handleSearch}>
          <input
            style={styles.input}
            placeholder="Search by SKU or name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select style={styles.select} value={status} onChange={e => handleStatusChange(e.target.value)}>
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <button style={styles.button} type="submit">Search</button>
        </form>

        <div style={styles.rightControls}>
          <div className="view-toggle-container">
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => handleViewModeChange('grid')}
              title="Storefront Grid"
              style={{ padding: '6px 10px' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => handleViewModeChange('list')}
              title="Table List"
              style={{ padding: '6px 10px' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </div>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="cog-btn"
              title="Media Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>

            {showSettings && (
              <div className="settings-popover">
                <h4 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Media Settings</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>Media Base URL</label>
                  <input
                    className="media-url-input"
                    type="text"
                    placeholder="e.g. https://store.example.com/media/"
                    value={mediaUrl}
                    onChange={e => handleMediaUrlChange(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 8px' }}
                  />
                  {!mediaUrl && (
                    <span style={{ fontSize: 10, color: '#f59e0b' }}>⚠️ Set URL to load product images</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {loading ? (
        <div style={styles.loading}>Loading products...</div>
      ) : products.length === 0 ? (
        <div style={styles.empty}>
          <p>No products found.</p>
          <p>Use the Setup link at the top to import products from ShopSite XML.</p>
        </div>
      ) : (
        <>
          {viewMode === 'grid' ? (
            <div className="catalog-grid">
              {products.map(p => (
                <div key={p.sku} className="product-card" onClick={() => onSelectProduct(p.sku)}>
                  <div className="card-badge-container">
                    <span className="card-badge" style={{
                      background: p.status === 'active' ? '#16a34a' : p.status === 'draft' ? '#f59e0b' : '#6b7280',
                    }}>
                      {p.status}
                    </span>
                  </div>
                  <div className="card-badge-right-container">
                    <span className="card-badge" style={{
                      background: p.syncStatus === 'synced' ? '#16a34a' : p.syncStatus === 'pending' ? '#f59e0b' : p.syncStatus === 'failed' ? '#dc2626' : '#9ca3af',
                    }}>
                      {p.syncStatus}
                    </span>
                  </div>
                  <div className="card-image-container">
                    <ProductImage
                      src={p.primaryImage ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + p.primaryImage : '') : ''}
                      alt={decodeHtmlEntities(p.title)}
                      title={decodeHtmlEntities(p.title)}
                    />
                  </div>
                  <div className="card-content">
                    <div className="card-sku">{p.sku}</div>
                    <h3 className="card-title" title={decodeHtmlEntities(p.title)}>{decodeHtmlEntities(p.title)}</h3>
                    <div className="card-footer">
                      <span className="card-price">{p.price ? `$${p.price}` : '—'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>SKU</th>
                  <th style={styles.th}>Name</th>
                  <th style={styles.th}>Price</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Sync</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => (
                  <tr key={p.sku} style={styles.row} onClick={() => onSelectProduct(p.sku)}>
                    <td style={styles.td}><strong>{p.sku}</strong></td>
                    <td style={styles.td}>{decodeHtmlEntities(p.title)}</td>
                    <td style={styles.td}>{p.price ? `$${p.price}` : '-'}</td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.badge,
                        background: p.status === 'active' ? '#16a34a' : p.status === 'draft' ? '#f59e0b' : '#6b7280',
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.badge,
                        background: p.syncStatus === 'synced' ? '#16a34a' : p.syncStatus === 'pending' ? '#f59e0b' : p.syncStatus === 'failed' ? '#dc2626' : '#9ca3af',
                      }}>
                        {p.syncStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={styles.pagination}>
            <div style={styles.paginationInfo}>
              Showing {Math.min((page - 1) * pageSize + 1, total)} to {Math.min(page * pageSize, total)} of {total} products
            </div>
            <div style={styles.paginationControls}>
              <button 
                type="button"
                style={{ ...styles.pageBtn, opacity: page === 1 ? 0.5 : 1, cursor: page === 1 ? 'not-allowed' : 'pointer' }}
                onClick={handlePrevPage}
                disabled={page === 1}
              >
                Previous
              </button>
              <span style={styles.pageIndicator}>Page {page} of {totalPages}</span>
              <button 
                type="button"
                style={{ ...styles.pageBtn, opacity: page >= totalPages ? 0.5 : 1, cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
                onClick={handleNextPage}
                disabled={page >= totalPages}
              >
                Next
              </button>
              
              <select 
                style={styles.select} 
                value={pageSize} 
                onChange={e => handlePageSizeChange(Number(e.target.value))}
              >
                <option value={25}>25 per page</option>
                <option value={50}>50 per page</option>
                <option value={100}>100 per page</option>
                <option value={200}>200 per page</option>
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

