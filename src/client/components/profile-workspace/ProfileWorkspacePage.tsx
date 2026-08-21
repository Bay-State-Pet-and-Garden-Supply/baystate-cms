// story: e08 tracer — merged picker/suite → canonical capture → builder preview
import { useEffect, useState, useCallback } from 'react';
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
import { InventoryPicker } from './InventoryPicker';

type SuiteResp = { suite: string[]; inventory: { candidateCount: number; confirmedCount: number; freshness: string | null }; clusters?: Array<{ prefix: string; count: number; key: string; fingerprint: string; suggestedUrl: string }>; suggested?: string[] };
type CaptureArtifact = { dom: string; screenshotBase64: string; runtime: string; hash: string; capturedAt: string; url: string } | null;

export function ProfileWorkspacePage({ domain: rawDomain }: { domain: string }): React.ReactElement {
  const domain = normalizeBrandHubDomain(rawDomain);
  const [state, setState] = useState<DomainProfileState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suiteResp, setSuiteResp] = useState<SuiteResp | null>(null);
  const [captureArtifact, setCaptureArtifact] = useState<CaptureArtifact>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const returnPath = typeof window !== 'undefined' ? parseReturnPath(window.location.search) : null;

  const fetchState = async (): Promise<void> => {
    setLoadError(null);
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile-state`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && typeof j === 'object' && 'domain' in j) setState(j as DomainProfileState);
      else throw new Error('Invalid profile state');
    } catch (e) { setLoadError(String(e)); }
  };

  const fetchSuite = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`);
      if (!r.ok) return;
      const j = await r.json() as SuiteResp;
      setSuiteResp(j);
    } catch {}
  }, [domain]);

  useEffect(() => { void fetchState(); void fetchSuite(); }, [domain, fetchSuite]);

  const suiteConfirmed = suiteResp?.suite.length ?? 0;
  const evidencePass = !!state?.testsPassEvidence && state.testsPassEvidence.artifactHashes.length >= 3;
  const readiness = state
    ? deriveReadinessState({
        hasProfile: state.hasProfile,
        hasIndex: state.productCount > 0,
        hasDraft: !!state.activeVersion,
        confirmedCount: suiteConfirmed,
        testsPass: evidencePass && suiteConfirmed >= 3 && state.activeVersion === state.testsPassEvidence?.versionId,
        isActive: !!state.activeVersion && evidencePass,
        needsRevalidation: (!state.activeVersion || !evidencePass) && state.productCount > 0,
        productCount: state.productCount,
      })
    : deriveReadinessState({
        hasProfile: false, hasIndex: false, hasDraft: false, confirmedCount: suiteConfirmed, testsPass: false, isActive: false, needsRevalidation: false, productCount: 0,
      });

  const [gridVisible, setGridVisible] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.ctrlKey && e.key.toLowerCase() === 'g') { e.preventDefault(); setGridVisible((v) => !v); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const handlePick = useCallback(async (url: string): Promise<void> => {
    setCaptureStatus(`Adding ${url} to suite…`);
    try {
      const suite = suiteResp?.suite ?? [];
      const nextSuite = suite.includes(url) ? suite : [...suite, url].slice(0, 10);
      const put = await fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: nextSuite, actor: 'operator' }),
      });
      if (!put.ok) { setCaptureStatus(`Suite add failed: ${await put.text()}`); return; }
      await fetchSuite();
    } catch (e) { setCaptureStatus(String(e)); return; }
    setCaptureStatus(`Capturing ${url}…`);
    try {
      const cap = await fetch('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, runtime: 'rendered' }) });
      const j = await cap.json() as { ok: boolean; dom?: string; screenshotBase64?: string; runtime?: string; hash?: string; capturedAt?: string; error?: string };
      if (!cap.ok || !j.ok || !j.dom) { setCaptureStatus(j.error ?? 'Capture failed'); return; }
      const artifact: CaptureArtifact = { dom: j.dom, screenshotBase64: j.screenshotBase64 ?? '', runtime: j.runtime ?? 'rendered', hash: j.hash ?? '', capturedAt: j.capturedAt ?? new Date().toISOString(), url };
      setCaptureArtifact(artifact);
      setCaptureStatus(null);
    } catch (e) { setCaptureStatus(String(e)); }
  }, [domain, suiteResp, fetchSuite]);

  const showMaraBand = !state || (!state.activeVersion && suiteConfirmed < 3);

  return (
    <>
      <div className={`ws-grid-toggle ${gridVisible ? 'is-visible' : ''}`} aria-hidden="true" />
      <div className="ws-container" style={{ paddingTop: 'var(--space-3)', paddingBottom: 'var(--space-3)' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          {loadError ? (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-signet-burgundy)', background: 'var(--color-white-surface)', border: '1px solid var(--color-signet-burgundy)', borderLeft: '3px solid var(--color-signet-burgundy)', borderRadius: 'var(--radius-lg)', padding: '12px 16px' }}>
              <span>Could not load profile state: {loadError}</span>
              <button type="button" onClick={() => void fetchState()} style={{ marginLeft: 'auto', background: 'var(--color-signet-burgundy)', color: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-burgundy-dark)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-body)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>Retry</button>
            </div>
          ) : state ? <ProfileWorkspaceHeader state={state} /> : <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-mulch-brown)', padding: 'var(--space-2)', background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)' }}>Loading {domain}…</div>}
          {showMaraBand && (
            <div style={{ marginTop: 'var(--space-2)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderTop: '3px solid var(--color-corner-gold)', borderRadius: 'var(--radius-lg)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-body)', fontSize: '0.875rem', color: 'var(--color-ledger-charcoal)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700, color: 'var(--color-uniform-green)', whiteSpace: 'nowrap' }}>First time?</span>
              <span>Found URLs → confirm 3 real products → Build → Test → Activate. Candidate = found on site, Confirmed = you marked real.</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', border: '1px dotted var(--color-corner-gold)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>You confirmed: {suiteConfirmed} · Need 3</span>
            </div>
          )}
        </div>
        <div style={{ gridColumn: '1 / span 2' }}>
          <div style={{ position: 'sticky', top: 16 }}><ReadinessRail state={readiness} /></div>
        </div>
        <div style={{ gridColumn: '3 / span 7', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <InventoryPicker domain={domain} onPick={handlePick} suiteResp={suiteResp} onRefreshSuite={fetchSuite} />
          {captureStatus && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-uniform-green)', background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }} role="status">{captureStatus}</div>}
          {captureArtifact && (
            <div style={{ border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--color-white-surface)' }}>
              <div style={{ padding: '8px 12px', fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-mulch-brown)', borderBottom: '1px solid var(--color-card-border)' }}>Preview — {captureArtifact.url}</div>
              <div style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {captureArtifact.screenshotBase64 ? <img src={`data:image/png;base64,${captureArtifact.screenshotBase64}`} alt="capture" style={{ width: 160, height: 120, objectFit: 'cover', border: '1px solid var(--color-card-border)', borderRadius: 4 }} /> : <div style={{ width: 160, height: 120, background: 'var(--color-feed-bag-cream)', border: '1px solid var(--color-card-border)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--color-mulch-brown)' }}>no screenshot</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', wordBreak: 'break-all' }}>{captureArtifact.hash} · {captureArtifact.runtime} · {new Date(captureArtifact.capturedAt).toLocaleString()}</div>
                  <div style={{ marginTop: 8, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-ledger-charcoal)', maxHeight: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>{captureArtifact.dom.slice(0, 400)}…</div>
                </div>
              </div>
            </div>
          )}
          <SuitePanel domain={domain} suiteResp={suiteResp} onRefresh={fetchSuite} />
          <div data-workspace style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)', boxShadow: '0 1px 3px 0 rgba(33,20,20,0.06)' }}>
            <ProfileBuilder mode="inline" initialDomain={domain} initialProductUrl={captureArtifact?.url ?? undefined} initialCapture={captureArtifact} onCancel={() => {}} />
          </div>
          <HistoryShell />
          {returnPath ? (
            <a href={returnPath} onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', returnPath); window.dispatchEvent(new PopStateEvent('popstate')); }} style={{ marginTop: 'var(--space-2)', display: 'inline-block', fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-uniform-green)', textDecoration: 'none', borderBottom: '1px solid var(--color-card-border)' }}>← Back</a>
          ) : (
            <a href="/?view=settings" onClick={(e) => { e.preventDefault(); window.history.pushState(null, '', '/?view=settings'); window.dispatchEvent(new PopStateEvent('popstate')); }} style={{ marginTop: 'var(--space-2)', display: 'inline-block', fontFamily: 'var(--font-body)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-uniform-green)', textDecoration: 'none', borderBottom: '1px solid var(--color-card-border)' }}>← Back to Settings</a>
          )}
          <div style={{ marginTop: 'var(--space-1)', fontSize: 11, color: 'var(--color-mulch-brown)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>Path: {getProfileWorkspacePath(domain, returnPath ?? undefined)}</div>
        </div>
        <div style={{ gridColumn: '10 / span 3' }}>
          <div style={{ position: 'sticky', top: 16 }}><EvidenceRail capture={captureArtifact} /></div>
        </div>
      </div>
    </>
  );
}
export { getProfileWorkspacePath };
