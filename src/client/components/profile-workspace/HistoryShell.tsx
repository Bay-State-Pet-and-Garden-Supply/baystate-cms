// story: e06s01, e08 history — immutable versions with provenance/artifact/diffs/rollback (General Store)
import React from 'react';
import { colors, fonts, rounded } from '../../theme';

export function HistoryShell({ versions = [] }: { versions?: Array<{ id: string; version?: number; approver?: string; reason?: string; provenance?: { provider: string; model: string; configId?: string }; artifactHashes?: string[]; createdAt?: string }> }): React.ReactElement {
  if (versions.length === 0) {
    return (
      <section
        aria-label="History"
        style={{
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          padding: 20,
          boxShadow: '0 1px 4px rgba(33, 20, 20, 0.06)',
        }}
      >
        <h3 style={{ fontFamily: fonts.display, fontSize: '1.125rem', fontWeight: 700, color: colors.ledgerCharcoal, margin: '0 0 12px' }}>
          Version History & Provenance Ledger
        </h3>
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: '0.8125rem',
            color: colors.mulchBrown,
            textAlign: 'center',
            padding: '24px 16px',
            border: `1px dashed ${colors.cardBorder}`,
            background: colors.feedBagCream,
            borderRadius: rounded.sm,
            lineHeight: 1.5,
          }}
        >
          No immutable versions recorded yet. Your first activation will create an immutable audit entry with actor, model, artifact hashes, and activation rollback records.
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="History"
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: 20,
        boxShadow: '0 1px 4px rgba(33, 20, 20, 0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ fontFamily: fonts.display, fontSize: '1.125rem', fontWeight: 700, color: colors.ledgerCharcoal, margin: 0 }}>
          Version History & Provenance Ledger
        </h3>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown }}>
          {versions.length} immutable {versions.length === 1 ? 'version' : 'versions'}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {versions.map((v, idx) => (
          <div
            key={v.id}
            style={{
              padding: 12,
              border: `1px solid ${colors.cardBorder}`,
              borderLeft: `3px solid ${idx === 0 ? colors.seedlingGreen : colors.cardBorder}`,
              borderRadius: rounded.sm,
              background: idx === 0 ? colors.feedBagCream : colors.whiteSurface,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  fontWeight: 700,
                  color: colors.feedBagCream,
                  background: idx === 0 ? colors.uniformGreen : colors.mulchBrown,
                  padding: '2px 8px',
                  borderRadius: rounded.sm,
                }}
              >
                v{v.version ?? '?'}
              </span>

              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal }}>
                ID: {v.id.slice(0, 12)}
              </span>

              <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.mulchBrown }}>
                Approver: <strong>{v.approver ?? 'operator'}</strong>
              </span>

              {v.reason && (
                <span style={{ fontFamily: fonts.body, fontSize: 12, color: colors.ledgerCharcoal, background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, padding: '1px 8px', borderRadius: rounded.sm }}>
                  "{v.reason}"
                </span>
              )}

              <span style={{ marginLeft: 'auto', fontFamily: fonts.mono, fontSize: 11, color: colors.mulchBrown }}>
                {v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, fontFamily: fonts.mono, color: colors.mulchBrown }}>
              {v.provenance && (
                <span style={{ background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, padding: '2px 6px', borderRadius: rounded.sm }}>
                  Model: {v.provenance.provider}/{v.provenance.model}
                  {v.provenance.configId ? ` (${v.provenance.configId.slice(0, 8)})` : ''}
                </span>
              )}

              {v.artifactHashes && v.artifactHashes.length > 0 && (
                <span>
                  Hashes: {v.artifactHashes.slice(0, 3).map((h) => h.slice(0, 10)).join(', ')}
                  {v.artifactHashes.length > 3 ? ` +${v.artifactHashes.length - 3} more` : ''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

