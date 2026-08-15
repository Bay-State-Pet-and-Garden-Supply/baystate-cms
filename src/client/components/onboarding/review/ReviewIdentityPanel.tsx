/**
 * Epic #46 — Review identity panel (Phase 6).
 *
 * Imported identity vs curated output side by side, UPC, brand, variant/size,
 * family context, and source identity.
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { itemDisplayName, sourceTypeLabel } from './review-logic';

export interface ReviewIdentityPanelProps {
  workState: OnboardingWorkState;
  detail: ItemDetailResponse | null;
}

function extraction(detail: ItemDetailResponse | null) {
  return detail?.extraction ?? detail?.item.extractionData ?? null;
}

export function ReviewIdentityPanel({ workState, detail }: ReviewIdentityPanelProps) {
  const ext = extraction(detail);
  const curatedTitle = detail?.item.curationData?.curatedTitle ?? null;
  const brand = workState.brand ?? detail?.item.brandHint ?? ext?.brand ?? null;
  const variant =
    detail?.item.curationData?.curatedWeight ?? ext?.weight ?? null;
  const displayTitle = itemDisplayName(workState, curatedTitle);

  return (
    <section className="rv-panel" aria-label="Product identity">
      <header className="rv-panel-head">Identity</header>
      <div className="rv-panel-body">
        <div className="rv-compare">
          <div>
            <div className="rv-compare-col-label">Imported</div>
            <div className="rv-field-value rv-imported" title={workState.name}>
              {workState.name || '—'}
            </div>
          </div>
          <div>
            <div className="rv-compare-col-label">Curated</div>
            <div className="rv-field-value" title={displayTitle}>
              {displayTitle || '—'}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '0.5rem 1rem',
            marginTop: '0.875rem',
          }}
        >
          <div className="rv-field" style={{ marginBottom: 0 }}>
            <div className="rv-field-label">UPC / GTIN</div>
            <div className="rv-field-value" style={{ fontFamily: 'var(--font-mono)' }}>
              {workState.upc || '—'}
            </div>
          </div>
          <div className="rv-field" style={{ marginBottom: 0 }}>
            <div className="rv-field-label">Brand</div>
            <div className="rv-field-value">{brand || '—'}</div>
          </div>
          {variant && (
            <div className="rv-field" style={{ marginBottom: 0 }}>
              <div className="rv-field-label">Size / variant</div>
              <div className="rv-field-value">{variant}</div>
            </div>
          )}
        </div>

        {workState.family && (
          <div className="rv-field" style={{ marginTop: '0.875rem' }}>
            <div className="rv-field-label">Family</div>
            <div className="rv-field-value">
              {workState.family.label ?? 'Product family'} · {workState.family.readyCount}/
              {workState.family.memberCount} members ready
            </div>
          </div>
        )}

        <div className="rv-field" style={{ marginTop: '0.875rem' }}>
          <div className="rv-field-label">Source</div>
          <div className="rv-field-value">
            {sourceTypeLabel(workState.sourceType)}
            {workState.domain ? ` · ${workState.domain}` : ''}
            {ext?.distributorProviderId ? ` · ${ext.distributorProviderId}` : ''}
          </div>
        </div>
      </div>
    </section>
  );
}