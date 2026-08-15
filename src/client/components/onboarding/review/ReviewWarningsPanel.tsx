/**
 * Epic #46 — Review warnings / provenance panel (Phase 6).
 *
 * Surfaces blocking semantic validation, consistency warnings, evidence
 * summary, and source provenance. A blocked finding prevents Looks Good.
 */
import type { ItemDetailResponse } from '../../../onboarding-api';
import { warningInfoFromDetail } from './review-logic';

export interface ReviewWarningsPanelProps {
  detail: ItemDetailResponse | null;
}

function evidenceSummary(detail: ItemDetailResponse | null): string[] {
  const lines: string[] = [];
  const ext = detail?.extraction ?? detail?.item.extractionData ?? null;
  if (!ext) return ['No extraction evidence yet.'];
  if (ext.distributorProviderIds && ext.distributorProviderIds.length > 0) {
    lines.push(`Distributor evidence: ${[...new Set(ext.distributorProviderIds)].join(', ')}`);
  }
  if (ext.sourceType === 'official_page') {
    lines.push(`Official page evidence${ext.sourceUrl ? ` from ${ext.sourceUrl}` : ''}`);
  }
  if (ext.distributorRecordProvenance) {
    lines.push(
      `Distributor record projection (${ext.distributorRecordProvenance.projectionVersion ?? 'v1'}) — evidence hash ${ext.distributorRecordProvenance.evidenceHash.slice(0, 10)}…`,
    );
  }
  const piEvidence = ext.productIntelligenceEvidence ?? [];
  if (piEvidence.length > 0) {
    lines.push(`Product Intelligence imports: ${piEvidence.length}`);
  }
  if (lines.length === 0) lines.push('Extraction evidence present (provenance unknown).');
  return lines;
}

export function ReviewWarningsPanel({ detail }: ReviewWarningsPanelProps) {
  const info = warningInfoFromDetail(detail ?? {});
  const evidence = evidenceSummary(detail);

  return (
    <section className="rv-panel" aria-label="Warnings and provenance">
      <header className="rv-panel-head">Warnings / provenance</header>
      <div className="rv-panel-body">
        {info.blocked ? (
          <div className="rv-blocked">
            <div className="rv-blocked-title">Review is blocked for this product</div>
            <ul className="rv-warn-list">
              {info.messages.map((message, idx) => (
                <li key={idx}>{message}</li>
              ))}
            </ul>
          </div>
        ) : info.messages.length > 0 ? (
          <ul className="rv-warn-list" style={{ marginBottom: '0.625rem' }}>
            {info.messages.map((message, idx) => (
              <li key={idx}>{message}</li>
            ))}
          </ul>
        ) : (
          <div className="rv-warn-ok">✓ No blocking warnings</div>
        )}

        <div className="rv-field" style={{ marginTop: '0.875rem' }}>
          <div className="rv-field-label">Evidence summary</div>
          <ul className="rv-list" style={{ fontSize: '0.8125rem' }}>
            {evidence.map((line, idx) => (
              <li key={idx}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}