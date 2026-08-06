/**
 * EvidenceSourceCard — compact source card (PI-7).
 */

import React from 'react';
import type { PiSourceRow } from '../../product-intelligence-api';

interface Props {
  source: PiSourceRow;
}

export function EvidenceSourceCard({ source }: Props) {
  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, marginBottom: 8, cursor: 'pointer' },
    url: { fontSize: 13, color: '#2563eb', fontWeight: 600, wordBreak: 'break-all' as const },
    domain: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
    chips: { display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 6 },
    chip: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap' },
    meta: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  };

  const truncateUrl = (url: string, max = 80): string => {
    if (url.length <= max) return url;
    return url.slice(0, max - 3) + '…';
  };

  const matchChip = (label: string, status: string): React.CSSProperties => {
    const base: React.CSSProperties = { ...styles.chip };
    if (status === 'exact') return { ...base, background: '#f0fdf4', color: '#16a34a' };
    if (status === 'unknown') return { ...base, background: '#f3f4f6', color: '#9ca3af' };
    return { ...base, background: '#fef3c7', color: '#92400e' };
  };

  return (
    <div style={styles.card}>
      <div style={styles.url}>{truncateUrl(source.url)}</div>
      <div style={styles.domain}>{source.domain} · {source.sourceType}</div>
      <div style={styles.chips}>
        <span style={matchChip('GTIN', source.gtinMatchStatus)}>GTIN: {source.gtinMatchStatus}</span>
        <span style={matchChip('Variant', source.variantMatchStatus)}>Var: {source.variantMatchStatus}</span>
      </div>
      {source.retrievedAt && (
        <div style={styles.meta}>Accessed: {new Date(source.retrievedAt).toLocaleString()}</div>
      )}
      {source.licenseRef && (
        <div style={styles.meta}>License: {source.licenseRef}</div>
      )}
      {source.termsRef && (
        <div style={styles.meta}>Terms: {source.termsRef}</div>
      )}
    </div>
  );
}