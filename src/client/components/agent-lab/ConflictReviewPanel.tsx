/**
 * ConflictReviewPanel — conflicts, image rights, missing fields (PI-7).
 */

import React from 'react';
import type { PiRunProjection } from '../../product-intelligence-api';
import { getProposalFields, deriveFieldStatus } from '../../agent-lab/logic';

interface Props {
  projection: PiRunProjection;
  onReject: () => void;
}

export function ConflictReviewPanel({ projection, onReject }: Props) {
  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    section: { marginBottom: 16 },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase' as const },
    table: { width: '100%', borderCollapse: 'collapse' as const },
    th: { textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#374151', padding: '4px 8px', borderBottom: '1px solid #e5e7eb' },
    td: { fontSize: 13, color: '#4b5563', padding: '4px 8px', borderBottom: '1px solid #f3f4f6' },
    empty: { fontSize: 13, color: '#9ca3af', padding: 8 },
    rejectBtn: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    chip: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', marginRight: 4, marginBottom: 4 },
    missingField: { fontSize: 13, color: '#9ca3af', padding: '4px 0' },
    note: { fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 8 },
  };

  const openConflicts = projection.conflicts.filter((c) => c.status === 'open');
  const proposalFields = getProposalFields(projection.result);
  const manuallyResolved = new Set<string>();
  const missingFields = proposalFields.filter(
    (f) => deriveFieldStatus(f.key, projection.evidence, projection.conflicts, projection.result, manuallyResolved) === 'missing',
  );

  const rightsChip = (status: string): React.CSSProperties => {
    const base: React.CSSProperties = { ...styles.chip };
    if (status === 'approved') return { ...base, background: '#f0fdf4', color: '#16a34a' };
    if (status === 'restricted') return { ...base, background: '#fef3c7', color: '#92400e' };
    return { ...base, background: '#f3f4f6', color: '#9ca3af' };
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Review & Conflicts</h3>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Open conflicts ({openConflicts.length})</div>
        {openConflicts.length === 0 ? (
          <p style={styles.empty}>No open conflicts.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Field</th>
                <th style={styles.th}>Severity</th>
                <th style={styles.th}>Values</th>
              </tr>
            </thead>
            <tbody>
              {openConflicts.map((c) => {
                let vals: unknown[] = [];
                try { vals = JSON.parse(c.competingValuesJson) as unknown[]; } catch { /* keep */ }
                return (
                  <tr key={c.id}>
                    <td style={styles.td}>{c.field}</td>
                    <td style={styles.td}>{c.severity}</td>
                    <td style={styles.td}>{vals.map((v) => String(v)).join(' vs ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {projection.assets.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Image rights summary</div>
          {projection.assets.map((asset, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <span style={rightsChip(asset.rightsStatus)}>{asset.rightsStatus}</span>
              <span style={{ ...styles.chip, background: asset.commerceApproved ? '#f0fdf4' : '#f3f4f6', color: asset.commerceApproved ? '#16a34a' : '#9ca3af' }}>
                {asset.commerceApproved ? 'commerce ✓' : 'commerce ✕'}
              </span>
              {asset.exactProductMatch && (
                <span style={{ ...styles.chip, background: '#f0fdf4', color: '#16a34a' }}>exact product ✓</span>
              )}
              <span style={{ ...styles.chip, background: '#f3f4f6', color: '#9ca3af' }}>{asset.qualityStatus}</span>
            </div>
          ))}
        </div>
      )}

      {missingFields.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Missing fields ({missingFields.length})</div>
          {missingFields.map((f) => (
            <div key={f.key} style={styles.missingField}>• {f.label} ({f.key})</div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button style={styles.rejectBtn} onClick={onReject}>Reject result (delete run)</button>
        <p style={styles.note}>Image approval is deterministic — no manual commerce approval here.</p>
      </div>
    </div>
  );
}