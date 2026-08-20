/**
 * SeedPanel — immutable ProductSeed display (e02s01 Task 1).
 * Shows sku/name/price verbatim; seed is never mutated from UI.
 */
import React from 'react';
import { parseProductSeedDisplay, escapeArtifactString } from '../../agent-lab/specialist-workspace-logic';

interface Props {
  inputJson: string;
}

export function SeedPanel({ inputJson }: Props) {
  const seed = parseProductSeedDisplay(inputJson);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 8 },
    row: { fontSize: 13, color: '#4b5563', marginBottom: 4 },
    label: { fontWeight: 600, color: '#374151' },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, background: '#f0fdf4', color: '#16a34a', marginLeft: 8 },
    empty: { fontSize: 13, color: '#9ca3af' },
  };

  if (!seed) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>ProductSeed</h3>
        <p style={styles.empty}>No seed data (legacy GTIN run).</p>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>ProductSeed <span style={styles.badge}>immutable</span></h3>
      <div style={styles.row}><span style={styles.label}>SKU:</span> {escapeArtifactString(seed.sku)}</div>
      <div style={styles.row}><span style={styles.label}>Name:</span> {escapeArtifactString(seed.name)}</div>
      {seed.price && <div style={styles.row}><span style={styles.label}>Price:</span> {escapeArtifactString(seed.price)}</div>}
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>Seed is the operator input — never inferred from SKU; GTIN is separate evidence.</div>
    </div>
  );
}
