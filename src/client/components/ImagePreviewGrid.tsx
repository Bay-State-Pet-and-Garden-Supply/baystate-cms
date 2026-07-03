/**
 * ImagePreviewGrid.tsx — render image sample previews for the
 * governance review surface.
 *
 * Renders one card per sample URL passed in. Each card shows:
 *  - a small thumbnail (or a fallback when the URL fails to load)
 *  - the sample's source URL
 *  - the expected product name (when provided)
 *  - any per-image warnings
 *
 * The component is purely presentational. The parent decides
 * which images are correct / excluded / included and feeds the
 * results into the per-image "correct" / "exclude" / "include"
 * verdicts. The component never calls the network or any API.
 *
 * Phase 4 (UI) + Phase 3 (governance service) consumer.
 */

import React from 'react';

export interface ImagePreview {
  url: string;
  sampleUrl: string;
  expectedName?: string | null;
  brandHint?: string | null;
  warnings?: string[];
  /** Parent's verdict for this specific image. */
  verdict?: 'correct' | 'exclude' | 'include' | 'pending';
}

interface ImagePreviewGridProps {
  previews: ImagePreview[];
  /** Render a checkbox / button row per preview when true. */
  onChangeVerdict?: (url: string, verdict: 'correct' | 'exclude' | 'include') => void;
  /** Disable the verdict controls (read-only mode). */
  readOnly?: boolean;
  /** Compact mode for inline use inside a field row. */
  compact?: boolean;
}

const VERDICT_COLORS: Record<NonNullable<ImagePreview['verdict']>, string> = {
  correct: '#16a34a',
  exclude: '#dc2626',
  include: '#2563eb',
  pending: '#9ca3af',
};

export function ImagePreviewGrid(props: ImagePreviewProps): React.ReactElement {
  const { previews, onChangeVerdict, readOnly, compact } = props;
  if (previews.length === 0) {
    return <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No images to preview.</p>;
  }

  const containerStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(100px, 1fr))' : 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: compact ? 8 : 12,
  };

  return (
    <div style={containerStyle}>
      {previews.map((p) => {
        const verdict = p.verdict ?? 'pending';
        return (
          <div
            key={`${p.sampleUrl}::${p.url}`}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              padding: compact ? 4 : 6,
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div
              style={{
                position: 'relative',
                paddingTop: '100%',
                background: '#f9fafb',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <img
                src={p.url}
                alt=""
                loading="lazy"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
                onError={(e) => {
                  const target = e.currentTarget;
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent) {
                    const fallback = document.createElement('div');
                    fallback.style.position = 'absolute';
                    fallback.style.inset = '0';
                    fallback.style.display = 'flex';
                    fallback.style.alignItems = 'center';
                    fallback.style.justifyContent = 'center';
                    fallback.style.fontSize = '11px';
                    fallback.style.color = '#9ca3af';
                    fallback.textContent = 'unavailable';
                    parent.appendChild(fallback);
                  }
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  background: VERDICT_COLORS[verdict],
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: 999,
                  textTransform: 'uppercase',
                }}
              >
                {verdict}
              </div>
            </div>
            {!compact && p.expectedName && (
              <div style={{ fontSize: 11, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.expectedName}>
                {p.expectedName}
              </div>
            )}
            {!compact && (p.warnings ?? []).length > 0 && (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {p.warnings!.map((w, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: 10,
                      color: '#b45309',
                      background: '#fef3c7',
                      padding: '2px 4px',
                      borderRadius: 3,
                    }}
                  >
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && onChangeVerdict && (
              <div style={{ display: 'flex', gap: 4, marginTop: 'auto' }}>
                <VerdictButton
                  label="✓"
                  color="#16a34a"
                  active={verdict === 'correct'}
                  onClick={() => onChangeVerdict(p.url, 'correct')}
                />
                <VerdictButton
                  label="✗"
                  color="#dc2626"
                  active={verdict === 'exclude'}
                  onClick={() => onChangeVerdict(p.url, 'exclude')}
                />
                <VerdictButton
                  label="+"
                  color="#2563eb"
                  active={verdict === 'include'}
                  onClick={() => onChangeVerdict(p.url, 'include')}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface VerdictButtonProps {
  label: string;
  color: string;
  active: boolean;
  onClick: () => void;
}

function VerdictButton(props: VerdictButtonProps) {
  const { label, color, active, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        fontSize: 12,
        fontWeight: 600,
        color: active ? '#fff' : color,
        background: active ? color : '#fff',
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '4px 0',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

// Re-export ImagePreview with the type name expected by the
// surface (the prop interface uses ImagePreview, the type is
// declared on the interface, so this keeps the import path clean
// for callers without an additional `type` import).
export type ImagePreviewProps = ImagePreviewGridProps;
