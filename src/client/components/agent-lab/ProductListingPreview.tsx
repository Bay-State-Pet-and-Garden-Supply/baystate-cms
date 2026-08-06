/**
 * ProductListingPreview — proposed product fields with status chips (PI-7).
 */

import React, { useState } from 'react';
import type { PiRunProjection } from '../../product-intelligence-api';
import {
  getProposalFields,
  deriveFieldStatus,
  primaryImageUrl,
  type FieldStatus,
} from '../../agent-lab/logic';

interface Props {
  projection: PiRunProjection;
  onFieldSelect?: (fieldKey: string) => void;
}

const STATUS_CHIPS: Record<FieldStatus, { label: string; bg: string; color: string }> = {
  verified: { label: '✓ Verified', bg: '#f0fdf4', color: '#16a34a' },
  conflicting: { label: '⚠ Conflicting', bg: '#fef2f2', color: '#dc2626' },
  inferred: { label: 'Inferred', bg: '#fef3c7', color: '#92400e' },
  missing: { label: 'Missing', bg: '#f3f4f6', color: '#9ca3af' },
  resolved: { label: 'Resolved', bg: '#eff6ff', color: '#2563eb' },
};

export function ProductListingPreview({ projection, onFieldSelect }: Props) {
  const proposalFields = getProposalFields(projection.result);
  const manuallyResolved = new Set<string>(); // no manual-resolution state in this release
  const imageData = primaryImageUrl(projection);
  const [imageFailed, setImageFailed] = useState(false);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    imageContainer: { width: 120, height: 120, marginBottom: 12, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb' },
    image: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
    placeholder: { fontSize: 24, color: '#d1d5db' },
    row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer', padding: '4px 0' },
    fieldLabel: { fontSize: 12, fontWeight: 600, color: '#4b5563' },
    fieldValue: { fontSize: 13, color: '#111827', flex: 1, marginRight: 8, wordBreak: 'break-word' },
    chip: { display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap' },
    empty: { fontSize: 13, color: '#9ca3af', padding: 20, textAlign: 'center' as const },
    imagePlaceholder: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, background: '#f3f4f6', borderRadius: 8, fontSize: 12, color: '#6b7280', marginBottom: 12 },
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Product Listing Preview</h3>
      {imageData && !imageFailed && (
        <div style={styles.imageContainer}>
          <img
            src={imageData}
            alt="Primary product image"
            style={styles.image}
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        </div>
      )}
      {imageData && imageFailed && (
        <div style={styles.imagePlaceholder}>Image unavailable (remote asset failed to load)</div>
      )}
      {proposalFields.length === 0 ? (
        <div style={styles.empty}>No proposal yet — waiting for run to complete.</div>
      ) : (
        proposalFields.map((field) => {
          const status = deriveFieldStatus(
            field.key,
            projection.evidence,
            projection.conflicts,
            projection.result,
            manuallyResolved,
          );
          const chip = STATUS_CHIPS[status];
          return (
            <div key={field.key} style={styles.row} onClick={onFieldSelect ? () => onFieldSelect(field.key) : undefined}>
              <div style={{ flex: 1 }}>
                <div style={styles.fieldLabel}>{field.label}</div>
                <div style={styles.fieldValue}>{field.value ?? '(none)'}</div>
              </div>
              <span style={{ ...styles.chip, background: chip.bg, color: chip.color }}>{chip.label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}