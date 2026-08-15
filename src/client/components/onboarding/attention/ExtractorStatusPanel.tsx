/**
 * Epic #46 Phase 4 — Extractor status panel.
 *
 * One continuous step after URL confirmation: does this domain have a usable
 * extractor? When not, the operator sets one up right here (Profile Builder
 * renders in place). On a usable profile, blocked products on the same domain
 * are released automatically and the result is reported.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainDiagnosticsEntry } from '../../../../shared/schemas/onboarding';
import type { DomainReleaseResponse } from '../../../../shared/schemas/onboarding-work-state';
import { getDomainDiagnostics } from '../../../onboarding-api';
import { releaseDomainItems } from '../../../onboarding-work-api';
import ProfileBuilderWorkspace from '../../ProfileBuilderWorkspace';
import { deriveProfileReadiness, PROFILE_READINESS_LABELS, type ProfileReadinessState } from './attention-logic';

interface ExtractorStatusPanelProps {
  domain: string;
  seedItem?: {
    expectedName?: string | null;
    upc?: string | null;
    brandHint?: string | null;
  } | null;
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
  seedItem,
  onReleaseResult,
}: ExtractorStatusPanelProps): React.ReactElement {
  const [entries, setEntries] = useState<DomainDiagnosticsEntry[] | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
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

  // Auto-release once when a usable profile is detected (initial load or
  // after the profile builder closes with a saved profile).
  useEffect(() => {
    if (state === 'ready' && !releasedOnce.current && !builderOpen) {
      void doRelease();
    }
  }, [state, builderOpen, doRelease]);

  const handleBuilderClose = () => {
    setBuilderOpen(false);
    void loadDiagnostics();
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
            <button type="button" className="btn btn-primary" onClick={() => setBuilderOpen(true)}>
              Set Up Extraction
            </button>
            <span className="attn-mutating">
              After saving, this product and other blocked products on {domain} resume automatically.
            </span>
          </div>
        ) : (
          <div className="attn-candidate-actions">
            <span className="badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success-text)' }}>
              {PROFILE_READINESS_LABELS.ready}
            </span>
            {release.status === 'releasing' ? (
              <span className="attn-mutating">
                <span className="attn-spinner" aria-hidden="true" /> Releasing blocked products on {domain}…
              </span>
            ) : null}
          </div>
        )}

        {release.status === 'done' && release.result ? (
          <div className="attn-profile-banner attn-profile-ready" role="status">
            Released {release.result.count} blocked product{release.result.count === 1 ? '' : 's'} on{' '}
            {release.result.domain}.{release.result.skippedCount > 0 ? ` ${release.result.skippedCount} left for manual review.` : ''}
          </div>
        ) : null}

        {release.status === 'error' ? (
          <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
            {release.message} — you can release blocked products again from the Needs Attention queue later.
          </div>
        ) : null}
      </div>

      {builderOpen ? (
        <div className="attn-builder-overlay">
          <ProfileBuilderWorkspace
            domain={domain}
            onClose={handleBuilderClose}
            seedItem={seedItem ?? null}
            diagnostics={readiness?.entry ?? null}
          />
        </div>
      ) : null}
    </section>
  );
}
