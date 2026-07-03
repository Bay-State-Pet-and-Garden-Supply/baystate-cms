/**
 * ProfileExtractionPreview.tsx — preview-driven review panel that shows
 * extracted product data (seed preview or on-demand result) instead of
 * raw CSS selectors.
 *
 * Pure presentational component. No network calls.
 */

import React from 'react';
import { ImagePreviewGrid } from './ImagePreviewGrid';

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface SeedPreviewData {
  title: string | null;
  description: string | null;
  images: string[];
  variantOptions: string[];
  strategy: 'shopify-json' | 'css';
  variantSelectionStrategy: {
    containerSelector: string | null;
    optionType: string | null;
    detectedOptions: string[];
    optionFields: string[];
  } | null;
}

interface ProfileExtractionPreviewProps {
  seedPreview: SeedPreviewData | null;
  sourceUrl: string;
  onDemandResult?: {
    title?: string | null;
    description?: string | null;
    images?: string[];
    variantOptions?: string[];
  } | null;
  busy?: boolean;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const PULSE_KEYFRAMES = `@keyframes profileExtractionPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`;

const s: Record<string, React.CSSProperties> = {
  container: {
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    border: '1px solid #e5e7eb',
    position: 'relative',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    margin: '0 0 8px',
  },
  titleEmpty: {
    color: '#9ca3af',
  },
  description: {
    fontSize: 14,
    lineHeight: 1.5,
    color: '#555',
    margin: '0 0 12px',
    display: '-webkit-box',
    WebkitLineClamp: 4,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    color: '#888',
    marginBottom: 4,
  },
  pill: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 12,
    background: '#e9ecef',
    marginRight: 4,
    marginBottom: 4,
  },
  code: {
    fontSize: 12,
    background: '#f3f4f6',
    padding: '1px 4px',
    borderRadius: 3,
    fontFamily: 'monospace',
  },
  spinner: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#2563eb',
    display: 'inline-block',
    marginLeft: 6,
    animation: 'profileExtractionPulse 1.5s ease-in-out infinite',
  },
  noDataText: {
    fontSize: 14,
    color: '#9ca3af',
    margin: 0,
  },
  noDataNote: {
    fontSize: 12,
    color: '#6b7280',
    margin: '8px 0 0',
  },
  link: {
    color: '#2563eb',
    textDecoration: 'underline',
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  strategyBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  badgeBlue: {
    background: '#dbeafe',
    color: '#1e40af',
    border: '1px solid #93c5fd',
  },
  badgeGray: {
    background: '#f3f4f6',
    color: '#4b5563',
    border: '1px solid #d1d5db',
  },
  optionTypeBadge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 999,
    background: '#e0e7ff',
    color: '#4338ca',
    textTransform: 'uppercase',
    marginLeft: 8,
  },
  variantStrategySection: {
    marginTop: 8,
    padding: 8,
    background: '#f9fafb',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
  },
  section: {
    marginBottom: 12,
  },
  sectionLast: {
    marginBottom: 0,
  },
  emptyText: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileExtractionPreview(
  props: ProfileExtractionPreviewProps,
): React.ReactElement {
  const { seedPreview, sourceUrl, onDemandResult, busy } = props;

  // ── Loading state ──────────────────────────────────────────────────────
  if (busy) {
    return (
      <div style={s.container}>
        <style>{PULSE_KEYFRAMES}</style>
        <span style={s.loadingText}>
          Loading preview...
          <span style={s.spinner} />
        </span>
      </div>
    );
  }

  // ── No data state ──────────────────────────────────────────────────────
  if (!seedPreview && !onDemandResult) {
    return (
      <div style={s.container}>
        <p style={s.noDataText}>
          No preview available. Generate a proposal first.
        </p>
        <p style={s.noDataNote}>
          Seed URL:{' '}
          <a
            href={sourceUrl}
            style={s.link}
            target="_blank"
            rel="noopener noreferrer"
          >
            {sourceUrl}
          </a>
        </p>
      </div>
    );
  }

  // ── Resolve data (seedPreview first, onDemandResult fallback) ──────────
  const resolvedTitle =
    seedPreview?.title ?? onDemandResult?.title ?? null;
  const resolvedDescription =
    seedPreview?.description ?? onDemandResult?.description ?? null;
  const resolvedImages =
    seedPreview && seedPreview.images.length > 0
      ? seedPreview.images
      : onDemandResult?.images ?? [];

  // Resolve variant options: seedPreview.variantOptions →
  // seedPreview.variantSelectionStrategy.detectedOptions →
  // onDemandResult.variantOptions
  let resolvedVariantOptions: string[] = [];
  let variantOptionsLabel = 'Variant options';
  if (seedPreview && seedPreview.variantOptions.length > 0) {
    resolvedVariantOptions = seedPreview.variantOptions;
  } else if (
    seedPreview?.variantSelectionStrategy?.detectedOptions &&
    seedPreview.variantSelectionStrategy.detectedOptions.length > 0
  ) {
    resolvedVariantOptions =
      seedPreview.variantSelectionStrategy.detectedOptions;
    variantOptionsLabel = 'Detected options';
  } else if (
    onDemandResult?.variantOptions &&
    onDemandResult.variantOptions.length > 0
  ) {
    resolvedVariantOptions = onDemandResult.variantOptions;
  }

  // ── Render ────────────────────────────────────────────────────────────

  const strategyLabel =
    seedPreview?.strategy === 'shopify-json' ? 'Shopify JSON' : 'CSS Selectors';
  const strategyBadgeStyle =
    seedPreview?.strategy === 'shopify-json'
      ? { ...s.strategyBadge, ...s.badgeBlue }
      : { ...s.strategyBadge, ...s.badgeGray };

  return (
    <div style={s.container}>
      {/* Strategy badge */}
      {seedPreview?.strategy && (
        <span style={strategyBadgeStyle}>{strategyLabel}</span>
      )}

      {/* Title */}
      <div style={s.section}>
        {resolvedTitle ? (
          <h2 style={s.title}>{resolvedTitle}</h2>
        ) : (
          <h2 style={{ ...s.title, ...s.titleEmpty }}>—</h2>
        )}
      </div>

      {/* Description */}
      {resolvedDescription && (
        <div style={s.section}>
          <p style={s.description}>{resolvedDescription}</p>
        </div>
      )}

      {/* Image thumbnails */}
      <div style={s.section}>
        {resolvedImages.length > 0 ? (
          <ImagePreviewGrid
            previews={resolvedImages.slice(0, 8).map((url) => ({
              url,
              sampleUrl: url,
              expectedName: null,
              brandHint: null,
              warnings: [],
              verdict: 'pending' as const,
            }))}
            readOnly
            compact
          />
        ) : (
          <p style={s.emptyText}>No images extracted</p>
        )}
      </div>

      {/* Variant options */}
      {resolvedVariantOptions.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionHeader}>{variantOptionsLabel}:</div>
          <div>
            {resolvedVariantOptions.map((opt, i) => (
              <span key={i} style={s.pill}>
                {opt}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Variant strategy subsection */}
      {seedPreview?.variantSelectionStrategy && (
        <div style={{ ...s.section, ...s.sectionLast }}>
          <div style={s.variantStrategySection}>
            {seedPreview.variantSelectionStrategy.containerSelector && (
              <div style={{ marginBottom: 6, fontSize: 12, color: '#555' }}>
                Container selector:{' '}
                <code style={s.code}>
                  {seedPreview.variantSelectionStrategy.containerSelector}
                </code>
              </div>
            )}
            {seedPreview.variantSelectionStrategy.optionType && (
              <div style={{ marginBottom: 6, fontSize: 12, color: '#555' }}>
                Option type:
                <span style={s.optionTypeBadge}>
                  {seedPreview.variantSelectionStrategy.optionType}
                </span>
              </div>
            )}
            {seedPreview.variantSelectionStrategy.detectedOptions &&
              seedPreview.variantSelectionStrategy.detectedOptions.length >
                0 && (
                <div style={{ fontSize: 12, color: '#555' }}>
                  Detected options:{' '}
                  {seedPreview.variantSelectionStrategy.detectedOptions.map(
                    (opt, i) => (
                      <span key={i} style={s.pill}>
                        {opt}
                      </span>
                    ),
                  )}
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProfileExtractionPreview;
