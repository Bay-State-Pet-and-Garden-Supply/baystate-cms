// story: e06s01 — dedicated full page at /settings/domains/:domain/profile
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
  const returnPath = typeof window !== 'undefined' ? parseReturnPath(window.location.search) : null;

  useEffect(() => {
    let mounted = true;
    fetch(`/api/domains/${encodeURIComponent(domain)}/profile-state`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (mounted && j && typeof j === 'object' && 'domain' in j) {
          setState(j as DomainProfileState);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [domain]);

  const readiness = state
    ? deriveReadinessState({
        hasProfile: state.hasProfile,
        hasIndex: state.productCount > 0,
        hasDraft: !!state.activeVersion,
        confirmedCount: 0,
        testsPass: false,
        isActive: !!state.activeVersion,
        needsRevalidation: !!state.activeVersion,
        productCount: state.productCount,
      })
    : deriveReadinessState({
        hasProfile: false,
        hasIndex: false,
        hasDraft: false,
        confirmedCount: 0,
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
        setGridVisible(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <div className={`ws-grid-toggle ${gridVisible ? 'is-visible' : ''}`} aria-hidden="true" />
      <div className="ws-container" style={{ paddingTop: 'var(--space-3)', paddingBottom: 'var(--space-3)' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          {state ? <ProfileWorkspaceHeader state={state} /> : <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', padding: 'var(--space-2)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)' }}>Loading {domain}…</div>}
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
          <div style={{ marginTop: 'var(--space-1)', fontSize: 11, color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
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
