/**
 * Epic #46 — Review media panel (Phase 6).
 *
 * Primary image with provenance caption, additional images grid, click-to-zoom
 * (lightbox handled by the workspace), and a clear missing-image empty state.
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { distributorApprovedImages } from './review-logic';

export interface ReviewMediaPanelProps {
  workState: OnboardingWorkState;
  detail: ItemDetailResponse | null;
  onOpenLightbox: (url: string, caption: string) => void;
}

function extraction(detail: ItemDetailResponse | null) {
  return detail?.extraction ?? detail?.item.extractionData ?? null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function ReviewMediaPanel({ workState, detail, onOpenLightbox }: ReviewMediaPanelProps) {
  const ext = extraction(detail);
  const approved = distributorApprovedImages(ext);
  // Distributor records carry rights-attested approvals (Amendment B addendum
  // 3) instead of primaryImage/additionalImages — render those so the
  // operator can actually SEE the product during review.
  const primary = ext?.primaryImage ?? approved?.primary ?? workState.imageUrl ?? null;
  const additional = (ext?.additionalImages ?? []).filter(url => url !== primary);
  for (const url of approved?.additional ?? []) {
    if (url !== primary && !additional.includes(url)) additional.push(url);
  }
  const provenance =
    workState.sourceType === 'distributor_record'
      ? 'Distributor record image'
      : 'Official page image';

  return (
    <section className="rv-panel" aria-label="Media">
      <header className="rv-panel-head">Media</header>
      <div className="rv-panel-body">
        {primary ? (
          <button
            type="button"
            className="rv-image-tile"
            style={{ width: 220, height: 220, cursor: 'zoom-in', border: '1px solid var(--color-card-border)', padding: '4px', background: 'var(--color-feed-bag-cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--rounded-lg)', overflow: 'hidden' }}
            onClick={() => onOpenLightbox(primary, `${provenance}${hostOf(primary) ? ` — ${hostOf(primary)}` : ''}`)}
            aria-label={`Open primary image: ${hostOf(primary) ?? primary}`}
          >
            <img
              src={primary}
              alt={`${workState.curatedTitle || workState.name} primary image`}
              className="rv-primary-image"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </button>
        ) : (
          <div className="rv-empty">No primary image for this listing.</div>
        )}
        <div className="rv-provenance">
          {provenance}
          {primary && hostOf(primary) ? ` from ${hostOf(primary)}` : ''}
        </div>

        {additional.length > 0 && (
          <>
            <div className="rv-field-label" style={{ marginTop: '0.875rem' }}>
              Additional images ({additional.length})
            </div>
            <div className="rv-image-grid" style={{ marginTop: '0.5rem' }}>
              {additional.map((url, idx) => (
                <button
                  key={`${url}-${idx}`}
                  type="button"
                  className="rv-image-tile"
                  style={{ padding: '2px', border: '1px solid var(--color-card-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-feed-bag-cream)', overflow: 'hidden' }}
                  onClick={() => onOpenLightbox(url, `Additional image ${idx + 1}${hostOf(url) ? ` — ${hostOf(url)}` : ''}`)}
                  aria-label={`Open additional image ${idx + 1}`}
                >
                  <img
                    src={url}
                    alt={`${workState.curatedTitle || workState.name} additional image ${idx + 1}`}
                    style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 4 }}
                  />
                </button>
              ))}
            </div>
          </>
        )}

        {!ext && (
          <p className="rv-provenance" style={{ marginTop: '0.5rem' }}>
            Detail not loaded yet — edit data reflects the last saved extraction.
          </p>
        )}
      </div>
    </section>
  );
}
