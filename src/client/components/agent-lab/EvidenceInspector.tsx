/**
 * EvidenceInspector — bottom bar: sources list + field evidence (PI-7).
 */

import React, { useState } from 'react';
import type { PiRunProjection } from '../../product-intelligence-api';
import { EvidenceSourceCard } from './EvidenceSourceCard';
import { ProductFieldEvidence } from './ProductFieldEvidence';

interface Props {
  projection: PiRunProjection;
  initialFieldKey?: string;
  onClose: () => void;
}

export function EvidenceInspector({ projection, initialFieldKey, onClose }: Props) {
  const [selectedField, setSelectedField] = useState<string | null>(initialFieldKey ?? null);

  const styles: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed' as const,
      bottom: 0,
      left: 0,
      right: 0,
      height: 320,
      background: '#fff',
      borderTop: '2px solid #e5e7eb',
      boxShadow: '0 -4px 12px rgba(0,0,0,0.08)',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column' as const,
    },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827' },
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    leftPanel: { width: 240, overflowY: 'auto' as const, padding: 8, borderRight: '1px solid #e5e7eb' },
    rightPanel: { flex: 1, overflowY: 'auto' as const, padding: 8 },
    closeBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' },
    fieldBtn: { display: 'block', width: '100%', textAlign: 'left' as const, background: 'none', border: 'none', padding: '6px 8px', cursor: 'pointer', fontSize: 13, color: '#374151', borderRadius: 4 },
    fieldBtnActive: { display: 'block', width: '100%', textAlign: 'left' as const, background: '#eff6ff', border: 'none', padding: '6px 8px', cursor: 'pointer', fontSize: 13, color: '#2563eb', borderRadius: 4, fontWeight: 600 },
  };

  // Collect all field keys from evidence + conflicts
  const fieldKeys = new Set<string>();
  for (const e of projection.evidence) fieldKeys.add(e.targetField);
  for (const c of projection.conflicts) fieldKeys.add(c.field);

  return (
    <div style={styles.overlay}>
      <div style={styles.header}>
        <span style={styles.title}>Evidence & Sources</span>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close evidence inspector">✕</button>
      </div>
      <div style={styles.body}>
        <div style={styles.leftPanel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 4 }}>SOURCES</div>
          {projection.sources.map((src) => (
            <EvidenceSourceCard key={src.id} source={src} />
          ))}
          {projection.sources.length === 0 && (
            <div style={{ fontSize: 13, color: '#9ca3af', padding: 8 }}>No sources.</div>
          )}
        </div>
        <div style={styles.rightPanel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 4, display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
            {Array.from(fieldKeys).map((key) => (
              <button
                key={key}
                style={selectedField === key ? styles.fieldBtnActive : styles.fieldBtn}
                onClick={() => setSelectedField(key)}
              >
                {key}
              </button>
            ))}
          </div>
          {selectedField ? (
            <ProductFieldEvidence projection={projection} fieldKey={selectedField} />
          ) : (
            <div style={{ fontSize: 13, color: '#9ca3af', padding: 8 }}>Select a field to inspect evidence.</div>
          )}
        </div>
      </div>
    </div>
  );
}