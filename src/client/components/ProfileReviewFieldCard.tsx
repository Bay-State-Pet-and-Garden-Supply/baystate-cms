/**
 * ProfileReviewFieldCard.tsx — a single dynamic review card for one field.
 *
 * Renders the selector comparison, validation tally, extracted sample
 * preview, and approve/reject/edit/feedback controls. Works for any
 * field key — standard or custom.
 */

import React, { useState } from 'react';
import type { ReviewFieldRow } from '../profile-review-utils';
import { normalizeFieldLabel, getCategoryLabel } from '../profile-review-utils';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProfileReviewFieldCardProps {
  row: ReviewFieldRow;
  /** Whether the field is currently approved */
  approved: boolean;
  /** Whether the field is currently rejected */
  rejected: boolean;
  /** Called when the approve/reject toggle changes */
  onToggleApprove?: (key: string, approve: boolean) => void;
  /** Called when the user wants to send feedback */
  onFeedback?: (key: string) => void;
  /** Called when the user wants to edit the selector manually */
  onEditSelector?: (key: string, selector: string) => void;
  /** Whether the review is busy (promoting/validating) */
  disabled?: boolean;
  /** Whether image approval checkbox is required */
  imageApprovalRequired?: boolean;
  /** Whether image previews were reviewed (for image fields) */
  imagePreviewsReviewed?: boolean;
  /** Called when image review checkbox toggles */
  onImageReviewToggle?: (reviewed: boolean) => void;
  /** Whether this field has strong multi-sample evidence */
  hasStrongEvidence?: boolean;
  /** Whether this field has limited (single-sample) evidence */
  hasLimitedEvidence?: boolean;
}

// ─── Style utilities ─────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 14,
  background: '#fff',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#374151',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 4,
};

const badgeStyle = (
  bg: string,
  fg: string,
): React.CSSProperties => ({
  display: 'inline-block',
  fontSize: 10,
  fontWeight: 700,
  padding: '1px 6px',
  borderRadius: 999,
  background: bg,
  color: fg,
  textTransform: 'uppercase',
  marginLeft: 6,
});

const selectorBoxStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'monospace',
  background: '#f9fafb',
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid #e5e7eb',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
};

const tallyDot = (count: number, color: string): React.ReactNode => (
  <span
    key={color}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      fontSize: 11,
      color,
      fontWeight: 600,
    }}
  >
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
      }}
    />
    {count}
  </span>
);

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileReviewFieldCard(
  props: ProfileReviewFieldCardProps,
): React.ReactElement {
  const {
    row,
    approved,
    rejected,
    onToggleApprove,
    onFeedback,
    onEditSelector,
    disabled = false,
    imageApprovalRequired = false,
    imagePreviewsReviewed = false,
    onImageReviewToggle,
    hasStrongEvidence = false,
    hasLimitedEvidence = false,
  } = props;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(row.proposedSelector ?? '');

  const borderColor = approved
    ? '#16a34a'
    : rejected
      ? '#dc2626'
      : row.changed
        ? '#f59e0b'
        : '#e5e7eb';

  const handleSaveEdit = () => {
    if (editValue.trim() && onEditSelector) {
      onEditSelector(row.key, editValue.trim());
    }
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditValue(row.proposedSelector ?? '');
    setEditing(false);
  };

  return (
    <div style={{ ...cardStyle, borderColor }}>
      {/* ── Header: label + approve/reject badges ── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 8,
        }}
      >
        <div>
          <div style={labelStyle}>
            {row.label}
            {row.isCustom && (
              <span style={{ ...badgeStyle('#e0e7ff', '#4338ca') }}>
                Custom
              </span>
            )}
            {row.changed && !approved && !rejected && (
              <span style={{ ...badgeStyle('#fef3c7', '#d97706') }}>
                Changed
              </span>
            )}
            {row.isImageField && (
              <span style={{ ...badgeStyle('#f3e8ff', '#7c3aed') }}>
                Image
              </span>
            )}
            {hasStrongEvidence && (
              <span style={{ ...badgeStyle('#dcfce7', '#16a34a') }}>
                Multi-sample
              </span>
            )}
            {hasLimitedEvidence && !hasStrongEvidence && (
              <span style={{ ...badgeStyle('#fef3c7', '#d97706') }}>
                Limited evidence
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            {getCategoryLabel(row.category)}
            {row.valueType !== 'text' && (
              <span style={{ marginLeft: 4 }}>· {row.valueType}</span>
            )}
          </div>
        </div>

        {/* Approve / Reject toggles */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => onToggleApprove?.(row.key, true)}
            disabled={disabled || approved}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 700,
              border: `1px solid ${approved ? '#16a34a' : '#d1d5db'}`,
              borderRadius: 4,
              background: approved ? '#dcfce7' : '#fff',
              color: approved ? '#16a34a' : '#6b7280',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {approved ? '✓ Approved' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => onToggleApprove?.(row.key, false)}
            disabled={disabled || rejected}
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 700,
              border: `1px solid ${rejected ? '#dc2626' : '#d1d5db'}`,
              borderRadius: 4,
              background: rejected ? '#fee2e2' : '#fff',
              color: rejected ? '#dc2626' : '#6b7280',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {rejected ? '✗ Rejected' : 'Reject'}
          </button>
        </div>
      </div>

      {/* ── Selector comparison (active vs proposed) ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>
            Active
          </div>
          <div
            style={{
              ...selectorBoxStyle,
              color: row.activeSelector ? '#374151' : '#9ca3af',
              fontStyle: row.activeSelector ? 'normal' : 'italic',
            }}
          >
            {row.activeSelector || 'Not set'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>
            Proposed
          </div>
          <div
            style={{
              ...selectorBoxStyle,
              color: row.proposedSelector ? '#374151' : '#9ca3af',
              fontStyle: row.proposedSelector ? 'normal' : 'italic',
              background: row.changed ? '#fffbeb' : '#f9fafb',
              borderColor: row.changed ? '#f59e0b' : '#e5e7eb',
            }}
          >
            {row.proposedSelector || 'Not proposed'}
          </div>
        </div>
      </div>

      {/* ── Sample value / preview ── */}
      {(row.sampleValue || row.sampleImages.length > 0) && (
        <div
          style={{
            marginBottom: 8,
            padding: 8,
            background: '#f9fafb',
            borderRadius: 4,
            fontSize: 12,
            color: '#4b5563',
          }}
        >
          {row.isImageField && row.sampleImages.length > 0 ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {row.sampleImages.slice(0, 6).map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`Product image ${i + 1}`}
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 4,
                    border: '1px solid #e5e7eb',
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ))}
              {row.sampleImages.length > 6 && (
                <span style={{ fontSize: 10, color: '#9ca3af', alignSelf: 'center' }}>
                  +{row.sampleImages.length - 6} more
                </span>
              )}
            </div>
          ) : row.sampleValue ? (
            <div style={{ maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {row.sampleValue.length > 200
                ? row.sampleValue.slice(0, 200) + '…'
                : row.sampleValue}
            </div>
          ) : null}
        </div>
      )}

      {/* ── Validation tally ── */}
      {row.tally && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12 }}>
          {row.tally.passing > 0 && tallyDot(row.tally.passing, '#16a34a')}
          {row.tally.warning > 0 && tallyDot(row.tally.warning, '#d97706')}
          {row.tally.failing > 0 && tallyDot(row.tally.failing, '#dc2626')}
          {row.tally.passing === 0 &&
            row.tally.warning === 0 &&
            row.tally.failing === 0 && (
              <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>
                No validation samples
              </span>
            )}
          <span style={{ color: '#9ca3af', marginLeft: 'auto' }}>
            {row.validationSamples.length} sample
            {row.validationSamples.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* ── Validation sample warnings ── */}
      {row.validationSamples.filter((s) => s.warnings.length > 0).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {row.validationSamples
            .filter((s) => s.warnings.length > 0)
            .slice(0, 2)
            .map((s, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  color: '#d97706',
                  padding: '2px 0',
                }}
              >
                ⚠ {s.warnings.join('; ')}
              </div>
            ))}
        </div>
      )}

      {/* ── Image approval gate (image fields only) ── */}
      {row.isImageField && imageApprovalRequired && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: '#4b5563',
            marginBottom: 8,
            padding: 6,
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 4,
          }}
        >
          <input
            type="checkbox"
            checked={imagePreviewsReviewed}
            onChange={(e) => onImageReviewToggle?.(e.target.checked)}
            disabled={disabled}
          />
          <span>
            I reviewed the image previews — images show the actual product
          </span>
        </label>
      )}

      {/* ── Action buttons ── */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setEditValue(row.proposedSelector ?? '');
              setEditing(true);
            }}
            disabled={disabled}
            style={{
              padding: '2px 8px',
              fontSize: 11,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              background: '#fff',
              cursor: disabled ? 'not-allowed' : 'pointer',
              color: '#374151',
            }}
          >
            Edit Selector
          </button>
        )}
        {onFeedback && (
          <button
            type="button"
            onClick={() => onFeedback(row.key)}
            disabled={disabled}
            style={{
              padding: '2px 8px',
              fontSize: 11,
              border: '1px solid #d1d5db',
              borderRadius: 4,
              background: '#fff',
              cursor: disabled ? 'not-allowed' : 'pointer',
              color: '#374151',
            }}
          >
            Feedback
          </button>
        )}
      </div>

      {/* ── Inline editor ── */}
      {editing && (
        <div style={{ marginTop: 8, padding: 8, background: '#f9fafb', borderRadius: 4 }}>
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="Enter CSS selector…"
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: 12,
              fontFamily: 'monospace',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              marginBottom: 4,
              boxSizing: 'border-box',
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={!editValue.trim()}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid #16a34a',
                borderRadius: 4,
                background: '#dcfce7',
                color: '#16a34a',
                fontWeight: 600,
                cursor: editValue.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleCancelEdit}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid #d1d5db',
                borderRadius: 4,
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
