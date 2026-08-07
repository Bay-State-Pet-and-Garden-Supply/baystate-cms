/**
 * ProductFieldEvidence — supporting evidence and conflicts for one field (PI-7).
 */

import React from 'react';
import type { PiRunProjection } from '../../product-intelligence-api';

interface Props {
  projection: PiRunProjection;
  fieldKey: string;
}

export function ProductFieldEvidence({ projection, fieldKey }: Props) {
  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    section: { marginBottom: 16 },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase' as const },
    evidence: { fontSize: 13, color: '#374151', padding: '6px 0', borderBottom: '1px solid #f3f4f6' },
    evidenceValue: { fontWeight: 600, color: '#111827' },
    evidenceMeta: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
    conflict: { fontSize: 13, color: '#dc2626', padding: '6px 0', borderBottom: '1px solid #fef2f2' },
    empty: { fontSize: 13, color: '#9ca3af' },
  };

  const sources = projection.sources;
  const supporting = projection.evidence.filter((e) => e.targetField === fieldKey);
  const conflicts = projection.conflicts.filter((c) => c.field === fieldKey);

  const sourceUrl = (sourceId: string): string => {
    const src = sources.find((s) => s.id === sourceId);
    return src?.url ?? '(unknown source)';
  };

  // P1-4: field-level rows store the ACTUAL extracted value in valueJson plus
  // the source path + durable tool evidence id in metadataJson; legacy rows
  // store { evidenceId, snippet }. Render both faithfully.
  const displayValue = (e: typeof supporting[number]): string => {
    let parsed: unknown = e.valueJson;
    try { parsed = JSON.parse(e.valueJson); } catch { /* keep raw */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { evidenceId?: string; snippet?: string };
      return obj.snippet ?? obj.evidenceId ?? e.valueJson;
    }
    return String(parsed);
  };

  const evidenceMeta = (e: typeof supporting[number]): { path: string | null; toolEvidenceId: string | null } => {
    try {
      const meta = JSON.parse(e.metadataJson ?? '{}') as { path?: string; toolEvidenceId?: string };
      return { path: meta.path ?? null, toolEvidenceId: meta.toolEvidenceId ?? null };
    } catch {
      return { path: null, toolEvidenceId: null };
    }
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Evidence: {fieldKey}</h3>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Supporting evidence ({supporting.length})</div>
        {supporting.length === 0 ? (
          <p style={styles.empty}>No direct supporting evidence.</p>
        ) : (
          supporting.map((e) => {
            const meta = evidenceMeta(e);
            return (
              <div key={e.id} style={styles.evidence}>
                <div style={styles.evidenceValue}>{displayValue(e)}</div>
                <div style={styles.evidenceMeta}>
                  {e.extractionMethod ?? 'unknown'}
                  {meta.path ? ` · ${meta.path}` : ''}
                  {meta.toolEvidenceId ? ` · ${meta.toolEvidenceId.slice(0, 40)}` : ''}
                  {' · '}
                  {sourceUrl(e.sourceId)}
                </div>
                {e.snippet && (
                  <div style={{ fontSize: 12, color: '#4b5563', marginTop: 4, fontStyle: 'italic' }}>
                    "{e.snippet}"
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {conflicts.length > 0 && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionTitle, color: '#dc2626' }}>Conflicts ({conflicts.length})</div>
          {conflicts.map((c) => {
            let competing: unknown[] = [];
            try { competing = JSON.parse(c.competingValuesJson) as unknown[]; } catch { /* keep empty */ }
            return (
              <div key={c.id} style={styles.conflict}>
                <div>Severity: {c.severity}</div>
                <div>Competing values: {competing.map((v) => String(v)).join(' vs ')}</div>
                <div style={styles.evidenceMeta}>Evidence: {c.evidenceIdsJson}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}