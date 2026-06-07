import React, { useState, useEffect } from 'react';
import { getProduct, saveDraft, getConnection, listFieldRegistry, type ProductDetail as ProductDetailType } from '../api';

function ProductImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (error || !src) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', textAlign: 'center', padding: 16 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, color: '#94a3b8' }}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>No Image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      onError={() => setError(true)}
    />
  );
}

function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = text;
  return txt.value;
}

interface Props {
  sku: string;
  onBack: () => void;
}

export function ProductDetail({ sku, onBack }: Props) {
  const [data, setData] = useState<ProductDetailType | null>(null);
  const [registry, setRegistry] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRegistry, setLoadingRegistry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});

  const [mediaUrl, setMediaUrl] = useState(() => {
    return localStorage.getItem('shopsite_media_url') || '';
  });

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
    setLoadingRegistry(true);
    listFieldRegistry().then(res => {
      // Filter out non-editable fields and 'SKU' from editable fields list
      const editableFields = res.entries.filter((e: any) => e.editable && e.xmlField !== 'SKU');
      setRegistry(editableFields);
      setLoadingRegistry(false);
    }).catch(err => {
      console.error('Failed to load field registry:', err);
      setLoadingRegistry(false);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    getProduct(sku).then(d => {
      setData(d);
      const product = d.product as any;
      
      // Initialize field values based on product data
      const values: Record<string, any> = {};
      
      values['Name'] = decodeHtmlEntities(product?.core?.name ?? '');
      values['Price'] = product?.core?.price ?? '';
      values['SaleAmount'] = product?.core?.salePrice ?? '';
      values['ProductDescription'] = decodeHtmlEntities(product?.core?.description ?? '');
      values['Weight'] = product?.core?.weight ?? '';
      values['Taxable'] = product?.core?.taxable ?? false;
      values['Graphic'] = product?.core?.media?.primary ?? '';
      values['MoreInformationGraphic'] = product?.core?.media?.primary ?? '';
      values['QuantityOnHand'] = product?.core?.inventory?.quantityOnHand ?? '';
      values['Availability'] = product?.core?.availability ?? '';
      
      if (product?.customFields) {
        Object.entries(product.customFields).forEach(([k, v]) => {
          values[k] = v;
        });
      }
      
      setFieldValues(values);
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
      const core: any = {};
      const customFields: Record<string, string> = {};
      
      Object.entries(fieldValues).forEach(([field, val]) => {
        if (field === 'Name') core.name = val;
        else if (field === 'Price') core.price = val || null;
        else if (field === 'SaleAmount') core.salePrice = val || null;
        else if (field === 'ProductDescription') core.description = val || null;
        else if (field === 'Weight') core.weight = val || null;
        else if (field === 'Taxable') core.taxable = !!val;
        else if (field === 'Graphic') {
          if (!core.media) core.media = { primary: null, additional: [] };
          core.media.primary = val || null;
        }
        else if (field === 'MoreInformationGraphic') {
          if (!core.media) core.media = { primary: null, additional: [] };
          if (!core.media.primary) core.media.primary = val || null;
        }
        else if (field === 'QuantityOnHand') {
          if (!core.inventory) core.inventory = { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null };
          core.inventory.quantityOnHand = val !== '' && val !== null && val !== undefined && val !== '' ? parseInt(val, 10) : null;
        }
        else if (field === 'Availability') core.availability = val || null;
        else if (field.startsWith('ProductField')) {
          customFields[field] = val || '';
        }
      });
      
      const result = await saveDraft(sku, {
        core,
        customFields,
      });
      setMessage(`Draft saved to change set ${result.changeSetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 800 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 8 },
    subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 24 },
    field: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
    input: { width: '100%', padding: '8px 12px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' as any },
    buttonRow: { display: 'flex', gap: 8, marginTop: 24 },
    button: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4 },
    back: { padding: '8px 20px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, marginBottom: 20 },
    error: { color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0' },
    message: { color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0' },
    info: { fontSize: 12, color: '#9ca3af', marginTop: 16 },
    sectionTitle: { fontSize: 16, fontWeight: 600, borderBottom: '1px solid #e5e7eb', paddingBottom: 6, marginTop: 24, marginBottom: 16, color: '#111827' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 },
  };

  if (loading || loadingRegistry) return <div style={{ padding: 24, color: '#6b7280' }}>Loading product details...</div>;
  if (error) return <div style={{ padding: 24 }}><div style={styles.error}>{error}</div><button style={styles.back} onClick={onBack}>Back</button></div>;

  const primaryImage = (data?.product as any)?.core?.media?.primary;
  const imageUrl = primaryImage ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + primaryImage : '') : '';

  // Split registry into core and custom
  const coreFields = registry.filter(e => e.kind === 'core');
  const customFieldsList = registry.filter(e => e.kind === 'custom');

  // Find Name and Description
  const nameField = coreFields.find(e => e.xmlField === 'Name');
  const descField = coreFields.find(e => e.xmlField === 'ProductDescription');
  const otherCoreFields = coreFields.filter(e => e.xmlField !== 'Name' && e.xmlField !== 'ProductDescription');

  const renderFieldInput = (entry: any) => {
    const value = fieldValues[entry.xmlField] ?? '';
    const onChange = (val: any) => {
      setFieldValues(prev => ({ ...prev, [entry.xmlField]: val }));
    };

    if (entry.xmlField === 'ProductDescription') {
      return (
        <div key={entry.xmlField} style={styles.field}>
          <label style={styles.label}>{entry.label}</label>
          <textarea
            style={{ ...styles.input, minHeight: 100, fontFamily: 'inherit' }}
            value={value}
            onChange={e => onChange(e.target.value)}
          />
        </div>
      );
    }

    if (entry.dataType === 'boolean') {
      return (
        <div key={entry.xmlField} style={{ ...styles.field, display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 16 }}>
          <input
            type="checkbox"
            id={entry.xmlField}
            checked={!!value}
            onChange={e => onChange(e.target.checked)}
            style={{ cursor: 'pointer', width: 16, height: 16 }}
          />
          <label htmlFor={entry.xmlField} style={{ ...styles.label, marginBottom: 0, cursor: 'pointer' }}>
            {entry.label}
          </label>
        </div>
      );
    }

    return (
      <div key={entry.xmlField} style={styles.field}>
        <label style={styles.label}>{entry.label}</label>
        <input
          type={entry.dataType === 'number' ? 'number' : 'text'}
          style={styles.input}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={entry.dataType === 'number' ? '0.00' : ''}
          step={entry.dataType === 'number' ? 'any' : undefined}
        />
      </div>
    );
  };

  const nameVal = fieldValues['Name'] ?? '';

  return (
    <div style={styles.container}>
      <button style={styles.back} onClick={onBack}>← Back to Catalog</button>
      <h1 style={styles.title}>{sku}</h1>
      <p style={styles.subtitle}>
        {data?.hasDraft ? '🖊️ Has unsaved draft' : '✓ Approved version'}
        {data?.changeSetId ? ` — Change Set: ${data.changeSetId.slice(0, 8)}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 32, marginTop: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', maxWidth: 300 }}>
          <div style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 260,
            overflow: 'hidden',
          }}>
            <ProductImage
              src={imageUrl}
              alt={decodeHtmlEntities(nameVal)}
              title={decodeHtmlEntities(nameVal)}
            />
          </div>
          {primaryImage && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 10, textAlign: 'center', fontFamily: 'monospace' }}>
              📁 {primaryImage}
            </div>
          )}
        </div>
        
        <div style={{ flex: '2 2 300px' }}>
          {nameField && renderFieldInput(nameField)}
          
          {otherCoreFields.length > 0 && (
            <div style={styles.grid}>
              {otherCoreFields.map(e => renderFieldInput(e))}
            </div>
          )}
          
          {descField && renderFieldInput(descField)}
          
          {customFieldsList.length > 0 && (
            <>
              <h3 style={styles.sectionTitle}>Custom Fields</h3>
              <div style={styles.grid}>
                {customFieldsList.map(e => renderFieldInput(e))}
              </div>
            </>
          )}

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
      </div>
    </div>
  );
}
