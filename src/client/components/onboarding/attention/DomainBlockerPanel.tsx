/**
 * Epic #46 follow-up (GPT plan phase 5) — domain-level extractor setup queue.
 *
 * Instead of 14 indistinguishable item failures, the operator sees
 * "build profile for frommfamily.com — unblocks 4 products". Building the
 * profile in the dedicated Profile Workspace (full page at /settings/domains/:domain/profile)
 * makes the domain-release sweep re-queue the blocked items automatically; the
 * panel refreshes and the row disappears.
 * // story: e06s04 — park as setup_required_profile, domain task, distributor bypass
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExtractorProfileDomainBlocker,
  ExtractorProfileBlockersResponse,
} from '../../../../shared/schemas/onboarding-work-state';
import { getExtractorProfileBlockers } from '../../../onboarding-work-api';
import { getProfileWorkspacePath } from '../../profile-workspace/route';
import './attention.css';

interface DomainBlockerPanelProps {
  batchId: string;
}

export function DomainBlockerPanel({ batchId }: DomainBlockerPanelProps): React.ReactElement | null {
  const [blockers, setBlockers] = useState<ExtractorProfileDomainBlocker[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res: ExtractorProfileBlockersResponse = await getExtractorProfileBlockers(batchId);
      if (mounted.current) setBlockers(res.blockers);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not load domain setup queue');
    }
  }, [batchId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  if (error) {
    return (
      <div className="attn-error" role="alert" style={{ margin: '0 0 12px' }}>
        {error}
      </div>
    );
  }

  if (!blockers || blockers.length === 0) return null;

  const navigateToWorkspace = (domain: string) => {
    const path = getProfileWorkspacePath(domain, window.location.pathname + window.location.search);
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <section className="attn-domain-queue" aria-label="Extractor profile setup queue">
      <div className="attn-domain-queue-title">
        <strong>Extractor profiles needed</strong>
        <span className="attn-domain-queue-sub">
          One profile per domain unblocks every product on it — the domain release
          sweep re-queues them automatically once the profile is usable.
        </span>
      </div>
      <ul className="attn-domain-queue-list">
        {blockers.map(blocker => (
          <li className="attn-domain-queue-row" key={blocker.domain}>
            <div className="attn-domain-queue-main">
              <span className="attn-domain-queue-domain">{blocker.domain}</span>
              <span className="attn-domain-queue-count">
                {blocker.blockedItemCount} product{blocker.blockedItemCount === 1 ? '' : 's'} blocked
              </span>
              {blocker.profileExists && (
                <span className="attn-badge attn-badge-warn" title="A profile exists but these items still failed — the profile may be broken or the failures stale">
                  profile on file
                </span>
              )}
              {blocker.sampleItems.length > 0 && (
                <span className="attn-domain-queue-samples">
                  e.g. {blocker.sampleItems.map(s => s.name).join(' · ')}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => navigateToWorkspace(blocker.domain)}
            >
              Build profile
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
