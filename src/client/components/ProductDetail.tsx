import React, { useState, useEffect } from 'react';
import { getProduct, saveDraft, type ProductDetail as ProductDetailType } from '../api';

interface Props {
  sku: string;
  onBack: () => void;
}

export function ProductDetail({ sku, onBack }: Props) {
  const [data, setData] = useState<ProductDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  useEffect(() => {
    setLoading(true);
    getProduct(sku).then(d => {
      setData(d);
      const product = d.product as any;
      setName(product?.core?.name ?? '');
      setPrice(product?.core?.price ?? '');
      setLoading(false);
    }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
  }, [sku]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await saveDraft(sku, {
        core: { name, price: price || null },
      });
      setMessage(`Draft saved to change set ${result.changeSetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 600 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 8 },
    subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 24 },
    field: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
    input: { width: '100%', padding: '8px 12px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' as any },
    buttonRow: { display: 'flex', gap: 8, marginTop: 24 },
    button: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4 },
    back: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4 },
    error: { color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0' },
    message: { color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0' },
    info: { fontSize: 12, color: '#9ca3af', marginTop: 16 },
  };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading product...</div>;
  if (error) return <div style={{ padding: 24 }}><div style={styles.error}>{error}</div><button style={styles.back} onClick={onBack}>Back</button></div>;

  return (
    <div style={styles.container}>
      <button style={styles.back} onClick={onBack}>← Back to Catalog</button>
      <h1 style={styles.title}>{sku}</h1>
      <p style={styles.subtitle}>
        {data?.hasDraft ? '🖊️ Has unsaved draft' : '✓ Approved version'}
        {data?.changeSetId ? ` — Change Set: ${data.changeSetId.slice(0, 8)}` : ''}
      </p>

      <div style={styles.field}>
        <label style={styles.label}>Name</label>
        <input style={styles.input} value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>Price</label>
        <input style={styles.input} value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" />
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {message && <div style={styles.message}>{message}</div>}

      <div style={styles.buttonRow}>
        <button style={styles.button} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Draft'}
        </button>
      </div>

      <p style={styles.info}>
        Changes are saved to a SQLite draft change set. Git and product files are not modified until approval.
      </p>
    </div>
  );
}
