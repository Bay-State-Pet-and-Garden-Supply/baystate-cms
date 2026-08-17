import React from 'react';
import type { ExtractionData } from '../../../shared/schemas/onboarding';
import type { SourcingQualificationView } from '../../onboarding-api';

interface ExtractionStagePanelProps {
  extractionData: ExtractionData | null;
  sourceUrl: string | null;
  showEditUrl: boolean;
  setShowEditUrl: (show: boolean) => void;
  manualUrlInput: string;
  setManualUrlInput: (url: string) => void;
  onSetManualUrl: (url: string) => Promise<void>;
  /** Item source type (Amendment A): distributor_record items use the deterministic materializer, not a scraped page. */
  sourceType?: 'official_page' | 'distributor_record';
  /**
   * Server-derived distributor-record qualification view (from item detail).
   * Used to render sourcing provenance for distributor items whose extraction
   * payload is not yet materialized (extraction pending / failed): the
   * accepted attempts, providers, and evidence hash remain visible even when
   * `extractionData` is null.
   */
  qualificationView?: SourcingQualificationView | null;
  /** Item stage status: distinguishes extraction pending vs failed null-payload states. */
  stageStatus?: string;
  /**
   * Operator "Continue with Official Site Discovery" (MD item 8). Provided by
   * the board only for distributor-source extraction items at pending/failed/
   * completed-before-curation. The server owns the guarded transaction.
   */
  onContinueWithOfficialDiscovery?: () => Promise<void>;
}

export function ExtractionStagePanel({
  extractionData,
  sourceUrl,
  showEditUrl,
  setShowEditUrl,
  manualUrlInput,
  setManualUrlInput,
  onSetManualUrl,
  sourceType = 'official_page',
  qualificationView = null,
  stageStatus,
  onContinueWithOfficialDiscovery,
}: ExtractionStagePanelProps) {
  const isDistributor = sourceType === 'distributor_record';
  const distributorProvenance = extractionData?.distributorRecordProvenance ?? null;
  // Amendment B (M5b-2): VERIFIED v2 materializations (extractionMethod
  // distributor_record_v2) render merchandising-depth data. V1 / unverified
  // rows keep the identity-only surface.
  const verifiedV2Distributor = isDistributor && distributorProvenance?.extractionMethod === 'distributor_record_v2';
  const distributorProviderIds = extractionData?.distributorProviderIds ?? [];
  const distributorAttemptIds = extractionData?.distributorEvidenceAttemptIds ?? [];
  const notYetMaterialized = isDistributor && !extractionData;
  const materializationFailed = notYetMaterialized && stageStatus === 'failed';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Source Banner */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {isDistributor ? '🏬 Distributor Record' : '🔗 Source URL'}
        </h3>

        {isDistributor ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: '#fffbeb',
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #fde68a',
            }}
          >
            <span style={{ fontSize: 13, color: '#92400e', fontWeight: 600 }}>
              {extractionData
                ? 'Materialized from a qualified distributor record (no product page).'
                : materializationFailed
                  ? 'Materialization failed — review provenance and use the guarded fallback.'
                  : 'Distributor record qualified — materialization pending (no product page).'}
            </span>
            {distributorProviderIds.length > 0 ? (
              <span style={{ fontSize: 12, color: '#78350f' }}>
                Providers: <strong>{distributorProviderIds.join(', ')}</strong>
              </span>
            ) : qualificationView && qualificationView.providerIds.length > 0 ? (
              <span style={{ fontSize: 12, color: '#78350f' }}>
                Providers: <strong>{qualificationView.providerIds.join(', ')}</strong>
              </span>
            ) : null}
            {distributorProvenance ? (
              <details style={{ fontSize: 12, color: '#78350f' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Distributor provenance (generation / attempts / hash)</summary>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Generation: <strong>{distributorProvenance.sourcingGenerationId}</strong></span>
                  <span>Accepted attempts: <strong>{distributorProvenance.acceptedEvidenceAttemptIds.join(', ') || '—'}</strong></span>
                  <span>Catalog versions: <strong>{distributorProvenance.catalogVersions.join(', ') || '—'}</strong></span>
                  <span>Evidence hash: <code style={{ wordBreak: 'break-all' }}>{distributorProvenance.evidenceHash}</code></span>
                </div>
              </details>
            ) : qualificationView ? (
              <details style={{ fontSize: 12, color: '#78350f' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                  Distributor qualification (providers / attempts / hash)
                </summary>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Qualified: <strong>{qualificationView.qualified ? 'yes' : 'no'}</strong></span>
                  {qualificationView.reasonCodes.length > 0 && (
                    <span>Reason codes: <strong>{qualificationView.reasonCodes.join(', ')}</strong></span>
                  )}
                  <span>Generation: <strong>{qualificationView.sourcingGenerationId ?? '—'}</strong></span>
                  <span>Accepted attempts: <strong>{qualificationView.acceptedEvidenceAttemptIds.join(', ') || '—'}</strong></span>
                  <span>Evidence hash: <code style={{ wordBreak: 'break-all' }}>{qualificationView.evidenceHash ?? '—'}</code></span>
                </div>
              </details>
            ) : null}
            {distributorAttemptIds.length > 0 ? (
              <span style={{ fontSize: 12, color: '#78350f' }}>
                Evidence attempts: <strong>{distributorAttemptIds.join(', ')}</strong>
              </span>
            ) : qualificationView && qualificationView.acceptedEvidenceAttemptIds.length > 0 ? (
              <span style={{ fontSize: 12, color: '#78350f' }}>
                Evidence attempts: <strong>{qualificationView.acceptedEvidenceAttemptIds.join(', ')}</strong>
              </span>
            ) : null}
            {onContinueWithOfficialDiscovery && (
              <button
                type="button"
                onClick={async () => {
                  await onContinueWithOfficialDiscovery();
                }}
                style={{
                  alignSelf: 'flex-start',
                  padding: '6px 12px',
                  background: '#fff',
                  border: '1px solid #d97706',
                  color: '#92400e',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Continue with Official Site Discovery
              </button>
            )}
          </div>
        ) : showEditUrl ? (
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
            {isDistributor ? (verifiedV2Distributor ? '📦 Distributor Record Data (merchandising-depth)' : '📦 Distributor Record Data (identity-only)') : '📋 Raw Scraped Spec Data'}
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {extractionData.title && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Title</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word', fontWeight: 500 }}>{extractionData.title}</td>
                </tr>
              )}
              {extractionData.brand && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Brand</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.brand}</td>
                </tr>
              )}
              {extractionData.weight && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Weight</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.weight}</td>
                </tr>
              )}
              {isDistributor && extractionData.distributorSku && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Distributor SKU</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>
                    {extractionData.distributorSku}
                    {extractionData.distributorReferenceValues?.distributorSku &&
                      extractionData.distributorReferenceValues.distributorSku.length > 1 && (
                        <span style={{ color: '#64748b', fontSize: 11 }}>
                          {' '}· Also:{' '}
                          {extractionData.distributorReferenceValues.distributorSku
                            .filter((v) => v !== extractionData.distributorSku)
                            .join(' · ')}
                        </span>
                      )}
                  </td>
                </tr>
              )}
              {isDistributor && extractionData.manufacturerPartNumber && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>MPN</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.manufacturerPartNumber}</td>
                </tr>
              )}
              {isDistributor &&
                extractionData.variantAttributes &&
                Object.keys(extractionData.variantAttributes).length > 0 &&
                Object.entries(extractionData.variantAttributes).map(([axis, value]) => (
                  <tr key={axis}>
                    <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>{axis}</td>
                    <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{String(value)}</td>
                  </tr>
                ))}
              {isDistributor && verifiedV2Distributor && extractionData.description && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Description</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {extractionData.description.slice(0, 500)}{extractionData.description.length > 500 ? '…' : ''}
                  </td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.bulletPoints && extractionData.bulletPoints.length > 0 && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Features</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {extractionData.bulletPoints.map((b, i) => (
                        <li key={i} style={{ margin: '2px 0' }}>{b}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.distributorCategory && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Category</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.distributorCategory}</td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.dimensions && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Dimensions</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.dimensions}</td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.casePack && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Case pack</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.casePack}</td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.unitOfMeasure && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Unit of measure</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.unitOfMeasure}</td>
                </tr>
              )}
              {isDistributor && verifiedV2Distributor && extractionData.ingredients && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Ingredients</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{extractionData.ingredients}</td>
                </tr>
              )}
              {!isDistributor && extractionData.description && (
                <tr>
                  <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Description</td>
                  <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {extractionData.description.slice(0, 500)}{extractionData.description.length > 500 ? '…' : ''}
                  </td>
                </tr>
              )}
              {!isDistributor &&
                extractionData.customFields &&
                Object.keys(extractionData.customFields).length > 0 && (
                Object.entries(extractionData.customFields).map(([fieldName, value]) => (
                  <tr key={fieldName}>
                    <td style={{ padding: '8px 8px 8px 0', fontWeight: 600, color: '#475569', width: 140, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>{fieldName}</td>
                    <td style={{ padding: '8px 0', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{String(value)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {isDistributor &&
            verifiedV2Distributor &&
            extractionData.distributorImageCandidates &&
            extractionData.distributorImageCandidates.length > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: '10px 14px',
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>
                🖼 Image candidates — DISPLAY ONLY, not approved for catalog use
              </span>
              <span style={{ fontSize: 12, color: '#78350f' }}>
                These distributor URLs are never downloaded, OCR'd, or published without PI-6 rights
                verification. Shown as text only.
              </span>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {extractionData.distributorImageCandidates.map((cand, i) => (
                  <li key={i} style={{ fontSize: 12, color: '#78350f', wordBreak: 'break-all', margin: '2px 0' }}>
                    {cand.url}
                    {cand.sourceAttemptIds.length > 0 && (
                      <span style={{ color: '#b45309' }}> (attempts: {cand.sourceAttemptIds.join(', ')})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

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
          {isDistributor && verifiedV2Distributor && distributorProvenance?.merchandisingProvenance && (
            <details style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#475569' }}>
                Merchandising provenance (which attempt supplied each merchandising field)
              </summary>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(distributorProvenance.merchandisingProvenance).map(([field, entries]) => (
                  <span key={field} style={{ background: '#fef3c7', padding: '3px 8px', borderRadius: 4, color: '#92400e', fontSize: 11, fontWeight: 500 }}>
                    {field}:{' '}
                    <strong>
                      {(entries ?? [])
                        .map((e) => e.providerId)
                        .filter((v, i, arr) => arr.indexOf(v) === i)
                        .join(', ')}
                    </strong>
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
          {isDistributor
            ? qualificationView && !extractionData
              ? materializationFailed
                ? 'Distributor record materialization failed. Review the provenance below and use the guarded fallback, or re-run when evidence changes.'
                : 'Distributor evidence is qualified; record materialization is pending.'
              : 'No distributor record materialization available yet for this item.'
            : 'No raw extraction data available yet for this item.'}
        </div>
      )}
    </div>
  );
}
