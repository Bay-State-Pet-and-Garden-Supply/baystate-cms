// fallow-ignore-file unused-exports

/**
 * ProfileFieldValidationTable.tsx — per-field validation table for
 * the governance review surface.
 *
 * @deprecated Use ProfileReviewFieldCard + ProfileReviewFieldGroup instead.
 * This component only handles the three fixed SELECTOR_FIELDS and does not
 * support dynamic/custom fields, price/brand, or variant strategy.
 *
 * For each of the five selector fields, renders:
 *  - the current active selector (from `extractor_profiles`)
 *  - the proposed selector (from the revision under review)
 *  - per-sample extracted value or previews
 *  - per-sample warnings
 *  - per-field approval / rejection checkboxes
 *
 * The component is presentational. Parent owns the approval
 * state and the gating logic (image approvals require
 * `imagePreviewsReviewed`; text fields warn when only one
 * sample exists).
 *
 * Phase 4 (UI) consumer.
 */

import React from 'react';
import type { SelectorField } from '../../shared/schemas/onboarding';
import { ImagePreviewGrid, type ImagePreview } from './ImagePreviewGrid';

export interface FieldValidationRow {
  field: SelectorField;
  proposedSelector: string | null;
  currentSelector: string | null;
  passing: number;
  warning: number;
  failing: number;
  samples: Array<{
    sampleUrl: string;
    expectedName: string | null;
    brandHint: string | null;
    extractedText: string | null;
    extractedImages: string[];
    warnings: string[];
    status: 'pass' | 'warning' | 'fail';
  }>;
}

interface ProfileFieldValidationTableProps {
  rows: FieldValidationRow[];
  /** Per-field approval state, controlled by parent. */
  approvedFields: Partial<Record<SelectorField, boolean>>;
  onToggleApproved: (field: SelectorField, value: boolean) => void;
  /** Per-field rejection state (mutually exclusive with approved). */
  rejectedFields?: Partial<Record<SelectorField, boolean>>;
  onToggleRejected?: (field: SelectorField, value: boolean) => void;
  /** Whether the image-approval gate is satisfied. */
  readyForImageApproval: boolean;
  /** True when the operator attests they reviewed the image previews. */
  imagePreviewsReviewed: boolean;
  onToggleImagePreviewsReviewed: (value: boolean) => void;
  /** Read-only mode (history view, no toggles). */
  readOnly?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};

const TALLY_COLORS: Record<'pass' | 'warning' | 'fail', string> = {
  pass: '#16a34a',
  warning: '#d97706',
  fail: '#dc2626',
};

export function ProfileFieldValidationTable(props: ProfileFieldValidationTableProps): React.ReactElement {
  const {
    rows,
    approvedFields,
    onToggleApproved,
    rejectedFields,
    onToggleRejected,
    readyForImageApproval,
    imagePreviewsReviewed,
    onToggleImagePreviewsReviewed,
    readOnly,
  } = props;

  return (
    <div>
      {rows.map((row) => {
        const isImageField = row.field === 'imagesSelector';
        const approved = !!approvedFields[row.field];
        const rejected = !!rejectedFields?.[row.field];
        const totalPassing = row.passing;
        const totalWarning = row.warning;
        const totalFailing = row.failing;
        const sampleCount = totalPassing + totalWarning + totalFailing;
        const limitedEvidence = isImageField
          ? false
          : sampleCount > 0 && totalPassing < 2;

        // Image approval requires readyForImageApproval + checkbox.
        const imageApprovalBlocked = isImageField && (!readyForImageApproval || !imagePreviewsReviewed);

        // Rejection blocks approval.
        const approvalDisabled =
          readOnly ||
          rejected ||
          !row.proposedSelector ||
          imageApprovalBlocked;

        const rejectionDisabled = readOnly || approved;

        return (
          <div
            key={row.field}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: 16,
              marginBottom: 12,
              background: approved ? '#f0fdf4' : rejected ? '#fef2f2' : '#fff',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div>
                <strong style={{ fontSize: 14 }}>{FIELD_LABELS[row.field]}</strong>
                <code style={{ marginLeft: 8, fontSize: 12, color: '#4b5563' }}>
                  {row.proposedSelector || <em style={{ color: '#9ca3af' }}>no selector proposed</em>}
                </code>
                {row.currentSelector && row.currentSelector !== row.proposedSelector && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>
                    (current: <code style={{ fontSize: 11 }}>{row.currentSelector}</code>)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {!readOnly && (
                  <>
                    <ToggleButton
                      label="Approve"
                      active={approved}
                      color="#16a34a"
                      onClick={() => onToggleApproved(row.field, !approved)}
                      disabled={approvalDisabled}
                    />
                    {onToggleRejected && (
                      <ToggleButton
                        label="Reject"
                        active={rejected}
                        color="#dc2626"
                        onClick={() => onToggleRejected(row.field, !rejected)}
                        disabled={rejectionDisabled}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, color: '#4b5563' }}>
              <span style={{ color: TALLY_COLORS.pass }}>{totalPassing} passing</span>
              <span style={{ color: TALLY_COLORS.warning }}>{totalWarning} warning</span>
              <span style={{ color: TALLY_COLORS.fail }}>{totalFailing} failing</span>
              {limitedEvidence && (
                <span
                  style={{
                    marginLeft: 'auto',
                    color: '#b45309',
                    background: '#fef3c7',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 11,
                  }}
                >
                  Limited evidence (1 sample)
                </span>
              )}
            </div>

            {isImageField && !readOnly && (
              <div style={{ marginBottom: 8, fontSize: 12, color: '#4b5563' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={imagePreviewsReviewed}
                    onChange={(e) => onToggleImagePreviewsReviewed(e.target.checked)}
                  />
                  <span>I reviewed the image previews below</span>
                </label>
                {!readyForImageApproval && (
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: '#b45309' }}>
                    At least {2} samples with no failures are required before image approval unlocks.
                  </p>
                )}
              </div>
            )}

            {isImageField ? (
              <ImagePreviewGrid
                previews={row.samples.flatMap((s) =>
                  s.extractedImages.map((url) => ({
                    url,
                    sampleUrl: s.sampleUrl,
                    expectedName: s.expectedName,
                    brandHint: s.brandHint,
                    warnings: s.warnings,
                    verdict: 'pending' as const,
                  })),
                )}
                readOnly={readOnly}
                compact
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {row.samples.length === 0 ? (
                  <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', margin: 0 }}>
                    No samples tested.
                  </p>
                ) : (
                  row.samples.map((s, i) => (
                    <div
                      key={`${s.sampleUrl}-${i}`}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        fontSize: 12,
                        padding: 4,
                        borderRadius: 4,
                        background: s.status === 'pass' ? '#f0fdf4' : s.status === 'warning' ? '#fffbeb' : '#fef2f2',
                      }}
                    >
                      <span
                        style={{
                          color: TALLY_COLORS[s.status],
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          fontSize: 10,
                          minWidth: 60,
                        }}
                      >
                        {s.status}
                      </span>
                      <span style={{ flex: 1, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.extractedText || <em style={{ color: '#9ca3af' }}>(empty)</em>}
                      </span>
                      <span style={{ color: '#6b7280', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.sampleUrl}>
                        {s.sampleUrl}
                      </span>
                      {s.expectedName && (
                        <span style={{ color: '#6b7280', fontSize: 10 }} title="Expected">
                          expected: {s.expectedName}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ToggleButtonProps {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}

function ToggleButton(props: ToggleButtonProps) {
  const { label, active, color, onClick, disabled } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: active ? '#fff' : color,
        background: active ? color : disabled ? '#f3f4f6' : '#fff',
        border: `1px solid ${disabled ? '#d1d5db' : color}`,
        borderRadius: 4,
        padding: '4px 10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !active ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}
