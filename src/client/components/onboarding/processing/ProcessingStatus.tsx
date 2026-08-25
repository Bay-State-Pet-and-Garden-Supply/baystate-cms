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
import { statusText } from './processing-logic';

interface ProcessingStatusProps {
  item: OnboardingWorkState;
}

export function ProcessingStatus({ item }: ProcessingStatusProps) {
  return (
    <li className="pw-row">
      <span className="pw-indicator" aria-hidden="true" />
      <div className="pw-identity">
        <p className="pw-name" title={item.curatedTitle || item.name}>{item.curatedTitle || item.name}</p>
        <div className="pw-meta">
          {item.upc ? <span className="pw-upc">{item.upc}</span> : null}
          {item.brand ? <span className="pw-brand">· {item.brand}</span> : null}
        </div>
      </div>
      <div className="pw-activity">
        <p className="pw-status-label" title={item.label || undefined}>{statusText(item)}</p>
        {item.detail ? (
          <p className="pw-detail" title={item.detail}>{item.detail}</p>
        ) : null}
      </div>
      <span
        className="pw-stage"
        title={`Pipeline diagnostics — stage: ${item.stage}, status: ${item.stageStatus}`}
      >
        {item.stage} / {item.stageStatus}
      </span>
    </li>
  );
}
