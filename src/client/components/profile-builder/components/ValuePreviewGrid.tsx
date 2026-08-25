// story: e07s03 — value previews per field per sample (General Store)
import React, { useState } from 'react';
import { colors, fonts, rounded } from '../../../theme';
import { evaluateValuesInstant, evaluateImagesInstant } from '../hooks/useProfileBuilderController';

export type RankedRecipe = {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  source: 'jsonld' | 'css-stable' | 'shopify' | 'semantic' | 'generic';
  score: number;
};

export interface ValuePreviewGridProps {
  samples: Array<{ id: string; url: string }>;
  candidates: RankedRecipe[];
  /** values[sampleId] -> extracted value or null for no match */
  values?: Record<string, string | null>;
  /** optional field label for caption */
  fieldLabel?: string;
  /** per-sample captures for true 3/3 matrix */
  captures?: Record<string, { html: string; dom?: string }>;
  /** callback when a candidate is selected */
  onSelectCandidate?: (selector: string) => void;
  /** current active selector */
  activeSelector?: string;
}

function formatUrlTail(url: string, fallbackIdx: number): string {
  if (!url) return `…/sample-${fallbackIdx + 1}`;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);
    const tail = segments[segments.length - 1];
    if (tail) {
      return `…/${decodeURIComponent(tail)}`;
    }
    return u.hostname;
  } catch {
    const parts = url.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? `…/${last}` : `…/sample-${fallbackIdx + 1}`;
  }
}

export interface ImageCarouselState {
  images: string[];
  activeIndex: number;
  sampleTitle: string;
}

export function ValuePreviewGridComponent({
  samples,
  candidates,
  values = {},
  fieldLabel,
  captures = {},
  onSelectCandidate,
  activeSelector,
}: ValuePreviewGridProps) {
  const [carouselState, setCarouselState] = useState<ImageCarouselState | null>(null);

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

  if (candidates.length === 0 || samples.length === 0) return null;

  const isImageField =
    fieldLabel?.toLowerCase().includes('image') ||
    candidates.some((c) => c.selector.toLowerCase().includes('image'));

  // Memoized candidate evaluation across all samples (0ms re-renders)
  const evaluationMatrix = React.useMemo(() => {
    const imagesMap: Record<string, { bySample: Record<string, string[]>; total: number }> = {};
    const valuesMap: Record<string, Record<string, string | null>> = {};

    for (const c of candidates) {
      if (isImageField) {
        const sampleImageMap: Record<string, string[]> = {};
        let total = 0;
        for (const s of samples) {
          const sampleHtml = captures[s.id]?.html || captures[s.id]?.dom || (values as any)[s.id];
          const imgs = sampleHtml
            ? evaluateImagesInstant({ html: sampleHtml, url: s.url }, c.selector)
            : [];
          sampleImageMap[s.id] = imgs;
          total += imgs.length;
        }
        imagesMap[c.selector] = { bySample: sampleImageMap, total };
      } else {
        const sampleValMap: Record<string, string | null> = {};
        for (const s of samples) {
          const sampleHtml = captures[s.id]?.html || captures[s.id]?.dom || (values as any)[s.id];
          const rawVal = sampleHtml
            ? evaluateValuesInstant({ html: sampleHtml }, c.selector)
            : (values[s.id] ?? null);
          sampleValMap[s.id] = rawVal;
        }
        valuesMap[c.selector] = sampleValMap;
      }
    }

    return { imagesMap, valuesMap };
  }, [candidates, samples, captures, values, isImageField]);

  return (
    <div
      className="value-preview-grid"
      data-field={fieldLabel ?? ''}
      style={{
        marginTop: 10,
        marginBottom: 10,
        background: colors.feedBagCream,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        padding: 12,
      }}
    >
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.ledgerCharcoal }}>
            {isImageField ? '📸 Image Candidate Selectors' : 'Candidate Selectors'} ({candidates.length})
          </span>
          <span style={{ fontSize: 10, background: 'rgba(20, 83, 45, 0.1)', color: colors.uniformGreen, padding: '2px 8px', borderRadius: rounded.full, fontWeight: 600 }}>
            3-Page Multi-Sample Verification
          </span>
        </div>
        <span style={{ fontSize: 10, color: colors.mulchBrown, fontStyle: 'italic' }}>
          {isImageField ? 'Click image to open gallery carousel · Click card or "Use" to assign selector' : 'Click a candidate row to use it as the selector'}
        </span>
      </div>

      {isImageField ? (
        /* ── Visual Image Candidates Gallery View ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {candidates.map((c) => {
            const isSelected = activeSelector === c.selector;
            const evalEntry = evaluationMatrix.imagesMap[c.selector] ?? { bySample: {}, total: 0 };
            const sampleImageMap = evalEntry.bySample;
            const totalImagesFound = evalEntry.total;

            return (
              <div
                key={c.selector}
                onClick={() => onSelectCandidate?.(c.selector)}
                style={{
                  background: isSelected ? 'rgba(20, 83, 45, 0.04)' : colors.whiteSurface,
                  border: `2px solid ${isSelected ? colors.uniformGreen : colors.cardBorder}`,
                  borderRadius: rounded.md,
                  padding: 12,
                  boxShadow: isSelected ? '0 2px 8px rgba(20,83,45,0.12)' : '0 1px 3px rgba(33,20,20,0.04)',
                  cursor: onSelectCandidate ? 'pointer' : 'default',
                  transition: 'border-color 150ms ease, box-shadow 150ms ease, background 150ms ease',
                }}
              >
                {/* Candidate Selector Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${colors.cardBorder}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontFamily: fonts.mono,
                        fontSize: 12,
                        fontWeight: 700,
                        color: isSelected ? colors.uniformGreen : colors.ledgerCharcoal,
                        background: isSelected ? 'rgba(20,83,45,0.08)' : colors.feedBagCream,
                        padding: '3px 8px',
                        borderRadius: rounded.sm,
                        border: `1px solid ${isSelected ? 'rgba(20,83,45,0.25)' : colors.cardBorder}`,
                      }}
                    >
                      {c.selector}
                    </span>
                    {isSelected && (
                      <span
                        style={{
                          fontSize: 9,
                          background: colors.uniformGreen,
                          color: colors.feedBagCream,
                          padding: '2px 6px',
                          borderRadius: rounded.sm,
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                        }}
                      >
                        ✓ Active Selector
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: colors.mulchBrown }}>
                      {c.source} · {c.stability} ({c.score} pts) · {totalImagesFound} images found
                    </span>
                  </div>

                  {onSelectCandidate && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectCandidate(c.selector);
                      }}
                      style={{
                        padding: '4px 12px',
                        background: isSelected ? colors.uniformGreen : colors.whiteSurface,
                        color: isSelected ? colors.feedBagCream : colors.uniformGreen,
                        border: `1px solid ${isSelected ? colors.shadowPine : colors.uniformGreen}`,
                        borderRadius: rounded.sm,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        boxShadow: '0 1px 2px rgba(20,83,45,0.1)',
                      }}
                    >
                      {isSelected ? '✓ In Use' : 'Use Selector'}
                    </button>
                  )}
                </div>

                {/* 3-Column Image Comparison Strip */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.max(1, samples.length)}, 1fr)`,
                    gap: 12,
                  }}
                >
                  {samples.map((s, idx) => {
                    const sampleTitle = formatUrlTail(s.url, idx);
                    const imgs = sampleImageMap[s.id] ?? [];
                    const primary = imgs[0];
                    const gallery = imgs.slice(1, 4);
                    const remainingCount = Math.max(0, imgs.length - 4);

                    return (
                      <div
                        key={s.id}
                        style={{
                          background: colors.feedBagCream,
                          border: `1px solid ${colors.cardBorder}`,
                          borderRadius: rounded.sm,
                          padding: 8,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        {/* Sample Column Header */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 4,
                          }}
                        >
                          <span
                            title={s.url}
                            style={{
                              fontFamily: fonts.mono,
                              fontSize: 10,
                              fontWeight: 700,
                              color: colors.ledgerCharcoal,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 160,
                            }}
                          >
                            {sampleTitle}
                          </span>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: rounded.sm,
                              background: imgs.length > 0 ? 'rgba(22,132,77,0.12)' : 'rgba(118,12,25,0.1)',
                              color: imgs.length > 0 ? colors.seedlingGreen : colors.signetBurgundy,
                            }}
                          >
                            {imgs.length} {imgs.length === 1 ? 'img' : 'imgs'}
                          </span>
                        </div>

                        {/* Image Display */}
                        {primary ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {/* Primary High-Resolution Thumbnail */}
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                setCarouselState({ images: imgs, activeIndex: 0, sampleTitle });
                              }}
                              title="Click to open image carousel"
                              style={{
                                width: '100%',
                                height: 110,
                                background: colors.whiteSurface,
                                border: `1px solid ${colors.cardBorder}`,
                                borderRadius: rounded.sm,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                overflow: 'hidden',
                                position: 'relative',
                                cursor: 'zoom-in',
                              }}
                            >
                              <img
                                src={primary}
                                alt="Product primary"
                                style={{
                                  maxWidth: '100%',
                                  maxHeight: '100%',
                                  objectFit: 'contain',
                                  padding: 4,
                                  transition: 'transform 150ms ease',
                                }}
                                onError={(e) => {
                                  (e.currentTarget as HTMLElement).style.display = 'none';
                                }}
                              />
                              <div
                                style={{
                                  position: 'absolute',
                                  bottom: 4,
                                  right: 4,
                                  background: 'rgba(33,20,20,0.75)',
                                  color: '#FFFFFF',
                                  fontSize: 9,
                                  padding: '2px 6px',
                                  borderRadius: 3,
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 3,
                                }}
                              >
                                <span>🔍 Gallery ({imgs.length})</span>
                              </div>
                            </div>

                            {/* Additional gallery thumbnails */}
                            {gallery.length > 0 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto' }}>
                                {gallery.map((gUrl, gIdx) => (
                                  <div
                                    key={gIdx}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCarouselState({ images: imgs, activeIndex: gIdx + 1, sampleTitle });
                                    }}
                                    title="Click to view in carousel"
                                    style={{
                                      width: 32,
                                      height: 32,
                                      background: colors.whiteSurface,
                                      border: `1px solid ${colors.cardBorder}`,
                                      borderRadius: rounded.sm,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      cursor: 'zoom-in',
                                      overflow: 'hidden',
                                      flexShrink: 0,
                                    }}
                                  >
                                    <img
                                      src={gUrl}
                                      alt={`gallery ${gIdx + 1}`}
                                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                                      onError={(e) => {
                                        (e.currentTarget as HTMLElement).style.display = 'none';
                                      }}
                                    />
                                  </div>
                                ))}
                                {remainingCount > 0 && (
                                  <span style={{ fontSize: 9, color: colors.mulchBrown, fontWeight: 700, marginLeft: 2 }}>
                                    +{remainingCount}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div
                            style={{
                              height: 110,
                              background: colors.whiteSurface,
                              border: `1px dashed ${colors.cardBorder}`,
                              borderRadius: rounded.sm,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: colors.signetBurgundy,
                              fontSize: 11,
                              fontWeight: 600,
                              padding: 8,
                              textAlign: 'center',
                            }}
                          >
                            <span style={{ fontSize: 16, marginBottom: 2 }}>⚠️</span>
                            <span>No images found</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Standard Text/Numeric Candidate Table ── */
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fonts.body, fontSize: 11 }}>
            <thead>
              <tr style={{ background: colors.whiteSurface, borderBottom: `1px solid ${colors.cardBorder}` }}>
                <th style={{ padding: '6px 8px', textAlign: 'left', color: colors.mulchBrown, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em', width: '35%' }}>
                  Candidate Selector
                </th>
                {samples.map((s, idx) => (
                  <th
                    key={s.id}
                    style={{
                      padding: '6px 8px',
                      textAlign: 'left',
                      color: colors.mulchBrown,
                      textTransform: 'none',
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: fonts.mono,
                      letterSpacing: '0.02em',
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={s.url}
                  >
                    {formatUrlTail(s.url, idx)}
                  </th>
                ))}
                <th style={{ padding: '6px 8px', textAlign: 'center', color: colors.mulchBrown, textTransform: 'uppercase', fontSize: 10, width: 60 }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const isSelected = activeSelector === c.selector;
                return (
                  <tr
                    key={c.selector}
                    onClick={() => onSelectCandidate?.(c.selector)}
                    style={{
                      borderBottom: `1px solid ${colors.cardBorder}`,
                      background: isSelected ? 'rgba(20, 83, 45, 0.08)' : 'transparent',
                      cursor: onSelectCandidate ? 'pointer' : 'default',
                      transition: 'background 120ms ease',
                    }}
                  >
                    <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: isSelected ? colors.uniformGreen : colors.ledgerCharcoal, fontWeight: 700 }}>
                          {c.selector}
                        </span>
                        {isSelected && (
                          <span style={{ fontSize: 9, background: colors.uniformGreen, color: colors.feedBagCream, padding: '1px 5px', borderRadius: rounded.sm, textTransform: 'uppercase', fontWeight: 700 }}>
                            Active
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: colors.mulchBrown, marginTop: 2 }}>
                        {c.source} · {c.stability} ({c.score} pts)
                      </div>
                    </td>

                    {samples.map((s) => {
                      const sampleValMap = evaluationMatrix.valuesMap[c.selector] ?? {};
                      const rawVal = sampleValMap[s.id] ?? null;

                      return (
                        <td key={s.id} style={{ padding: '6px 8px', verticalAlign: 'top', color: colors.ledgerCharcoal }}>
                          {rawVal === null ? (
                            <span style={{ color: colors.signetBurgundy, fontWeight: 600, fontSize: 10 }}>no match</span>
                          ) : (
                            <span
                              style={{
                                fontFamily: fonts.mono,
                                fontSize: 11,
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}
                              title={rawVal}
                            >
                              {rawVal}
                            </span>
                          )}
                        </td>
                      );
                    })}

                    <td style={{ padding: '6px 8px', verticalAlign: 'top', textAlign: 'center' }}>
                      {onSelectCandidate && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCandidate(c.selector);
                          }}
                          style={{
                            padding: '3px 8px',
                            background: isSelected ? colors.uniformGreen : colors.whiteSurface,
                            color: isSelected ? colors.feedBagCream : colors.uniformGreen,
                            border: `1px solid ${isSelected ? colors.shadowPine : colors.uniformGreen}`,
                            borderRadius: rounded.sm,
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          {isSelected ? '✓ In Use' : 'Use'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── High-Resolution Interactive Carousel Lightbox Modal ── */}
      {carouselState && (
        <div
          onClick={() => setCarouselState(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(20, 25, 20, 0.82)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: colors.whiteSurface,
              borderRadius: rounded.lg,
              border: `1px solid ${colors.cardBorder}`,
              width: '90vw',
              maxWidth: 960,
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: '0 20px 50px rgba(0,0,0,0.4)',
            }}
          >
            {/* Carousel Header */}
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
                <span style={{ fontFamily: fonts.display, fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal }}>
                  Image Carousel
                </span>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    color: colors.mulchBrown,
                    background: 'rgba(33,20,20,0.06)',
                    padding: '2px 8px',
                    borderRadius: rounded.sm,
                  }}
                >
                  {carouselState.sampleTitle}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: colors.uniformGreen,
                    background: 'rgba(20,83,45,0.1)',
                    padding: '2px 8px',
                    borderRadius: rounded.full,
                  }}
                >
                  Image {carouselState.activeIndex + 1} of {carouselState.images.length}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: colors.mulchBrown, fontStyle: 'italic' }}>
                  Use ◀ ▶ arrows or Esc
                </span>
                <button
                  type="button"
                  onClick={() => setCarouselState(null)}
                  style={{
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.sm,
                    padding: '4px 10px',
                    fontFamily: fonts.body,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Main Stage with Large Active Image & Navigation Arrows */}
            <div
              style={{
                position: 'relative',
                padding: 24,
                background: '#F7F7F7',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 380,
                maxHeight: '60vh',
                overflow: 'hidden',
              }}
            >
              {/* Left Prev Arrow Button */}
              {carouselState.images.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setCarouselState((prev) =>
                      prev
                        ? {
                            ...prev,
                            activeIndex:
                              (prev.activeIndex - 1 + prev.images.length) % prev.images.length,
                          }
                        : null
                    )
                  }
                  title="Previous image (Left Arrow)"
                  style={{
                    position: 'absolute',
                    left: 16,
                    zIndex: 10,
                    background: 'rgba(255,255,255,0.92)',
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.full,
                    width: 44,
                    height: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    transition: 'transform 100ms ease, background 100ms ease',
                  }}
                >
                  ◀
                </button>
              )}

              {/* Main Image */}
              {carouselState.images[carouselState.activeIndex] ? (
                <img
                  key={carouselState.activeIndex}
                  src={carouselState.images[carouselState.activeIndex]}
                  alt={`Product Asset ${carouselState.activeIndex + 1}`}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '55vh',
                    objectFit: 'contain',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
                    background: '#FFFFFF',
                    borderRadius: rounded.sm,
                  }}
                />
              ) : (
                <div style={{ color: colors.signetBurgundy, fontSize: 13, fontWeight: 600 }}>
                  Image unavailable
                </div>
              )}

              {/* Right Next Arrow Button */}
              {carouselState.images.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setCarouselState((prev) =>
                      prev
                        ? {
                            ...prev,
                            activeIndex: (prev.activeIndex + 1) % prev.images.length,
                          }
                        : null
                    )
                  }
                  title="Next image (Right Arrow)"
                  style={{
                    position: 'absolute',
                    right: 16,
                    zIndex: 10,
                    background: 'rgba(255,255,255,0.92)',
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.full,
                    width: 44,
                    height: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    transition: 'transform 100ms ease, background 100ms ease',
                  }}
                >
                  ▶
                </button>
              )}
            </div>

            {/* Bottom Filmstrip of Thumbnails */}
            {carouselState.images.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  overflowX: 'auto',
                  padding: '10px 18px',
                  background: colors.feedBagCream,
                  borderTop: `1px solid ${colors.cardBorder}`,
                }}
              >
                {carouselState.images.map((imgUrl, i) => {
                  const isCurrent = i === carouselState.activeIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setCarouselState((prev) => (prev ? { ...prev, activeIndex: i } : null))
                      }
                      style={{
                        width: 52,
                        height: 52,
                        padding: 2,
                        background: colors.whiteSurface,
                        border: `2px solid ${isCurrent ? colors.uniformGreen : colors.cardBorder}`,
                        borderRadius: rounded.sm,
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        boxShadow: isCurrent ? '0 0 0 2px rgba(20,83,45,0.25)' : 'none',
                        transition: 'border-color 120ms ease',
                      }}
                    >
                      <img
                        src={imgUrl}
                        alt={`Thumb ${i + 1}`}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      />
                    </button>
                  );
                })}
              </div>
            )}

            {/* Active Image URL Footer */}
            <div
              style={{
                padding: '8px 18px',
                borderTop: `1px solid ${colors.cardBorder}`,
                background: colors.whiteSurface,
                fontSize: 10,
                fontFamily: fonts.mono,
                color: colors.mulchBrown,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={carouselState.images[carouselState.activeIndex]}
              >
                URL: {carouselState.images[carouselState.activeIndex]}
              </span>
              <a
                href={carouselState.images[carouselState.activeIndex]}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: colors.uniformGreen,
                  textDecoration: 'underline',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                Open in new tab ↗
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const ValuePreviewGrid = React.memo(ValuePreviewGridComponent);
export default ValuePreviewGrid;


