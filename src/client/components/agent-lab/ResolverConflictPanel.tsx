/**
 * ResolverConflictPanel — conflicts + unresolved without raw logs (e02s01 Task 3).
 * Surfaces Resolver FactConflict sides and needs_more_evidence/abstained fields.
 * Verifier human_review/failed cites evidence/conflict fields; no tool stderr.
 */
import React from 'react';
import {
  toResolverFactDisplays,
  toResolverConflictDisplays,
  getUnresolvedFields,
  toVerifierVerdictDisplay,
  escapeArtifactString,
} from '../../agent-lab/specialist-workspace-logic';
import type { PiRunProjection } from '../../product-intelligence-api';

interface Props {
  projection: PiRunProjection;
  /** Optional pre-parsed resolver set; falls back to evidence/conflicts heuristic */
  resolverSet?: unknown;
  verifierReport?: unknown;
}

export function ResolverConflictPanel({ projection, resolverSet, verifierReport }: Props) {
  const inferredSet = resolverSet ?? inferResolverSet(projection);
  const factDisplays = toResolverFactDisplays(inferredSet);
  const conflicts = toResolverConflictDisplays(inferredSet);
  const unresolved = getUnresolvedFields(factDisplays);
  const verifier = verifierReport ? toVerifierVerdictDisplay(verifierReport) : inferVerifier(projection);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    section: { marginBottom: 16 },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase' as const },
    row: { fontSize: 13, color: '#4b5563', padding: '6px 0', borderBottom: '1px solid #f3f4f6' },
    conflict: { fontSize: 13, color: '#92400e', background: '#fef3c7', padding: 8, borderRadius: 6, marginBottom: 8 },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, marginLeft: 6 },
    empty: { fontSize: 13, color: '#9ca3af' },
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Resolver & Verifier</h3>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Conflicts ({conflicts.length})</div>
        {conflicts.length === 0 ? (
          <p style={styles.empty}>No conflicts detected.</p>
        ) : (
          conflicts.map((c) => (
            <div key={c.field} style={styles.conflict}>
              <div style={{ fontWeight: 600 }}>Field: {escapeArtifactString(c.field)} <span style={styles.badge}>{c.reason ? escapeArtifactString(c.reason) : 'conflict'}</span></div>
              {c.sides.map((side, i) => (
                <div key={i} style={styles.row}>
                  Side {i + 1}: <strong>{escapeArtifactString(side.value)}</strong> — evidence {side.evidenceIds.join(', ') || 'none'}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Unresolved fields ({unresolved.length})</div>
        {unresolved.length === 0 ? (
          <p style={styles.empty}>No unresolved fields.</p>
        ) : (
          unresolved.map((f) => (
            <div key={f} style={styles.row}>• {escapeArtifactString(f)} — needs_more_evidence</div>
          ))
        )}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Per-field status</div>
        {factDisplays.length === 0 ? (
          <p style={styles.empty}>No resolver facts available.</p>
        ) : (
          factDisplays.map((f) => (
            <div key={f.field} style={styles.row}>
              <span style={{ fontWeight: 600 }}>{escapeArtifactString(f.field)}</span>: {f.status}
              {f.value && <span> — {escapeArtifactString(f.value)}</span>}
              <span style={{ ...styles.badge, background: f.confidence >= 0.8 ? '#f0fdf4' : '#fef3c7', color: f.confidence >= 0.8 ? '#16a34a' : '#92400e' }}>{Math.round(f.confidence * 100)}%</span>
            </div>
          ))
        )}
      </div>

      {verifier && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Verifier — {verifier.verdict}</div>
          <div style={{ fontSize: 13, color: verifier.verdict === 'pass' ? '#16a34a' : verifier.verdict === 'human_review' ? '#92400e' : '#dc2626', fontWeight: 600 }}>
            {escapeArtifactString(verifier.summary) || '(no summary)'}
          </div>
          {verifier.failingFields.length > 0 && (
            <div style={styles.row}>Failing fields: {verifier.failingFields.map(escapeArtifactString).join(', ')}</div>
          )}
          {verifier.conflictFields.length > 0 && (
            <div style={styles.row}>Conflict fields: {verifier.conflictFields.map(escapeArtifactString).join(', ')}</div>
          )}
          {verifier.evidenceIds.length > 0 && (
            <div style={{ fontSize: 11, color: '#6b7280' }}>Evidence: {verifier.evidenceIds.slice(0, 5).join(', ')}</div>
          )}
          {verifier.verdict === 'human_review' && (
            <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: 6, borderRadius: 6, marginTop: 6 }}>
              Human review required — cites evidence/conflicts above; no auto-approval.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function inferResolverSet(projection: PiRunProjection): unknown {
  // Build a minimal ResolvedFactSet-shaped object from evidence/conflicts rows
  // so the panel works even when the run is legacy (no typed resolver artifact).
  const facts = Array.from(
    new Set(projection.evidence.map((e) => e.targetField).concat(projection.conflicts.map((c) => c.field))),
  ).map((field) => ({
    field,
    status: projection.conflicts.some((c) => c.field === field) ? 'conflict' : 'resolved',
    value: projection.evidence.find((e) => e.targetField === field)?.snippet ?? null,
    confidence: projection.evidence.some((e) => e.targetField === field && e.directSupport > 0) ? 0.9 : 0.4,
    supportingEvidence: projection.evidence.filter((e) => e.targetField === field).map((e) => ({ id: e.id })),
    contradictingEvidence: [],
  }));
  const conflicts = projection.conflicts.map((c) => {
    let vals: unknown[] = [];
    try { vals = JSON.parse(c.competingValuesJson) as unknown[]; } catch { /* ignore */ }
    return {
      field: c.field,
      reason: c.severity,
      sides: vals.map((v) => ({ value: String(v), evidenceIds: JSON.parse(c.evidenceIdsJson || '[]') as string[] })),
    };
  });
  return { facts, conflicts };
}

function inferVerifier(projection: PiRunProjection): ReturnType<typeof toVerifierVerdictDisplay> {
  if (!projection.result) return null;
  try {
    const parsed = JSON.parse(projection.result.resultJson) as Record<string, unknown>;
    const sub = (parsed.submission ?? parsed) as Record<string, unknown>;
    // If bundle disposition is needs_review, map to human_review
    const disp = typeof sub.disposition === 'string' ? sub.disposition : null;
    if (disp === 'needs_review') return { verdict: 'human_review', summary: 'Bundle requires human review', failingFields: [], evidenceIds: [], conflictFields: projection.conflicts.filter((c) => c.status === 'open').map((c) => c.field) };
    // Conflicts open → human_review, otherwise pass
    if (projection.conflicts.some((c) => c.status === 'open')) return { verdict: 'human_review', summary: 'Open conflicts require review', failingFields: [], evidenceIds: [], conflictFields: projection.conflicts.filter((c) => c.status === 'open').map((c) => c.field) };
    return { verdict: 'pass', summary: 'Verified', failingFields: [], evidenceIds: [], conflictFields: [] };
  } catch {
    return null;
  }
}
