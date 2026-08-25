// story: e06s03 — Build canvas grouped fields with per-field governance (General Store)
// story: e06-polish — 1.A hierarchy, 2.B committed palette
import React, { useState } from 'react';
import { colors, fonts, rounded } from '../../../theme';

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

function fieldStatusBadge(decision: string) {
  switch (decision) {
    case 'accepted':
      return { bg: 'rgba(22, 132, 77, 0.12)', fg: colors.seedlingGreen, label: '✓ Accepted' };
    case 'rejected':
      return { bg: 'rgba(118, 12, 25, 0.1)', fg: colors.signetBurgundy, label: '✗ Rejected' };
    case 'unsupported':
      return { bg: colors.feedBagCream, fg: colors.mulchBrown, label: 'Unsupported' };
    default:
      return { bg: 'rgba(246, 219, 18, 0.3)', fg: colors.ledgerCharcoal, label: 'Pending Review' };
  }
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
  const badge = fieldStatusBadge(field.decision);

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
        padding: 14,
        background: colors.whiteSurface,
        border: `1px solid ${pending ? colors.mutedGold : colors.cardBorder}`,
        borderLeft: `3px solid ${pending ? colors.cornerCalloutGold : field.decision === 'accepted' ? colors.seedlingGreen : field.decision === 'rejected' ? colors.signetBurgundy : colors.cardBorder}`,
        borderRadius: rounded.sm,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        outlineOffset: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div style={{ fontFamily: fonts.body, fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
          {field.label}{' '}
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown, fontWeight: 400 }}>
            ({field.key})
          </span>
        </div>

        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: badge.fg,
            background: badge.bg,
            padding: '2px 8px',
            borderRadius: rounded.full,
          }}
        >
          {badge.label}
        </span>
      </div>

      {field.active && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown, background: colors.feedBagCream, padding: '4px 8px', borderRadius: rounded.sm }}>
          <strong>active:</strong> {field.active}
        </div>
      )}

      {field.draft && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal, background: colors.whiteSurface, border: `1px dashed ${colors.cardBorder}`, padding: '4px 8px', borderRadius: rounded.sm }}>
          <strong>draft:</strong> {field.draft}
        </div>
      )}

      {field.alternatives.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontFamily: fonts.body, color: colors.mulchBrown, fontWeight: 600 }}>Alts:</span>
          {field.alternatives.map((a) => (
            <code key={a.selector} style={{ fontFamily: fonts.mono, fontSize: 10, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, padding: '2px 6px', borderRadius: rounded.sm }}>
              {a.selector}
            </code>
          ))}
        </div>
      )}

      {field.warnings.length > 0 && (
        <div style={{ fontFamily: fonts.body, fontSize: 11, color: colors.signetBurgundy, background: 'rgba(118,12,25,0.06)', padding: '4px 8px', borderRadius: rounded.sm, borderLeft: `2px solid ${colors.signetBurgundy}` }}>
          ⚠ {field.warnings.join('; ')}
        </div>
      )}

      {field.preview && (
        <div style={{ fontFamily: fonts.body, fontSize: 12, color: colors.ledgerCharcoal, background: colors.feedBagCream, padding: '6px 10px', borderRadius: rounded.sm, borderLeft: `3px solid ${colors.uniformGreen}` }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: colors.mulchBrown, marginRight: 6 }}>Extracted:</span>
          {field.preview}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
        <button
          type="button"
          onClick={() => onAccept(field.key)}
          disabled={!pending}
          style={{
            background: pending ? colors.uniformGreen : colors.feedBagCream,
            color: pending ? colors.feedBagCream : colors.mulchBrown,
            border: pending ? `1px solid ${colors.shadowPine}` : `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.sm,
            padding: '6px 14px',
            fontFamily: fonts.body,
            fontSize: 11,
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
            background: colors.whiteSurface,
            color: colors.ledgerCharcoal,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.sm,
            padding: '6px 12px',
            fontFamily: fonts.body,
            fontSize: 11,
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
              background: menuOpen ? colors.feedBagCream : 'transparent',
              color: colors.ledgerCharcoal,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.sm,
              padding: '6px 10px',
              fontFamily: fonts.body,
              fontSize: 11,
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
                background: colors.whiteSurface,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.lg,
                boxShadow: '0 8px 24px rgba(33,20,20,0.12)',
                padding: 6,
                minWidth: 160,
                zIndex: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => { setMenuOpen(false); onSuggest(field.key); }}
                style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 10px', fontFamily: fonts.body, fontSize: 12, cursor: 'pointer', borderRadius: rounded.sm }}
              >
                ✨ Suggest alternative
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => { setMenuOpen(false); onExplain(field.key); }}
                style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 10px', fontFamily: fonts.body, fontSize: 12, cursor: 'pointer', borderRadius: rounded.sm }}
              >
                ? Explain failure
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => { setMenuOpen(false); onRevise(field.key, 'feedback'); }}
                style={{ textAlign: 'left', background: 'transparent', color: colors.signetBurgundy, border: 'none', padding: '8px 10px', fontFamily: fonts.body, fontSize: 12, fontWeight: 600, cursor: 'pointer', borderRadius: rounded.sm }}
              >
                ↻ Revise selector
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
          background: colors.whiteSurface,
          color: colors.uniformGreen,
          border: `1px solid ${colors.uniformGreen}`,
          borderRadius: rounded.sm,
          padding: '6px 14px',
          fontFamily: fonts.body,
          fontSize: 11,
          fontWeight: 700,
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
    <div data-testid="build-canvas" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {provenance && (
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: 12,
            color: colors.mulchBrown,
            background: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderLeft: `4px solid ${colors.signetBurgundy}`,
            borderRadius: rounded.sm,
            padding: '10px 14px',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              background: colors.uniformGreen,
              color: colors.feedBagCream,
              padding: '2px 8px',
              borderRadius: rounded.sm,
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {provenance.disclosureBadge}
          </span>
          <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal }}>
            {provenance.provider}/{provenance.model}
          </span>
          {provenance.htmlLeftMachine && (
            <span style={{ color: colors.signetBurgundy, fontWeight: 600 }}>
              · HTML sent to model
            </span>
          )}
          <details style={{ marginLeft: 'auto' }}>
            <summary style={{ cursor: 'pointer', fontFamily: fonts.mono, fontSize: 10, color: colors.mulchBrown }}>
              details
            </summary>
            <span style={{ fontFamily: fonts.mono, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {provenance.promptHash} · {provenance.configId}
            </span>
          </details>
        </div>
      )}

      {!canSave && (
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: 12,
            color: colors.signetBurgundy,
            background: 'rgba(118,12,25,0.06)',
            border: `1px solid ${colors.signetBurgundy}`,
            borderLeft: `4px solid ${colors.signetBurgundy}`,
            padding: '10px 14px',
            borderRadius: rounded.sm,
            fontWeight: 600,
          }}
        >
          Pending decisions block Save / Activate — accept, reject, or mark unsupported per field.
        </div>
      )}

      <BulkActions fields={allFields} onAccept={onAccept} />

      {fieldGroups.map((g) => (
        <div
          key={g.group}
          style={{
            background: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.lg,
            padding: 16,
            boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
          }}
        >
          <h3 style={{ fontFamily: fonts.display, fontSize: '1rem', fontWeight: 700, color: colors.ledgerCharcoal, margin: '0 0 12px', paddingBottom: 8, borderBottom: `1px solid ${colors.cardBorder}` }}>
            {g.group}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {g.fields.map((f) => (
              <FieldRow key={f.key} field={f} onAccept={onAccept} onReject={onReject} onSuggest={onSuggest} onExplain={onExplain} onRevise={onRevise} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

