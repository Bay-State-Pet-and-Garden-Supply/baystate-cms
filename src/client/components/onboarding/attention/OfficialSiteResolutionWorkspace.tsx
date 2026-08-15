/**
 * Epic #46 Phase 4 — Official Site resolution workspace.
 *
 * ONE continuous operator workflow combining URL verification and extractor
 * setup (epic UX workstream 3). Rendered by the Batch Workspace shell inside
 * a modal drawer for a single itemId:
 *
 *   identity panel (sticky) → candidate URL decision → extractor status →
 *   domain-level release → done
 *
 * Also handles the other attention reasons: source conflicts (distributor
 * evidence decision) and processing failures (retry). Every mutation shows
 * explicit saving/success/error states; nothing is ever silently swallowed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { DomainReleaseResponse } from '../../../../shared/schemas/onboarding-work-state';
import type { OnboardingEvidenceConflict } from '../../../../shared/schemas/distributor';
import type { OnboardingSource, OnboardingItem } from '../../../../shared/schemas/onboarding';
import {
  continueWithOfficialDiscovery,
  getItemConflicts,
  getItemDetail,
  resolveItemConflict,
  resolveSourcingAction,
  retryItem,
  selectSource,
  setItemUrl,
} from '../../../onboarding-api';
import { getItemWorkState } from '../../../onboarding-work-api';
import { CandidateUrlPanel } from './CandidateUrlPanel';
import { ExtractorStatusPanel } from './ExtractorStatusPanel';
import { domainFromUrl, getAttentionConsequence } from './attention-logic';
import './attention.css';

interface OfficialSiteResolutionWorkspaceProps {
  batchId: string;
  itemId: string;
  /** Called when the blocker is resolved so the shell can close the drawer. */
  onResolved?: () => void;
}

type Phase =
  | 'loading'
  | 'load-error'
  | 'url' // candidate decision / manual URL
  | 'extractor' // extractor status after URL confirmation (or directly)
  | 'conflicts' // distributor evidence conflict decision
  | 'retry' // processing failure
  | 'done'; // blocker resolved — close when ready

function parseValue(valueJson: string): string {
  try {
    const parsed = JSON.parse(valueJson) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      // Distributor evidence values are stored as { value } or { valueJson }.
      const v = record.value ?? record.valueJson ?? record.name ?? record.label;
      if (typeof v === 'string') return v;
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return valueJson;
  }
}

export function OfficialSiteResolutionWorkspace({
  itemId,
  onResolved,
}: OfficialSiteResolutionWorkspaceProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [workState, setWorkState] = useState<OnboardingWorkState | null>(null);
  const [item, setItem] = useState<OnboardingItem | null>(null);
  const [sources, setSources] = useState<OnboardingSource[]>([]);
  const [qualificationView, setQualificationView] = useState<{
    qualified: boolean;
    reasonCodes: string[];
    acceptedEvidenceAttemptIds: string[];
    providerIds: string[];
    evidenceHash: string | null;
  } | null>(null);
  const [evidenceAttemptCount, setEvidenceAttemptCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmedUrl, setConfirmedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'select-source' | 'set-url' | 'retry' | 'conflict' | 'sourcing-route' | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [releaseResult, setReleaseResult] = useState<DomainReleaseResponse | null>(null);

  // Conflict state (source_conflict flow)
  const [conflicts, setConflicts] = useState<OnboardingEvidenceConflict[] | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const containerRef = useRef<HTMLDivElement>(null);

  const loadDetail = useCallback(async () => {
    setLoadError(null);
    try {
      const [detail, ws] = await Promise.all([getItemDetail(itemId), getItemWorkState(itemId)]);
      setItem(detail.item);
      setSources(detail.sources ?? []);
      setWorkState(ws.workState);
      setQualificationView(detail.sourcingQualificationView ?? null);
      setEvidenceAttemptCount(detail.evidenceAttempts?.length ?? 0);
      const reason = ws.workState.attentionReason;
      if (reason === 'source_conflict') {
        setPhase('conflicts');
      } else if (reason === 'processing_failed') {
        setPhase('retry');
      } else if (
        reason === 'extractor_profile_required' ||
        reason === 'extraction_profile_failed'
      ) {
        setPhase('extractor');
      } else {
        setPhase('url');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this product');
      setPhase('load-error');
    }
  }, [itemId]);

  useEffect(() => {
    void loadDetail();
    // Focus the workspace on mount so keyboard operation starts here.
    containerRef.current?.focus();
  }, [loadDetail]);

  // Esc closes the drawer (focus is trapped by the shell's dialog).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolved?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolved]);

  const loadConflicts = useCallback(async () => {
    setConflictError(null);
    try {
      const res = await getItemConflicts(itemId);
      setConflicts(res.conflicts);
      const open = res.conflicts.filter((c) => c.status === 'open');
      if (open.length === 0) {
        // Every conflict resolved — sourcing completes automatically.
        const ws = await getItemWorkState(itemId).catch(() => null);
        if (ws && ws.workState.category !== 'needs_attention') {
          onResolved?.();
          return;
        }
      }
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : 'Could not load conflicts');
    }
  }, [itemId, onResolved]);

  // Load conflicts when entering the conflicts phase.
  useEffect(() => {
    if (phase === 'conflicts') void loadConflicts();
  }, [phase, loadConflicts]);

  // ── URL decision ────────────────────────────────────────────────────────

  const handleConfirmCandidate = async (source: OnboardingSource) => {
    setBusy('select-source');
    setMutationError(null);
    try {
      await selectSource(itemId, source.id);
      setConfirmedUrl(source.url);
      setPhase('extractor');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not confirm this page');
    } finally {
      setBusy(null);
    }
  };

  const handleManualUrl = async (url: string) => {
    setBusy('set-url');
    setMutationError(null);
    try {
      await setItemUrl(itemId, url);
      setConfirmedUrl(url);
      setPhase('extractor');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not save that URL');
      throw err; // surfaced by the manual input
    } finally {
      setBusy(null);
    }
  };

  // ── Conflict resolution ──────────────────────────────────────────────────

  const handleResolveConflict = async (conflictId: string, body: Parameters<typeof resolveItemConflict>[2]) => {
    setBusy('conflict');
    setMutationError(null);
    try {
      await resolveItemConflict(itemId, conflictId, body);
      await loadConflicts();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not resolve that conflict');
    } finally {
      setBusy(null);
    }
  };

  const handleSourcingRoute = async (action: 'use_distributor_record' | 'fallback_to_discovery') => {
    setBusy('sourcing-route');
    setMutationError(null);
    try {
      await resolveSourcingAction(itemId, action);
      onResolved?.();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not apply that decision');
    } finally {
      setBusy(null);
    }
  };

  // ── Retry (processing failure) ───────────────────────────────────────────

  const handleRetry = async () => {
    setBusy('retry');
    setMutationError(null);
    try {
      await retryItem(itemId);
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  const handleContinueOfficial = async () => {
    setBusy('retry');
    setMutationError(null);
    try {
      await continueWithOfficialDiscovery(itemId);
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not switch to official site discovery');
    } finally {
      setBusy(null);
    }
  };

  // ── Derived context ──────────────────────────────────────────────────────

  const domain = workState?.domain ?? domainFromUrl(item?.sourceUrl) ?? domainFromUrl(confirmedUrl);
  const isDistributor = (workState?.sourceType ?? item?.sourceType) === 'distributor_record';
  const reason = workState?.attentionReason ?? null;
  const consequence = getAttentionConsequence(reason, workState?.detail);
  const family = workState?.family ?? null;

  if (phase === 'loading') {
    return (
      <div className="attn-workspace" role="status" aria-label="Loading product">
        <div className="attn-skeleton">
          <div className="attn-skeleton-line" style={{ width: '45%' }} />
          <div className="attn-skeleton-line" style={{ width: '80%' }} />
          <div className="attn-skeleton-line" style={{ width: '60%' }} />
        </div>
      </div>
    );
  }

  if (phase === 'load-error') {
    return (
      <div className="attn-workspace">
        <div className="attn-error" role="alert">
          <div style={{ marginBottom: 12 }}>{loadError ?? 'Could not load this product.'}</div>
          <button type="button" className="btn btn-outline" onClick={() => void loadDetail()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const openConflicts = (conflicts ?? []).filter((c) => c.status === 'open');

  return (
    <div
      className="attn-workspace"
      ref={containerRef}
      tabIndex={-1}
      style={{ outline: 'none', height: '100%' }}
      aria-label="Resolve product"
    >
      {/* ── Sticky identity panel ─────────────────────────────────────── */}
      <div className="attn-identity">
        <div className="attn-identity-name">{workState?.name ?? item?.name ?? ''}</div>
        <div className="attn-identity-meta">
          <span>UPC {workState?.upc ?? item?.upc ?? ''}</span>
          {workState?.brand || item?.brandHint ? <span>{workState?.brand ?? item?.brandHint}</span> : null}
          {item?.expectedName && item.expectedName !== item?.name ? <span>imported as “{item.expectedName}”</span> : null}
          <span
            className="badge"
            style={{
              background: isDistributor ? 'var(--color-warning-bg)' : 'var(--color-feed-bag-cream)',
              color: isDistributor ? 'var(--color-warning-text)' : 'var(--color-ledger-charcoal)',
              border: '1px solid var(--color-card-border)',
            }}
          >
            {isDistributor ? 'Distributor record' : 'Official page'}
          </span>
        </div>
        {family ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            Family: <strong>{family.label}</strong> — {family.readyCount} / {family.memberCount} members ready
            {family.waitingOnItemIds.length > 0 ? ` (waiting on ${family.waitingOnItemIds.length} sibling${family.waitingOnItemIds.length === 1 ? '' : 's'})` : ''}
          </div>
        ) : null}
        {isDistributor && qualificationView ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            Distributor evidence: {qualificationView.acceptedEvidenceAttemptIds.length} accepted record
            {qualificationView.acceptedEvidenceAttemptIds.length === 1 ? '' : 's'}
            {qualificationView.providerIds.length > 0
              ? ` from ${qualificationView.providerIds.join(', ')}`
              : ''}
            {qualificationView.qualified ? ' · qualified' : ' · needs decision'}
          </div>
        ) : isDistributor && evidenceAttemptCount > 0 ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            {evidenceAttemptCount} distributor evidence attempt{evidenceAttemptCount === 1 ? '' : 's'} recorded
          </div>
        ) : null}
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="attn-workspace-body">
        {mutationError ? (
          <div className="attn-error" role="alert">
            {mutationError}
          </div>
        ) : null}

        {phase === 'url' ? (
          <CandidateUrlPanel
            candidates={sources}
            itemName={workState?.name ?? item?.name ?? ''}
            expectedName={item?.expectedName}
            upc={workState?.upc ?? item?.upc ?? ''}
            busy={busy === 'select-source' || busy === 'set-url' ? (busy as 'confirming' | 'saving-url') : null}
            onConfirm={(source) => void handleConfirmCandidate(source)}
            onUseManualUrl={handleManualUrl}
          />
        ) : null}

        {phase === 'extractor' && domain ? (
          <ExtractorStatusPanel
            domain={domain}
            seedItem={
              item
                ? { expectedName: item.expectedName, upc: item.upc, brandHint: item.brandHint }
                : null
            }
            onReleaseResult={(result) => {
              setReleaseResult(result);
              setPhase('done');
            }}
          />
        ) : null}

        {phase === 'conflicts' ? (
          <section className="attn-section" aria-label="Distributor match conflict">
            <h3 className="attn-section-title">Distributor match — decide the correct value</h3>
            <div className="attn-section-body">
              {conflictError ? (
                <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
                  {conflictError}
                </div>
              ) : null}
              {conflicts === null ? (
                <span className="attn-mutating">
                  <span className="attn-spinner" aria-hidden="true" /> Loading conflicts…
                </span>
              ) : openConflicts.length === 0 ? (
                <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem' }}>
                  No open conflicts. Choose how to proceed:
                </p>
              ) : (
                openConflicts.map((conflict) => (
                  <div className="attn-conflict" key={conflict.id}>
                    <div className="attn-conflict-field">{conflict.field}</div>
                    {conflict.candidates.map((candidate) => (
                      <div className="attn-conflict-candidate" key={candidate.id}>
                        <span style={{ overflowWrap: 'anywhere' }}>{parseValue(candidate.valueJson)}</span>
                        <button
                          type="button"
                          className="btn btn-outline"
                          style={{ height: '2rem', padding: '0 0.75rem', flexShrink: 0 }}
                          onClick={() => void handleResolveConflict(conflict.id, { action: 'resolve_candidate', candidateId: candidate.id })}
                          disabled={busy !== null}
                        >
                          Use This Value
                        </button>
                      </div>
                    ))}
                    <div className="attn-candidate-actions">
                      <input
                        className="input"
                        style={{ maxWidth: 260, height: '2rem' }}
                        placeholder="Custom value…"
                        value={customValues[conflict.id] ?? ''}
                        onChange={(e) => setCustomValues((prev) => ({ ...prev, [conflict.id]: e.target.value }))}
                        disabled={busy !== null}
                      />
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ height: '2rem', padding: '0 0.75rem' }}
                        onClick={() => {
                          const value = (customValues[conflict.id] ?? '').trim();
                          if (value) void handleResolveConflict(conflict.id, { action: 'custom_value', customValue: value });
                        }}
                        disabled={busy !== null || (customValues[conflict.id] ?? '').trim().length === 0}
                      >
                        Use Custom Value
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ height: '2rem', padding: '0 0.75rem', borderColor: 'var(--color-card-border)', color: 'var(--color-mulch-brown)' }}
                        onClick={() => void handleResolveConflict(conflict.id, { action: 'dismiss' })}
                        disabled={busy !== null}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSourcingRoute('use_distributor_record')}
                  disabled={busy !== null}
                >
                  Use distributor record
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => void handleSourcingRoute('fallback_to_discovery')}
                  disabled={busy !== null}
                >
                  Continue to official site
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {phase === 'retry' ? (
          <section className="attn-section" aria-label="Processing failure">
            <h3 className="attn-section-title">Processing failure</h3>
            <div className="attn-section-body">
              <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-ledger-charcoal)' }}>
                {workState?.detail ?? 'Automation could not continue for this product.'}
              </p>
              <div className="attn-candidate-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleRetry()}
                  disabled={busy !== null}
                >
                  {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
                {isDistributor ? (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => void handleContinueOfficial()}
                    disabled={busy !== null}
                  >
                    Continue with official site discovery
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {phase === 'done' ? (
          <div className="attn-profile-banner attn-profile-ready" role="status">
            ✓ Resolved. {releaseResult ? `Released ${releaseResult.count} blocked product${releaseResult.count === 1 ? '' : 's'} on ${releaseResult.domain}.` : 'Extraction resumes automatically.'}
          </div>
        ) : null}

        {/* ── Consequence bar ────────────────────────────────────────── */}
        <div className="attn-consequence">
          <span className="attn-consequence-icon" aria-hidden="true">→</span>
          <span>{consequence}</span>
        </div>
      </div>

      {/* ── Footer actions ───────────────────────────────────────────── */}
      <div className="attn-candidate-actions" style={{ paddingTop: 4 }}>
        {phase === 'done' ? (
          <button type="button" className="btn btn-primary" onClick={onResolved}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onResolved}>
              Close
            </button>
            {busy ? (
              <span className="attn-mutating">
                <span className="attn-spinner" aria-hidden="true" /> Saving…
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
