/**
 * ExtractionPreview — product-like extraction preview using the single-URL test API.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import type { ExtractorTestResult } from '../../../onboarding-api';

interface ExtractionPreviewProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: '#fff',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    padding: 12,
  },
  title: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 8px' },
  btnRow: { marginBottom: 10 },
  primaryBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  disabledBtn: {
    background: '#9ca3af',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  empty: { fontSize: 12, color: '#9ca3af', fontStyle: 'italic' },
  loading: { fontSize: 12, color: '#6b7280' },
  errorBox: {
    padding: '6px 10px',
    background: '#fee2e2',
    borderRadius: 6,
    color: '#991b1b',
    fontSize: 12,
  },
  field: { marginBottom: 6 },
  fieldLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 },
  fieldValue: { fontSize: 13, color: '#111827', wordBreak: 'break-word' },
  imageRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 4,
    objectFit: 'cover',
    border: '1px solid #e5e7eb',
  },
  placeholder: {
    width: 48,
    height: 48,
    borderRadius: 4,
    background: '#f3f4f6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    color: '#9ca3af',
    border: '1px solid #e5e7eb',
  },
  customGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 4 },
  customKey: { fontSize: 10, fontWeight: 600, color: '#6b7280' },
  customValue: { fontSize: 11, color: '#374151', wordBreak: 'break-word' },
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
