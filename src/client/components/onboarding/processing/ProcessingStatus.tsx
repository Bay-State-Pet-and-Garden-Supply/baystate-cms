/**
 * Epic #46 — Processing row (Phase 5).
 *
 * One row per item that automation is currently handling. Deliberately NO
 * progression controls (advance/reset/skip): automation owns progression.
 * The raw pipeline stage appears only as a subtle secondary diagnostics
 * badge — never the primary meaning of the row.
 */
import React from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  getActivityBadgeLabel,
  getActivityBadgeTooltip,
  isGranularCurationActivity,
  statusText,
} from './processing-logic';

interface ProcessingStatusProps {
  item: OnboardingWorkState;
  onViewFamily?: (cohortId: string) => void;
}

export function ProcessingStatus({ item, onViewFamily }: ProcessingStatusProps) {
  const badgeLabel = getActivityBadgeLabel(item.activity);
  const badgeTooltip = getActivityBadgeTooltip(item.activity, item.detail ?? item.label);
  const showGranularBadge = isGranularCurationActivity(item.activity) || item.activity === 'curation';
  const badgeDescId = `pw-badge-desc-${item.itemId}`;

  // Sub-stage hint when server detail is absent but we know the granular stage.
  const fallbackHint: Record<string, string> = {
    packaging_ocr: 'Primary image • Packaging OCR in progress',
    cohort_freezing: 'Agreement check across siblings',
    title_coordination: 'Synchronizing family title skeleton',
    page_coordination: 'Verifying category placement',
    attribute_curation: 'Extracting variant attributes',
    semantic_validation: 'Checking family invariants',
  };
  const hint = !item.detail
    ? (item.activity ? (fallbackHint[item.activity] ?? null) : null)
    : null;

  return (
    <li className="pw-row">
      <span className="pw-indicator" aria-hidden="true" />
      <div className="pw-identity">
        <p className="pw-name" title={item.curatedTitle || item.name}>
          {item.curatedTitle || item.name}
        </p>
        <div className="pw-meta">
          {item.upc ? <span className="pw-upc">{item.upc}</span> : null}
          {item.brand ? <span className="pw-brand">· {item.brand}</span> : null}
        </div>
      </div>
      <div className="pw-activity">
        {showGranularBadge ? (
          <>
            <span
              className="pw-badge"
              title={badgeTooltip}
              aria-label={badgeLabel}
              aria-describedby={badgeDescId}
              role="status"
            >
              <span className="pw-badge-dot" aria-hidden="true" />
              {badgeLabel}
            </span>
            <span id={badgeDescId} className="visually-hidden">
              {badgeTooltip}
            </span>
          </>
        ) : null}
        <p className="pw-status-label" title={item.label || undefined}>
          {statusText(item)}
        </p>
        {item.detail ? (
          <p className="pw-detail" title={item.detail}>
            {item.detail}
          </p>
        ) : hint ? (
          <p className="pw-detail pw-detail--hint" title={hint}>
            {hint}
          </p>
        ) : null}
      </div>
      {item.family && item.family.memberCount > 1 && onViewFamily ? (
        <button
          type="button"
          className="btn btn-outline pw-family-btn"
          onClick={() => onViewFamily(item.family!.cohortId)}
          title={`View ${item.family.memberCount} siblings in family ${item.family.label ?? item.family.cohortId}`}
        >
          View family ({item.family.memberCount})
        </button>
      ) : null}
      <span
        className="pw-stage"
        title={`Pipeline diagnostics — stage: ${item.stage}, status: ${item.stageStatus}`}
      >
        {item.stage} / {item.stageStatus}
      </span>
    </li>
  );
}
