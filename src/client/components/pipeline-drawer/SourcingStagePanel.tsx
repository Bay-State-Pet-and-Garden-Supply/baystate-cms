import React, { useState } from 'react';
import type { OnboardingItem } from '../../../shared/schemas/onboarding';
import type { DistributorEvidenceAttemptView } from '../../../shared/schemas/onboarding';
import type { OnboardingEvidenceConflict, ResolveConflictRequest } from '../../../shared/schemas/distributor';
import type { SourcingQualificationView } from '../../onboarding-api';

interface SourcingGenerationView {
  id: string;
  status: string;
  supersedesId: string | null;
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
}

type SourcingMode = 'observe' | 'manual' | 'automatic' | null;

interface SourcingStagePanelProps {
  reviewItem: OnboardingItem;
  /** Sourcing engine capability. While disabled, only Continue-to-Discovery is available. */
  sourcingEngineEnabled: boolean;
  /** Amendment A: effective sourcing mode from /onboarding/capabilities (null when OFF/invalid). */
  sourcingMode?: SourcingMode;
  /** Amendment A: stable non-secret configuration reason (shown in banners). */
  configurationReason?: string | null;
  /** Amendment A: durable entry-policy version; 0 = legacy pre-amendment row. */
  sourcingEntryPolicyVersion?: number | null;
  /** Amendment A: server-derived distributor-record qualification (manual mode). */
  sourcingQualificationView?: SourcingQualificationView | null;
  /** Projected distributor evidence attempts (server-side parsed identity). */
  evidenceAttempts?: DistributorEvidenceAttemptView[];
  /** Durable conflicts with candidates (ADR 0014). Empty when none / engine disabled. */
  conflicts?: OnboardingEvidenceConflict[];
  /** Sourcing generations for this item (audit + superseded-history disclosure). */
  generations?: SourcingGenerationView[];
  /** Move this item to Discovery with an audited fallback_to_discovery decision. */
  onContinueToDiscovery: () => Promise<void>;
  /** Manual mode: adopt the qualified distributor record (server recomputes). */
  onUseDistributorRecord?: () => Promise<void>;
  /** Resolve a durable conflict (enabled mode only). */
  onResolveConflict?: (conflictId: string, body: ResolveConflictRequest) => Promise<void>;
  /** Re-run Sourcing: supersedes the current evidence generation (enabled mode only). */
  onRetry?: () => Promise<void>;
}

/** Human-readable labels for the server-derived qualification reason codes. */
const QUALIFICATION_REASON_LABELS: Record<string, string> = {
  no_accepted_evidence: 'No accepted distributor evidence.',
  incomplete_provenance: 'Distributor evidence is incomplete (missing provenance).',
  identifier_mismatch: 'Distributor identifier does not match this item.',
  stale_generation: 'Evidence generation is stale — re-run sourcing.',
  empty_identity: 'Distributor record carries no usable identity.',
  unknown_variant_axis: 'Distributor record has an unrecognized variant attribute.',
  open_hard_conflict: 'Distributor feeds disagree on identity-critical fields.',
  missing_name: 'Distributor record has no usable product name.',
  cross_item_attempt: 'Evidence belongs to a different item.',
};

function parseCandidateValue(valueJson: string): string {
  try {
    const parsed = JSON.parse(valueJson);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return valueJson;
  }
}

export function SourcingStagePanel({
  reviewItem,
  sourcingEngineEnabled,
  sourcingMode = null,
  configurationReason = null,
  sourcingEntryPolicyVersion,
  sourcingQualificationView = null,
  evidenceAttempts = [],
  conflicts = [],
  generations = [],
  onContinueToDiscovery,
  onUseDistributorRecord,
  onResolveConflict,
  onRetry,
}: SourcingStagePanelProps) {
  const [submitting, setSubmitting] = useState(false);
  const [usingDistributor, setUsingDistributor] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState(false);

  // Amendment A mode derivation (fail closed): a missing/invalid mode is
  // NEVER treated as automatic. Only a server-reported valid mode routes;
  // engine-enabled WITHOUT a valid mode degrades to the legacy/disabled UI
  // (Continue only). The server remains the authoritative gate.
  const effectiveMode: SourcingMode | null =
    sourcingMode === 'observe' || sourcingMode === 'manual' || sourcingMode === 'automatic'
      ? sourcingMode
      : null;
  const manualMode = effectiveMode === 'manual';
  const automaticMode = effectiveMode === 'automatic';
  const observeMode = effectiveMode === 'observe';
  // Legacy pre-amendment rows (entry-policy version 0) predate the engine:
  // they get Continue-to-Discovery ONLY, even when the engine is globally ON.
  const isLegacyItem = sourcingEntryPolicyVersion === 0;
  // Engine ACTIVE = enabled AND a routing mode (manual/automatic). OFF,
  // invalid, and observe never produce automatic decisions or claims.
  const engineActive = sourcingEngineEnabled && (manualMode || automaticMode);
  const engineInactive = !sourcingEngineEnabled || observeMode || effectiveMode === null;

  const sourcingDecision = reviewItem.sourcingDecision;
  const legacyConflicts = sourcingDecision?.conflicts || [];
  // CAPABILITY ISOLATION (ADR 0014): every durable-conflict computation and
  // advancement restriction is gated on the ACTIVE engine mode. While the
  // engine is OFF or observing, the drawer ignores durable conflicts,
  // never renders resolution UI, and Continue stays available regardless of
  // stageStatus/conflict presence.
  const durableConflictsPresent = engineActive && !isLegacyItem && conflicts.length > 0;
  const hasLegacyConflicts = legacyConflicts.length > 0 || reviewItem.errorMessage?.includes('conflict');
  const openHardConflicts = engineActive && durableConflictsPresent
    ? conflicts.some((c) => c.severity === 'hard' && c.status === 'open')
    : false;
  // Manual mode leaves every non-conflict outcome at needs_input for the
  // operator to choose; Continue stays available. Automatic mode blocks
  // Continue while needs_input awaits resolution.
  const continueDisabled = submitting
    || (engineActive && !isLegacyItem && openHardConflicts)
    || (automaticMode && engineActive && !isLegacyItem && reviewItem.stageStatus === 'needs_input');

  const handleContinue = async () => {
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await onContinueToDiscovery();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseDistributorRecord = async () => {
    if (!onUseDistributorRecord) return;
    setUsingDistributor(true);
    setErrorMsg(null);
    try {
      await onUseDistributorRecord();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUsingDistributor(false);
    }
  };

  const handleResolve = async (conflictId: string, body: ResolveConflictRequest) => {
    if (!onResolveConflict) return;
    setResolvingConflictId(conflictId);
    setErrorMsg(null);
    try {
      await onResolveConflict(conflictId, body);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingConflictId(null);
    }
  };

  const handleCustomResolve = async (conflictId: string) => {
    const value = (customValues[conflictId] ?? '').trim();
    if (!value) return;
    await handleResolve(conflictId, { action: 'custom_value', customValue: value });
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    setErrorMsg(null);
    try {
      await onRetry();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  const providerForAttempt = (attemptId: string): string => {
    const attempt = evidenceAttempts.find((a) => a.id === attemptId);
    return attempt ? attempt.providerId : 'provider';
  };

  const currentGeneration = generations.find((g) => g.status !== 'superseded') ?? generations[generations.length - 1] ?? null;
  const supersededGenerations = generations.filter((g) => g.status === 'superseded');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Overview Banner */}
      <div
        style={{
          padding: 16,
          borderRadius: 8,
          background: hasLegacyConflicts || openHardConflicts ? '#fff1f2' : '#f0fdf4',
          border: `1px solid ${hasLegacyConflicts || openHardConflicts ? '#fecdd3' : '#bbf7d0'}`,
          color: hasLegacyConflicts || openHardConflicts ? '#9f1239' : '#166534',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{hasLegacyConflicts || openHardConflicts ? '⚠️ Sourcing Identity Conflict Detected' : '✓ Distributor Sourcing Status'}</span>
        </div>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.9, lineHeight: 1.4 }}>
          {reviewItem.errorMessage ||
            (hasLegacyConflicts || openHardConflicts
              ? 'Multiple distributor data feeds provided conflicting product records. Resolve the conflicts below, or continue to Discovery to resolve via official brand site discovery.'
              : manualMode
                ? 'Manual mode is active — review the distributor record below and choose whether to use it or continue to official-site Discovery.'
                : observeMode
                  ? 'Observation mode is active — distributor lookups run during Discovery but never route items automatically. Items continue to official-site Discovery.'
                  : automaticMode
                    ? 'Distributor evidence attempts are shown below. Coherent evidence advances the item to extraction directly from the distributor record; hard identity conflicts require operator resolution.'
                    : 'Distributor evidence attempts are shown below for reference. The sourcing engine is not available in this installation, so items continue to official-site Discovery.')}
        </p>
      </div>

      {/* Generation Disclosure (active routing modes only) */}
      {engineActive && !isLegacyItem && currentGeneration && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#ffffff',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#111827' }}>
            Evidence Generation
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ fontFamily: 'monospace', color: '#374151' }}>{currentGeneration.id}</span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                background: currentGeneration.status === 'running' ? '#eff6ff' : '#f3f4f6',
                color: currentGeneration.status === 'running' ? '#1e40af' : '#6b7280',
              }}
            >
              {currentGeneration.status}
            </span>
            <span style={{ color: '#6b7280' }}>
              started {new Date(currentGeneration.startedAt).toLocaleString()}
            </span>
          </div>
          {supersededGenerations.length > 0 && (
            <details style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Superseded history ({supersededGenerations.length})
              </summary>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {supersededGenerations.map((g) => (
                  <div key={g.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace' }}>{g.id}</span>
                    <span style={{ fontStyle: 'italic' }}>{g.status}</span>
                    {g.reason && <span>({g.reason})</span>}
                    <span>{new Date(g.startedAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Legacy Conflict Details (disabled mode / no durable conflicts) */}
      {!durableConflictsPresent && legacyConflicts.length > 0 && (
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
            {legacyConflicts.map((c, idx) => (
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

      {/* Durable Conflict Resolution (active routing modes) */}
      {durableConflictsPresent && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#ffffff',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#111827' }}>
            Identity Conflicts — Resolve to Continue
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {conflicts.map((c) => {
              const isOpen = c.status === 'open';
              const resolving = resolvingConflictId === c.id;
              return (
                <div
                  key={c.id}
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
                      {c.severity} · {c.status}
                    </span>
                  </div>

                  {isOpen ? (
                    <>
                      {c.candidates.map((cand) => (
                        <div
                          key={cand.id}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0' }}
                        >
                          <span style={{ color: '#4b5563', fontFamily: 'monospace', fontSize: 11 }}>
                            <span style={{ fontWeight: 600 }}>{providerForAttempt(cand.evidenceAttemptId)}:</span>{' '}
                            {parseCandidateValue(cand.valueJson)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleResolve(c.id, { action: 'resolve_candidate', candidateId: cand.id })}
                            disabled={resolving}
                            style={{
                              padding: '4px 10px',
                              borderRadius: 6,
                              border: 'none',
                              background: '#2563eb',
                              color: '#ffffff',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: resolving ? 'not-allowed' : 'pointer',
                            }}
                          >
                            Use candidate
                          </button>
                        </div>
                      ))}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', marginTop: 4 }}>
                        <input
                          type="text"
                          placeholder="Custom value"
                          value={customValues[c.id] ?? ''}
                          onChange={(e) => setCustomValues((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          style={{
                            padding: '4px 8px',
                            border: '1px solid #ced4da',
                            borderRadius: 6,
                            fontSize: 12,
                            fontFamily: 'inherit',
                            flex: 1,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => handleCustomResolve(c.id)}
                          disabled={resolving}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #ced4da',
                            background: '#ffffff',
                            color: '#374151',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: resolving ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Custom value
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolve(c.id, { action: 'dismiss' })}
                          disabled={resolving}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #dc3545',
                            background: '#ffffff',
                            color: '#dc3545',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: resolving ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: '#4b5563', fontSize: 11 }}>
                      Resolved via {c.resolutionType ?? 'resolution'}:
                      <span style={{ fontFamily: 'monospace', marginLeft: 6 }}>
                        {c.resolvedValue ?? '(no value)'}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Manual-mode qualification view (Amendment A) */}
      {manualMode && !isLegacyItem && reviewItem.stageStatus === 'needs_input' && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#ffffff',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#111827' }}>
            Distributor Record Qualification
          </h3>
          {sourcingQualificationView ? (
            sourcingQualificationView.qualified ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 6,
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  color: '#166534',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                ✓ A <strong>qualified distributor record</strong> is available for this item —
                it can be used instead of official-site Discovery.
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
                  Providers: {sourcingQualificationView.providerIds.join(', ') || '(none)'} ·
                  Accepted attempts: {sourcingQualificationView.acceptedEvidenceAttemptIds.length}
                  {sourcingQualificationView.evidenceHash
                    ? ` · Evidence ${sourcingQualificationView.evidenceHash.slice(0, 8)}…`
                    : ''}
                </div>
              </div>
            ) : (
              <div
                style={{
                  padding: 12,
                  borderRadius: 6,
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                The distributor record is <strong>not qualified</strong> for direct use.
                {sourcingQualificationView.reasonCodes.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                    {sourcingQualificationView.reasonCodes.map((code) => (
                      <li key={code}>{QUALIFICATION_REASON_LABELS[code] ?? code}</li>
                    ))}
                  </ul>
                )}
                <div style={{ marginTop: 8 }}>
                  Continue to official-site Discovery to resolve the item via the brand site.
                </div>
              </div>
            )
          ) : (
            <div style={{ fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
              Qualification details are unavailable — review the attempts below and choose an action.
            </div>
          )}
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
          {!sourcingEngineEnabled && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                background: '#f3f4f6',
                color: '#6b7280',
              }}
            >
              read-only
            </span>
          )}
          {observeMode && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                background: '#eff6ff',
                color: '#1e40af',
              }}
            >
              observing
            </span>
          )}
        </div>

        {evidenceAttempts.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
            No distributor lookup attempts recorded for this item.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {evidenceAttempts.map((attempt) => {
              const identity = attempt.identity;
              const sourceError = attempt.outcome === 'source_error';
              return (
                <div
                  key={attempt.id}
                  style={{
                    padding: 12,
                    borderRadius: 6,
                    border: '1.5px solid #e5e7eb',
                    background: '#fafafa',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
                        Provider: {attempt.providerId.toUpperCase()}
                      </span>
                      {engineActive && attempt.isAccepted && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            padding: '2px 8px',
                            borderRadius: 10,
                            background: '#d1e7dd',
                            color: '#0f5132',
                          }}
                        >
                          accepted
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: attempt.outcome === 'found' ? '#dcfce7' : sourceError ? '#fee2e2' : '#f3f4f6',
                        color: attempt.outcome === 'found' ? '#15803d' : sourceError ? '#b91c1c' : '#6b7280',
                      }}
                    >
                      {attempt.outcome}
                    </span>
                  </div>

                  <div style={{ marginTop: 8, paddingLeft: 26, fontSize: 12, color: '#4b5563' }}>
                    {attempt.productName && (
                      <div><strong>Title:</strong> {attempt.productName}</div>
                    )}
                    {attempt.lookupUpc && (
                      <div><strong>Matched ID:</strong> {attempt.lookupUpc}</div>
                    )}
                    {attempt.brand && (
                      <div><strong>Brand:</strong> {attempt.brand}</div>
                    )}
                    {attempt.description && (
                      <div><strong>Description:</strong> {attempt.description}</div>
                    )}
                    {sourcingEngineEnabled && attempt.catalogVersion && (
                      <div><strong>Catalog version:</strong> {attempt.catalogVersion}</div>
                    )}
                    {sourcingEngineEnabled && attempt.observedAt && (
                      <div><strong>Observed:</strong> {new Date(attempt.observedAt).toLocaleString()}</div>
                    )}
                    {sourcingEngineEnabled && attempt.expiresAt && (
                      <div><strong>Expires:</strong> {new Date(attempt.expiresAt).toLocaleString()}</div>
                    )}
                    {sourceError && (
                      <div style={{ color: '#b91c1c' }}>
                        <strong>Error:</strong> {attempt.errorCode ? `[${attempt.errorCode}] ` : ''}{attempt.errorMessage}
                      </div>
                    )}
                    {sourcingEngineEnabled && attempt.warnings && attempt.warnings.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <strong>Warnings:</strong>
                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                          {attempt.warnings.map((w, idx) => (
                            <li key={idx}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {identity === null && attempt.outcome === 'found' && (
                      <div style={{ fontStyle: 'italic', color: '#6b7280' }}>identity unavailable</div>
                    )}
                    {sourcingEngineEnabled && attempt.imageUrls && attempt.imageUrls.length > 0 && (
                      <div style={{ marginTop: 4, color: '#92400e' }}>
                        <strong>Images (display only — not approved for catalog use):</strong>
                        <ul style={{ margin: '4px 0 0', paddingLeft: 18, wordBreak: 'break-all' }}>
                          {attempt.imageUrls.map((url, idx) => (
                            <li key={idx} style={{ fontFamily: 'monospace', fontSize: 11 }}>{url}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Engine availability note */}
      {engineInactive && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fffbeb',
            border: '1px solid #fde68a',
            color: '#92400e',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {observeMode
            ? '🔭 Observation mode is active — distributor lookups run during Discovery but never route items. Items continue to Discovery where the official brand product page is found and verified.'
            : '⚙️ The distributor sourcing engine is not enabled in this installation.'
              + (configurationReason ? ` (${configurationReason})` : '')
              + ' Items continue to Discovery where the official brand product page is found and verified. Distributor-bundle selection and re-runs are unavailable.'}
        </div>
      )}

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
          Resolution Action
        </h3>

        {continueDisabled && engineActive && (
          <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', padding: '8px 12px', borderRadius: 6 }}>
            Resolve all hard conflicts or retry before continuing.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {manualMode && !isLegacyItem && reviewItem.stageStatus === 'needs_input' && sourcingQualificationView?.qualified && onUseDistributorRecord && (
            <button
              type="button"
              onClick={handleUseDistributorRecord}
              disabled={usingDistributor}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 6,
                background: '#15803d',
                color: '#ffffff',
                border: 'none',
                fontWeight: 700,
                fontSize: 13,
                cursor: usingDistributor ? 'not-allowed' : 'pointer',
                boxShadow: '0 2px 4px rgba(21, 128, 61, 0.2)',
                minWidth: 200,
              }}
            >
              {usingDistributor ? 'Adopting…' : '✓ Use distributor record'}
            </button>
          )}

          <button
            type="button"
            onClick={handleContinue}
            disabled={continueDisabled}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 6,
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              fontWeight: 700,
              fontSize: 13,
              cursor: continueDisabled ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 4px rgba(37, 99, 235, 0.2)',
            }}
          >
            {submitting ? 'Moving…' : '→ Continue to Official Site Discovery'}
          </button>

          {engineActive && !isLegacyItem && onRetry && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              style={{
                padding: '12px 16px',
                borderRadius: 6,
                background: '#6c757d',
                color: '#ffffff',
                border: 'none',
                fontWeight: 700,
                fontSize: 13,
                cursor: retrying ? 'not-allowed' : 'pointer',
              }}
            >
              {retrying ? 'Re-running…' : '↻ Re-run Sourcing'}
            </button>
          )}
          {engineActive && !isLegacyItem && onRetry && (
            <div style={{ fontSize: 12, color: '#6b7280', width: '100%' }}>
              Re-running starts a NEW evidence generation; the current one is
              superseded and stays visible as history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
