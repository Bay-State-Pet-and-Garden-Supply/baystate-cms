import React, { useState, useEffect } from 'react';
import { listProducts, type ProductIndexItem } from '../api';

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

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    title: { fontSize: 24, fontWeight: 600 },
    searchRow: { display: 'flex', gap: 8, marginBottom: 16 },
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
      <div style={styles.header}>
        <h1 style={styles.title}>Products</h1>
        <button style={styles.navBtn} onClick={onShowChangeSets}>Change Sets</button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <form style={styles.searchRow} onSubmit={handleSearch}>
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

      {loading ? (
        <div style={styles.loading}>Loading products...</div>
      ) : products.length === 0 ? (
        <div style={styles.empty}>
          <p>No products found.</p>
          <p>Use the Setup link at the top to import products from ShopSite XML.</p>
        </div>
      ) : (
        <>
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
                  <td style={styles.td}>{p.title}</td>
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
