import React, { useState } from 'react';
import type { OnboardingItem, ResolveSourcingRequest } from '../../../shared/schemas/onboarding';

interface EvidenceAttemptSummary {
  id: string;
  providerId: string;
  lookupUpc: string;
  outcome: string;
  evidenceJson?: string | null;
  createdAt: string;
}

interface SourcingStagePanelProps {
  reviewItem: OnboardingItem;
  evidenceAttempts?: EvidenceAttemptSummary[];
  onResolveSourcing: (request: ResolveSourcingRequest) => Promise<void>;
  onRetrySourcing?: () => Promise<void>;
}

export function SourcingStagePanel({
  reviewItem,
  evidenceAttempts = [],
  onResolveSourcing,
  onRetrySourcing,
}: SourcingStagePanelProps) {
  const [selectedAttemptIds, setSelectedAttemptIds] = useState<string[]>([]);

  React.useEffect(() => {
    setSelectedAttemptIds(
      reviewItem.sourcingDecision?.acceptedEvidenceAttemptIds ||
      evidenceAttempts
        .filter(a => a.outcome === 'found' && (!a.lookupUpc || a.lookupUpc === reviewItem.upc))
        .map(a => a.id),
    );
  }, [reviewItem.id, reviewItem.sourcingDecision?.acceptedEvidenceAttemptIds, evidenceAttempts]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sourcingDecision = reviewItem.sourcingDecision;
  const conflicts = sourcingDecision?.conflicts || [];
  const hasConflicts = conflicts.length > 0 || reviewItem.errorMessage?.includes('conflict');

  const toggleAttempt = (id: string) => {
    setSelectedAttemptIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  const handleUseBundle = async () => {
    if (selectedAttemptIds.length === 0) {
      setErrorMsg('Please select at least one evidence attempt bundle.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await onResolveSourcing({
        action: 'use_selected_bundle',
        selectedAttemptIds,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFallback = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await onResolveSourcing({
        action: 'fallback_to_discovery',
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Overview Banner */}
      <div
        style={{
          padding: 16,
          borderRadius: 8,
          background: hasConflicts ? '#fff1f2' : '#f0fdf4',
          border: `1px solid ${hasConflicts ? '#fecdd3' : '#bbf7d0'}`,
          color: hasConflicts ? '#9f1239' : '#166534',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{hasConflicts ? '⚠️ Sourcing Identity Conflict Detected' : '✓ Distributor Sourcing Status'}</span>
        </div>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.9, lineHeight: 1.4 }}>
          {reviewItem.errorMessage ||
            (hasConflicts
              ? 'Multiple distributor data feeds provided conflicting product records. Operator resolution is required to choose a valid evidence bundle or fallback to brand site discovery.'
              : 'Evaluate distributor evidence attempts below or proceed with the automatic sourcing decision.')}
        </p>
      </div>

      {/* Conflict Details (if present) */}
      {conflicts.length > 0 && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#ffffff',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#111827' }}>
            Detected Discrepancies
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {conflicts.map((c, idx) => (
              <div
                key={idx}
                style={{
                  padding: '10px 12px',
                  background: '#f9fafb',
                  borderRadius: 6,
                  border: '1px solid #f3f4f6',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <strong style={{ color: '#374151', textTransform: 'capitalize' }}>
                    Field: {c.field}
                  </strong>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      background: c.severity === 'hard' ? '#ffe4e6' : '#fef3c7',
                      color: c.severity === 'hard' ? '#9f1239' : '#92400e',
                    }}
                  >
                    {c.severity} conflict
                  </span>
                </div>
                {Object.entries(c.providerValues || {}).map(([provider, val]) => (
                  <div key={provider} style={{ color: '#4b5563', fontFamily: 'monospace', fontSize: 11 }}>
                    <span style={{ fontWeight: 600 }}>{provider}:</span> {val}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provider Evidence Bundles */}
      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
          background: '#ffffff',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>
            Distributor Evidence Attempts ({evidenceAttempts.length})
          </h3>
          {onRetrySourcing && (
            <button
              type="button"
              onClick={onRetrySourcing}
              disabled={submitting}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                background: '#fff',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                cursor: 'pointer',
                color: '#374151',
                fontWeight: 600,
              }}
            >
              🔄 Re-run Sourcing
            </button>
          )}
        </div>

        {evidenceAttempts.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
            No distributor lookup attempts recorded for this item.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {evidenceAttempts.map(attempt => {
              const isSelected = selectedAttemptIds.includes(attempt.id);
              let parsedData: any = null;
              if (attempt.evidenceJson) {
                try {
                  parsedData = JSON.parse(attempt.evidenceJson);
                } catch {}
              }

              return (
                <div
                  key={attempt.id}
                  onClick={() => toggleAttempt(attempt.id)}
                  style={{
                    padding: 12,
                    borderRadius: 6,
                    border: `1.5px solid ${isSelected ? '#2563eb' : '#e5e7eb'}`,
                    background: isSelected ? '#eff6ff' : '#fafafa',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}} // handled by parent onClick
                        style={{ cursor: 'pointer', width: 16, height: 16 }}
                      />
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
                        Provider: {attempt.providerId.toUpperCase()}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: attempt.outcome === 'found' ? '#dcfce7' : '#f3f4f6',
                        color: attempt.outcome === 'found' ? '#15803d' : '#6b7280',
                      }}
                    >
                      {attempt.outcome}
                    </span>
                  </div>

                  {parsedData && (
                    <div style={{ marginTop: 8, paddingLeft: 26, fontSize: 12, color: '#4b5563' }}>
                      {parsedData.title && (
                        <div><strong>Title:</strong> {parsedData.title}</div>
                      )}
                      {parsedData.gtin && (
                        <div><strong>Matched GTIN:</strong> {parsedData.gtin}</div>
                      )}
                      {parsedData.brand && (
                        <div><strong>Brand:</strong> {parsedData.brand}</div>
                      )}
                      {parsedData.price && (
                        <div><strong>Wholesale Price:</strong> ${parsedData.price}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Resolution Actions */}
      {errorMsg && (
        <div style={{ padding: 10, borderRadius: 6, background: '#fee2e2', color: '#991b1b', fontSize: 12 }}>
          {errorMsg}
        </div>
      )}

      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
          background: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>
          Operator Resolution Actions
        </h3>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleUseBundle}
            disabled={submitting || selectedAttemptIds.length === 0}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 6,
              background: selectedAttemptIds.length > 0 ? '#2563eb' : '#93c5fd',
              color: '#ffffff',
              border: 'none',
              fontWeight: 700,
              fontSize: 13,
              cursor: selectedAttemptIds.length > 0 && !submitting ? 'pointer' : 'not-allowed',
              boxShadow: '0 2px 4px rgba(37, 99, 235, 0.2)',
            }}
          >
            {submitting ? 'Resolving…' : '✓ Use Selected Bundle & Continue'}
          </button>

          <button
            type="button"
            onClick={handleFallback}
            disabled={submitting}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 6,
              background: '#ffffff',
              color: '#374151',
              border: '1px solid #d1d5db',
              fontWeight: 600,
              fontSize: 13,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Updating…' : '🌐 Fallback to Official Site Discovery'}
          </button>
        </div>
      </div>
    </div>
  );
}
