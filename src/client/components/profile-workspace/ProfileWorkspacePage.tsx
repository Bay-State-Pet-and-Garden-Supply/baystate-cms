// story: e06s01 — dedicated full page at /settings/domains/:domain/profile
// story: e06-polish — Sam auditability (no hardcode, retry), Mara top band, grid
import { useEffect, useState } from 'react';
import { normalizeBrandHubDomain } from '../../../onboarding/brand-hub/normalizeDomain';
import { getProfileWorkspacePath, parseReturnPath } from './route';
import { ProfileWorkspaceHeader } from './ProfileWorkspaceHeader';
import { ReadinessRail } from './ReadinessRail';
import { EvidenceRail } from './EvidenceRail';
import { HistoryShell } from './HistoryShell';
import { ProfileBuilder } from '../profile-builder/ProfileBuilder';
import type { DomainProfileState } from '../../../db/repositories/domain-profile-state-repo';
import { deriveReadinessState } from '../../../onboarding/profile-readiness';
import { SuitePanel } from './SuitePanel';

export function ProfileWorkspacePage({ domain: rawDomain }: { domain: string }): React.ReactElement {
  const domain = normalizeBrandHubDomain(rawDomain);
  const [state, setState] = useState<DomainProfileState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suiteConfirmed, setSuiteConfirmed] = useState(0);
  const returnPath = typeof window !== 'undefined' ? parseReturnPath(window.location.search) : null;

  const fetchState = async () => {
    setLoadError(null);
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile-state`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && typeof j === 'object' && 'domain' in j) setState(j as DomainProfileState);
      else throw new Error('Invalid profile state');
    } catch (e) {
      setLoadError(String(e));
    }
  };

  const fetchSuite = async () => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`);
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.suite)) setSuiteConfirmed(j.suite.length);
    } catch {}
  };

  useEffect(() => {
    void fetchState();
    void fetchSuite();
  }, [domain]);

  const readiness = state
    ? deriveReadinessState({
        hasProfile: state.hasProfile,
        hasIndex: state.productCount > 0,
        hasDraft: !!state.activeVersion,
        confirmedCount: suiteConfirmed,
        testsPass: !!state.activeVersion && suiteConfirmed >= 3,
        isActive: !!state.activeVersion,
        needsRevalidation: !state.activeVersion && state.productCount > 0,
        productCount: state.productCount,
      })
    : deriveReadinessState({
        hasProfile: false,
        hasIndex: false,
        hasDraft: false,
        confirmedCount: suiteConfirmed,
        testsPass: false,
        isActive: false,
        needsRevalidation: false,
        productCount: 0,
      });

  const [gridVisible, setGridVisible] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setGridVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const showMaraBand = !state || (!state.activeVersion && suiteConfirmed < 3);

  return (
    <>
      <div className={`ws-grid-toggle ${gridVisible ? 'is-visible' : ''}`} aria-hidden="true" />
      <div className="ws-container" style={{ paddingTop: 'var(--space-3)', paddingBottom: 'var(--space-3)' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          {loadError ? (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-signet-burgundy)', background: 'var(--color-white-surface)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-lg)', padding: '12px 16px' }}>
              <span>Could not load profile state: {loadError}</span>
              <button type="button" onClick={() => void fetchState()} style={{ marginLeft: 'auto', background: 'var(--color-signet-burgundy)', color: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-burgundy-dark)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
                Retry
              </button>
            </div>
          ) : state ? (
            <ProfileWorkspaceHeader state={state} />
          ) : (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', padding: 'var(--space-2)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)' }}>Loading {domain}…</div>
          )}
          {showMaraBand && (
            <div style={{ marginTop: 'var(--space-2)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderTop: '3px solid var(--color-corner-gold)', borderRadius: 'var(--radius-lg)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-ledger-charcoal)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700, color: 'var(--color-uniform-green)', whiteSpace: 'nowrap' }}>First time?</span>
              <span>Found URLs → confirm 3 real products → Build → Test → Activate. Candidate = found on site, Confirmed = you marked real.</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', border: '1px dotted var(--color-corner-gold)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>You confirmed: {suiteConfirmed} · Need 3</span>
            </div>
          )}
        </div>
        <div style={{ gridColumn: '1 / span 2' }}>
          <div style={{ position: 'sticky', top: 16 }}>
            <ReadinessRail state={readiness} />
          </div>
        </div>
        <div style={{ gridColumn: '3 / span 7', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <SuitePanel domain={domain} />
          <div data-workspace style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
            <ProfileBuilder mode="inline" initialDomain={domain} onCancel={() => {}} />
          </div>
          <HistoryShell />
          {returnPath ? (
            <a
              href={returnPath}
              onClick={(e) => {
                e.preventDefault();
                window.history.pushState(null, '', returnPath);
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
              style={{ marginTop: 'var(--space-2)', display: 'inline-block', fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-uniform-green)', textDecoration: 'none', borderBottom: '1px solid var(--color-card-border)' }}
            >
              ← Back
            </a>
          ) : (
            <a
              href="/?view=settings"
              onClick={(e) => {
                e.preventDefault();
                window.history.pushState(null, '', '/?view=settings');
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
              style={{ marginTop: 'var(--space-2)', display: 'inline-block', fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-uniform-green)', textDecoration: 'none', borderBottom: '1px solid var(--color-card-border)' }}
            >
              ← Back to Settings
            </a>
          )}
          <div style={{ marginTop: 'var(--space-1)', fontSize: 11, color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>
            Path: {getProfileWorkspacePath(domain, returnPath ?? undefined)}
          </div>
        </div>
        <div style={{ gridColumn: '10 / span 3' }}>
          <div style={{ position: 'sticky', top: 16 }}>
            <EvidenceRail />
          </div>
        </div>
      </div>
    </>
  );
}

// Re-export for tests that check consolidation
export { getProfileWorkspacePath };
