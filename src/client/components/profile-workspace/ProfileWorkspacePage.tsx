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

export function ProfileWorkspacePage({ domain: rawDomain }: { domain: string }): React.ReactElement {
  const domain = normalizeBrandHubDomain(rawDomain);
  const [state, setState] = useState<DomainProfileState | null>(null);
  const returnPath = typeof window !== 'undefined' ? parseReturnPath(window.location.search) : null;

  useEffect(() => {
    let mounted = true;
    fetch(`/api/domains/${encodeURIComponent(domain)}/profile-state`)
      .then((r) => r.json())
      .then((j) => {
        if (mounted) setState(j as DomainProfileState);
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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 260px', gap: 16, padding: 16 }}>
      <ReadinessRail state={readiness} />
      <div>
        {state ? <ProfileWorkspaceHeader state={state} /> : <div>Loading {domain}…</div>}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
          <ProfileBuilder mode="inline" initialDomain={domain} onCancel={() => {}} />
        </div>
        <HistoryShell />
        {returnPath && (
          <a href={returnPath} style={{ marginTop: 12, display: 'inline-block' }}>
            Back
          </a>
        )}
        <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
          Path: {getProfileWorkspacePath(domain, returnPath ?? undefined)}
        </div>
      </div>
      <EvidenceRail />
    </div>
  );
}

// Re-export for tests that check consolidation
export { getProfileWorkspacePath };
