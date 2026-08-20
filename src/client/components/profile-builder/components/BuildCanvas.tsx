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
    <div data-testid="build-canvas">
      {provenance && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{provenance.disclosureBadge} · {provenance.provider}/{provenance.model} · {provenance.promptHash}</div>}
      {!canSave && <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', padding: 6, borderRadius: 6, marginBottom: 8 }}>pending decisions block Save/Activate</div>}
      {fieldGroups.map((g) => (
        <div key={g.group} style={{ marginBottom: 16, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{g.group}</h3>
          {g.fields.map((f) => (
            <div key={f.key} style={{ marginBottom: 12, padding: 8, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontWeight: 600 }}>{f.label} <span style={{ fontSize: 11, color: '#6b7280' }}>({f.key})</span> — decision: {f.decision} {f.decision === 'unsupported' && <em>unsupported for domain</em>}</div>
              {f.active && <div style={{ fontSize: 12 }}>active: <code>{f.active}</code></div>}
              {f.draft && <div style={{ fontSize: 12 }}>draft: <code>{f.draft}</code></div>}
              {f.alternatives.length > 0 && <div style={{ fontSize: 12 }}>alternatives: {f.alternatives.map((a) => <code key={a.selector} style={{ marginRight: 6 }}>{a.selector}</code>)}</div>}
              {f.warnings.length > 0 && <div style={{ fontSize: 11, color: '#92400e' }}>warnings: {f.warnings.join('; ')}</div>}
              {f.preview && <div style={{ fontSize: 12, color: '#374151' }}>preview: {f.preview}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" onClick={() => onAccept(f.key)} style={{ fontSize: 12 }}>Accept</button>
                <button type="button" onClick={() => onReject(f.key)} style={{ fontSize: 12 }}>Reject</button>
                <button type="button" onClick={() => onSuggest(f.key)} style={{ fontSize: 12 }}>Suggest alternatives</button>
                <button type="button" onClick={() => onExplain(f.key)} style={{ fontSize: 12 }}>Explain failure</button>
                <button type="button" onClick={() => onRevise(f.key, 'feedback')} style={{ fontSize: 12 }}>Revise</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
