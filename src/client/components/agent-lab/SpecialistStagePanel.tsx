/**
 * SpecialistStagePanel — specialist stage progress (e02s01 Task 1).
 * Renders ProductSeed → Discovery → Extraction → Resolver → Curator → Verifier.
 * Data comes from typed artifacts; never shows raw chain-of-thought.
 */
import React from 'react';
import { getSpecialistStages } from '../../agent-lab/specialist-workspace-logic';
import type { PiRunProjection } from '../../product-intelligence-api';

interface Props {
  projection: PiRunProjection;
  /** Optional artifact type ids already produced (e.g. from workflow state) */
  artifactTypes?: string[];
  statusOverrides?: Map<string, string>;
}

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  completed: { bg: '#f0fdf4', color: '#16a34a', label: '✓ done' },
  pending: { bg: '#f3f4f6', color: '#6b7280', label: '○ pending' },
  failed: { bg: '#fef2f2', color: '#dc2626', label: '✕ failed' },
  needs_review: { bg: '#fef3c7', color: '#92400e', label: '◐ needs review' },
  skipped: { bg: '#f3f4f6', color: '#9ca3af', label: '— skipped' },
};

export function SpecialistStagePanel({ projection, artifactTypes, statusOverrides }: Props) {
  const artifactIds = artifactTypes ?? deriveArtifactIds(projection);
  const stages = getSpecialistStages(artifactIds, statusOverrides);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 },
    stage: { border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, textAlign: 'center' as const },
    stageLabel: { fontSize: 12, fontWeight: 700, color: '#374151' },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, marginTop: 6 },
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Specialist stages</h3>
      <div style={styles.grid}>
        {stages.map((s) => {
          const st = STATUS_STYLES[s.status] ?? STATUS_STYLES.pending;
          return (
            <div key={s.id} style={styles.stage}>
              <div style={styles.stageLabel}>{s.label}</div>
              <span style={{ ...styles.badge, background: st.bg, color: st.color }}>{st.label}</span>
              {s.artifactType && (
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{s.artifactType}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function deriveArtifactIds(projection: PiRunProjection): string[] {
  // Heuristic from persisted rows: infer produced stages from available data.
  const ids: string[] = [];
  try {
    const input = JSON.parse(projection.run.inputJson) as Record<string, unknown>;
    if (input.productSeed) ids.push('product_seed');
  } catch { /* ignore */ }
  if (projection.sources.length > 0) ids.push('discovery_output');
  if (projection.evidence.length > 0) ids.push('extraction_evidence_bundle');
  if (projection.conflicts.length > 0 || projection.evidence.length > 0) ids.push('resolved_factset');
  if (projection.result) ids.push('curated_product_draft');
  // Verifier report is inside resultJson disposition when present; treat any result as verifier produced for legacy runs.
  if (projection.result) ids.push('verification_report');
  return ids;
}
