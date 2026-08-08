import React from 'react';
import type { ExtractionData } from '../../../shared/schemas/onboarding';

interface ExtractionStagePanelProps {
  extractionData: ExtractionData | null;
  sourceUrl: string | null;
  showEditUrl: boolean;
  setShowEditUrl: (show: boolean) => void;
  manualUrlInput: string;
  setManualUrlInput: (url: string) => void;
  onSetManualUrl: (url: string) => Promise<void>;
}

export function ExtractionStagePanel({
  extractionData,
  sourceUrl,
  showEditUrl,
  setShowEditUrl,
  manualUrlInput,
  setManualUrlInput,
  onSetManualUrl,
}: ExtractionStagePanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Source URL Banner */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          🔗 Source URL
        </h3>
        {showEditUrl ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={manualUrlInput}
              onChange={(e) => setManualUrlInput(e.target.value)}
              placeholder="Paste product page URL manually"
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minHeight: 36 }}
            />
            <button
              type="button"
              onClick={async () => {
                if (manualUrlInput.trim()) {
                  await onSetManualUrl(manualUrlInput.trim());
                  setShowEditUrl(false);
                }
              }}
              style={{ padding: '8px 16px', minHeight: 36, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              Set
            </button>
            <button
              type="button"
              onClick={() => setShowEditUrl(false)}
              style={{ padding: '8px 12px', minHeight: 36, background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#4b5563' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              background: '#f9fafb',
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #e5e7eb',
            }}
          >
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 13, color: '#2563eb', textDecoration: 'none', fontWeight: 600, wordBreak: 'break-all' }}
                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
              >
                {sourceUrl} <span style={{ fontSize: 11, marginLeft: 2 }}>↗</span>
              </a>
            ) : (
              <span style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No URL set</span>
            )}
            <button
              type="button"
              onClick={() => setShowEditUrl(true)}
              style={{
                background: 'none',
                border: '1px solid #d1d5db',
                color: '#374151',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                padding: '4px 10px',
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              ✏ Edit
            </button>
          </div>
        )}
      </div>

      {/* Raw Extraction Results Table */}
      {extractionData ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: '#1e293b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            📋 Raw Scraped Spec Data
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {extractionData.title && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Title</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word', fontWeight: 500 }}>{extractionData.title}</td>
                </tr>
              )}
              {extractionData.brand && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Brand</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.brand}</td>
                </tr>
              )}
              {extractionData.description && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Description</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {extractionData.description.slice(0, 500)}{extractionData.description.length > 500 ? '…' : ''}
                  </td>
                </tr>
              )}
              {extractionData.customFields && Object.keys(extractionData.customFields).length > 0 && (
                Object.entries(extractionData.customFields).map(([fieldName, value]) => (
                  <tr key={fieldName}>
                    <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>{fieldName}</td>
                    <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{String(value)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {extractionData.fieldProvenance && Object.keys(extractionData.fieldProvenance).length > 0 && (
            <details style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#475569' }}>Field provenance (which source each field came from)</summary>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(extractionData.fieldProvenance).map(([field, source]) => (
                  <span key={field} style={{ background: '#f1f5f9', padding: '3px 8px', borderRadius: 4, color: '#475569', fontSize: 11, fontWeight: 500 }}>
                    {field}: <strong>{String(source)}</strong>
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
          No raw extraction data available yet for this item.
        </div>
      )}
    </div>
  );
}
