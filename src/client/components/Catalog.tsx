import React, { useState, useEffect } from 'react';
import { listProducts, type ProductIndexItem } from '../api';

interface Props {
  onSelectProduct: (sku: string) => void;
  onShowChangeSets: () => void;
}

export function Catalog({ onSelectProduct, onShowChangeSets }: Props) {
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchProducts = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listProducts(status || undefined, search || undefined);
      setProducts(res.products);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProducts(); }, [status]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchProducts();
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
  };

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
        <select style={styles.select} value={status} onChange={e => setStatus(e.target.value)}>
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
      )}
    </div>
  );
}
