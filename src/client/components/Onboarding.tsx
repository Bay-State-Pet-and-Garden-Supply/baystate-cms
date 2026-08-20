import React, { useState, useEffect } from 'react';
import {
  getBatches,
  getBatch,
  deleteBatch,
  uploadSpreadsheet,
  createBatch,
  resolveBrandDomains,
  getBrandSites,
  getOnboardingCapabilities,
} from '../onboarding-api';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';
import { OnboardingSettings } from './OnboardingSettings';
import { PipelineBoard } from './PipelineBoard';
import { BatchWorkspace } from './onboarding/BatchWorkspace';
import { WeeklyReportModal } from './WeeklyReportModal';
import { BatchPreflightModal } from './onboarding/preflight/BatchPreflightModal';
import type { OnboardingBatch, ColumnMapping, BrandSite } from '../../shared/schemas/onboarding';
import { getProfileWorkspacePath } from './profile-workspace/route';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';
import type { WorkStateCounts } from '../../shared/schemas/onboarding-work-state';
import { formatCount, totalItemCount } from './onboarding/batch-workspace-logic';
import { matchExistingBrand } from '../../shared/brand-matcher';
import { getOnboardingFeatureFlags } from '../onboarding-feature-flags';
export function Onboarding() {
  const [showSettings, setShowSettings] = useState(false);

  // Sourcing engine capability (server-reported; fail closed to false).
  // While false, Sourcing items may only continue to Discovery.
  const [sourcingEngineEnabled, setSourcingEngineEnabled] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  // Deep-linked settings tab (`?view=onboarding&settingsTab=curation` — the
  // "Open Curation Targets settings" banner links land here, not on the
  // generic ?view=settings page). Read once at mount: the banner anchors are
  // full-page navigations, so a fresh mount always sees the param.
  const settingsDeepLinkTab = (() => {
    const tab = new URLSearchParams(window.location.search).get('settingsTab');
    return tab === 'general' || tab === 'llm' || tab === 'curation' || tab === 'profiles' ? tab : null;
  })();
  useEffect(() => {
    if (settingsDeepLinkTab === 'llm') {
      // Migrate the removed onboarding-owned editor to the canonical global
      // AI Compute surface while keeping existing bookmarks actionable.
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'settings');
      url.searchParams.set('tab', 'ai');
      url.searchParams.delete('settingsTab');
      window.history.replaceState({ view: 'settings' }, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    if (settingsDeepLinkTab) {
      setShowSettings(true);
    }
  }, [settingsDeepLinkTab]);
  const [showWeeklyReportModal, setShowWeeklyReportModal] = useState(false);
  const [batches, setBatches] = useState<OnboardingBatch[]>([]);
  const [batchCounts, setBatchCounts] = useState<Record<string, WorkStateCounts>>({});
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<OnboardingBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load onboarding capabilities once on mount; fail closed (engine disabled)
  // when the fetch fails, surfacing the error rather than engine actions.
  useEffect(() => {
    let cancelled = false;
    getOnboardingCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setSourcingEngineEnabled(caps.sourcing?.engineEnabled === true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCapabilitiesError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  // Upload modal states
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadHeaders, setUploadHeaders] = useState<string[]>([]);
  const [uploadMapping, setUploadMapping] = useState<Partial<ColumnMapping>>({});
  const [uploadTempRows, setUploadTempRows] = useState<Record<string, string>[]>([]);
  const [uploadRowsCount, setUploadRowsCount] = useState(0);
  const [uploadBatchName, setUploadBatchName] = useState('');
  const [uploadStep, setUploadStep] = useState<1 | 2>(1);
  const [detectedBrands, setDetectedBrands] = useState<string[]>([]);
  const [brandMappings, setBrandMappings] = useState<Record<string, string>>({});
  const [loadingBrands, setLoadingBrands] = useState(false);

  // Item review/edit drawer states were removed in the epic #46 operator
  // rollover — per-item review lives in the Review workspace, bulk actions in
  // the Batch Workspace, and the legacy Pipeline Board (diagnostics) owns its
  // own drawer components.
  // story: e07s04 — profile builder modal state removed; navigation via getProfileWorkspacePath

  // Custom Selector Editor state was removed; extractor profiles are
  // managed in OnboardingSettings ("Domain Extractor Profiles" section).

  // Brand/Domain Management states
  const [cachedBrandSites, setCachedBrandSites] = useState<BrandSite[]>([]);
  const [catalogBrands, setCatalogBrands] = useState<string[]>([]);

  // Preflight & Controlled Release modal states
  const [showPreflightModal, setShowPreflightModal] = useState(false);
  const [preflightBatchId, setPreflightBatchId] = useState<string | null>(null);

  const fetchBatchesList = async () => {
    try {
      const res = await getBatches();
      setBatches(res.batches);
      // Server-owned per-batch operator work-state counts (epic #46
      // refinement): the table shows the same metrics as the workspace tabs.
      setBatchCounts(res.workStateCounts ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadBrandSites = async () => {
    try {
      const res = await getBrandSites();
      setCachedBrandSites(res.brandSites);
      if (res.catalogBrands) {
        setCatalogBrands(res.catalogBrands);
      }
    } catch (err) {
      console.error('Failed to load brand sites:', err);
    }
  };

  useEffect(() => {
    fetchBatchesList();
    loadBrandSites();
  }, []);

  const handleSelectBatch = async (batchId: string) => {
    setLoading(true);
    setError('');
    setSelectedBatchId(batchId);
    try {
      const batchRes = await getBatch(batchId);
      setSelectedBatch(batchRes.batch);
      await loadBrandSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBackToBatches = () => {
    setSelectedBatchId(null);
    setSelectedBatch(null);
    fetchBatchesList();
  };

  const handleDeleteBatch = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this batch and all its items?')) return;
    try {
      await deleteBatch(id);
      fetchBatchesList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ─── SPREADSHEET UPLOAD & CREATION ──────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError('');
    setUploadStep(1);
    setDetectedBrands([]);
    setBrandMappings({});
    try {
      const res = await uploadSpreadsheet(file);
      setUploadFile(file);
      setUploadHeaders(res.headers);
      setUploadMapping(res.mapping);
      setUploadTempRows(res.tempRows);
      setUploadRowsCount(res.rowsCount);
      
      // Auto-name batch
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setUploadBatchName(baseName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleNextStep = async () => {
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoadingBrands(true);
    try {
      // Fetch existing brands in the system
      const brandSitesRes = await getBrandSites();
      const existingBrands = brandSitesRes.brandSites.map(b => b.brandName);

      const brandCol = uploadMapping.brand;
      const nameCol = uploadMapping.name;

      const brandsSet = new Set<string>();
      for (const row of uploadTempRows) {
        let brandVal = '';
        if (brandCol && row[brandCol]) {
          brandVal = row[brandCol].trim();
        } else if (nameCol && row[nameCol]) {
          // Check if first word(s) matches an existing brand exactly
          const matched = matchExistingBrand(row[nameCol], existingBrands);
          if (matched) {
            brandVal = matched;
          }
        }
        
        // Filter out short noise/numeric tokens
        if (brandVal && brandVal.length > 1 && !/^\d+$/.test(brandVal)) {
          brandsSet.add(brandVal.toUpperCase());
        }
      }

      const uniqueBrands = Array.from(brandsSet).sort();
      setDetectedBrands(uniqueBrands);

      // Query backend to resolve domains
      if (uniqueBrands.length > 0) {
        const res = await resolveBrandDomains(uniqueBrands);
        const initialMappings: Record<string, string> = {};
        for (const brand of uniqueBrands) {
          initialMappings[brand] = res.mappings[brand] || '';
        }
        setBrandMappings(initialMappings);
      }

      setUploadStep(2);
    } catch (err) {
      alert('Failed to detect brands: ' + String(err));
    } finally {
      setLoadingBrands(false);
    }
  };

  const handleConfirmBatch = async () => {
    if (!uploadBatchName.trim()) {
      alert('Please enter a batch name');
      return;
    }
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoading(true);
    setError('');
    try {
      // ADR 0017 follow-up: uploads no longer submit brandMappings — brand→domain
      // authority is managed in Settings (Domain Configuration) and via Discovery
      // attention actions. The step-2 UI is now a read-only confirm summary.
      const res = await createBatch({
        name: uploadBatchName,
        fileName: uploadFile!.name,
        mapping: uploadMapping as ColumnMapping,
        rows: uploadTempRows,
      });

      setShowUploadModal(false);
      setUploadFile(null);
      setUploadHeaders([]);
      setUploadMapping({});
      setUploadTempRows([]);
      setUploadRowsCount(0);
      setUploadBatchName('');
      setUploadStep(1);
      setDetectedBrands([]);
      setBrandMappings({});
      
      await fetchBatchesList();
      handleSelectBatch(res.batch.id);

      // Open Batch Preflight & Controlled Release modal immediately
      setPreflightBatchId(res.batch.id);
      setShowPreflightModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── LAYOUTS AND RENDERING ───────────────────────────────────────────────────

  const renderBatchProgress = (batch: OnboardingBatch) => {
    const counts = batchCounts[batch.id];
    if (!counts) {
      // Legacy fallback (no work-state data yet): keep the old bar.
      const total = batch.totalItems || 1;
      const completed = batch.completedItems;
      const failed = batch.failedItems;
      const skipped = batch.skippedItems ?? 0;
      const completedPercent = Math.round((completed / total) * 100);
      const failedPercent = Math.round((failed / total) * 100);
      const skippedPercent = Math.round((skipped / total) * 100);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
            <span>
              {completed} completed / {failed} failed
              {skipped > 0 && ` / ${skipped} skipped`} ({total} total)
            </span>
            <span>{completedPercent + failedPercent}%</span>
          </div>
          <div style={{ height: 6, width: '100%', background: '#e5e7eb', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
            <div style={{ height: '100%', width: `${completedPercent}%`, background: '#16a34a' }} />
            <div style={{ height: '100%', width: `${failedPercent}%`, background: '#dc2626' }} />
            <div style={{ height: '100%', width: `${skippedPercent}%`, background: '#9ca3af' }} />
          </div>
        </div>
      );
    }

    // Epic #46 refinement: the operator work-state metrics — the same
    // numbers the Batch Workspace tabs show. Needs Attention is emphasized
    // when non-zero.
    const total = Math.max(totalItemCount(counts), 1);
    const approvedTotal = counts.approved + counts.ready_to_export + counts.completed;
    const pct = (v: number) => Math.round((v / total) * 100);
    const barStyle = { height: '100%' } as const;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 230 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.125rem 0.625rem', fontSize: 12, color: '#6b7280' }}>
          <span title="Processing — automation is working">⚙ {formatCount(counts.processing)}</span>
          <span
            title="Needs Attention — products that need your judgment"
            style={counts.needs_attention > 0 ? { color: '#dc2626', fontWeight: 700 } : undefined}
          >
            ⚠ {formatCount(counts.needs_attention)}
          </span>
          <span title="Waiting on Family — blocked on sibling readiness">⏳ {formatCount(counts.waiting_on_family)}</span>
          <span title="Ready for Review — awaiting inspection">👁 {formatCount(counts.ready_for_review)}</span>
          <span title="Approved / Ready to Export / Completed" style={{ color: '#16a34a' }}>✓ {formatCount(approvedTotal)}</span>
          {counts.skipped > 0 && <span title="Skipped">⊘ {formatCount(counts.skipped)}</span>}
          <span>({formatCount(total)} total)</span>
        </div>
        <div style={{ height: 6, width: '100%', background: '#e5e7eb', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
          <div style={{ ...barStyle, width: `${pct(counts.needs_attention)}%`, background: '#dc2626' }} />
          <div style={{ ...barStyle, width: `${pct(counts.processing)}%`, background: '#9ca3af' }} />
          <div style={{ ...barStyle, width: `${pct(counts.waiting_on_family)}%`, background: '#f59e0b' }} />
          <div style={{ ...barStyle, width: `${pct(counts.ready_for_review)}%`, background: '#3b82f6' }} />
          <div style={{ ...barStyle, width: `${pct(approvedTotal)}%`, background: '#16a34a' }} />
          {counts.skipped > 0 && <div style={{ ...barStyle, width: `${pct(counts.skipped)}%`, background: '#d1d5db' }} />}
        </div>
      </div>
    );
  };

  const statusLabel = (s: string) => {
    const labels: Record<string, string> = {
      imported: 'Imported',
      discovering: 'Searching sources...',
      source_found: 'Source found',
      source_confirmed: 'Confirmed',
      extracting: 'Scraping page...',
      extracted: 'Scraped',
      needs_review: 'Needs review',
      ready: 'Ready',
      promoted: 'Promoted',
      failed: 'Failed',
      skipped: 'Skipped'
    };
    return labels[s] ?? s;
  };

  const statusStyle = (s: string): React.CSSProperties => {
    const colors: Record<string, { bg: string, text: string }> = {
      imported: { bg: '#f3f4f6', text: '#374151' },
      discovering: { bg: '#dbeafe', text: '#1e40af' },
      source_found: { bg: '#fef3c7', text: '#92400e' },
      source_confirmed: { bg: '#e0f2fe', text: '#0369a1' },
      extracting: { bg: '#eff6ff', text: '#1e40af' },
      extracted: { bg: '#f0fdf4', text: '#166534' },
      needs_review: { bg: '#ffedd5', text: '#c2410c' },
      ready: { bg: '#dcfce7', text: '#15803d' },
      promoted: { bg: '#dcfce7', text: '#15803d' },
      failed: { bg: '#fee2e2', text: '#991b1b' },
      skipped: { bg: '#e5e7eb', text: '#6b7280' }
    };
    const c = colors[s] ?? { bg: '#f3f4f6', text: '#374151' };
    return {
      background: c.bg,
      color: c.text,
      padding: '4px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
      display: 'inline-block'
    };
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0, color: '#111827' },
    btnRow: { display: 'flex', gap: 12 },
    primaryBtn: { background: colors.uniformGreen, color: colors.feedBagCream, border: `1px solid ${colors.shadowPine}`, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
    secondaryBtn: { background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, color: colors.ledgerCharcoal, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
    th: { background: '#f9fafb', borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '12px 16px', color: '#4b5563', fontWeight: 600, fontSize: 13 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '12px 16px', fontSize: 14, color: '#374151' },
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
    modalContent: { background: '#fff', padding: 24, borderRadius: 8, width: '100%', maxWidth: 600, boxSizing: 'border-box' },
    fieldGroup: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }
  };

  if (showSettings) {
    return (
      <OnboardingSettings
        onBack={() => {
          setShowSettings(false);
          const url = new URL(window.location.href);
          if (url.searchParams.has('settingsTab')) {
            url.searchParams.delete('settingsTab');
            window.history.replaceState(null, '', url.toString());
          }
        }}
        initialTab={settingsDeepLinkTab === 'llm' ? undefined : settingsDeepLinkTab ?? undefined}
      />
    );
  }

  // ─── VIEW 1: BATCHES LIST ─────────────────────────────────────────────────────

  if (!selectedBatchId) {
    return (
      <div style={styles.container}>
        <ViewHeader
          title="Product Onboarding"
          description="Automatic acquisition — distributor lookups, official-site fallback, extraction, and family curation — with human review and bulk approval before export."
          actions={
            <>
              <button
                style={{ ...styles.secondaryBtn, background: colors.signetBurgundy, color: colors.feedBagCream, borderColor: colors.burgundyDark }}
                onClick={() => setShowWeeklyReportModal(true)}
              >
                📊 Generate Weekly Report
              </button>
              <button style={styles.secondaryBtn} onClick={() => setShowSettings(true)}>⚙️ Onboarding Settings</button>
              <button style={styles.primaryBtn} onClick={() => setShowUploadModal(true)}>+ Upload Weekly Spreadsheet</button>
            </>
          }
        />

        {error && <div style={{ color: '#dc2626', background: '#fef2f2', padding: 12, borderRadius: 6, marginBottom: 20 }}>{error}</div>}
        {capabilitiesError && !error && (
          <div style={{ color: '#92400e', background: '#fffbeb', padding: 12, borderRadius: 6, marginBottom: 20, fontSize: 13 }}>
            ⚙️ Onboarding capabilities unavailable ({capabilitiesError}) — Sourcing engine treated as disabled.
          </div>
        )}

        {batches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <p style={{ fontSize: 16, color: '#6b7280', margin: '0 0 16px' }}>No onboarding batches uploaded yet.</p>
            <button onClick={() => setShowUploadModal(true)} style={{ ...styles.primaryBtn, margin: '0 auto' }}>Upload Spreadsheet to Start</button>
          </div>
        ) : (
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Batch Name</th>
                  <th style={styles.th}>Filename</th>
                  <th style={styles.th}>Uploaded At</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Progress</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(batch => (
                  <tr
                    key={batch.id}
                    onClick={() => handleSelectBatch(batch.id)}
                    style={{ cursor: 'pointer', transition: 'background 0.2s' }}
                    className="hover-row"
                  >
                    <td style={styles.td}><strong>{batch.name}</strong></td>
                    <td style={styles.td}>{batch.fileName}</td>
                    <td style={styles.td}>{batch.createdAt.slice(0, 19).replace('T', ' ')}</td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={statusStyle(batch.status)}>{statusLabel(batch.status)}</span>
                        {batch.executionState && (
                          <span style={{
                            fontSize: 10,
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontWeight: 700,
                            letterSpacing: '0.025em',
                            background: batch.executionState === 'running' ? '#d1fae5' :
                              batch.executionState === 'paused' ? '#fef3c7' :
                              batch.executionState === 'completed' ? '#e0f2fe' : '#f3f4f6',
                            color: batch.executionState === 'running' ? '#14532d' :
                              batch.executionState === 'paused' ? '#78350f' :
                              batch.executionState === 'completed' ? '#0369a1' : '#4b5563',
                            border: `1px solid ${
                              batch.executionState === 'running' ? '#a7f3d0' :
                              batch.executionState === 'paused' ? '#fde68a' :
                              batch.executionState === 'completed' ? '#bae6fd' : '#e5e7eb'
                            }`,
                          }}>
                            {batch.executionState.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={styles.td} onClick={(e) => e.stopPropagation()}>{renderBatchProgress(batch)}</td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          style={{
                            background: 'var(--color-uniform-green, #14532D)',
                            color: 'var(--color-feed-bag-cream, #FAF9F2)',
                            border: 'none',
                            borderRadius: 4,
                            padding: '5px 10px',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: 12,
                            boxShadow: '0 1px 2px rgba(33,20,20,0.06)',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreflightBatchId(batch.id);
                            setShowPreflightModal(true);
                          }}
                          title="Open Preflight & Brand Resolution Review"
                        >
                          ⚡ Preflight
                        </button>
                        <button
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-signet-burgundy, #760C19)',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: 13,
                          }}
                          onClick={(e) => handleDeleteBatch(batch.id, e)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── UPLOAD MODAL ──────────────────────────────────────────────────────── */}
        {showUploadModal && (
          <div style={styles.modalOverlay}>
            <div style={styles.modalContent}>
              <h2 style={{ margin: '0 0 16px' }}>Upload Onboarding Spreadsheet</h2>
              
              {!uploadFile ? (
                <div style={{ border: '2px dashed #d1d5db', borderRadius: 8, padding: 32, textAlign: 'center', background: '#f9fafb' }}>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                    id="file-upload-input"
                  />
                  <label htmlFor="file-upload-input" style={{ cursor: 'pointer', color: '#2563eb', fontWeight: 600 }}>
                    Click to browse files
                  </label>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: '#6b7280' }}>Accepts .xlsx, .xls, or .csv spreadsheets</p>
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 16px 0' }}>
                    File: <strong>{uploadFile.name}</strong> ({uploadRowsCount} data rows found)
                  </p>

                  {uploadStep === 1 ? (
                    <div>
                      <div style={styles.fieldGroup}>
                        <label style={styles.label}>Onboarding Batch Name</label>
                        <input
                          style={{
                            ...styles.input,
                            width: '100%',
                            padding: 8,
                            border: '1px solid #d1d5db',
                            borderRadius: 6,
                            ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                          }}
                          type="text"
                          value={uploadBatchName}
                          onChange={(e) => setUploadBatchName(e.target.value)}
                          disabled={loadingBrands}
                        />
                      </div>

                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 8px' }}>Map Spreadsheet Columns</h3>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>UPC/SKU Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.upc || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, upc: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Name Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.name || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, name: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Merge Name With Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.nameMergeWith || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, nameMergeWith: e.target.value || null }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Price Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.price || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, price: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Quantity Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.quantity || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, quantity: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Brand Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.brand || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, brand: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Page URL Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.sourceUrl || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, sourceUrl: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'flex-end' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            marginRight: 8,
                            ...(loadingBrands ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => { setUploadFile(null); setShowUploadModal(false); }}
                          disabled={loadingBrands}
                        >
                          Cancel
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loadingBrands ? { opacity: 0.7, cursor: 'not-allowed', background: '#3b82f6' } : {})
                          }}
                          onClick={handleNextStep}
                          disabled={loadingBrands}
                        >
                          {loadingBrands ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Analyzing Brands...
                            </>
                          ) : (
                            'Next →'
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px 0' }}>Confirm Import</h3>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px 0', lineHeight: '1.4' }}>
                        We detected <strong>{detectedBrands.length}</strong> distinct brand(s) in this batch.
                        Brands without configured official domains will be handled during Discovery.
                      </p>

                      {detectedBrands.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#6b7280', fontStyle: 'italic', padding: '12px 0' }}>
                          No brands detected in name/brand columns. Click Create Batch to proceed.
                        </p>
                      ) : (
                        <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, backgroundColor: '#f9fafb' }}>
                          {detectedBrands.map((brand) => {
                            const domain = (brandMappings[brand] || '').trim();
                            return (
                              <div key={brand} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={brand}>
                                  {brand}
                                </span>
                                {domain ? (
                                  <span style={{ fontSize: 13, color: '#166534' }}>
                                    → {domain} (configured)
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 13, color: '#92400e' }}>
                                    No official domain configured — will be resolved during Discovery (items may pause for setup; they will not block upload)
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'space-between' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            ...(loading ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => setUploadStep(1)}
                          disabled={loading}
                        >
                          ← Back
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loading ? { opacity: 0.7, cursor: 'not-allowed', background: '#3b82f6' } : {})
                          }}
                          onClick={handleConfirmBatch}
                          disabled={loading}
                        >
                          {loading ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Creating Batch...
                            </>
                          ) : (
                            'Create Batch'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
        {showPreflightModal && preflightBatchId && (
          <BatchPreflightModal
            batchId={preflightBatchId}
            isOpen={showPreflightModal}
            onClose={() => {
              setShowPreflightModal(false);
              setPreflightBatchId(null);
            }}
            onBatchStarted={() => {
              fetchBatchesList();
            }}
          />
        )}
      </div>
    );
  }

  // ─── VIEW 2: BATCH WORKSPACE (default) or PIPELINE BOARD (diagnostics) ──
  // Epic #46: the six-stage Kanban is no longer the primary operator model.
  // The Batch Workspace is the default; the Pipeline Board remains available
  // as a diagnostics escape hatch via `?board=pipeline` (separate query param
  // so App.tsx's `view` routing is untouched), gated by the rollout flags
  // (src/client/onboarding-feature-flags.ts).
  if (selectedBatchId && selectedBatch) {
    const { batchWorkspaceEnabled, pipelineDiagnosticsEnabled } = getOnboardingFeatureFlags();
    const forcePipelineDiagnostics =
      pipelineDiagnosticsEnabled &&
      new URLSearchParams(window.location.search).get('board') === 'pipeline';
    // Rollout guard: workspace disabled → Pipeline Board (unless the
    // diagnostics surface itself is disabled, which leaves a clear message
    // instead of a blank screen).
    if (!batchWorkspaceEnabled && pipelineDiagnosticsEnabled) {
      return (
        <>
          <div style={{ padding: 24 }}>
            <button
              onClick={handleBackToBatches}
              style={{
                background: 'none',
                border: 'none',
                color: '#1d4ed8',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              ← All Batches
            </button>
            <PipelineBoard
              batchId={selectedBatchId}
              batchName={selectedBatch.name}
              onBack={handleBackToBatches}
              cachedBrandSites={cachedBrandSites}
              _catalogBrands={catalogBrands}
              sourcingEngineEnabled={sourcingEngineEnabled}
              onRefreshBrandSites={loadBrandSites}
              onOpenProfileBuilder={(domain) => {
                const normalized = normalizeBrandHubDomain(domain);
                if (!normalized) return;
                const path = getProfileWorkspacePath(normalized, window.location.pathname + window.location.search);
                window.history.pushState(null, '', path);
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
              onOpenBrandSetup={() => {
                setShowSettings(true);
              }}
            />
          </div>
        </>
      );
    }
    return (
      <>
        {batchWorkspaceEnabled && !forcePipelineDiagnostics ? (
          <BatchWorkspace
            batchId={selectedBatchId}
            batchName={selectedBatch.name}
            onBack={handleBackToBatches}
            onOpenSettings={() => setShowSettings(true)}
            onOpenPreflight={() => {
              setPreflightBatchId(selectedBatchId);
              setShowPreflightModal(true);
            }}
          />
        ) : pipelineDiagnosticsEnabled ? (
          <PipelineBoard
            batchId={selectedBatchId}
            batchName={selectedBatch.name}
            onBack={handleBackToBatches}
            cachedBrandSites={cachedBrandSites}
            _catalogBrands={catalogBrands}
            sourcingEngineEnabled={sourcingEngineEnabled}
            onRefreshBrandSites={loadBrandSites}
            onOpenProfileBuilder={(domain) => {
              const normalized = normalizeBrandHubDomain(domain);
              if (!normalized) return;
              const path = getProfileWorkspacePath(normalized, window.location.pathname + window.location.search);
              window.history.pushState(null, '', path);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
            onOpenBrandSetup={() => {
              setShowSettings(true);
            }}
          />
        ) : (
          <div style={{ padding: 24 }}>
            <ViewHeader
              title="Onboarding unavailable"
              description="Both the Batch Workspace and the Pipeline diagnostics surface are disabled. Enable VITE_BATCH_WORKSPACE_ENABLED or VITE_PIPELINE_DIAGNOSTICS_ENABLED to use onboarding."
            />
            <button onClick={handleBackToBatches} style={styles.secondaryBtn}>← All Batches</button>
          </div>
        )}
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
        {showPreflightModal && preflightBatchId && (
          <BatchPreflightModal
            batchId={preflightBatchId}
            isOpen={showPreflightModal}
            onClose={() => {
              setShowPreflightModal(false);
              setPreflightBatchId(null);
            }}
            onBatchStarted={() => {
              fetchBatchesList();
              if (selectedBatchId) {
                handleSelectBatch(selectedBatchId);
              }
            }}
          />
        )}
      </>
    );
  }

  // No batch selected or batch not loaded
  return null;
}
