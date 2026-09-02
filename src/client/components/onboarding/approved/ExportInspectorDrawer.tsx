import React, { useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getItemDetail, type ItemDetailResponse } from '../../../onboarding-api';

interface ExportInspectorDrawerProps {
  itemId: string | null;
  workState: OnboardingWorkState | null;
  onClose: () => void;
  onCreateDraftSingle?: (itemId: string) => Promise<void>;
  busy?: boolean;
}

export function ExportInspectorDrawer({
  itemId,
  workState,
  onClose,
  onCreateDraftSingle,
  busy = false,
}: ExportInspectorDrawerProps) {
  const [detail, setDetail] = useState<ItemDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [activeDrawerTab, setActiveDrawerTab] = useState<'payload' | 'attributes' | 'audit'>('payload');

  const drawerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!itemId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedImage(null);

    (async () => {
      try {
        const res = await getItemDetail(itemId);
        if (!cancelled) {
          setDetail(res);
          const ext = res.extraction ?? res.item?.extractionData ?? null;
          const cur = res.item?.curationData as any;
          const primary = ext?.primaryImage || cur?.primaryImage || workState?.imageUrl;
          if (primary) setSelectedImage(primary);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId, workState?.imageUrl]);

  // Keyboard accessibility: Escape to close
  useEffect(() => {
    if (!itemId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [itemId, onClose]);

  if (!itemId || !workState) return null;

  const curData = detail?.item?.curationData as any;
  const extraction = detail?.extraction ?? detail?.item?.extractionData ?? null;

  const displayTitle = curData?.curatedTitle || workState.curatedTitle || extraction?.title || workState.name;
  const displayBrand = curData?.brand || workState.brand || extraction?.brand || 'Unbranded';
  const displayUpc = workState.upc || detail?.item?.upc || '—';
  const displaySku = curData?.sku || extraction?.distributorSku || 'Auto-generated';
  const displayPrice = curData?.curatedPrice ? `$${curData.curatedPrice}` : extraction?.price ? `$${extraction.price}` : '—';
  const displayWeight = curData?.curatedWeight || workState.weight || extraction?.weight || '—';
  const displayDescription = curData?.curatedDescription || extraction?.description || workState.detail || 'No description provided';
  const displayPages: string[] = Array.isArray(curData?.categoryPages)
    ? curData.categoryPages
    : Array.isArray(curData?.pages)
      ? curData.pages
      : [];

  const allImages = [
    ...(curData?.primaryImage ? [curData.primaryImage] : []),
    ...(extraction?.primaryImage && extraction.primaryImage !== curData?.primaryImage ? [extraction.primaryImage] : []),
    ...(Array.isArray(curData?.additionalImages) ? curData.additionalImages : []),
    ...(Array.isArray(extraction?.additionalImages) ? extraction.additionalImages : []),
    ...(workState.imageUrl ? [workState.imageUrl] : []),
  ].filter((url, idx, arr): url is string => typeof url === 'string' && url.length > 0 && arr.indexOf(url) === idx);

  const activeImage = selectedImage || allImages[0] || workState.imageUrl;
  const ocrData = extraction?.packagingOcrData;

  return (
    <div
      className="ow-drawer-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ow-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-drawer-title"
      >
        {/* Drawer Header */}
        <div className="ow-drawer-header">
          <div className="ow-drawer-header-content">
            <div className="ow-drawer-badges">
              <span className={`ow-status-pill ow-status-pill--${workState.category}`}>
                {workState.category === 'approved' && 'Awaiting Export Draft'}
                {workState.category === 'ready_to_export' && 'Draft Staged in Change Set'}
                {workState.category === 'completed' && '✓ Export Verified'}
              </span>
              {displayBrand && <span className="ow-drawer-brand-tag">{displayBrand}</span>}
              {workState.sourceType && (
                <span className="ow-drawer-source-tag">
                  {workState.sourceType === 'distributor_record' ? 'Distributor Source' : 'Brand Site'}
                </span>
              )}
            </div>
            <h3 id="export-drawer-title" className="ow-drawer-title">
              {displayTitle}
            </h3>
            <div className="ow-drawer-meta-bar">
              <span className="ow-drawer-mono">UPC: {displayUpc}</span>
              <span className="ow-drawer-mono">SKU: {displaySku}</span>
              {displayWeight !== '—' && <span>Weight: {displayWeight}</span>}
              {displayPrice !== '—' && <span className="ow-drawer-price">{displayPrice}</span>}
            </div>
          </div>
          <button
            type="button"
            ref={closeBtnRef}
            className="ow-drawer-close"
            onClick={onClose}
            aria-label="Close inspector drawer"
          >
            ✕
          </button>
        </div>

        {/* Drawer Tabs */}
        <div className="ow-drawer-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeDrawerTab === 'payload'}
            className={`ow-drawer-tab ${activeDrawerTab === 'payload' ? 'ow-drawer-tab--active' : ''}`}
            onClick={() => setActiveDrawerTab('payload')}
          >
            ShopSite XML Draft
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeDrawerTab === 'attributes'}
            className={`ow-drawer-tab ${activeDrawerTab === 'attributes' ? 'ow-drawer-tab--active' : ''}`}
            onClick={() => setActiveDrawerTab('attributes')}
          >
            Product Attributes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeDrawerTab === 'audit'}
            className={`ow-drawer-tab ${activeDrawerTab === 'audit' ? 'ow-drawer-tab--active' : ''}`}
            onClick={() => setActiveDrawerTab('audit')}
          >
            Release & Audit Trail
          </button>
        </div>

        {/* Drawer Body */}
        <div className="ow-drawer-body">
          {loading && (
            <div className="ow-drawer-loading">
              <span className="ow-spinner" /> Loading full product specifications…
            </div>
          )}

          {error && (
            <div className="ow-error" role="alert">
              <span>Could not load complete item details: {error}</span>
            </div>
          )}

          {activeDrawerTab === 'payload' && (
            <div className="ow-drawer-section-stack">
              {/* Product Media Gallery */}
              <div className="ow-drawer-card">
                <h5 className="ow-drawer-card-title">ShopSite Product Image</h5>
                <div className="ow-media-preview-container">
                  {activeImage ? (
                    <div className="ow-media-hero">
                      <img
                        src={activeImage}
                        alt={displayTitle}
                        className="ow-media-hero-img"
                        onError={e => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>
                  ) : (
                    <div className="ow-media-placeholder">
                      <span>No image available</span>
                    </div>
                  )}

                  {allImages.length > 1 && (
                    <div className="ow-media-thumbnails">
                      {allImages.map((img, i) => (
                        <button
                          key={i}
                          type="button"
                          className={`ow-media-thumb-btn ${img === activeImage ? 'ow-media-thumb-btn--active' : ''}`}
                          onClick={() => setSelectedImage(img)}
                        >
                          <img src={img} alt={`Thumbnail ${i + 1}`} className="ow-media-thumb-img" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Core XML Payload Fields */}
              <div className="ow-drawer-card">
                <h5 className="ow-drawer-card-title">Core ShopSite XML Fields</h5>
                <div className="ow-grid-props">
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Product Name:</span>
                    <span className="ow-prop-val ow-prop-val--highlight">{displayTitle}</span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">SKU / Code:</span>
                    <code className="ow-sku-code">{displaySku}</code>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">UPC / Barcode:</span>
                    <code className="ow-sku-code">{displayUpc}</code>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Price:</span>
                    <span className="ow-prop-val">{displayPrice}</span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Weight:</span>
                    <span className="ow-prop-val">{displayWeight}</span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Taxable:</span>
                    <span className="ow-prop-val">Yes (Default Tax)</span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Store Pages:</span>
                    <div className="ow-pages-list">
                      {displayPages.length > 0 ? (
                        displayPages.map((p: string, i: number) => (
                          <span key={i} className="ow-page-badge">
                            📄 {p}
                          </span>
                        ))
                      ) : (
                        <span className="ow-prop-val ow-prop-val--muted">Assigned to catalog root / pending sync</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Formatted Description */}
              <div className="ow-drawer-card">
                <h5 className="ow-drawer-card-title">Product Description</h5>
                <div className="ow-desc-box">
                  {displayDescription}
                </div>
              </div>
            </div>
          )}

          {activeDrawerTab === 'attributes' && (
            <div className="ow-drawer-section-stack">
              <div className="ow-drawer-card">
                <h5 className="ow-drawer-card-title">Categorization & Taxonomy</h5>
                <div className="ow-grid-props">
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Primary Type:</span>
                    <span className="ow-prop-val">{curData?.primaryProductType || '—'}</span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Product Types:</span>
                    <span className="ow-prop-val">
                      {Array.isArray(curData?.productTypes) && curData.productTypes.length > 0
                        ? curData.productTypes.join(', ')
                        : '—'}
                    </span>
                  </div>
                  <div className="ow-prop-row">
                    <span className="ow-prop-key">Brand Authority:</span>
                    <span className="ow-prop-val">{displayBrand}</span>
                  </div>
                </div>
              </div>

              {/* Bullet Points */}
              {extraction?.bulletPoints && extraction.bulletPoints.length > 0 && (
                <div className="ow-drawer-card">
                  <h5 className="ow-drawer-card-title">Bullet Highlights</h5>
                  <ul className="ow-bullets-list">
                    {extraction.bulletPoints.map((bp: string, i: number) => (
                      <li key={i}>{bp}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* OCR & Packaging Findings */}
              {ocrData && (
                <div className="ow-drawer-card">
                  <h5 className="ow-drawer-card-title">Packaging OCR Analysis</h5>
                  <div className="ow-grid-props">
                    {ocrData.species && ocrData.species.length > 0 && (
                      <div className="ow-prop-row">
                        <span className="ow-prop-key">Target Species:</span>
                        <span className="ow-prop-val">{ocrData.species.join(', ')}</span>
                      </div>
                    )}
                    {ocrData.flavorVariety && (
                      <div className="ow-prop-row">
                        <span className="ow-prop-key">Flavor / Variety:</span>
                        <span className="ow-prop-val">{ocrData.flavorVariety}</span>
                      </div>
                    )}
                    {ocrData.dietaryLabels && ocrData.dietaryLabels.length > 0 && (
                      <div className="ow-prop-row">
                        <span className="ow-prop-key">Dietary Claims:</span>
                        <span className="ow-prop-val">{ocrData.dietaryLabels.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeDrawerTab === 'audit' && (
            <div className="ow-drawer-section-stack">
              <div className="ow-drawer-card">
                <h5 className="ow-drawer-card-title">Release Audit Trail</h5>
                <div className="ow-timeline">
                  <div className="ow-timeline-step ow-timeline-step--done">
                    <div className="ow-timeline-marker">✓</div>
                    <div className="ow-timeline-content">
                      <strong className="ow-timeline-title">Curation Complete</strong>
                      <span className="ow-timeline-desc">Attributes and taxonomies synthesized.</span>
                    </div>
                  </div>
                  <div className="ow-timeline-step ow-timeline-step--done">
                    <div className="ow-timeline-marker">✓</div>
                    <div className="ow-timeline-content">
                      <strong className="ow-timeline-title">Human QA Inspection</strong>
                      <span className="ow-timeline-desc">Listing verified in Review workspace.</span>
                    </div>
                  </div>
                  <div className="ow-timeline-step ow-timeline-step--done">
                    <div className="ow-timeline-marker">✓</div>
                    <div className="ow-timeline-content">
                      <strong className="ow-timeline-title">Formal Bulk Approval</strong>
                      <span className="ow-timeline-desc">Release decision recorded with actor timestamp.</span>
                    </div>
                  </div>
                  <div className={`ow-timeline-step ${workState.category !== 'approved' ? 'ow-timeline-step--done' : 'ow-timeline-step--current'}`}>
                    <div className="ow-timeline-marker">{workState.category !== 'approved' ? '✓' : '●'}</div>
                    <div className="ow-timeline-content">
                      <strong className="ow-timeline-title">ShopSite Draft Creation</strong>
                      <span className="ow-timeline-desc">
                        {workState.category !== 'approved'
                          ? 'Product draft staged in Change Set.'
                          : 'Pending draft creation in Change Set.'}
                      </span>
                    </div>
                  </div>
                  <div className={`ow-timeline-step ${workState.category === 'completed' ? 'ow-timeline-step--done' : ''}`}>
                    <div className="ow-timeline-marker">{workState.category === 'completed' ? '✓' : '○'}</div>
                    <div className="ow-timeline-content">
                      <strong className="ow-timeline-title">ShopSite CGI Sync (Upload)</strong>
                      <span className="ow-timeline-desc">
                        {workState.category === 'completed'
                          ? 'Uploaded and verified via dbupload.cgi.'
                          : 'Pending change set export and store sync.'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer Actions */}
        <div className="ow-drawer-footer">
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
            Close
          </button>
          {workState.category === 'approved' && onCreateDraftSingle && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={async () => {
                await onCreateDraftSingle(itemId);
                onClose();
              }}
            >
              {busy ? 'Creating Draft…' : '⚡ Create Export Draft'}
            </button>
          )}
          {workState.category === 'ready_to_export' && (
            <a
              href="?view=changesets"
              className="btn btn-primary btn-sm"
            >
              Open Change Set Review →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
