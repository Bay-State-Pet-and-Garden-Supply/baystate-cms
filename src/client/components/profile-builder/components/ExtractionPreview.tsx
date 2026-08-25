/**
 * ExtractionPreview — product-like extraction preview using the single-URL test API (General Store).
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import type { ExtractorTestResult } from '../../../onboarding-api';
import { colors, fonts, rounded } from '../../../theme';

interface ExtractionPreviewProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    padding: 14,
    boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
  },
  title: {
    fontFamily: fonts.display,
    fontSize: '0.9375rem',
    fontWeight: 700,
    color: colors.ledgerCharcoal,
    margin: '0 0 10px',
    paddingBottom: 6,
    borderBottom: `1px solid ${colors.cardBorder}`,
  },
  btnRow: { marginBottom: 12 },
  primaryBtn: {
    background: colors.uniformGreen,
    color: colors.feedBagCream,
    border: 'none',
    borderRadius: rounded.sm,
    padding: '7px 16px',
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    boxShadow: '0 1px 2px rgba(20, 83, 45, 0.15)',
  },
  disabledBtn: {
    background: colors.feedBagCream,
    color: colors.mulchBrown,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '7px 16px',
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  empty: { fontSize: 12, color: colors.mulchBrown, fontStyle: 'italic' },
  loading: { fontSize: 12, color: colors.mulchBrown, fontFamily: fonts.body },
  errorBox: {
    padding: '8px 12px',
    background: 'rgba(118, 12, 25, 0.08)',
    border: `1px solid ${colors.signetBurgundy}`,
    borderRadius: rounded.sm,
    color: colors.signetBurgundy,
    fontSize: 12,
    fontFamily: fonts.body,
    fontWeight: 600,
  },
  field: { marginBottom: 8 },
  fieldLabel: { fontSize: 10, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 },
  fieldValue: { fontSize: 12, color: colors.ledgerCharcoal, wordBreak: 'break-word', fontFamily: fonts.body },
  imageRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: rounded.sm,
    objectFit: 'cover',
    border: `1px solid ${colors.cardBorder}`,
  },
  placeholder: {
    width: 48,
    height: 48,
    borderRadius: rounded.sm,
    background: colors.feedBagCream,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    color: colors.mulchBrown,
    border: `1px solid ${colors.cardBorder}`,
  },
  customGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 },
  customKey: { fontSize: 10, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' },
  customValue: { fontSize: 11, color: colors.ledgerCharcoal, wordBreak: 'break-word', fontFamily: fonts.mono },
};

function renderPreviewContent(extracted: ExtractorTestResult) {
  return (
    <>
      {extracted.title && (
        <div style={s.field}>
          <div style={s.fieldLabel}>Title</div>
          <div style={s.fieldValue}>{extracted.title}</div>
        </div>
      )}
      {extracted.brand && (
        <div style={s.field}>
          <div style={s.fieldLabel}>Brand</div>
          <div style={s.fieldValue}>{extracted.brand}</div>
        </div>
      )}
      {extracted.description && (
        <div style={s.field}>
          <div style={s.fieldLabel}>Description</div>
          <div style={s.fieldValue}>
            {extracted.description.length > 200
              ? extracted.description.slice(0, 200) + '…'
              : extracted.description}
          </div>
        </div>
      )}
      {extracted.images && extracted.images.length > 0 && (
        <div style={s.field}>
          <div style={s.fieldLabel}>Images ({extracted.images.length})</div>
          <div style={s.imageRow}>
            {extracted.images.slice(0, 6).map((url: string, i: number) => (
              <img key={i} src={url} alt="" style={s.thumb} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ))}
          </div>
        </div>
      )}
      {extracted.customFields && Object.keys(extracted.customFields).length > 0 && (
        <div style={s.field}>
          <div style={s.fieldLabel}>Custom Fields</div>
          <div style={s.customGrid}>
            {Object.entries(extracted.customFields).map(([k, v]) => (
              <React.Fragment key={k}>
                <span style={s.customKey}>{k}</span>
                <span style={s.customValue}>{v}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function ExtractionPreview({ state, controller }: ExtractionPreviewProps) {
  const { extractionPreview, draft, requests } = state;

  return (
    <div style={s.panel}>
      <h4 style={s.title}>Extraction Preview</h4>

      <div style={s.btnRow}>
        <button
          type="button"
          style={requests.preview.loading || !draft.productUrl ? s.disabledBtn : s.primaryBtn}
          onClick={controller.runPreview}
          disabled={requests.preview.loading || !draft.productUrl}
        >
          {requests.preview.loading ? 'Running…' : 'Run Preview'}
        </button>
      </div>

      {requests.preview.error && (
        <div style={s.errorBox}>{requests.preview.error}</div>
      )}

      {requests.preview.loading && (
        <div style={s.loading}>Running extraction preview…</div>
      )}

      {!requests.preview.loading && !requests.preview.error && extractionPreview && (
        renderPreviewContent(extractionPreview)
      )}

      {!extractionPreview && !requests.preview.error && !requests.preview.success && (
        <div style={s.empty}>No extraction preview yet. Assign selectors and run preview.</div>
      )}
    </div>
  );
}
