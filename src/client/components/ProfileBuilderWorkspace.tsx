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

type TabId = 'overview' | 'snapshot' | 'review';

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
  const [activeTab, setActiveTab] = useState<TabId>('overview');

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





  // ── Tab rendering ──────────────────────────────────────────────────────

  const renderTabHeader = () => (
    <div style={s.tabs}>
      {(
        [
          ['overview', 'Overview'],
          ['snapshot', 'Snapshot'],
          ['review', 'Review'],
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

  const renderOverview = () => {
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

        {/* Quick actions */}
        <div style={s.section}>
          <h3 style={s.sectionTitle}>Quick Actions</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              style={s.primaryBtn}
              onClick={handleGenerateProposal}
              disabled={proposalGenerating}
            >
              {proposalGenerating
                ? 'Generating…'
                : 'Generate Profile Proposal'}
            </button>
            <button
              type="button"
              style={s.secondaryBtn}
              onClick={() => setActiveTab('snapshot')}
            >
              Snapshot Page
            </button>
            <button
              type="button"
              style={s.secondaryBtn}
              onClick={() => setActiveTab('review')}
            >
              Validate Across Samples
            </button>
          </div>

          {generationResult && (
            <div
              style={
                generationResult.success
                  ? s.successBox
                  : s.errorBox
              }
            >
              {generationResult.success
                ? generationResult.existing
                  ? `Existing open proposal found for ${domain}.`
                  : `Profile proposal generated for ${domain}${generationResult.anchorUrl ? ` from ${generationResult.anchorUrl}` : ''}.`
                : 'Profile generation returned no proposal.'}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Snapshot tab ────────────────────────────────────────────────────────

  const renderSnapshot = () => (
    <div>
      <div style={s.section}>
        <h3 style={s.sectionTitle}>Snapshot Page</h3>
        <p style={s.hint}>
          Fetch a live product page and analyse its structure for profile
          building.
        </p>

        {/* URL input */}
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Page URL</label>
          <input
            type="text"
            style={s.input}
            value={snapshotUrl}
            onChange={(e) => setSnapshotUrl(e.target.value)}
            placeholder="https://example.com/product/123"
          />
        </div>

        {/* Runtime toggle */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <label style={s.label}>Runtime</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={{
                ...(snapshotRuntime === 'static'
                  ? s.primaryBtn
                  : s.secondaryBtn),
                padding: '4px 12px',
                fontSize: 12,
              }}
              onClick={() => setSnapshotRuntime('static')}
            >
              Static
            </button>
            <button
              type="button"
              style={{
                ...(snapshotRuntime === 'rendered'
                  ? s.primaryBtn
                  : s.secondaryBtn),
                padding: '4px 12px',
                fontSize: 12,
              }}
              onClick={() => setSnapshotRuntime('rendered')}
            >
              Rendered
            </button>
          </div>
        </div>

        {/* Checkboxes */}
        <div
          style={{
            display: 'flex',
            gap: 16,
            marginBottom: 12,
          }}
        >
          <label style={s.checkboxLabel}>
            <input
              type="checkbox"
              checked={snapshotCaptureScreenshot}
              onChange={(e) =>
                setSnapshotCaptureScreenshot(e.target.checked)
              }
            />
            Capture screenshot
          </label>
          <label style={s.checkboxLabel}>
            <input
              type="checkbox"
              checked={snapshotCaptureNetwork}
              onChange={(e) =>
                setSnapshotCaptureNetwork(e.target.checked)
              }
            />
            Capture network
          </label>
        </div>

        {/* Take Snapshot button */}
        <button
          type="button"
          style={s.primaryBtn}
          onClick={handleSnapshot}
          disabled={snapshotBusy || !snapshotUrl.trim()}
        >
          {snapshotBusy ? 'Snapshotting…' : 'Take Snapshot'}
        </button>

        {snapshotError && <div style={s.errorBox}>{snapshotError}</div>}
      </div>

      {/* Snapshot results */}
      {snapshotResult && (
        <div style={s.section}>
          <h3 style={s.sectionTitle}>Snapshot Results</h3>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
            }}
          >
            {/* JSON-LD */}
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>
                JSON-LD ({snapshotResult.jsonLd.length})
              </h4>
              {snapshotResult.jsonLd.length > 0 ? (
                <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12 }}>
                  {snapshotResult.jsonLd.map((item, i) => {
                    const type =
                      (item as Record<string, unknown>)['@type'] ?? 'Item';
                    return (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <strong>{String(type)}</strong>
                        {Object.entries(item as Record<string, unknown>)
                          .filter(
                            ([k]) => k !== '@type' && k !== '@context',
                          )
                          .slice(0, 4)
                          .map(([k, v]) => (
                            <div
                              key={k}
                              style={{
                                fontSize: 11,
                                color: '#6b7280',
                                marginLeft: 8,
                              }}
                            >
                              {k}: {String(v).slice(0, 80)}
                            </div>
                          ))}
                        {Object.keys(item).length > 6 && (
                          <div style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>
                            +{Object.keys(item).length - 6} more fields
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p style={s.empty}>No JSON-LD found</p>
              )}
            </div>

            {/* Embedded product data */}
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>
                Embedded Product Data (
                {snapshotResult.embeddedProductData.length})
              </h4>
              {snapshotResult.embeddedProductData.length > 0 ? (
                <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12 }}>
                  {snapshotResult.embeddedProductData.map((item, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      {Object.entries(item as Record<string, unknown>)
                        .slice(0, 6)
                        .map(([k, v]) => (
                          <div key={k} style={{ fontSize: 11, color: '#6b7280' }}>
                            {k}: {String(v).slice(0, 60)}
                          </div>
                        ))}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={s.empty}>No embedded data found</p>
              )}
            </div>
          </div>

          {/* Image candidates */}
          <div style={{ ...s.card, marginTop: 16 }}>
            <h4 style={s.subsectionTitle}>
              Image Candidates ({snapshotResult.imageCandidates.length})
            </h4>
            {snapshotResult.imageCandidates.length > 0 ? (
              <ImagePreviewGrid
                previews={snapshotResult.imageCandidates.map((url) => ({
                  url,
                  sampleUrl: snapshotResult.url,
                  expectedName: null,
                  brandHint: null,
                  warnings: [],
                  verdict: 'pending' as const,
                }))}
                readOnly
                compact
              />
            ) : (
              <p style={s.empty}>No image candidates found</p>
            )}
          </div>

          {/* Page structure signals */}
          <div style={{ ...s.card, marginTop: 16 }}>
            <h4 style={s.subsectionTitle}>Page Structure Signals</h4>
            {snapshotResult.pageStructureSignals.length > 0 ? (
              <div>
                {snapshotResult.pageStructureSignals.map((signal, i) => (
                  <span key={i} style={s.pill}>
                    {signal}
                  </span>
                ))}
              </div>
            ) : (
              <p style={s.empty}>No structure signals detected</p>
            )}
          </div>

          {/* Screenshot */}
          <div style={{ ...s.card, marginTop: 16 }}>
            <h4 style={s.subsectionTitle}>Screenshot</h4>
            {snapshotResult.screenshotRef ? (
              <div
                style={{
                  padding: 12,
                  background: '#f9fafb',
                  borderRadius: 6,
                  fontSize: 12,
                  color: '#6b7280',
                  fontFamily: 'monospace',
                }}
              >
                {snapshotResult.screenshotRef}
              </div>
            ) : (
              <p style={s.empty}>No screenshot captured</p>
            )}
          </div>

          {/* Warnings */}
          {snapshotResult.warnings.length > 0 && (
            <div style={s.errorBox}>
              <strong>Warnings:</strong>
              <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
                {snapshotResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Visual Selector Section ── */}
      {snapshotResult && snapshotResult.url && (
        <div style={{ ...s.section, marginTop: 24, borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
          <h3 style={s.sectionTitle}>Visually Select Elements</h3>
          <p style={s.hint}>
            Click a button below, then click on the corresponding element in the browser
            window to generate a stable CSS selector.
          </p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                Title
              </div>
              <ElementPickerButton
                field="title"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({
                    ...prev,
                    title: { selector: result.selector, stability: result.stability },
                  }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.title && (
                <div
                  style={{
                    marginTop: 4,
                    padding: '2px 6px',
                    background: '#f3f4f6',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  <code>{pickedSelectors.title.selector}</code>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 10,
                      color:
                        pickedSelectors.title.stability === 'high'
                          ? '#16a34a'
                          : pickedSelectors.title.stability === 'medium'
                            ? '#d97706'
                            : '#dc2626',
                    }}
                  >
                    {pickedSelectors.title.stability}
                  </span>
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                Description
              </div>
              <ElementPickerButton
                field="description"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({
                    ...prev,
                    description: { selector: result.selector, stability: result.stability },
                  }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.description && (
                <div
                  style={{
                    marginTop: 4,
                    padding: '2px 6px',
                    background: '#f3f4f6',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  <code>{pickedSelectors.description.selector}</code>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 10,
                      color:
                        pickedSelectors.description.stability === 'high'
                          ? '#16a34a'
                          : pickedSelectors.description.stability === 'medium'
                            ? '#d97706'
                            : '#dc2626',
                    }}
                  >
                    {pickedSelectors.description.stability}
                  </span>
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                Images
              </div>
              <ElementPickerButton
                field="images"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({
                    ...prev,
                    images: { selector: result.selector, stability: result.stability },
                  }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.images && (
                <div
                  style={{
                    marginTop: 4,
                    padding: '2px 6px',
                    background: '#f3f4f6',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  <code>{pickedSelectors.images.selector}</code>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 10,
                      color:
                        pickedSelectors.images.stability === 'high'
                          ? '#16a34a'
                          : pickedSelectors.images.stability === 'medium'
                            ? '#d97706'
                            : '#dc2626',
                    }}
                  >
                    {pickedSelectors.images.stability}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Worker unavailable */}
      {snapshotError && !snapshotResult && (
        <p style={{ fontSize: 13, color: '#dc2626' }}>
          The extraction worker is not available. Start the worker service
          (e.g. via the worker Docker container) and try again.
        </p>
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
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'snapshot' && renderSnapshot()}
          {activeTab === 'review' && renderReview()}
        </div>
      </div>
    </>
  );
}

export default ProfileBuilderWorkspace;
