// story: e08 Test slice — Side-by-side E-Commerce Product Card Previews & 3-Sample Approval
import React from 'react';
import type { MatrixResult } from '../../../onboarding/profile-test-matrix';
import { colors, fonts, rounded } from '../../theme';

function getDomainPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

type Props = {
  result: MatrixResult | null;
  loading: boolean;
  error: string | null;
  suiteUrls?: string[];
  approvedSamples?: Set<string>;
  onToggleApproveSample?: (sampleUrl: string) => void;
  onApproveAll?: () => void;
  onRevise: (field: string) => void;
  onSelectCell?: (cell: { field: string; sampleId: string } | null) => void;
  onRunTests?: () => void;
};

export function TestMatrix({
  result,
  loading,
  error,
  suiteUrls: _suiteUrls = [],
  approvedSamples = new Set(),
  onToggleApproveSample,
  onApproveAll,
  onRevise: _onRevise,
  onSelectCell: _onSelectCell,
  onRunTests,
}: Props): React.ReactElement {
  const [activeImageIndices, setActiveImageIndices] = React.useState<Record<string, number>>({});
  const [carouselState, setCarouselState] = React.useState<{ images: string[]; activeIndex: number; sampleTitle: string } | null>(null);

  // Keyboard navigation for image carousel (ArrowLeft, ArrowRight, Escape)
  React.useEffect(() => {
    if (!carouselState) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCarouselState(null);
      } else if (e.key === 'ArrowLeft') {
        setCarouselState((prev) => {
          if (!prev || prev.images.length <= 1) return prev;
          const nextIdx = (prev.activeIndex - 1 + prev.images.length) % prev.images.length;
          return { ...prev, activeIndex: nextIdx };
        });
      } else if (e.key === 'ArrowRight') {
        setCarouselState((prev) => {
          if (!prev || prev.images.length <= 1) return prev;
          const nextIdx = (prev.activeIndex + 1) % prev.images.length;
          return { ...prev, activeIndex: nextIdx };
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [carouselState]);

  if (loading) {
    return (
      <div
        style={{
          padding: 24,
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          fontFamily: fonts.body,
          fontSize: 13,
          color: colors.mulchBrown,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 18 }}>⏳</span>
        <span>Extracting and testing values across the 3 representative product pages…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        style={{
          padding: 16,
          background: colors.whiteSurface,
          border: `1px solid ${colors.signetBurgundy}`,
          borderLeft: `4px solid ${colors.signetBurgundy}`,
          borderRadius: rounded.lg,
          color: colors.signetBurgundy,
          fontFamily: fonts.body,
          fontSize: 13,
        }}
      >
        <strong>Validation Test Error:</strong> {error}
      </div>
    );
  }

  if (!result || result.rows.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          border: `1px dashed ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          background: colors.feedBagCream,
          fontFamily: fonts.body,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
          Validation: E-Commerce Product Previews
        </div>
        <p style={{ fontSize: 12, color: colors.mulchBrown, margin: '0 0 16px 0' }}>
          Run tests to extract and preview how all 3 product pages render side by side.
        </p>
        {onRunTests && (
          <button
            type="button"
            onClick={onRunTests}
            style={{
              padding: '8px 20px',
              background: colors.uniformGreen,
              color: colors.feedBagCream,
              border: 'none',
              borderRadius: rounded.sm,
              fontFamily: fonts.body,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(20,83,45,0.15)',
            }}
          >
            Extract & Preview 3 Samples
          </button>
        )}
      </div>
    );
  }

  const approvedCount = approvedSamples.size;
  const totalCount = result.rows.length;
  const allApproved = totalCount > 0 && approvedCount >= totalCount;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '12px 16px',
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          boxShadow: '0 1px 3px rgba(33,20,20,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.ledgerCharcoal }}>
            Validation Previews
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '3px 10px',
              borderRadius: rounded.full,
              background: allApproved ? 'rgba(22, 132, 77, 0.12)' : 'rgba(246, 219, 18, 0.25)',
              color: allApproved ? colors.seedlingGreen : colors.ledgerCharcoal,
              border: `1px solid ${allApproved ? 'rgba(22, 132, 77, 0.3)' : 'rgba(246, 219, 18, 0.5)'}`,
            }}
          >
            {allApproved ? '✓ All 3 Approved' : `${approvedCount} of ${totalCount} Approved`}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!allApproved && onApproveAll && (
            <button
              type="button"
              onClick={onApproveAll}
              style={{
                padding: '6px 14px',
                background: colors.feedBagCream,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 700,
                color: colors.uniformGreen,
                cursor: 'pointer',
              }}
            >
              ✓ Approve All ({totalCount})
            </button>
          )}

          {onRunTests && (
            <button
              type="button"
              onClick={onRunTests}
              style={{
                padding: '6px 14px',
                background: colors.whiteSurface,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 600,
                color: colors.mulchBrown,
                cursor: 'pointer',
              }}
            >
              ↻ Re-extract Samples
            </button>
          )}
        </div>
      </div>

      {/* 3 Side-by-Side E-Commerce Product Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, result.rows.length))}, 1fr)`,
          gap: 16,
        }}
      >
        {result.rows.map((row, idx) => {
          const isApproved = approvedSamples.has(row.sampleUrl);
          const ext = row.extractedProduct;
          const title = ext?.title ?? row.cells.find((c) => c.field === 'title')?.extracted;
          const brand = ext?.brand ?? row.cells.find((c) => c.field === 'brand')?.extracted;
          const description = ext?.description ?? row.cells.find((c) => c.field === 'description')?.extracted;
          const allImages = Array.isArray(ext?.images) && ext.images.length > 0
            ? ext.images.filter(Boolean)
            : (ext?.images?.[0] ? [ext.images[0]] : []);
          const currentImageIndex = activeImageIndices[row.sampleId || row.sampleUrl] ?? 0;
          const displayedImageUrl = allImages[currentImageIndex] ?? allImages[0] ?? null;
          const customFields = ext?.customFields ?? {};

          return (
            <div
              key={row.sampleId || row.sampleUrl}
              style={{
                background: colors.whiteSurface,
                border: `2px solid ${isApproved ? colors.uniformGreen : colors.cardBorder}`,
                borderRadius: rounded.lg,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: isApproved ? '0 2px 8px rgba(20,83,45,0.12)' : '0 1px 4px rgba(33,20,20,0.06)',
                transition: 'border-color 150ms ease, box-shadow 150ms ease',
              }}
            >
              {/* Card Header: Sample Label & Status */}
              <div
                style={{
                  padding: '10px 14px',
                  background: isApproved ? 'rgba(20, 83, 45, 0.06)' : colors.feedBagCream,
                  borderBottom: `1px solid ${isApproved ? 'rgba(20, 83, 45, 0.2)' : colors.cardBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: fonts.body,
                      fontSize: 10,
                      fontWeight: 700,
                      background: isApproved ? colors.uniformGreen : colors.cardBorder,
                      color: isApproved ? colors.feedBagCream : colors.mulchBrown,
                      padding: '2px 6px',
                      borderRadius: rounded.sm,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Sample #{idx + 1}
                  </span>
                  <span
                    title={row.sampleUrl}
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      color: colors.ledgerCharcoal,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getDomainPath(row.sampleUrl)}
                  </span>
                </div>

                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: isApproved ? colors.seedlingGreen : colors.mulchBrown,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isApproved ? '✓ Approved' : 'Pending'}
                </span>
              </div>

              {/* Product Image Area */}
              <div
                style={{
                  height: 190,
                  background: '#fcfcfc',
                  borderBottom: `1px solid ${colors.cardBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  overflow: 'hidden',
                  cursor: allImages.length > 0 ? 'zoom-in' : 'default',
                }}
                onClick={() => {
                  if (allImages.length > 0) {
                    setCarouselState({
                      images: allImages,
                      activeIndex: currentImageIndex,
                      sampleTitle: `Sample #${idx + 1} — ${getDomainPath(row.sampleUrl)}`,
                    });
                  }
                }}
                title={allImages.length > 0 ? 'Click to open full image carousel' : undefined}
              >
                {displayedImageUrl ? (
                  <>
                    <img
                      src={displayedImageUrl}
                      alt={title ?? 'Product preview'}
                      style={{
                        maxHeight: '100%',
                        maxWidth: '100%',
                        objectFit: 'contain',
                        padding: 8,
                        transition: 'transform 150ms ease',
                      }}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                    />
                    {/* Top-Right Count Badge */}
                    <div
                      style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        background: 'rgba(33, 20, 20, 0.75)',
                        color: colors.feedBagCream,
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: fonts.mono,
                        padding: '2px 7px',
                        borderRadius: rounded.sm,
                        backdropFilter: 'blur(2px)',
                      }}
                    >
                      📸 {allImages.length} {allImages.length === 1 ? 'photo' : 'photos'}
                    </div>
                    {/* Bottom-Left Zoom Cue */}
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 6,
                        left: 6,
                        background: 'rgba(255, 255, 255, 0.92)',
                        color: colors.uniformGreen,
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: fonts.body,
                        padding: '2px 6px',
                        borderRadius: rounded.sm,
                        border: `1px solid ${colors.cardBorder}`,
                        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                      }}
                    >
                      🔍 Inspect Carousel ({allImages.length})
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', color: colors.mulchBrown, fontSize: 11, padding: 12 }}>
                    <div style={{ fontSize: 24, marginBottom: 4 }}>📦</div>
                    <div>No images extracted</div>
                  </div>
                )}
              </div>

              {/* Multi-Image Thumbnail Filmstrip */}
              {allImages.length > 1 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    background: colors.feedBagCream,
                    borderBottom: `1px solid ${colors.cardBorder}`,
                    overflowX: 'auto',
                  }}
                >
                  {allImages.slice(0, 5).map((img, imgIdx) => {
                    const isSelected = imgIdx === currentImageIndex;
                    return (
                      <div
                        key={imgIdx}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveImageIndices((prev) => ({
                            ...prev,
                            [row.sampleId || row.sampleUrl]: imgIdx,
                          }));
                        }}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: rounded.sm,
                          border: isSelected
                            ? `2px solid ${colors.uniformGreen}`
                            : `1px solid ${colors.cardBorder}`,
                          background: colors.whiteSurface,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          cursor: 'pointer',
                          flexShrink: 0,
                          boxShadow: isSelected ? '0 0 0 1px rgba(20,83,45,0.2)' : 'none',
                        }}
                        title={`View image #${imgIdx + 1}`}
                      >
                        <img
                          src={img}
                          alt={`Thumbnail ${imgIdx + 1}`}
                          style={{
                            maxWidth: '100%',
                            maxHeight: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      </div>
                    );
                  })}
                  {allImages.length > 5 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCarouselState({
                          images: allImages,
                          activeIndex: 5,
                          sampleTitle: `Sample #${idx + 1} — ${getDomainPath(row.sampleUrl)}`,
                        });
                      }}
                      style={{
                        padding: '2px 6px',
                        height: 32,
                        background: colors.whiteSurface,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: rounded.sm,
                        fontFamily: fonts.mono,
                        fontSize: 10,
                        fontWeight: 700,
                        color: colors.uniformGreen,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      +{allImages.length - 5}
                    </button>
                  )}
                </div>
              )}

              {/* Product Details (E-Commerce Storefront Style) */}
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', flex: 1, gap: 8 }}>
                {brand && (
                  <span
                    style={{
                      alignSelf: 'flex-start',
                      fontFamily: fonts.body,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: colors.mulchBrown,
                      background: colors.feedBagCream,
                      padding: '2px 8px',
                      borderRadius: rounded.sm,
                      border: `1px solid ${colors.cardBorder}`,
                    }}
                  >
                    {brand}
                  </span>
                )}

                <h4
                  title={title ?? undefined}
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 14,
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                    margin: 0,
                    lineHeight: 1.3,
                    minHeight: 36,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {title || 'Untitled Product'}
                </h4>

                <div
                  title={description ?? undefined}
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 12,
                    color: colors.mulchBrown,
                    lineHeight: 1.4,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    flex: 1,
                  }}
                >
                  {description || 'No description extracted.'}
                </div>

                {Object.keys(customFields).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {Object.entries(customFields).map(([k, v]) => (
                      <span
                        key={k}
                        style={{
                          fontSize: 10,
                          fontFamily: fonts.mono,
                          background: colors.feedBagCream,
                          color: colors.ledgerCharcoal,
                          border: `1px solid ${colors.cardBorder}`,
                          borderRadius: rounded.sm,
                          padding: '2px 6px',
                        }}
                      >
                        <strong>{k}:</strong> {String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Per-Card Approval Button */}
              <div style={{ padding: '10px 14px', borderTop: `1px solid ${colors.cardBorder}`, background: colors.feedBagCream }}>
                <button
                  type="button"
                  onClick={() => onToggleApproveSample?.(row.sampleUrl)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: rounded.sm,
                    border: `1px solid ${isApproved ? colors.shadowPine : colors.uniformGreen}`,
                    background: isApproved ? colors.uniformGreen : colors.whiteSurface,
                    color: isApproved ? colors.feedBagCream : colors.uniformGreen,
                    fontFamily: fonts.body,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    boxShadow: isApproved ? '0 1px 2px rgba(20,83,45,0.15)' : 'none',
                    transition: 'all 150ms ease',
                  }}
                >
                  {isApproved ? '✓ Approved' : `Approve Sample #${idx + 1}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Full Interactive Image Carousel Modal ── */}
      {carouselState && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(33, 20, 20, 0.85)',
            backdropFilter: 'blur(4px)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => setCarouselState(null)}
        >
          <div
            style={{
              background: colors.whiteSurface,
              borderRadius: rounded.lg,
              border: `1px solid ${colors.cardBorder}`,
              width: '95vw',
              maxWidth: 900,
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 48px rgba(0,0,0,0.35)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 18px',
                borderBottom: `1px solid ${colors.cardBorder}`,
                background: colors.feedBagCream,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <strong style={{ fontFamily: fonts.display, fontSize: 14, color: colors.ledgerCharcoal }}>
                  {carouselState.sampleTitle}
                </strong>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    fontWeight: 700,
                    color: colors.uniformGreen,
                    background: 'rgba(22, 132, 77, 0.1)',
                    padding: '2px 8px',
                    borderRadius: rounded.sm,
                  }}
                >
                  Image {carouselState.activeIndex + 1} of {carouselState.images.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setCarouselState(null)}
                style={{
                  background: 'none',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  padding: '4px 10px',
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 700,
                  color: colors.mulchBrown,
                  cursor: 'pointer',
                }}
              >
                ✕ Close (Esc)
              </button>
            </div>

            {/* Carousel Main Stage */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 20px',
                background: '#f7f7f7',
                flex: 1,
                minHeight: 340,
                position: 'relative',
              }}
            >
              {/* Left Arrow */}
              <button
                type="button"
                disabled={carouselState.images.length <= 1}
                onClick={() => {
                  setCarouselState((prev) => {
                    if (!prev) return null;
                    const nextIdx = (prev.activeIndex - 1 + prev.images.length) % prev.images.length;
                    return { ...prev, activeIndex: nextIdx };
                  });
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.9)',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.full,
                  width: 42,
                  height: 42,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  fontWeight: 700,
                  color: colors.ledgerCharcoal,
                  cursor: carouselState.images.length <= 1 ? 'not-allowed' : 'pointer',
                  opacity: carouselState.images.length <= 1 ? 0.3 : 1,
                  boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                  zIndex: 2,
                }}
                title="Previous image (ArrowLeft)"
              >
                ◀
              </button>

              {/* Large Image Preview */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  maxHeight: '55vh',
                  padding: '0 16px',
                }}
              >
                <img
                  src={carouselState.images[carouselState.activeIndex]}
                  alt={`Product photo ${carouselState.activeIndex + 1}`}
                  style={{
                    maxHeight: '55vh',
                    maxWidth: '100%',
                    objectFit: 'contain',
                    borderRadius: rounded.sm,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                  }}
                />
              </div>

              {/* Right Arrow */}
              <button
                type="button"
                disabled={carouselState.images.length <= 1}
                onClick={() => {
                  setCarouselState((prev) => {
                    if (!prev) return null;
                    const nextIdx = (prev.activeIndex + 1) % prev.images.length;
                    return { ...prev, activeIndex: nextIdx };
                  });
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.9)',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.full,
                  width: 42,
                  height: 42,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  fontWeight: 700,
                  color: colors.ledgerCharcoal,
                  cursor: carouselState.images.length <= 1 ? 'not-allowed' : 'pointer',
                  opacity: carouselState.images.length <= 1 ? 0.3 : 1,
                  boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                  zIndex: 2,
                }}
                title="Next image (ArrowRight)"
              >
                ▶
              </button>
            </div>

            {/* Filmstrip Footer */}
            {carouselState.images.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  borderTop: `1px solid ${colors.cardBorder}`,
                  background: colors.whiteSurface,
                  overflowX: 'auto',
                }}
              >
                {carouselState.images.map((img, idx) => {
                  const isSelected = idx === carouselState.activeIndex;
                  return (
                    <div
                      key={idx}
                      onClick={() => setCarouselState((prev) => prev ? { ...prev, activeIndex: idx } : null)}
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: rounded.sm,
                        border: isSelected ? `2px solid ${colors.uniformGreen}` : `1px solid ${colors.cardBorder}`,
                        background: colors.whiteSurface,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        flexShrink: 0,
                        boxShadow: isSelected ? '0 0 0 1px rgba(20,83,45,0.3)' : 'none',
                        opacity: isSelected ? 1 : 0.65,
                      }}
                    >
                      <img
                        src={img}
                        alt={`Thumb ${idx + 1}`}
                        style={{
                          maxWidth: '100%',
                          maxHeight: '100%',
                          objectFit: 'contain',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
