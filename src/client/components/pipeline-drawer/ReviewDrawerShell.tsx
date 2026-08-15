import React, { useEffect, useRef } from 'react';
import type { OnboardingItem, PipelineStage } from '../../../shared/schemas/onboarding';

const STAGES: PipelineStage[] = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'];
const STAGE_LABELS: Record<PipelineStage, string> = {
  sourcing: 'Sourcing',
  discovery: 'Discovery',
  extraction: 'Extraction',
  curation: 'Curation',
  review: 'Review',
  promotion: 'Promotion',
};

interface ReviewDrawerShellProps {
  reviewItem: OnboardingItem;
  hasPrev: boolean;
  hasNext: boolean;
  reviewTransitioning: boolean;
  onPrevItem: () => void;
  onNextItem: () => void;
  onClose: () => void;
  onOpenProfileBuilder?: (domain: string, item: OnboardingItem) => void;
  consistencyWarnings?: Array<{ groupId: string; field: string; message: string }>;
  /**
   * PR10 (issue #30, DECISION-A/B): the first-class cohort semantic
   * validation surface from the hydrated item payload. Present ONLY for
   * ACTIVE-cohort members; null for legacy/shadow items (legacy rendering
   * unchanged). When present, the semantic surface REPLACES the legacy
   * consistency-warnings box (the server already sends `[]` warnings in
   * active mode); `status === 'blocked'` renders the red findings banner
   * (the member is NOT review-ready — the review-complete gate refuses it).
   */
  semanticValidation?: {
    status: 'passed' | 'blocked';
    findings: Array<{ code: string; message: string; memberSku: string | null }>;
  } | null;
  handleResetSingle?: () => void;
  /** When true, the generic Reset button is suppressed (used for Sourcing while the engine is disabled). */
  suppressReset?: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveError: string | null;
  hasRetryableSaveFailure?: boolean;
  retryFailedWrites?: () => Promise<void>;
  onApproveReview?: () => void;
  onApproveAndNext?: () => void;
  onAdvanceStage?: () => void;
  leftColumnContent: React.ReactNode;
  rightColumnContent: React.ReactNode;
}

export function ReviewDrawerShell({
  reviewItem,
  hasPrev,
  hasNext,
  reviewTransitioning,
  onPrevItem,
  onNextItem,
  onClose,
  onOpenProfileBuilder,
  consistencyWarnings = [],
  semanticValidation = null,
  handleResetSingle,
  suppressReset = false,
  saveStatus,
  saveError,
  hasRetryableSaveFailure,
  retryFailedWrites,
  onApproveReview,
  onApproveAndNext,
  onAdvanceStage,
  leftColumnContent,
  rightColumnContent,
}: ReviewDrawerShellProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  // Global Keyboard Shortcuts (Esc to close, ArrowLeft/Right for item nav, Cmd+Enter for primary action)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputFocused =
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable);

      if (e.key === 'Escape' && !isInputFocused) {
        e.preventDefault();
        onClose();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (reviewItem.stage === 'review' && onApproveAndNext && hasNext) {
          onApproveAndNext();
        } else if (reviewItem.stage === 'review' && onApproveReview) {
          onApproveReview();
        } else if (['discovery', 'extraction', 'curation'].includes(reviewItem.stage) && onAdvanceStage) {
          onAdvanceStage();
        }
        return;
      }

      if (!isInputFocused) {
        if (e.key === 'ArrowLeft' && hasPrev && !reviewTransitioning) {
          e.preventDefault();
          onPrevItem();
        } else if (e.key === 'ArrowRight' && hasNext && !reviewTransitioning) {
          e.preventDefault();
          onNextItem();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    onClose,
    hasPrev,
    hasNext,
    reviewTransitioning,
    onPrevItem,
    onNextItem,
    reviewItem.stage,
    onApproveReview,
    onApproveAndNext,
    onAdvanceStage,
  ]);

  // Focus trap management on mount
  useEffect(() => {
    drawerRef.current?.focus();
  }, [reviewItem.id]);

  const domain = (() => {
    try {
      return reviewItem.sourceUrl ? new URL(reviewItem.sourceUrl).hostname.replace(/^www./, '') : null;
    } catch {
      return null;
    }
  })();

  const isEarlyStage = ['discovery', 'extraction', 'curation'].includes(reviewItem.stage);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        role="presentation"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 1000,
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Drawer Shell Container */}
      <div
        ref={drawerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-item-title"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          maxWidth: 900,
          background: '#fff',
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-6px 0 20px rgba(0,0,0,0.18)',
          boxSizing: 'border-box',
          overflow: 'hidden',
          outline: 'none',
        }}
      >
        {/* Header Bar */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid #e5e7eb',
            position: 'relative',
            flexShrink: 0,
            background: '#fff',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 20,
              right: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            {/* Previous / Next Navigation Buttons */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={onPrevItem}
                disabled={!hasPrev || reviewTransitioning}
                aria-label="Previous item in batch"
                style={{
                  padding: '6px 12px',
                  minHeight: 36,
                  background: '#fff',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  color: hasPrev ? '#374151' : '#d1d5db',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: hasPrev && !reviewTransitioning ? 'pointer' : 'not-allowed',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                ◀ Prev
              </button>
              <button
                type="button"
                onClick={onNextItem}
                disabled={!hasNext || reviewTransitioning}
                aria-label="Next item in batch"
                style={{
                  padding: '6px 12px',
                  minHeight: 36,
                  background: '#fff',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  color: hasNext ? '#374151' : '#d1d5db',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: hasNext && !reviewTransitioning ? 'pointer' : 'not-allowed',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                Next ▶
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={reviewTransitioning}
              aria-label="Close review drawer"
              style={{
                background: '#f3f4f6',
                border: '1px solid #e5e7eb',
                borderRadius: '50%',
                width: 36,
                height: 36,
                fontSize: 18,
                cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
                color: '#4b5563',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#e5e7eb';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#f3f4f6';
              }}
            >
              ✕
            </button>
          </div>

          <h2
            id="drawer-item-title"
            style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#111827', paddingRight: 180 }}
          >
            {reviewItem.name}
          </h2>

          {reviewItem.expectedName && reviewItem.expectedName !== reviewItem.name && (
            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#7c3aed', fontWeight: 600 }}>
              Expected: {reviewItem.expectedName}
            </p>
          )}

          <p style={{ margin: 0, fontSize: 13, color: '#6b7280', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>UPC: <strong>{reviewItem.upc}</strong></span>
            {reviewItem.price ? (
              <span>
                Price: <strong>${(() => { const n = parseFloat(reviewItem.price.replace(/[^0-9.]/g, '')); return isNaN(n) ? reviewItem.price : n.toFixed(2); })()}</strong>
              </span>
            ) : null}
            {domain && onOpenProfileBuilder && (
              <button
                type="button"
                disabled={reviewTransitioning}
                onClick={() => onOpenProfileBuilder(domain, reviewItem)}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
                  border: '1px solid #2563eb',
                  borderRadius: 4,
                  color: '#2563eb',
                  background: '#eff6ff',
                  fontWeight: 600,
                }}
              >
                Open Profile Builder
              </button>
            )}
          </p>
        </div>

        {/* 2-Column Responsive Body */}
        <div
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '320px 1fr',
            gap: 20,
            padding: 24,
            overflowY: 'hidden',
            minHeight: 0,
            pointerEvents: reviewTransitioning ? 'none' : 'auto',
          }}
        >
          {/* Left Column: Sticky Media & Identity Summary */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              overflowY: 'auto',
              paddingRight: 8,
              borderRight: '1px solid #f3f4f6',
            }}
          >
            {/* Stage Stepper Progress */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: '#f9fafb',
                padding: '12px 14px',
                borderRadius: 8,
                border: '1px solid #e5e7eb',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Pipeline Progress
              </span>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap' }}>
                {STAGES.map((stg, idx) => {
                  const isCurrent = reviewItem.stage === stg;
                  const isPast = STAGES.indexOf(reviewItem.stage) > idx;
                  const label = STAGE_LABELS[stg];

                  let color = '#9ca3af';
                  let fontWeight = 'normal';
                  let icon = '○';
                  if (isCurrent) {
                    color = '#7c3aed';
                    fontWeight = '600';
                    icon = reviewItem.stageStatus === 'in_progress' ? '◌' : '●';
                  } else if (isPast) {
                    color = '#16a34a';
                    fontWeight = '500';
                    icon = '✓';
                  }

                  return (
                    <div key={stg} style={{ display: 'flex', alignItems: 'center', gap: 4, color, fontSize: 11, fontWeight }}>
                      <span>{icon}</span>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Status Banner */}
            {(() => {
              const currentStageLabel = STAGE_LABELS[reviewItem.stage];
              const stageStatus = reviewItem.stageStatus;
              const isNeedsReview = stageStatus === 'completed' && reviewItem.errorMessage?.startsWith('needs_review:');

              let statusBannerBg = '#f3f4f6';
              let statusBannerTextColor = '#374151';
              let statusBannerBorderColor = '#d1d5db';
              let statusTitle = '';
              let statusDesc = '';

              if (stageStatus === 'pending') {
                statusTitle = `Pending ${currentStageLabel}`;
                statusDesc = 'Queued for processing...';
              } else if (stageStatus === 'in_progress') {
                statusBannerBg = '#eff6ff';
                statusBannerTextColor = '#1e40af';
                statusBannerBorderColor = '#bfdbfe';
                statusTitle = `${currentStageLabel} in progress...`;
                statusDesc = 'Processing task in background...';
              } else if (isNeedsReview) {
                statusBannerBg = '#ffedd5';
                statusBannerTextColor = '#c2410c';
                statusBannerBorderColor = '#fed7aa';
                statusTitle = `${currentStageLabel} needs review`;
                statusDesc = reviewItem.errorMessage || 'Requires manual review.';
              } else if (stageStatus === 'completed') {
                statusBannerBg = '#f0fdf4';
                statusBannerTextColor = '#166534';
                statusBannerBorderColor = '#bbf7d0';
                statusTitle = `${currentStageLabel} completed`;
                statusDesc = 'Stage completed successfully.';
              } else if (stageStatus === 'failed') {
                statusBannerBg = '#fee2e2';
                statusBannerTextColor = '#991b1b';
                statusBannerBorderColor = '#fca5a5';
                statusTitle = `${currentStageLabel} failed`;
                statusDesc = reviewItem.errorMessage || 'An error occurred.';
              }

              return (
                <div
                  style={{
                    background: statusBannerBg,
                    color: statusBannerTextColor,
                    border: `1px solid ${statusBannerBorderColor}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 12, lineHeight: 1.4 }}>
                    <strong style={{ display: 'block', marginBottom: 2 }}>{statusTitle}</strong>
                    <span style={{ opacity: 0.9 }}>{statusDesc}</span>
                  </div>
                  {handleResetSingle && !suppressReset && (stageStatus === 'failed' || stageStatus === 'completed' || stageStatus === 'skipped') && (
                    <button
                      type="button"
                      onClick={handleResetSingle}
                      style={{
                        padding: '4px 10px',
                        background: '#fff',
                        border: `1px solid ${statusBannerBorderColor}`,
                        color: statusBannerTextColor,
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      🔄 Reset
                    </button>
                  )}
                </div>
              );
            })()}

            {/* PR10 (issue #30, DECISION-A/B): the active-cohort semantic
                surface REPLACES the legacy consistency-warnings box. A
                blocked member renders the red findings banner (NOT
                review-ready — the review-complete gate refuses it); a
                passed member renders nothing (the server already sends `[]`
                legacy warnings in active mode). Legacy/shadow items
                (semanticValidation === null) keep the amber sibling-warnings
                box byte-identical. */}
            {semanticValidation === null && consistencyWarnings.length > 0 && (
              <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', color: '#92400e', fontSize: 12 }}>
                <strong style={{ display: 'block', marginBottom: 4 }}>Sibling consistency warning</strong>
                {consistencyWarnings.map((w) => (
                  <div key={`${w.groupId}:${w.field}`} style={{ marginTop: 2 }}>
                    <strong>{w.field}:</strong> {w.message}
                  </div>
                ))}
              </div>
            )}
            {semanticValidation?.status === 'blocked' && (
              <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#991b1b', fontSize: 12 }}>
                <strong style={{ display: 'block', marginBottom: 2 }}>⛔ Not review-ready — cohort semantic validation blocked</strong>
                <div style={{ marginBottom: 4 }}>Resolve the findings below (fix the member evidence or start a new cohort revision) — review completion is blocked until the fresh revision validates.</div>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {semanticValidation.findings.map((finding, idx) => (
                    <li key={`${finding.code}:${idx}`} style={{ marginTop: 2 }}>
                      <strong>[{finding.code}]</strong> {finding.message}
                      {finding.memberSku ? ` (SKU ${finding.memberSku})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Mandatory Promotion Fields Warning */}
            {(() => {
              if (!['curation', 'review', 'promotion'].includes(reviewItem.stage)) return null;
              const missing: string[] = [];
              if (!reviewItem.name?.trim()) missing.push('Title/Name');
              if (!reviewItem.price?.trim()) missing.push('Price');
              if (!reviewItem.brandHint?.trim()) missing.push('Brand (ProductField16)');
              if (!reviewItem.extractionData?.primaryImage) missing.push('Primary Image');
              if (!(reviewItem.curationData?.suggestedPages?.length)) missing.push('Pages');
              if (missing.length === 0) return null;

              return (
                <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#991b1b', fontSize: 12 }}>
                  <strong style={{ display: 'block', marginBottom: 2 }}>⚠ Missing Mandatory Promotion Fields</strong>
                  <div>Complete the following fields before promoting to CMS draft:</div>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {missing.map((f) => (
                      <li key={f} style={{ fontWeight: 600 }}>{f}</li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* Custom Media / Identity Left Column Content */}
            {leftColumnContent}
          </div>

          {/* Right Column: Scrollable Form Body */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              overflowY: 'auto',
              paddingRight: 6,
            }}
          >
            {rightColumnContent}
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '16px 24px 20px',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            gap: 10,
            justifyContent: 'flex-end',
            alignItems: 'center',
            flexShrink: 0,
            background: '#fff',
          }}
        >
          {/* Save Status Feedback */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 'auto' }}>
            {saveStatus === 'saving' && (
              <span style={{ fontSize: 13, color: '#4b5563', fontWeight: 500 }}>
                Saving changes...
              </span>
            )}
            {saveStatus === 'saved' && (
              <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>
                ✓ Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <>
                <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>
                  Error: {saveError}
                </span>
                {hasRetryableSaveFailure && retryFailedWrites && (
                  <button
                    type="button"
                    onClick={() => { void retryFailedWrites(); }}
                    style={{ padding: '4px 10px', border: '1px solid #dc2626', borderRadius: 4, background: '#fff', color: '#b91c1c', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                  >
                    Retry save
                  </button>
                )}
              </>
            )}
          </div>

          {/* Footer Action Triggers */}
          <button
            type="button"
            disabled={reviewTransitioning}
            onClick={onClose}
            style={{
              padding: '10px 18px',
              minHeight: 40,
              background: '#fff',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
              fontSize: 13,
              color: '#374151',
              fontWeight: 600,
            }}
          >
            {isEarlyStage ? 'Close' : 'Cancel'}
          </button>

          {isEarlyStage && onAdvanceStage && (
            <button
              type="button"
              disabled={reviewTransitioning}
              onClick={onAdvanceStage}
              style={{
                padding: '10px 20px',
                minHeight: 40,
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
                fontSize: 13,
                fontWeight: 600,
                boxShadow: '0 2px 4px rgba(37, 99, 235, 0.2)',
              }}
            >
              Save & Advance Stage ➔
            </button>
          )}

          {reviewItem.stage === 'review' && (
            <>
              {onApproveReview && (
                <button
                  type="button"
                  disabled={reviewTransitioning}
                  onClick={onApproveReview}
                  style={{
                    padding: '10px 18px',
                    minHeight: 40,
                    background: '#fff',
                    border: '1.5px solid #16a34a',
                    color: '#16a34a',
                    borderRadius: 6,
                    cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  ✓ Approve
                </button>
              )}
              {onApproveAndNext && hasNext && (
                <button
                  type="button"
                  disabled={reviewTransitioning}
                  onClick={onApproveAndNext}
                  style={{
                    padding: '10px 22px',
                    minHeight: 40,
                    background: reviewTransitioning ? '#86efac' : '#16a34a',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: reviewTransitioning ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    fontWeight: 700,
                    boxShadow: '0 2px 6px rgba(22, 163, 74, 0.3)',
                  }}
                >
                  {reviewTransitioning ? 'Approving…' : '✓ Approve & Next ▶'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
