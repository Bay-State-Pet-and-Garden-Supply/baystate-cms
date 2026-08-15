/**
 * Epic #46 — Review listing content panel (Phase 6).
 *
 * Description, specs/bullets, custom fields, search keywords, and price where
 * present. Supports inline editing of curated fields during review (edits
 * invalidate the durable review server-side).
 */
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { ReviewDraft } from './review-types';

export interface ReviewListingPanelProps {
  detail: ItemDetailResponse | null;
  editing: boolean;
  draft: ReviewDraft;
  onDraftChange: (draft: ReviewDraft) => void;
  onSaveEdit: () => Promise<void>;
  onCancelEdit: () => void;
  saving: boolean;
  saveError: string | null;
}

function extraction(detail: ItemDetailResponse | null) {
  return detail?.extraction ?? detail?.item.extractionData ?? null;
}

export function ReviewListingPanel({
  detail,
  editing,
  draft,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  saving,
  saveError,
}: ReviewListingPanelProps) {
  const ext = extraction(detail);
  const curation = detail?.item.curationData ?? null;

  const description = curation?.curatedDescription ?? ext?.description ?? null;
  const bullets = ext?.bulletPoints ?? [];
  const keywords = curation?.searchKeywords ?? ext?.searchKeywords ?? null;
  const customFields = ext?.customFields ?? {};
  const price = ext?.price ?? detail?.item.price ?? null;
  const quantity = detail?.item.quantity;

  return (
    <section className="rv-panel" aria-label="Listing content">
      <header className="rv-panel-head">Listing content</header>
      <div className="rv-panel-body">
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <div>
              <label className="rv-field-label" htmlFor="rv-edit-title">
                Curated title
              </label>
              <input
                id="rv-edit-title"
                className="rv-input"
                value={draft.curatedTitle}
                onChange={e => onDraftChange({ ...draft, curatedTitle: e.target.value })}
              />
            </div>
            <div>
              <label className="rv-field-label" htmlFor="rv-edit-brand">
                Brand hint
              </label>
              <input
                id="rv-edit-brand"
                className="rv-input"
                value={draft.brandHint}
                onChange={e => onDraftChange({ ...draft, brandHint: e.target.value })}
              />
            </div>
            <div>
              <label className="rv-field-label" htmlFor="rv-edit-desc">
                Description
              </label>
              <textarea
                id="rv-edit-desc"
                className="rv-textarea"
                value={draft.curatedDescription}
                onChange={e => onDraftChange({ ...draft, curatedDescription: e.target.value })}
              />
            </div>
            <div>
              <label className="rv-field-label" htmlFor="rv-edit-keywords">
                Search keywords
              </label>
              <input
                id="rv-edit-keywords"
                className="rv-input"
                value={draft.searchKeywords}
                onChange={e => onDraftChange({ ...draft, searchKeywords: e.target.value })}
              />
            </div>
            <div className="rv-proposal-actions">
              <button type="button" className="rv-btn rv-btn-primary" disabled={saving} onClick={() => void onSaveEdit()}>
                {saving ? 'Saving…' : 'Save edits'}
              </button>
              <button type="button" className="rv-btn rv-btn-secondary" disabled={saving} onClick={onCancelEdit}>
                Cancel
              </button>
            </div>
            {saveError && <div className="rv-error-banner">Could not save edits: {saveError}</div>}
          </div>
        ) : (
          <>
            <div className="rv-field">
              <div className="rv-field-label">Description</div>
              <div className="rv-field-value">{description || '—'}</div>
            </div>

            {bullets.length > 0 && (
              <div className="rv-field">
                <div className="rv-field-label">Specs / highlights</div>
                <ul className="rv-list">
                  {bullets.map((b, idx) => (
                    <li key={idx}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.5rem 1rem' }}>
              {price && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Price (source)</div>
                  <div className="rv-field-value">{price}</div>
                </div>
              )}
              {typeof quantity === 'number' && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Quantity</div>
                  <div className="rv-field-value">{quantity}</div>
                </div>
              )}
              {ext?.weight && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Weight</div>
                  <div className="rv-field-value">{ext.weight}</div>
                </div>
              )}
            </div>

            {keywords && (
              <div className="rv-field" style={{ marginTop: '0.875rem' }}>
                <div className="rv-field-label">Search keywords</div>
                <div className="rv-field-value">{keywords}</div>
              </div>
            )}

            {Object.keys(customFields).length > 0 && (
              <div className="rv-field" style={{ marginTop: '0.875rem' }}>
                <div className="rv-field-label">Custom fields</div>
                <ul className="rv-list">
                  {Object.entries(customFields).map(([key, value]) => (
                    <li key={key}>
                      <strong>{key}</strong>: {value}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}