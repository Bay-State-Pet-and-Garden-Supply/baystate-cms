/**
 * Epic #46 Phase 4 — Extractor status panel.
 *
 * One continuous step after URL confirmation: does this domain have a usable
 * extractor? When not, the operator goes to the dedicated Profile Workspace
 * (full page at /settings/domains/:domain/profile). On a usable profile,
 * blocked products on the same domain are released automatically.
 * // story: e06s04 — park as setup_required_profile, distributor bypass
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainDiagnosticsEntry } from '../../../../shared/schemas/onboarding';
import type { DomainReleaseResponse, AttentionReason } from '../../../../shared/schemas/onboarding-work-state';
import { getDomainDiagnostics } from '../../../onboarding-api';
import { releaseDomainItems } from '../../../onboarding-work-api';
import { getProfileWorkspacePath } from '../../profile-workspace/route';
import { deriveProfileReadiness, PROFILE_READINESS_LABELS, type ProfileReadinessState } from './attention-logic';

interface ExtractorStatusPanelProps {
  domain: string;
  /** When 'extraction_profile_failed', the operator chooses: retry first,
   *  then (re)set-up if the profile itself looks broken. Auto-release is
   *  suppressed so the decision is never preempted by a fresh scrape. */
  attentionReason?: AttentionReason | null;
  seedItem?: {
    expectedName?: string | null;
    upc?: string | null;
    brandHint?: string | null;
  } | null;
  /** Retry the current product's extraction against the existing profile. */
  onRetry?: () => void;
  /** Surfaced to the workspace so the consequence bar can report the release. */
  onReleaseResult?: (result: DomainReleaseResponse) => void;
}

interface ReleaseState {
  status: 'idle' | 'releasing' | 'done' | 'error';
  result: DomainReleaseResponse | null;
  message: string | null;
}

export function ExtractorStatusPanel({
  domain,
  attentionReason,
  seedItem: _seedItem,
  onRetry,
  onReleaseResult,
}: ExtractorStatusPanelProps): React.ReactElement {
  const [entries, setEntries] = useState<DomainDiagnosticsEntry[] | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseState>({ status: 'idle', result: null, message: null });

  const releasedOnce = useRef(false);
  const mounted = useRef(true);

  const loadDiagnostics = useCallback(async () => {
    setDiagError(null);
    try {
      const res = await getDomainDiagnostics();
      if (mounted.current) setEntries(res.entries);
    } catch (err) {
      if (mounted.current) setDiagError(err instanceof Error ? err.message : 'Could not check extractor status');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadDiagnostics();
    return () => {
      mounted.current = false;
    };
  }, [loadDiagnostics]);

  const doRelease = useCallback(async () => {
    if (releasedOnce.current) return;
    releasedOnce.current = true;
    setRelease({ status: 'releasing', result: null, message: null });
    try {
      const result = await releaseDomainItems(domain);
      if (!mounted.current) return;
      setRelease({ status: 'done', result, message: null });
      onReleaseResult?.(result);
    } catch (err) {
      if (!mounted.current) return;
      setRelease({
        status: 'error',
        result: null,
        message: err instanceof Error ? err.message : 'Could not release blocked products on this domain',
      });
    }
  }, [domain, onReleaseResult]);

  const readiness = entries ? deriveProfileReadiness(domain, entries) : null;
  const state: ProfileReadinessState = readiness?.state ?? 'unknown';

  // Auto-release once when a usable profile is detected. Suppressed for
  // `extraction_profile_failed` so the operator can decide retry-vs-setup.
  const retryFirst = attentionReason === 'extraction_profile_failed';
  useEffect(() => {
    if (retryFirst) return;
    if (state === 'ready' && !releasedOnce.current) {
      void doRelease();
    }
  }, [state, doRelease, retryFirst]);

  const navigateToWorkspace = () => {
    const path = getProfileWorkspacePath(domain, window.location.pathname + window.location.search);
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const bannerClass =
    state === 'ready'
      ? 'attn-profile-ready'
      : state === 'failed'
        ? 'attn-profile-failed'
        : 'attn-profile-missing';

  const bannerText =
    state === 'ready'
      ? `We have a working extractor for ${domain}.`
      : state === 'failed'
        ? `Extractor generation failed for ${domain}. Set it up again to continue.`
        : `We do not have a working extractor for ${domain} yet.`;

  return (
    <section className="attn-section" aria-label="Extractor status">
      <h3 className="attn-section-title">Extractor status</h3>
      <div className="attn-section-body">
        <div className={`attn-profile-banner ${bannerClass}`} role="status">
          {bannerText}
        </div>

        {readiness?.entry ? (
          <div className="attn-identity-meta" style={{ fontFamily: 'var(--font-mono)' }}>
            <span>{readiness.entry.hasActiveProfile ? 'active profile' : 'no active profile'}</span>
            {readiness.entry.healthStatus ? <span>health: {readiness.entry.healthStatus}</span> : null}
            {readiness.entry.generationCount > 0 ? (
              <span>{readiness.entry.generationCount} generation attempts</span>
            ) : null}
          </div>
        ) : null}

        {diagError ? (
          <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
            {diagError}
          </div>
        ) : null}

        {state !== 'ready' ? (
          <div className="attn-candidate-actions">
            {retryFirst ? (
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Retry extraction
              </button>
            ) : null}
            <button type="button" className="btn btn-outline" onClick={navigateToWorkspace}>
              Set Up Extraction
            </button>
            <span className="attn-mutating">
              {retryFirst
                ? 'Retry first — if the profile itself is broken, setting it up again releases this domain together.'
                : 'Opens the dedicated profile workspace — after saving, this product and other blocked products on this domain resume automatically.'}
            </span>
          </div>
        ) : (
          <div className="attn-candidate-actions">
            {retryFirst ? (
              <button type="button" className="btn btn-primary" onClick={onRetry}>
                Retry extraction
              </button>
            ) : null}
            <span className="badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success-text)' }}>
              {PROFILE_READINESS_LABELS.ready}
            </span>
            {retryFirst ? (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void doRelease()}
                disabled={release.status === 'releasing'}
              >
                {release.status === 'releasing' ? 'Releasing…' : 'Release blocked products on this domain'}
              </button>
            ) : null}
            {release.status === 'releasing' ? (
              <span className="attn-mutating">
                <span className="attn-spinner" aria-hidden="true" /> Releasing blocked products on {domain}…
              </span>
            ) : null}
          </div>
        )}

        {release.status === 'done' && release.result ? (
          <div className="attn-profile-banner attn-profile-ready" role="status">
            {release.result.count === 0
              ? `No blocked products on ${release.result.domain} needed a release (they may already be running, or none were blocked).`
              : `Released ${release.result.count} blocked product${release.result.count === 1 ? '' : 's'} on ${release.result.domain}.${release.result.skippedCount > 0 ? ` ${release.result.skippedCount} left for manual review.` : ''}`}
          </div>
        ) : null}

        {release.status === 'error' ? (
          <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
            {release.message} — you can release blocked products again from the Needs Attention queue later.
          </div>
        ) : null}
      </div>
    </section>
  );
}
