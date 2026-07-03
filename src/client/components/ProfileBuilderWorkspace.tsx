/**
 * ProfileBuilderWorkspace.tsx — full-page overlay/modal for
 * domain-first profile building.
 *
 * Provides a tabbed workspace (Overview, Snapshot, Review)
 * for one domain at a time. Uses the extraction
 * worker for snapshotting and in-browser validation, and the
 * governance service for profile generation and field approval.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  getDomainProfileGovernance,
  getExtractionWorkerHealth,
  snapshotPageForBuilder,
  generateProfileForDomain,
  fetchPageHtml,
  generateSelectorFromElement,
  testExtractorProfile,
  type GenerateProfileResult,
} from '../onboarding-api';
import type {
  DomainProfileGovernance,
  DomainHealthStatus,
  DomainDiagnosticsEntry,
} from '../../shared/schemas/onboarding';
import type {
  WorkerHealthResponse,
  SnapshotRequest,
  SnapshotResponse,
} from '../../shared/schemas/extraction-worker';
import { ProfileGenerationReview } from './ProfileGenerationReview';
import { ElementPickerButton } from './ElementPickerButton';
import { ImagePreviewGrid } from './ImagePreviewGrid';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProfileBuilderWorkspaceProps {
  domain: string;
  onClose: () => void;
  seedSampleUrl?: string | null;
  seedItem?: {
    expectedName?: string | null;
    upc?: string | null;
    brandHint?: string | null;
  } | null;
  diagnostics?: DomainDiagnosticsEntry | null;
}

type TabId = 'build' | 'review' | 'advanced';

type RuntimeMode = 'static' | 'rendered';

// ─── Health badge style (matches OnboardingSettings pattern) ────────────────

const DOMAIN_HEALTH_BADGE_COLORS: Record<
  DomainHealthStatus,
  { bg: string; fg: string; border: string }
> = {
  ok: { bg: '#dcfce7', fg: '#166534', border: '#16a34a' },
  blocked: { bg: '#fee2e2', fg: '#991b1b', border: '#dc2626' },
  offline: { bg: '#e5e7eb', fg: '#374151', border: '#6b7280' },
  mismatch: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
  unknown: { bg: '#f3f4f6', fg: '#6b7280', border: '#d1d5db' },
};

function domainHealthBadgeStyle(
  status: DomainHealthStatus,
): React.CSSProperties {
  const palette = DOMAIN_HEALTH_BADGE_COLORS[status] ??
    DOMAIN_HEALTH_BADGE_COLORS.unknown;
  return {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 10px',
    borderRadius: 999,
    textTransform: 'uppercase',
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
    letterSpacing: 0.4,
  };
}

// ─── Selector field labels ─────────────────────────────────────────────────

const SELECTOR_FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};

// ─── Shared styles ─────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 998,
  },
  modal: {
    position: 'fixed',
    top: 24,
    left: 24,
    right: 24,
    bottom: 24,
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
    zIndex: 999,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid #e5e7eb',
    flexShrink: 0,
  },
  headerTitle: { fontSize: 20, fontWeight: 600, margin: 0 },
  closeBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  tabs: {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid #e5e7eb',
    flexShrink: 0,
    padding: '0 24px',
    background: '#f9fafb',
  },
  tab: {
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: '#6b7280',
    borderBottom: '2px solid transparent',
    marginBottom: -1,
  },
  tabActive: {
    color: '#2563eb',
    borderBottomColor: '#2563eb',
    fontWeight: 600,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: '0 0 12px',
    color: '#111827',
  },
  subsectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: '0 0 8px',
    color: '#374151',
  },
  label: { fontSize: 13, fontWeight: 500, color: '#4b5563', display: 'block', marginBottom: 4 },
  input: {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 14,
    boxSizing: 'border-box',
  },
  primaryBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
  },
  dangerBtn: {
    background: 'none',
    border: '1px solid #dc2626',
    color: '#dc2626',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    borderBottom: '2px solid #e5e7eb',
    textAlign: 'left',
    padding: '6px 8px',
    color: '#4b5563',
    fontWeight: 600,
  },
  td: {
    borderBottom: '1px solid #e5e7eb',
    padding: '6px 8px',
    verticalAlign: 'top',
  },
  code: { fontSize: 12, background: '#f3f4f6', padding: '1px 4px', borderRadius: 3 },
  badge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase',
  },
  errorBox: {
    color: '#dc2626',
    fontSize: 13,
    padding: 8,
    background: '#fef2f2',
    borderRadius: 4,
    marginTop: 8,
  },
  successBox: {
    color: '#16a34a',
    fontSize: 13,
    padding: 8,
    background: '#f0fdf4',
    borderRadius: 4,
    marginTop: 8,
    border: '1px solid #16a34a',
  },
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: 16,
  },
  hint: { fontSize: 12, color: '#6b7280', margin: '0 0 8px' },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 13,
    color: '#4b5563',
  },
  pill: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    background: '#e0e7ff',
    color: '#4338ca',
    marginRight: 4,
    marginBottom: 4,
  },
  divider: { border: 'none', borderTop: '1px solid #e5e7eb', margin: '16px 0' },
  empty: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic' },
};

// ─── Component ─────────────────────────────────────────────────────────────

export function ProfileBuilderWorkspace(
  props: ProfileBuilderWorkspaceProps,
): React.ReactElement {
  const { domain, onClose, seedSampleUrl, diagnostics } = props;

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('build');

  // ── Governance & worker health (loaded on mount) ───────────────────────
  const [governance, setGovernance] = useState<DomainProfileGovernance | null>(null);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [governanceError, setGovernanceError] = useState('');

  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workerHealthLoading, setWorkerHealthLoading] = useState(true);

  // ── Snapshot state ─────────────────────────────────────────────────────
  const [snapshotUrl, setSnapshotUrl] = useState(seedSampleUrl ?? '');
  const [snapshotRuntime, setSnapshotRuntime] = useState<RuntimeMode>('rendered');
  const [snapshotCaptureScreenshot, setSnapshotCaptureScreenshot] = useState(true);
  const [snapshotCaptureNetwork, setSnapshotCaptureNetwork] = useState(true);
  const [snapshotResult, setSnapshotResult] = useState<SnapshotResponse | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState('');

  // Visually picked selectors state
  const [pickedSelectors, setPickedSelectors] = useState<
    Record<string, { selector: string; stability: string }>
  >({});
  const [customFieldName, setCustomFieldName] = useState('');
  const [customPasteFields, setCustomPasteFields] = useState<Record<string, string>>({});
  const [customPasteGenerating, setCustomPasteGenerating] = useState<string | null>(null);
  const [customPickedFields, setCustomPickedFields] = useState<
    Record<string, { selector: string; stability: string }>
  >({});

  // Paste-element state
  const [pastedTitle, setPastedTitle] = useState('');
  const [pastedDescription, setPastedDescription] = useState('');
  const [pastedImages, setPastedImages] = useState('');
  const [pasteGenBusy, setPasteGenBusy] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState('');

  // Test/save state
  const [testResult, setTestResult] = useState<any>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ── Proposals state ────────────────────────────────────────────────────
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [proposalGenerating, setProposalGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<GenerateProfileResult | null>(null);
  const [proposalUrl, setProposalUrl] = useState(seedSampleUrl ?? '');

  // ── Lifecycle: load governance & worker health on mount ───────────────
  const reload = useCallback(async () => {
    setGovernanceLoading(true);
    setGovernanceError('');
    try {
      const [gov, health] = await Promise.all([
        getDomainProfileGovernance(domain),
        getExtractionWorkerHealth(),
      ]);
      setGovernance(gov);
      setWorkerHealth(health);
    } catch (err) {
      setGovernanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setGovernanceLoading(false);
      setWorkerHealthLoading(false);
    }
  }, [domain]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── Derived data ───────────────────────────────────────────────────────

  const activeProfile = governance?.activeProfile ?? null;
  const generations = governance?.generations ?? [];

  const activeSelectors: Record<string, string | null> = activeProfile
    ? {
        titleSelector: activeProfile.titleSelector ?? null,
        descriptionSelector: activeProfile.descriptionSelector ?? null,
        imagesSelector: activeProfile.imagesSelector ?? null,
      }
    : {};

  const confirmedSampleCount = governance?.validationSampleCount ?? 0;

  // ── Generate profile proposal ──────────────────────────────────────────

  const handleGenerateProposal = async () => {
    setProposalGenerating(true);
    setGenerationResult(null);
    setGovernanceError('');
    try {
      const result = await generateProfileForDomain(
        domain,
        proposalUrl?.trim() || undefined,
      );
      setGenerationResult(result);
      if (result.success) {
        // Reload governance to pick up the new generation
        await reload();
      }
    } catch (err) {
      setGovernanceError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setProposalGenerating(false);
    }
  };

  // ── Snapshot ───────────────────────────────────────────────────────────

  const handleSnapshot = async () => {
    if (!snapshotUrl.trim()) return;
    setSnapshotBusy(true);
    setSnapshotError('');
    setSnapshotResult(null);
    try {
      const req: SnapshotRequest = {
        url: snapshotUrl.trim(),
        runtime: snapshotRuntime,
        captureScreenshot: snapshotCaptureScreenshot,
        captureNetwork: snapshotCaptureNetwork,
      };
      const res = await snapshotPageForBuilder(req);
      if (res.ok && res.data) {
        setSnapshotResult(res.data);
      } else {
        setSnapshotError(res.error ?? 'Snapshot failed with no error message');
      }
    } catch (err) {
      setSnapshotError(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapshotBusy(false);
    }
  };

  // ── Paste-element generate ──────────────────────────────────────────────
  const handlePasteGenerate = async (field: string, outerHTML: string) => {
    if (!outerHTML.trim() || !snapshotUrl.trim()) return;
    setPasteGenBusy(field);
    setPasteError('');
    try {
      const htmlRes = await fetchPageHtml(snapshotUrl.trim());
      if (!htmlRes.ok || !htmlRes.html) {
        setPasteError(htmlRes.error || 'Failed to fetch page HTML');
        return;
      }
      const res = await generateSelectorFromElement({ html: htmlRes.html, outerHTML });
      if (!res.ok || !res.data) {
        setPasteError(res.error || 'Failed to generate selector');
        return;
      }
      const data = res.data;
      const key = field === 'title' ? 'title' : field === 'description' ? 'description' : 'images';
      setPickedSelectors((prev) => ({ ...prev, [key]: { selector: data.selector, stability: data.stability } }));
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasteGenBusy(null);
    }
  };

  const handleCustomPasteGenerate = async (fieldName: string, outerHTML: string) => {
    if (!outerHTML.trim() || !snapshotUrl.trim()) return;
    setCustomPasteGenerating(fieldName);
    try {
      const htmlRes = await fetchPageHtml(snapshotUrl.trim());
      if (!htmlRes.ok || !htmlRes.html) return;
      const res = await generateSelectorFromElement({ html: htmlRes.html, outerHTML });
      const data = res.data;
      if (data && data.selector) {
        setCustomPickedFields((prev) => ({ ...prev, [fieldName]: { selector: data.selector, stability: data.stability } }));
      }
    } catch { /* skip */ }
    finally { setCustomPasteGenerating(null); }
  };

  // ── Test extraction ─────────────────────────────────────────────────────
  const handleTestExtraction = async () => {
    if (!snapshotUrl.trim()) return;
    setTestBusy(true);
    setTestResult(null);
    setPasteError('');
    try {
      const sel = (key: string) => pickedSelectors[key]?.selector || null;
      const res = await testExtractorProfile({
        url: snapshotUrl.trim(),
        titleSelector: sel('title'),
        descriptionSelector: sel('description'),
        imagesSelector: sel('images'),
      });
      if (res.success) {
        setTestResult(res.extracted);
      } else {
        setPasteError('Test extraction failed');
      }
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestBusy(false);
    }
  };

  // ── Save profile ────────────────────────────────────────────────────────
  const handleSaveProfile = async () => {
    setSaveBusy(true);
    setSaveError('');
    try {
      const sel = (key: string) => pickedSelectors[key]?.selector || null;
      const body: Record<string, any> = {
        domain,
        titleSelector: sel('title'),
        descriptionSelector: sel('description'),
        imagesSelector: sel('images'),
      };
      if (Object.keys(customPickedFields).length > 0) {
        const cSel: Record<string, string> = {};
        for (const [name, s] of Object.entries(customPickedFields)) {
          cSel[name] = s.selector;
        }
        body.customSelectors = cSel;
      }
      const res = await fetch('/api/onboarding/settings/extractor-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSaveSuccess(true);
      } else {
        setSaveError(data.error || 'Save failed');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  };






  // ── Tab rendering ──────────────────────────────────────────────────────

  const renderTabHeader = () => (
    <div style={s.tabs}>
      {(
        [
          ['build', 'Build'],
          ['review', 'Review'],
          ['advanced', 'Advanced'],
        ] as [TabId, string][]
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          style={{
            ...s.tab,
            ...(activeTab === id ? s.tabActive : {}),
          }}
          onClick={() => setActiveTab(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  // ── Overview tab ───────────────────────────────────────────────────────

  const renderAdvanced = () => {
    if (governanceLoading) {
      return <p style={{ color: '#6b7280' }}>Loading domain governance…</p>;
    }
    if (governanceError) {
      return <div style={s.errorBox}>{governanceError}</div>;
    }

    const healthStatus = diagnostics?.healthStatus ?? 'unknown';

    return (
      <div>
        {/* Domain header */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 22 }}>{domain}</h2>
          <span style={domainHealthBadgeStyle('unknown' as DomainHealthStatus)}>
            {healthStatus}
          </span>
          {workerHealthLoading ? (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              Worker health… loading
            </span>
          ) : workerHealth ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: '#4b5563',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: workerHealth.ok ? '#16a34a' : '#dc2626',
                  display: 'inline-block',
                }}
              />
              Worker v{workerHealth.version}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: '#dc2626' }}>
              Worker unavailable
            </span>
          )}
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            {confirmedSampleCount} confirmed sample
            {confirmedSampleCount !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Existing profiles list */}
        <div style={s.section}>
          <h3 style={s.sectionTitle}>Active Profile</h3>
          {activeProfile ? (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Field</th>
                  <th style={s.th}>Selector</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(SELECTOR_FIELD_LABELS).map(
                  ([field, label]) => (
                    <tr key={field}>
                      <td style={s.td}>{label}</td>
                      <td style={s.td}>
                        <code style={s.code}>
                          {activeSelectors[field] ?? '—'}
                        </code>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : (
            <p style={s.empty}>No active profile for this domain.</p>
          )}
        </div>

        <hr style={s.divider} />

        {/* Get Started — primary action */}
        <div style={s.section}>
          <h3 style={s.sectionTitle}>Get Started</h3>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>
            Use the <strong>Build</strong> tab to visually select elements on a product page.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={s.primaryBtn}
              onClick={() => setActiveTab('build')}
            >
              Go to Build Tab
            </button>
          </div>
        </div>

        {/* AI Proposal — deprecated, tucked at bottom */}
        <details style={{ marginTop: 24, fontSize: 13, color: '#6b7280' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#9ca3af' }}>Advanced: AI-Generated Proposal (deprecated)</summary>
          <div style={{ marginTop: 12, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
              The AI proposal generator is unreliable for complex page structures.
              Use the <strong>Build</strong> tab to visually select elements instead.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={{ ...s.secondaryBtn, fontSize: 12, padding: '4px 10px' }}
                onClick={handleGenerateProposal}
                disabled={proposalGenerating}
              >
                {proposalGenerating ? 'Generating…' : 'Generate AI Proposal'}
              </button>
            </div>
            {generationResult && (
              <div style={generationResult.success ? s.successBox : s.errorBox}>
                {generationResult.success
                  ? generationResult.existing
                    ? 'Existing open proposal found.'
                    : `Proposal generated${generationResult.anchorUrl ? ` from ${generationResult.anchorUrl}` : ''}.`
                  : 'Generation returned no proposal.'}
              </div>
            )}
          </div>
        </details>
      </div>
    );
  };

  // ── Snapshot tab ────────────────────────────────────────────────────────

    const renderBuild = () => (
    <div>
      {/* ─── Hero: URL Input ─── */}
      <div style={{
        ...s.section,
        background: '#faf5ff',
        borderRadius: 12,
        padding: 24,
        border: '2px solid #e9d5ff',
        marginBottom: 24,
      }}>
        <h3 style={{ ...s.sectionTitle, fontSize: 18, color: '#6b21a8', marginTop: 0 }}>
          🖱️ Build Profile by Clicking Elements
        </h3>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          Enter a product page URL, load it, then click on the title, description, and images
          in the browser window. The system generates stable CSS selectors from your clicks.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            style={{ ...s.input, flex: 1 }}
            value={snapshotUrl}
            onChange={(e) => setSnapshotUrl(e.target.value)}
            placeholder="https://example.com/product/123"
          />
          <button
            type="button"
            style={{
              background: snapshotBusy ? '#9ca3af' : '#7c3aed',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 24px',
              fontSize: 14,
              fontWeight: 600,
              cursor: snapshotBusy ? 'not-allowed' : 'pointer',
            }}
            onClick={handleSnapshot}
            disabled={snapshotBusy || !snapshotUrl.trim()}
          >
            {snapshotBusy ? 'Loading…' : 'Load Page'}
          </button>
        </div>
        {snapshotError && <div style={s.errorBox}>{snapshotError}</div>}
      </div>

            {/* ─── Paste Element HTML — Primary Method ─── */}
      {snapshotResult && (
        <div style={{ ...s.section, marginBottom: 16 }}>
          <details style={{ marginBottom: 12 }} open>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14, color: '#166534' }}>
              📋 Paste Element HTML — No browser needed
            </summary>
            <div style={{ marginTop: 8, padding: 12, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
              <p style={{ fontSize: 12, color: '#4b5563', margin: '0 0 8px', lineHeight: 1.5 }}>
                Open DevTools (<strong>F12</strong>), find the element, right-click it in the Elements panel,
                select <strong>Copy → Copy outerHTML</strong>, paste below, and click <strong>Generate</strong>.
              </p>
              {['title', 'description', 'images'].map((field) => {
                const label = field === 'title' ? 'Title' : field === 'description' ? 'Description' : 'Images';
                const key = field as 'title' | 'description' | 'images';
                const val = field === 'title' ? pastedTitle : field === 'description' ? pastedDescription : pastedImages;
                const setVal = field === 'title' ? setPastedTitle : field === 'description' ? setPastedDescription : setPastedImages;
                return (
                  <div key={field} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <textarea
                        value={val}
                        onChange={(e) => setVal(e.target.value)}
                        rows={2}
                        placeholder={'Paste ' + label + ' outerHTML here...'}
                        style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
                      />
                      <button
                        type="button"
                        onClick={() => handlePasteGenerate(field, val)}
                        disabled={pasteGenBusy !== null || !val.trim()}
                        style={{ padding: '4px 12px', fontSize: 12, background: pasteGenBusy === field ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: pasteGenBusy !== null ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap', alignSelf: 'flex-start' }}
                      >
                        {pasteGenBusy === field ? 'Generating...' : 'Generate'}
                      </button>
                    </div>
                    {pickedSelectors[key] && (
                      <div style={{ marginTop: 4, padding: '4px 8px', background: '#f0fdf4', borderRadius: 4, border: '1px solid #bbf7d0', fontSize: 11 }}>
                        <code>{pickedSelectors[key].selector}</code>
                        <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: pickedSelectors[key].stability === 'high' ? '#16a34a' : pickedSelectors[key].stability === 'medium' ? '#d97706' : '#dc2626' }}>
                          {pickedSelectors[key].stability}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
              {pasteError && <p style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{pasteError}</p>}
            </div>
          </details>
        </div>
      )}

      {/* ─── Visual Select — Hero Section ─── */}{/* ─── Visual Select — Hero Section ─── */}
      {snapshotResult && (
        <>
          <div style={{ ...s.section, marginBottom: 32 }}>
            <h3 style={s.sectionTitle}>Select Elements <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#d97706', verticalAlign: 'middle', marginLeft: 6 }}>EXPERIMENTAL</span></h3>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 20,
            }}>
              {/* Title */}
              <div style={{
                background: '#fff',
                border: pickedSelectors.title ? '2px solid #16a34a' : '2px solid #e5e7eb',
                borderRadius: 8,
                padding: 16,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  1. Title
                </div>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
                  Click the product name on the page
                </p>
                <ElementPickerButton
                  field="title"
                  url={snapshotResult.finalUrl || snapshotResult.url}
                  onPicked={(result) => {
                    setPickedSelectors((prev) => ({ ...prev, title: { selector: result.selector, stability: result.stability } }));
                  }}
                  onCancel={() => {}}
                />
                {pickedSelectors.title && (
                  <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                    <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                      {pickedSelectors.title.selector}
                    </code>
                    <span style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 999,
                      textTransform: 'uppercase',
                      background: pickedSelectors.title.stability === 'high' ? '#dcfce7' : pickedSelectors.title.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                      color: pickedSelectors.title.stability === 'high' ? '#16a34a' : pickedSelectors.title.stability === 'medium' ? '#d97706' : '#dc2626',
                    }}>
                      {pickedSelectors.title.stability}
                    </span>
                  </div>
                )}
              </div>

              {/* Description */}
              <div style={{
                background: '#fff',
                border: pickedSelectors.description ? '2px solid #16a34a' : '2px solid #e5e7eb',
                borderRadius: 8,
                padding: 16,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  2. Description
                </div>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
                  Click the product description on the page
                </p>
                <ElementPickerButton
                  field="description"
                  url={snapshotResult.finalUrl || snapshotResult.url}
                  onPicked={(result) => {
                    setPickedSelectors((prev) => ({ ...prev, description: { selector: result.selector, stability: result.stability } }));
                  }}
                  onCancel={() => {}}
                />
                {pickedSelectors.description && (
                  <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                    <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                      {pickedSelectors.description.selector}
                    </code>
                    <span style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 999,
                      textTransform: 'uppercase',
                      background: pickedSelectors.description.stability === 'high' ? '#dcfce7' : pickedSelectors.description.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                      color: pickedSelectors.description.stability === 'high' ? '#16a34a' : pickedSelectors.description.stability === 'medium' ? '#d97706' : '#dc2626',
                    }}>
                      {pickedSelectors.description.stability}
                    </span>
                  </div>
                )}
              </div>

              {/* Images */}
              <div style={{
                background: '#fff',
                border: pickedSelectors.images ? '2px solid #16a34a' : '2px solid #e5e7eb',
                borderRadius: 8,
                padding: 16,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  3. Images
                </div>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
                  Click a product image (gallery) on the page
                </p>
                <ElementPickerButton
                  field="images"
                  url={snapshotResult.finalUrl || snapshotResult.url}
                  onPicked={(result) => {
                    setPickedSelectors((prev) => ({ ...prev, images: { selector: result.selector, stability: result.stability } }));
                  }}
                  onCancel={() => {}}
                />
                {pickedSelectors.images && (
                  <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                    <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                      {pickedSelectors.images.selector}
                    </code>
                    <span style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 999,
                      textTransform: 'uppercase',
                      background: pickedSelectors.images.stability === 'high' ? '#dcfce7' : pickedSelectors.images.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                      color: pickedSelectors.images.stability === 'high' ? '#16a34a' : pickedSelectors.images.stability === 'medium' ? '#d97706' : '#dc2626',
                    }}>
                      {pickedSelectors.images.stability}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* ─── Custom Fields ─── */}
            <div style={{ marginTop: 32, borderTop: '1px solid #e5e7eb', paddingTop: 24 }}>
              <h3 style={s.sectionTitle}>Custom Fields</h3>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
                Add additional fields like Size, Flavor, Variant, Weight, etc.
              </p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  type="text"
                  value={customFieldName}
                  onChange={(e) => setCustomFieldName(e.target.value)}
                  placeholder="e.g. Size, Flavor, Weight"
                  style={{ ...s.input, flex: 1 }}
                />
                <button
                  type="button"
                  style={{
                    background: customFieldName.trim() ? '#7c3aed' : '#d1d5db',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: customFieldName.trim() ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap',
                  }}
                  disabled={!customFieldName.trim()}
                  onClick={() => {
                    const name = customFieldName.trim();
                    if (name && !customPickedFields[name] && !pickedSelectors[name]) {
                      setCustomPickedFields((prev) => ({ ...prev, [name]: { selector: '', stability: 'low' } }));
                      setCustomFieldName('');
                    }
                  }}
                >
                  + Add Field
                </button>
              </div>
              {Object.keys(customPickedFields).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {Object.entries(customPickedFields).map(([fieldName, value]) => (
                    <div key={fieldName} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: 12,
                      background: '#fff',
                      border: value.selector ? '2px solid #16a34a' : '2px solid #e5e7eb',
                      borderRadius: 8,
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4, textTransform: 'capitalize' }}>
                          {fieldName}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <textarea
                            value={customPasteFields[fieldName] || ''}
                            onChange={(e) => setCustomPasteFields((prev) => ({ ...prev, [fieldName]: e.target.value }))}
                            rows={1}
                            placeholder="Or paste outerHTML here..."
                            style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
                          />
                          <button
                            type="button"
                            onClick={() => handleCustomPasteGenerate(fieldName, customPasteFields[fieldName] || '')}
                            disabled={customPasteGenerating !== null || !customPasteFields[fieldName]?.trim()}
                            style={{ padding: '4px 10px', fontSize: 11, background: customPasteGenerating === fieldName ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: customPasteGenerating !== null ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                          >
                            {customPasteGenerating === fieldName ? '...' : 'Generate'}
                          </button>
                        </div>
                        <ElementPickerButton
                          field={fieldName}
                          url={snapshotResult.finalUrl || snapshotResult.url}
                          onPicked={(result) => {
                            setCustomPickedFields((prev) => ({ ...prev, [fieldName]: { selector: result.selector, stability: result.stability } }));
                          }}
                          onCancel={() => {}}
                        />
                        {value.selector && (
                          <div style={{ marginTop: 6, padding: 6, background: '#f0fdf4', borderRadius: 4, border: '1px solid #bbf7d0', fontSize: 12 }}>
                            <code style={{ fontSize: 11 }}>{value.selector}</code>
                            <span style={{
                              marginLeft: 6,
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: 999,
                              textTransform: 'uppercase',
                              background: value.stability === 'high' ? '#dcfce7' : value.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                              color: value.stability === 'high' ? '#16a34a' : value.stability === 'medium' ? '#d97706' : '#dc2626',
                            }}>
                              {value.stability}
                            </span>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...customPickedFields };
                          delete next[fieldName];
                          setCustomPickedFields(next);
                        }}
                        style={{
                          background: 'none',
                          border: '1px solid #dc2626',
                          color: '#dc2626',
                          borderRadius: 4,
                          padding: '4px 8px',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        ✕ Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ─── Test & Save ─── */}
          {Object.keys(pickedSelectors).length > 0 && (
            <div style={{ marginTop: 16, padding: 16, background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={handleTestExtraction}
                  disabled={testBusy || !pickedSelectors.title}
                  style={{ padding: '8px 20px', fontSize: 13, background: testBusy ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: testBusy ? 'not-allowed' : 'pointer', fontWeight: 600 }}
                >
                  {testBusy ? 'Testing...' : 'Test Extraction'}
                </button>
                <button
                  type="button"
                  onClick={handleSaveProfile}
                  disabled={saveBusy || saveSuccess || !pickedSelectors.title}
                  style={{ padding: '8px 20px', fontSize: 13, background: saveBusy || saveSuccess ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: saveBusy || !pickedSelectors.title ? 'not-allowed' : 'pointer', fontWeight: 600 }}
                >
                  {saveBusy ? 'Saving...' : saveSuccess ? '✓ Saved!' : 'Save Profile'}
                </button>
              </div>
              {saveError && <p style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{saveError}</p>}
              {saveSuccess && (
                <p style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>
                  ✓ Profile saved for {domain}. Close this panel and advance items to extraction.
                </p>
              )}
              {testResult && (
                <div style={{ marginTop: 8, padding: 8, background: '#f8f9fa', borderRadius: 4, fontSize: 12 }}>
                  <strong>Extraction preview:</strong>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                    {Object.entries(testResult).map(([k, v]) => (
                      <li key={k}><strong>{k}:</strong> {String(v).slice(0, 80)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Progress */}
            {Object.keys(pickedSelectors).length > 0 && (
              <div style={{ marginTop: 20, padding: 16, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0', textAlign: 'center' }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#166534', margin: '0 0 8px' }}>
                  {'✓'} {Object.keys(pickedSelectors).length >= 3 ? 'All elements selected!' : Object.keys(pickedSelectors).length + '/3 elements selected'}
                </p>
                <p style={{ fontSize: 12, color: '#4b5563', margin: 0 }}>
                  Use <strong>Test Extraction</strong> to preview, then <strong>Save Profile</strong> to persist.
                </p>
              </div>
            )}
          </div>

          {/* ─── Technical Details — collapsed ─── */}
          <details style={{ marginTop: 16, fontSize: 13, color: '#6b7280' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Page Technical Details (JSON-LD, images, signals)</summary>
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={s.card}>
                <h4 style={s.subsectionTitle}>JSON-LD ({snapshotResult.jsonLd.length})</h4>
                {snapshotResult.jsonLd.length > 0 ? (
                  <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12 }}>
                    {snapshotResult.jsonLd.map((item, i) => (
                      <li key={i}>{String((item as Record<string, unknown>)['@type'] ?? 'Item')}</li>
                    ))}
                  </ul>
                ) : <p style={s.empty}>None</p>}
              </div>
              <div style={s.card}>
                <h4 style={s.subsectionTitle}>Image Candidates ({snapshotResult.imageCandidates.length})</h4>
                {snapshotResult.imageCandidates.length > 0 ? (
                  <ImagePreviewGrid previews={snapshotResult.imageCandidates.map(url => ({ url, sampleUrl: snapshotResult.url, expectedName: null, brandHint: null, warnings: [], verdict: 'pending' as const }))} readOnly compact />
                ) : <p style={s.empty}>None</p>}
              </div>
              <div style={s.card}>
                <h4 style={s.subsectionTitle}>Page Structure Signals</h4>
                {snapshotResult.pageStructureSignals.length > 0 ? (
                  <div>{snapshotResult.pageStructureSignals.map((signal, i) => <span key={i} style={s.pill}>{signal}</span>)}</div>
                ) : <p style={s.empty}>None</p>}
              </div>
            </div>
            {snapshotResult.warnings.length > 0 && (
              <div style={s.errorBox}>
                <strong>Warnings:</strong>
                <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>{snapshotResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
          </details>
        </>
      )}
    </div>
  );

  // ── Proposals tab ───────────────────────────────────────────────────────

  const renderReview = () => {
    if (governanceLoading) {
      return <p style={{ color: '#6b7280' }}>Loading generations…</p>;
    }

    // If a specific generation is selected, show the review component
    if (selectedGenerationId) {
      return (
        <div>
          <button
            type="button"
            style={{
              ...s.secondaryBtn,
              marginBottom: 12,
            }}
            onClick={() => setSelectedGenerationId(null)}
          >
            ← Back to Proposals
          </button>
          <ProfileGenerationReview
            generationId={selectedGenerationId}
            governance={governance}
            onChange={() => void reload()}
            onClose={() => setSelectedGenerationId(null)}
          />
        </div>
      );
    }

    return (
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h3 style={s.sectionTitle}>
            Profile Generations ({generations.length})
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={proposalUrl}
              onChange={(e) => setProposalUrl(e.target.value)}
              placeholder="https://example.com/products/... (optional — uses sitemap if empty)"
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: 13,
                border: '1px solid #d1d5db',
                borderRadius: 6,
                outline: 'none',
              }}
            />
            <button
              type="button"
              style={s.primaryBtn}
              onClick={handleGenerateProposal}
              disabled={proposalGenerating}
            >
              {proposalGenerating
                ? 'Generating…'
                : 'Generate New Proposal'}
            </button>
          </div>
        </div>

        {generationResult && (
          <div
            style={
              generationResult.success ? s.successBox : s.errorBox
            }
          >
            {generationResult.success
              ? `Proposal ${generationResult.existing ? 'already exists' : 'generated'} for ${domain}.`
              : 'Generation returned no proposal.'}
          </div>
        )}

        {generations.length === 0 ? (
          <p style={s.empty}>
            No profile generations yet. Click "Generate New Proposal" to
            create the first one.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {generations
              .slice()
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime(),
              )
              .map((g) => {
                const statusColor =
                  g.status === 'validated' || g.status === 'promoted'
                    ? '#16a34a'
                    : g.status === 'rejected'
                      ? '#dc2626'
                      : g.status === 'failed'
                        ? '#d97706'
                        : '#9ca3af';
                const statusBg =
                  g.status === 'validated' || g.status === 'promoted'
                    ? '#f0fdf4'
                    : g.status === 'rejected'
                      ? '#fef2f2'
                      : g.status === 'failed'
                        ? '#fffbeb'
                        : '#f3f4f6';
                return (
                  <div
                    key={g.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: '1px solid #e5e7eb',
                      background: '#fff',
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        ...s.badge,
                        background: statusBg,
                        color: statusColor,
                        border: `1px solid ${statusColor}`,
                      }}
                    >
                      {g.status}
                    </span>
                    <span style={{ color: '#4b5563', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {g.sourceUrl || '—'}
                    </span>
                    <span style={{ color: '#6b7280', fontSize: 12 }}>
                      conf: {g.confidence.toFixed(2)}
                    </span>
                    <span style={{ color: '#6b7280', fontSize: 12 }}>
                      {new Date(g.createdAt).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      style={{
                        background: '#2563eb',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                      onClick={() => setSelectedGenerationId(g.id)}
                    >
                      Review
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    );
  };

  // ── Validation tab ──────────────────────────────────────────────────────

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Overlay */}
      <div style={s.overlay} onClick={onClose} />

      {/* Modal */}
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <h1 style={s.headerTitle}>
            Profile Builder: <span style={{ color: '#2563eb' }}>{domain}</span>
          </h1>
          <button type="button" style={s.closeBtn} onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {/* Tabs */}
        {renderTabHeader()}

        {/* Body */}
        <div style={s.body}>
          {activeTab === 'build' && renderBuild()}
          {activeTab === 'review' && renderReview()}
          {activeTab === 'advanced' && renderAdvanced()}
        </div>
      </div>
    </>
  );
}

export default ProfileBuilderWorkspace;
