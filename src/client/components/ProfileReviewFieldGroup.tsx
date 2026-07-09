/**
 * ProfileReviewFieldGroup.tsx — collapsible field group by category.
 *
 * Renders a category header with counts (proposed/approved/rejected/failing)
 * and a list of ProfileReviewFieldCard components inside.
 */

import React, { useState } from 'react';
import type { ReviewFieldRow } from '../profile-review-utils';
import { getCategoryLabel } from '../profile-review-utils';
import { ProfileReviewFieldCard } from './ProfileReviewFieldCard';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProfileReviewFieldGroupProps {
  category: string;
  rows: ReviewFieldRow[];
  approvedFields: Record<string, boolean>;
  rejectedFields: Record<string, boolean>;
  onToggleApprove: (key: string, approve: boolean) => void;
  onFeedback?: (key: string) => void;
  onEditSelector?: (key: string, selector: string) => void;
  disabled?: boolean;
  imagePreviewsReviewed: boolean;
  onImageReviewToggle: (reviewed: boolean) => void;
  /** Default expanded */
  defaultExpanded?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileReviewFieldGroup(
  props: ProfileReviewFieldGroupProps,
): React.ReactElement {
  const {
    category,
    rows,
    approvedFields,
    rejectedFields,
    onToggleApprove,
    onFeedback,
    onEditSelector,
    disabled = false,
    imagePreviewsReviewed,
    onImageReviewToggle,
    defaultExpanded = true,
  } = props;

  const [expanded, setExpanded] = useState(defaultExpanded);

  if (rows.length === 0) return <></>;

  const proposed = rows.length;
  const approved = rows.filter((r) => approvedFields[r.key] === true).length;
  const rejected = rows.filter((r) => rejectedFields[r.key] === true).length;
  const failing = rows.filter(
    (r) => r.tally && r.tally.failing > 0,
  ).length;

  const hasImages = rows.some((r) => r.isImageField);
  const imagesNeedReview = hasImages && rows.some(
    (r) => r.isImageField && approvedFields[r.key] && r.tally && r.tally.passing >= 2,
  );

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* ── Category header ── */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '10px 14px',
          border: 'none',
          background: '#f9fafb',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          color: '#374151',
          textAlign: 'left',
        }}
      >
        <span>
          {getCategoryLabel(category)}
          <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
            {proposed} field{proposed !== 1 ? 's' : ''}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
          {approved > 0 && (
            <span style={{ color: '#16a34a', fontWeight: 600 }}>
              {approved} approved
            </span>
          )}
          {rejected > 0 && (
            <span style={{ color: '#dc2626', fontWeight: 600 }}>
              {rejected} rejected
            </span>
          )}
          {failing > 0 && (
            <span style={{ color: '#d97706', fontWeight: 600 }}>
              {failing} failing
            </span>
          )}
          <span style={{ color: '#9ca3af', marginLeft: 4 }}>
            {expanded ? '▲' : '▼'}
          </span>
        </span>
      </button>

      {/* ── Field cards ── */}
      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
          }}
        >
          {rows.map((row) => (
            <ProfileReviewFieldCard
              key={row.key}
              row={row}
              approved={approvedFields[row.key] === true}
              rejected={rejectedFields[row.key] === true}
              onToggleApprove={onToggleApprove}
              onFeedback={onFeedback}
              onEditSelector={onEditSelector}
              disabled={disabled}
              imageApprovalRequired={imagesNeedReview}
              imagePreviewsReviewed={imagePreviewsReviewed}
              onImageReviewToggle={onImageReviewToggle}
              hasStrongEvidence={
                row.tally ? row.tally.passing >= 2 : false
              }
              hasLimitedEvidence={
                row.tally ? row.tally.passing >= 1 : false
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
