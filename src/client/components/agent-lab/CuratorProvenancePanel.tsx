/**
 * CuratorProvenancePanel — per-field provenance reveal (e02s01 Task 2).
 * Every Curator fact links back to resolvedFacts evidence IDs; evidence
 * inspector shows source page/method/hash/profile/version/method/path.
 */
import React, { useState } from 'react';
import {
  toCuratorFactDisplays,
  toExtractionProfileDisplays,
  escapeArtifactString,
  isUnsupportedClaim,
} from '../../agent-lab/specialist-workspace-logic';
import { getProvenanceLinks } from '../../agent-lab/specialist-workspace-provenance';
import type { PiRunProjection } from '../../product-intelligence-api';

interface Props {
  projection: PiRunProjection;
  curatedDraft?: unknown;
  resolvedFactSet?: unknown;
  extractionBundles?: unknown;
}

export function CuratorProvenancePanel({ projection, curatedDraft, resolvedFactSet, extractionBundles }: Props) {
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const draft = curatedDraft ?? inferDraft(projection);
  const resolver = resolvedFactSet ?? inferResolverSet(projection);
  const facts = toCuratorFactDisplays(draft, resolver);
  const links = getProvenanceLinks(facts, projection.evidence, projection.sources);
  const profiles = toExtractionProfileDisplays(extractionBundles ?? inferBundles(projection), projection.sources);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
    list: { border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, maxHeight: 320, overflowY: 'auto' as const },
    item: { padding: '6px 8px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', fontSize: 13 },
    itemActive: { padding: '6px 8px', borderBottom: '1px solid #bfdbfe', cursor: 'pointer', fontSize: 13, background: '#eff6ff', color: '#2563eb', fontWeight: 600 },
    detail: { fontSize: 12, color: '#6b7280', marginTop: 2 },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, marginLeft: 6 },
    profileRow: { fontSize: 12, color: '#4b5563', padding: '4px 0', borderBottom: '1px solid #f3f4f6' },
    empty: { fontSize: 13, color: '#9ca3af' },
  };

  const selectedFact = selectedField ? facts.find((f) => f.field === selectedField) : null;
  const selectedLinks = selectedField ? links.filter((l) => l.resolvedFactField === selectedField) : [];

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Curator — field provenance</h3>
      {facts.length === 0 ? (
        <p style={styles.empty}>No curated facts (no result yet).</p>
      ) : (
        <div style={styles.grid}>
          <div style={styles.list}>
            {facts.map((f) => {
              const unsupported = isUnsupportedClaim(f.value, f.supportedByEvidenceCount);
              return (
                <div
                  key={f.field}
                  style={selectedField === f.field ? styles.itemActive : styles.item}
                  onClick={() => setSelectedField(f.field)}
                  role="button"
                  tabIndex={0}
                >
                  <span style={{ fontWeight: 600 }}>{escapeArtifactString(f.field)}</span>
                  <span style={{ ...styles.badge, background: f.groundedInResolvedFact ? '#f0fdf4' : '#fef3c7', color: f.groundedInResolvedFact ? '#16a34a' : '#92400e' }}>
                    {f.groundedInResolvedFact ? 'grounded' : 'ungrounded'}
                  </span>
                  {unsupported && <span style={{ ...styles.badge, background: '#fef2f2', color: '#dc2626' }}>unsupported</span>}
                  <div style={styles.detail}>{escapeArtifactString(f.value).slice(0, 80)}{f.value.length > 80 ? '…' : ''} · {f.supportedByEvidenceCount} evidence</div>
                </div>
              );
            })}
          </div>
          <div style={styles.list}>
            {!selectedFact ? (
              <p style={styles.empty}>Select a field to see provenance.</p>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>{escapeArtifactString(selectedFact.field)} — provenance</div>
                {selectedLinks.length === 0 ? (
                  <p style={styles.empty}>No evidence links.</p>
                ) : (
                  selectedLinks.map((l) => (
                    <div key={l.evidenceId} style={styles.profileRow}>
                      <div style={{ fontWeight: 600, fontSize: 11 }}>{escapeArtifactString(l.evidenceId)}</div>
                      <div>method: {escapeArtifactString(l.method ?? 'unknown')}</div>
                      {l.sourceUrl && <div style={{ wordBreak: 'break-all' as const }}>source: {escapeArtifactString(l.sourceUrl)}</div>}
                      {l.contentHash && <div>hash: {escapeArtifactString(l.contentHash.slice(0, 16))}…</div>}
                    </div>
                  ))
                )}
                {profiles.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 12, marginBottom: 4 }}>Extraction profile / method / path (inspectable)</div>
                    {profiles.slice(0, 5).map((p, i) => (
                      <div key={i} style={styles.profileRow}>
                        domain: {escapeArtifactString(p.domain)} · v{p.profileVersion} · {escapeArtifactString(p.method)}
                        {p.selectorPath && <div>path: {escapeArtifactString(p.selectorPath)}</div>}
                        {p.sourceUrl && <div style={{ wordBreak: 'break-all' as const }}>page: {escapeArtifactString(p.sourceUrl)}</div>}
                        {p.contentHash && <div>hash: {escapeArtifactString(p.contentHash.slice(0, 12))}…</div>}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function inferDraft(projection: PiRunProjection): unknown {
  try {
    if (!projection.result) return null;
    const parsed = JSON.parse(projection.result.resultJson) as Record<string, unknown>;
    const sub = (parsed.submission ?? parsed) as Record<string, unknown>;
    if (Array.isArray(sub.commerceFacts)) return { commerceFacts: sub.commerceFacts };
    if (Array.isArray((sub as Record<string, unknown>).facts)) return { commerceFacts: (sub as Record<string, unknown>).facts };
    const pp = sub.productProposal as Record<string, unknown> | undefined;
    if (pp && Array.isArray(pp.fields)) return { commerceFacts: pp.fields.map((f: unknown) => {
      const r = f as Record<string, unknown>;
      return { field: r.field, value: r.value, evidenceIds: r.evidenceIds ?? [] };
    }) };
    return null;
  } catch { return null; }
}

function inferResolverSet(projection: PiRunProjection): unknown {
  const facts = Array.from(new Set(projection.evidence.map((e) => e.targetField))).map((field) => ({
    field,
    status: 'resolved',
    value: projection.evidence.find((e) => e.targetField === field)?.snippet ?? null,
    confidence: 0.9,
    supportingEvidence: projection.evidence.filter((e) => e.targetField === field).map((e) => ({ id: e.id })),
  }));
  return { facts, conflicts: [] };
}

function inferBundles(projection: PiRunProjection): unknown[] {
  return projection.sources.map((s) => ({
    sourceId: s.id,
    sourceUrl: s.url,
    extractionMethod: projection.evidence.find((e) => e.sourceId === s.id)?.extractionMethod ?? 'unknown',
    sourcePath: null,
    contentHash: s.contentHash,
    profileBinding: { domain: s.domain, version: 'unknown' },
  }));
}
