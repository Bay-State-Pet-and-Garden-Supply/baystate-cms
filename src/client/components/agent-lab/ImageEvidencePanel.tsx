/**
 * ImageEvidencePanel — asset cards grid with rights and identity badges (PI-7).
 */

import React, { useState } from 'react';
import type { ProductAssetEvidence } from '../../product-intelligence-api';

interface Props {
  assets: ProductAssetEvidence[];
}

export function ImageEvidencePanel({ assets }: Props) {
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set());

  const styles: Record<string, React.CSSProperties> = {
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 },
    cardPrimary: { background: '#fff', border: '2px solid #2563eb', borderRadius: 8, padding: 12 },
    thumb: { width: '100%', height: 120, objectFit: 'contain' as const, borderRadius: 6, marginBottom: 8, background: '#f9fafb' },
    placeholder: { width: '100%', height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, marginBottom: 8, background: '#f9fafb', fontSize: 24, color: '#d1d5db' },
    badges: { display: 'flex', flexWrap: 'wrap' as const, gap: 3 },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 6, whiteSpace: 'nowrap' },
    meta: { fontSize: 11, color: '#6b7280', marginTop: 4, wordBreak: 'break-all' as const },
    link: { fontSize: 11, color: '#2563eb' },
    conflict: { fontSize: 11, color: '#dc2626', marginTop: 4 },
    note: { fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 8 },
    empty: { fontSize: 14, color: '#9ca3af', textAlign: 'center' as const, padding: 20 },
  };

  const rightsBadge = (status: string): React.CSSProperties => {
    const base: React.CSSProperties = { ...styles.badge };
    if (status === 'approved') return { ...base, background: '#f0fdf4', color: '#16a34a' };
    if (status === 'restricted') return { ...base, background: '#fef3c7', color: '#92400e' };
    return { ...base, background: '#f3f4f6', color: '#9ca3af' };
  };

  if (assets.length === 0) {
    return (
      <div>
        <div style={styles.empty}>No image assets verified yet.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={styles.grid}>
        {assets.map((asset, i) => {
          const isPrimary = asset.rightsStatus === 'approved' && asset.commerceApproved && asset.exactProductMatch;
          const hasError = imgErrors.has(i);
          return (
            <div key={i} style={isPrimary ? styles.cardPrimary : styles.card}>
              {hasError ? (
                <div style={styles.placeholder}>🖼</div>
              ) : (
                <img
                  src={asset.sourceUrl}
                  alt="asset"
                  style={styles.thumb}
                  referrerPolicy="no-referrer"
                  onError={() => {
                    setImgErrors((prev) => new Set(prev).add(i));
                  }}
                />
              )}
              <div style={styles.badges}>
                <span style={rightsBadge(asset.rightsStatus)}>{asset.rightsStatus}</span>
                <span style={{
                  ...styles.badge,
                  background: asset.commerceApproved ? '#f0fdf4' : '#f3f4f6',
                  color: asset.commerceApproved ? '#16a34a' : '#9ca3af',
                }}>
                  commerce {asset.commerceApproved ? '✓' : '✕'}
                </span>
                {asset.exactProductMatch && (
                  <span style={{ ...styles.badge, background: '#f0fdf4', color: '#16a34a' }}>product ✓</span>
                )}
                {asset.exactVariantMatch != null && (
                  <span style={{ ...styles.badge, background: asset.exactVariantMatch ? '#f0fdf4' : '#fef3c7', color: asset.exactVariantMatch ? '#16a34a' : '#92400e' }}>
                    variant {asset.exactVariantMatch ? '✓' : '?'}
                  </span>
                )}
                <span style={{ ...styles.badge, background: '#f3f4f6', color: '#9ca3af' }}>{asset.qualityStatus}</span>
              </div>
              {asset.conflicts.length > 0 && (
                <div style={styles.conflict}>{asset.conflicts.join('; ')}</div>
              )}
              {asset.sourcePageUrl && (
                <div style={styles.meta}>
                  <a href={asset.sourcePageUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
                    {asset.sourcePageUrl.length > 60 ? asset.sourcePageUrl.slice(0, 57) + '…' : asset.sourcePageUrl}
                  </a>
                </div>
              )}
              {asset.extractionMethod && (
                <div style={styles.meta}>via {asset.extractionMethod}</div>
              )}
              {asset.originalContentHash && (
                <div style={styles.meta}>sha256: {asset.originalContentHash.slice(0, 12)}…</div>
              )}
              {asset.variantReference && (
                <div style={styles.meta}>variant: {asset.variantReference}</div>
              )}
            </div>
          );
        })}
      </div>
      <p style={styles.note}>Image approval is deterministic — no manual commerce approval here.</p>
    </div>
  );
}