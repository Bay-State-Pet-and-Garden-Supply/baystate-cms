// story: e06s03 — Build canvas grouped fields with per-field governance
import React from 'react';

interface FieldEntry {
  key: string;
  label: string;
  active?: string | null;
  draft?: string | null;
  alternatives: Array<{ selector: string; evidence: string; quality?: string }>;
  warnings: string[];
  preview?: string | null;
  decision: 'pending' | 'accepted' | 'rejected' | 'unsupported' | string;
}

interface FieldGroup {
  group: string;
  fields: FieldEntry[];
}

interface Provenance {
  provider: string;
  model: string;
  configId: string;
  promptHash: string;
  htmlLeftMachine: boolean;
  disclosureBadge: string;
}

interface BuildCanvasProps {
  fieldGroups: FieldGroup[];
  onAccept: (key: string) => void;
  onReject: (key: string) => void;
  onSuggest: (key: string) => void;
  onExplain: (key: string) => void;
  onRevise: (key: string, feedback: string) => void;
  provenance: Provenance | null;
  canSave: boolean;
}

export function BuildCanvas({ fieldGroups, onAccept, onReject, onSuggest, onExplain, onRevise, provenance, canSave }: BuildCanvasProps) {
  return (
    <div data-testid="build-canvas" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {provenance && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', alignItems: 'center' }}><span style={{ background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{provenance.disclosureBadge}</span><span>{provenance.provider}/{provenance.model}</span><span style={{ opacity: 0.6 }}>·</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{provenance.promptHash}</span>{provenance.htmlLeftMachine && <span style={{ color: 'var(--color-signet-burgundy)', fontWeight: 600 }}>· HTML left machine</span>}</div>}
      {!canSave && <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.06)', border: '1px solid var(--color-signet-burgundy)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>pending decisions block Save/Activate — accept/reject or mark unsupported per field</div>}
      {fieldGroups.map((g) => (
        <div key={g.group} style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', margin: '0 0 var(--space-2)', paddingBottom: 'var(--space-1)', borderBottom: '1px solid var(--color-card-border)' }}>{g.group}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' }}>
            {g.fields.map((f) => (
              <div key={f.key} style={{ padding: 'var(--space-2)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', lineHeight: 1.3 }}>{f.label} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', fontWeight: 400 }}>({f.key})</span> — <span style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: f.decision === 'unsupported' ? 'var(--color-mulch-brown)' : f.decision === 'accepted' ? 'var(--color-seedling-green)' : 'var(--color-ledger-charcoal)', background: f.decision === 'unsupported' ? 'var(--color-feed-bag-cream)' : 'transparent', padding: '1px 5px', borderRadius: 'var(--radius-sm)' }}>{f.decision}</span> {f.decision === 'unsupported' && <em style={{ fontSize: '0.75rem', color: 'var(--color-mulch-brown)' }}>unsupported for domain</em>}</div>
                {f.active && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '4px 6px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>active: {f.active}</div>}
                {f.draft && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-white-surface)', border: '1px dashed var(--color-card-border)', padding: '4px 6px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>draft: {f.draft}</div>}
                {f.alternatives.length > 0 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>{f.alternatives.map((a) => <code key={a.selector} style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', padding: '2px 5px', borderRadius: 'var(--radius-sm)' }}>{a.selector}</code>)}</div>}
                {f.warnings.length > 0 && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.06)', padding: '4px 6px', borderRadius: 'var(--radius-sm)' }}>warnings: {f.warnings.join('; ')}</div>}
                {f.preview && <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', borderLeft: '2px solid var(--color-uniform-green)' }}>{f.preview}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => onAccept(f.key)} style={{ background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-shadow-pine)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' }}>Accept</button>
                  <button type="button" onClick={() => onReject(f.key)} style={{ background: 'var(--color-white-surface)', color: 'var(--color-ledger-charcoal)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' }}>Reject</button>
                  <button type="button" onClick={() => onSuggest(f.key)} style={{ background: 'transparent', color: 'var(--color-uniform-green)', border: '1px solid transparent', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer' }}>Suggest</button>
                  <button type="button" onClick={() => onExplain(f.key)} style={{ background: 'transparent', color: 'var(--color-mulch-brown)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: '0.7rem', cursor: 'pointer' }}>Explain</button>
                  <button type="button" onClick={() => onRevise(f.key, 'feedback')} style={{ background: 'transparent', color: 'var(--color-signet-burgundy)', border: '1px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer' }}>Revise</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
