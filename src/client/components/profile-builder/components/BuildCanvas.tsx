// story: e06s03 — Build canvas grouped fields with per-field governance (hierarchy-primary)
// story: e06-polish — 1.A hierarchy (primary + overflow), 2.B committed palette, Devon keyboard
import React, { useState } from 'react';

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

function isPending(decision: string): boolean {
  return decision === 'pending';
}

function fieldStatusColor(decision: string): string {
  if (decision === 'unsupported') return 'var(--color-mulch-brown)';
  if (decision === 'accepted') return 'var(--color-seedling-green)';
  return 'var(--color-ledger-charcoal)';
}

function FieldRow({
  field,
  onAccept,
  onReject,
  onSuggest,
  onExplain,
  onRevise,
}: {
  field: FieldEntry;
  onAccept: (k: string) => void;
  onReject: (k: string) => void;
  onSuggest: (k: string) => void;
  onExplain: (k: string) => void;
  onRevise: (k: string, fb: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = isPending(field.decision);

  return (
    <div
      tabIndex={0}
      data-field-key={field.key}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && pending) {
          e.preventDefault();
          onAccept(field.key);
        }
      }}
      style={{
        padding: 'var(--space-2)',
        background: 'var(--color-white-surface)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        outlineOffset: 2,
      }}
    >
      <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', lineHeight: 1.3 }}>
        {field.label}{' '}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', fontWeight: 400 }}>
          ({field.key})
        </span>{' '}
        —{' '}
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: fieldStatusColor(field.decision),
            background: field.decision === 'unsupported' ? 'var(--color-feed-bag-cream)' : 'transparent',
            padding: '1px 5px',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {field.decision}
        </span>{' '}
        {field.decision === 'unsupported' && <em style={{ fontSize: '0.75rem', color: 'var(--color-mulch-brown)' }}>unsupported for domain</em>}
      </div>
      {field.active && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '4px 6px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>active: {field.active}</div>}
      {field.draft && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)', background: 'var(--color-white-surface)', border: '1px dashed var(--color-card-border)', padding: '4px 6px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>draft: {field.draft}</div>}
      {field.alternatives.length > 0 && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {field.alternatives.map((a) => (
            <code key={a.selector} style={{ background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', padding: '2px 5px', borderRadius: 'var(--radius-sm)' }}>
              {a.selector}
            </code>
          ))}
        </div>
      )}
      {field.warnings.length > 0 && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.06)', padding: '4px 6px', borderRadius: 'var(--radius-sm)', borderLeft: '2px solid var(--color-signet-burgundy)' }}>warnings: {field.warnings.join('; ')}</div>}
      {field.preview && <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-ledger-charcoal)', background: 'var(--color-feed-bag-cream)', padding: '6px 8px', borderRadius: 'var(--radius-sm)', borderLeft: '2px solid var(--color-uniform-green)' }}>{field.preview}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
        <button
          type="button"
          onClick={() => onAccept(field.key)}
          disabled={!pending}
          style={{
            background: pending ? 'var(--color-uniform-green)' : 'var(--color-feed-bag-cream)',
            color: pending ? 'var(--color-feed-bag-cream)' : 'var(--color-mulch-brown)',
            border: pending ? '1px solid var(--color-shadow-pine)' : '1px solid var(--color-card-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 14px',
            fontFamily: 'var(--font-body)',
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: pending ? 'pointer' : 'not-allowed',
            opacity: pending ? 1 : 0.6,
            boxShadow: pending ? '0 1px 2px rgba(20,83,45,0.15)' : 'none',
          }}
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => onReject(field.key)}
          disabled={!pending}
          style={{
            background: 'var(--color-white-surface)',
            color: 'var(--color-ledger-charcoal)',
            border: '1px solid var(--color-card-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 12px',
            fontFamily: 'var(--font-body)',
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: pending ? 'pointer' : 'not-allowed',
            opacity: pending ? 1 : 0.6,
          }}
        >
          Reject
        </button>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              background: menuOpen ? 'var(--color-feed-bag-cream)' : 'transparent',
              color: 'var(--color-ledger-charcoal)',
              border: '1px solid var(--color-card-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              fontFamily: 'var(--font-body)',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            … More
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                background: 'var(--color-white-surface)',
                border: '1px solid var(--color-card-border)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: '0 8px 24px rgba(33,20,20,0.12)',
                padding: 6,
                minWidth: 160,
                zIndex: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onSuggest(field.key); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 10px', fontFamily: 'var(--font-body)', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>
                ✨ Suggest alternative
              </button>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onExplain(field.key); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 10px', fontFamily: 'var(--font-body)', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>
                ? Explain failure
              </button>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onRevise(field.key, 'feedback'); }} style={{ textAlign: 'left', background: 'transparent', color: 'var(--color-signet-burgundy)', border: 'none', padding: '8px 10px', fontFamily: 'var(--font-body)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>
                ↻ Revise
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BulkActions({ fields, onAccept }: { fields: FieldEntry[]; onAccept: (k: string) => void }): React.ReactElement | null {
  const pending = fields.filter((f) => isPending(f.decision));
  if (pending.length < 2) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => pending.forEach((f) => onAccept(f.key))}
        style={{
          background: 'transparent',
          color: 'var(--color-uniform-green)',
          border: '1px solid var(--color-card-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '6px 12px',
          fontFamily: 'var(--font-body)',
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        Accept all drafts ({pending.length})
      </button>
    </div>
  );
}

export function BuildCanvas({ fieldGroups, onAccept, onReject, onSuggest, onExplain, onRevise, provenance, canSave }: BuildCanvasProps) {
  const allFields = fieldGroups.flatMap((g) => g.fields);

  return (
    <div data-testid="build-canvas" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {provenance && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.75rem', color: 'var(--color-mulch-brown)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ background: 'var(--color-uniform-green)', color: 'var(--color-feed-bag-cream)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-body)', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{provenance.disclosureBadge}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{provenance.provider}/{provenance.model}</span>
          {provenance.htmlLeftMachine && <span style={{ color: 'var(--color-signet-burgundy)', fontWeight: 600 }}>· HTML left machine</span>}
          <details style={{ marginLeft: 'auto' }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-mulch-brown)' }}>details</summary>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{provenance.promptHash} · {provenance.configId}</span>
          </details>
        </div>
      )}
      {!canSave && <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8rem', color: 'var(--color-signet-burgundy)', background: 'rgba(118,12,25,0.06)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>pending decisions block Save/Activate — accept, reject, or mark unsupported per field</div>}
      <BulkActions fields={allFields} onAccept={onAccept} />
      {fieldGroups.map((g) => (
        <div key={g.group} style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700, color: 'var(--color-ledger-charcoal)', margin: '0 0 var(--space-2)', paddingBottom: 'var(--space-1)', borderBottom: '1px solid var(--color-card-border)' }}>{g.group}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' }}>
            {g.fields.map((f) => (
              <FieldRow key={f.key} field={f} onAccept={onAccept} onReject={onReject} onSuggest={onSuggest} onExplain={onExplain} onRevise={onRevise} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
