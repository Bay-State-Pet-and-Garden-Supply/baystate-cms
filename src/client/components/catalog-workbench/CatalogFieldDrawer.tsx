import React, { useState, useEffect } from 'react';
import { getCatalogFieldDetail } from '../../api';
import type { CatalogFieldDetail, TopValueEntry } from './types';

interface CatalogFieldDrawerProps {
  xmlField: string;
  label: string;
  onClose: () => void;
  onSelectProduct: (sku: string) => void;
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(15, 23, 42, 0.4)',
  zIndex: 200,
  display: 'flex',
  justifyContent: 'flex-end',
};

const DRAWER_STYLE: React.CSSProperties = {
  width: 520,
  maxWidth: '100vw',
  background: '#fff',
  boxShadow: '-4px 0 20px rgba(0,0,0,0.1)',
  overflowY: 'auto',
  padding: 24,
};

export function CatalogFieldDrawer({ xmlField, label, onClose, onSelectProduct }: CatalogFieldDrawerProps) {
  const [detail, setDetail] = useState<CatalogFieldDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCatalogFieldDetail(xmlField)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [xmlField]);

  return (
    <div style={OVERLAY_STYLE} onClick={onClose}>
      <div style={DRAWER_STYLE} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{label}</h2>
            <code style={{ fontSize: 12, color: '#6b7280' }}>{xmlField}</code>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading field details...</div>
        ) : detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Field info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <InfoTile label="Kind" value={detail.kind} />
              <InfoTile label="Data Type" value={detail.dataType} />
              <InfoTile label="Inferred Mode" value={detail.inferredValueMode} />
              <InfoTile label="Non-empty" value={String(detail.nonEmptyCount)} />
              <InfoTile label="Distinct Values" value={String(detail.distinctCount)} />
              <InfoTile label="Empty Rate" value={`${(detail.emptyRate * 100).toFixed(1)}%`} />
            </div>

            {/* Top values */}
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Top Values ({detail.topValues.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 250, overflowY: 'auto' }}>
                {detail.topValues.slice(0, 20).map((tv: TopValueEntry) => (
                  <div key={tv.value} style={{ fontSize: 12, padding: '6px 8px', background: '#f8fafc', borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>{tv.value}</div>
                    <div style={{ color: '#64748b', fontSize: 11 }}>
                      {tv.frequency} product(s)
                      {tv.skus.length > 0 && (
                        <span style={{ marginLeft: 8 }}>
                          — SKUs: {tv.skus.map(s => (
                            <button key={s} onClick={() => onSelectProduct(s)} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline', marginRight: 4 }}>{s}</button>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sample values */}
            {detail.sampleValues.length > 0 && (
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Sample Values</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {detail.sampleValues.slice(0, 10).map(v => (
                    <span key={v} style={{ fontSize: 11, background: '#f1f5f9', padding: '2px 8px', borderRadius: 4, color: '#475569' }}>{v}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Example SKUs */}
            {detail.affectedExampleSkus.length > 0 && (
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Example Products</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {detail.affectedExampleSkus.map(sku => (
                    <button key={sku} onClick={() => onSelectProduct(sku)} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#1d4ed8' }}>
                      {sku}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {detail.warning && (
              <div style={{ padding: 10, background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, fontSize: 13, color: '#92400e' }}>
                ⚠️ {detail.warning}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Field details unavailable (requires backend support).</div>
        )}
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '12px 14px', border: '1px solid #f1f5f9' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{value}</div>
    </div>
  );
}
