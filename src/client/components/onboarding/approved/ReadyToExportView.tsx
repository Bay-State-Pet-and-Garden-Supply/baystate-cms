/**
 * Epic #46 & Impeccable — Ready to Export view (Phase 8 UI).
 *
 * The Store Manager's catalog release control room:
 * 1. Visual Release Funnel: Approved → Staged in Change Sets → Export Verified
 * 2. High-density Dual View: Rich Product Cards & Fast Scanning Table
 * 3. Pre-Export Product Inspector Drawer for zero-ambiguity ShopSite XML audit
 * 4. Deterministic ShopSite draft promotion into Git-versioned change sets
 * 5. Idempotent draft creation: Idempotency-Key header engages scoped receipt replay
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  getBatchWorkState,
  getBatchWorkStateCounts,
  subscribeBatchEvents,
  createExportDrafts,
  type CreateExportDraftsResponse,
} from '../../../onboarding-work-api';
import { ExportActions } from './ExportActions';
import { ExportInspectorDrawer } from './ExportInspectorDrawer';
import { exportStatusPresentation } from './approved-logic';
import './approved.css';

interface ReadyToExportViewProps {
  batchId: string;
}

const PAGE_SIZE = 200;

type SectionKey = 'approved' | 'ready_to_export' | 'completed';

const SECTIONS: SectionKey[] = ['approved', 'ready_to_export', 'completed'];

export function ReadyToExportView({ batchId }: ReadyToExportViewProps) {
  const [bySection, setBySection] = useState<Record<SectionKey, OnboardingWorkState[]>>({
    approved: [],
    ready_to_export: [],
    completed: [],
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<CreateExportDraftsResponse | null>(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | SectionKey>('all');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [inspectingItemId, setInspectingItemId] = useState<string | null>(null);

  // Retain Idempotency-Key per logical operation (exportIdempotencyKeyRef)
  const exportIdempotencyKeyRef = useRef<{ key: string; fingerprint: string } | null>(null);

  const loadSections = useCallback(async () => {
    try {
      setError(null);
      const results = await Promise.all(
        SECTIONS.map(async category => {
          const collected: OnboardingWorkState[] = [];
          let offset = 0;
          for (;;) {
            const res = await getBatchWorkState(batchId, { category, limit: PAGE_SIZE, offset });
            collected.push(...res.items);
            if (collected.length >= res.total) break;
            offset += PAGE_SIZE;
          }
          return [category, collected] as const;
        }),
      );
      const next = { approved: [] as OnboardingWorkState[], ready_to_export: [] as OnboardingWorkState[], completed: [] as OnboardingWorkState[] };
      for (const [category, items] of results) next[category] = items;
      setBySection(next);
      const validIds = new Set([...next.approved].map(it => it.itemId));
      setSelectedIds(prev => prev.filter(id => validIds.has(id)));
      try {
        const healthRes = await getBatchWorkStateCounts(batchId);
        setIsDegraded(healthRes.projectionHealth?.status === 'degraded');
      } catch {
        setIsDegraded(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const results = await Promise.all(
          SECTIONS.map(async category => {
            const collected: OnboardingWorkState[] = [];
            let offset = 0;
            for (;;) {
              const res = await getBatchWorkState(batchId, { category, limit: PAGE_SIZE, offset });
              if (cancelled) return [category, collected] as const;
              collected.push(...res.items);
              if (collected.length >= res.total) break;
              offset += PAGE_SIZE;
            }
            return [category, collected] as const;
          }),
        );
        if (cancelled) return;
        const next = { approved: [] as OnboardingWorkState[], ready_to_export: [] as OnboardingWorkState[], completed: [] as OnboardingWorkState[] };
        for (const [category, items] of results) next[category] = items;
        setBySection(next);
        const validIds = new Set([...next.approved].map(it => it.itemId));
        setSelectedIds(prev => prev.filter(id => validIds.has(id)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const unsubscribe = subscribeBatchEvents(batchId, event => {
      if (event.type === 'item:status' || event.type === 'batch:progress') loadSections();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [batchId, loadSections]);

  const handleCreateDrafts = useCallback(
    async (targetIds?: string[]) => {
      const idsToPromote = targetIds || selectedIds;
      if (idsToPromote.length === 0) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      setDraftResult(null);

      // Manage idempotency key with payload fingerprinting
      const fingerprint = [...idsToPromote].sort().join(',');
      const stored = exportIdempotencyKeyRef.current;
      if (!stored || stored.fingerprint !== fingerprint) {
        let newKey: string;
        try {
          newKey = typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
            ? (crypto as any).randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        } catch {
          newKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
        exportIdempotencyKeyRef.current = { key: newKey, fingerprint };
      }
      const currentKey = exportIdempotencyKeyRef.current!.key;

      try {
        const res = await createExportDrafts(batchId, idsToPromote, { idempotencyKey: currentKey });
        // Clear on success / replay
        exportIdempotencyKeyRef.current = null;
        setDraftResult(res);
        setNotice(
          res.createdCount > 0
            ? `Created export drafts for ${res.createdCount} product${res.createdCount === 1 ? '' : 's'}${res.changeSetId ? ` in change set ${res.changeSetId}` : ''}.`
            : 'No export drafts were created — check the selected products.',
        );
        await loadSections();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [batchId, selectedIds, loadSections],
  );

  const total = useMemo(
    () => bySection.approved.length + bySection.ready_to_export.length + bySection.completed.length,
    [bySection],
  );

  const filteredBySection = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return bySection;
    const filterItem = (it: OnboardingWorkState) =>
      it.name.toLowerCase().includes(query) ||
      (it.curatedTitle && it.curatedTitle.toLowerCase().includes(query)) ||
      (it.upc && it.upc.toLowerCase().includes(query)) ||
      (it.brand && it.brand.toLowerCase().includes(query));

    return {
      approved: bySection.approved.filter(filterItem),
      ready_to_export: bySection.ready_to_export.filter(filterItem),
      completed: bySection.completed.filter(filterItem),
    };
  }, [bySection, filterText]);

  const visibleApproved = filteredBySection.approved;
  const allApprovedSelected =
    visibleApproved.length > 0 && visibleApproved.every(it => selectedIds.includes(it.itemId));
  const toggleAllApproved = () =>
    setSelectedIds(prev =>
      allApprovedSelected
        ? prev.filter(id => !visibleApproved.some(it => it.itemId === id))
        : [...new Set([...prev, ...visibleApproved.map(it => it.itemId)])],
    );

  const inspectingItem = useMemo(() => {
    if (!inspectingItemId) return null;
    return (
      bySection.approved.find(it => it.itemId === inspectingItemId) ||
      bySection.ready_to_export.find(it => it.itemId === inspectingItemId) ||
      bySection.completed.find(it => it.itemId === inspectingItemId) ||
      null
    );
  }, [inspectingItemId, bySection]);

  if (loading) {
    return (
      <div className="ow-loading">
        <span className="ow-spinner" /> Loading catalog release pipeline…
      </div>
    );
  }

  if (error && total === 0) {
    return (
      <div className="ow-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={loadSections}>
          Retry
        </button>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="ow-empty">
        <strong>No products in the release pipeline yet.</strong>
        <span>
          Products that are inspected in the <strong>Review</strong> tab and approved in <strong>Approved</strong> land here to generate ShopSite export drafts and stage catalog change sets.
        </span>
      </div>
    );
  }

  const sectionsToRender = activeTab === 'all' ? SECTIONS : [activeTab];

  return (
    <div className="ow-export-dashboard">
      {/* ── KPI & Release Funnel Header ── */}
      <div className="ow-funnel-header">
        <div className="ow-funnel-title-area">
          <div className="ow-header">
            <h4 className="ow-panel-title">Catalog Release & Export Pipeline</h4>
            <span className="ow-audit-line">
              Audited 3-stage release: Approved → Staged in Change Sets → Uploaded & Verified
            </span>
          </div>
        </div>

        <div className="ow-funnel-metrics" role="tablist" aria-label="Release funnel stages">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            className={`ow-funnel-stat ${activeTab === 'all' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <span className="ow-funnel-num">{total}</span>
            <span className="ow-funnel-label">Total in Pipeline</span>
          </button>
          <div className="ow-funnel-arrow" aria-hidden="true">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'approved'}
            className={`ow-funnel-stat ow-funnel-stat--approved ${activeTab === 'approved' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('approved')}
          >
            <span className="ow-funnel-num">{bySection.approved.length}</span>
            <span className="ow-funnel-label">1. Awaiting Drafts</span>
          </button>
          <div className="ow-funnel-arrow" aria-hidden="true">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ready_to_export'}
            className={`ow-funnel-stat ow-funnel-stat--ready ${activeTab === 'ready_to_export' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('ready_to_export')}
          >
            <span className="ow-funnel-num">{bySection.ready_to_export.length}</span>
            <span className="ow-funnel-label">2. Staged in Change Sets</span>
          </button>
          <div className="ow-funnel-arrow" aria-hidden="true">→</div>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'completed'}
            className={`ow-funnel-stat ow-funnel-stat--completed ${activeTab === 'completed' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('completed')}
          >
            <span className="ow-funnel-num">{bySection.completed.length}</span>
            <span className="ow-funnel-label">3. Export Verified</span>
          </button>
        </div>
      </div>

      {/* ── Search, Filters & Batch Toolbar ── */}
      <div className="ow-toolbar">
        <div className="ow-search-box">
          <svg className="ow-search-icon" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            className="ow-search-input"
            placeholder="Search by title, brand, or UPC…"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          {filterText && (
            <button type="button" className="ow-search-clear" onClick={() => setFilterText('')}>
              Clear
            </button>
          )}
        </div>

        <div className="ow-toolbar-controls">
          {/* View Mode Toggle */}
          <div className="ow-view-toggle" role="group" aria-label="Layout view mode">
            <button
              type="button"
              className={`ow-view-btn ${viewMode === 'cards' ? 'ow-view-btn--active' : ''}`}
              onClick={() => setViewMode('cards')}
              title="Rich card grid view"
            >
              Cards
            </button>
            <button
              type="button"
              className={`ow-view-btn ${viewMode === 'table' ? 'ow-view-btn--active' : ''}`}
              onClick={() => setViewMode('table')}
              title="High-density table view"
            >
              Table
            </button>
          </div>

          {/* Batch Actions for Approved items */}
          {bySection.approved.length > 0 && (
            <div className="ow-toolbar-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={toggleAllApproved}
                disabled={isDegraded || visibleApproved.length === 0}
              >
                {allApprovedSelected
                  ? 'Deselect All'
                  : `Select All Awaiting (${visibleApproved.length})`}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => handleCreateDrafts()}
                disabled={selectedIds.length === 0 || isDegraded || busy}
              >
                {busy ? 'Creating Drafts…' : `⚡ Create Export Drafts (${selectedIds.length})`}
              </button>
            </div>
          )}

          {/* Direct CTA to Change Set Review when items are ready */}
          {bySection.ready_to_export.length > 0 && (
            <a
              href="?view=changesets"
              className="btn btn-secondary btn-sm"
              title="Review and push change sets to ShopSite"
            >
              Open Change Set Review →
            </a>
          )}
        </div>
      </div>

      {/* ── Banners & Notifications ── */}
      {notice && (
        <div
          className="ow-section ow-notice-banner"
          style={{
            background: 'var(--color-success-bg)',
            borderColor: 'var(--color-success-border)',
            color: 'var(--color-success-text)',
          }}
        >
          <span>{notice}</span>
        </div>
      )}

      {draftResult?.changeSetId && (
        <div className="ow-changeset-alert">
          <span className="ow-detail">
            Export drafts successfully created in Change Set{' '}
            <a
              href="?view=changesets"
              style={{ fontWeight: 700, color: 'var(--color-uniform-green)', textDecoration: 'underline' }}
            >
              {draftResult.changeSetId}
            </a>
            . Open the Change Set Review to inspect and run the ShopSite CGI upload package.
          </span>
          <a href="?view=changesets" className="btn btn-primary btn-sm">
            Review Change Set →
          </a>
        </div>
      )}

      {error && (
        <div className="ow-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {/* ── Section Cards List ── */}
      {sectionsToRender.map(section => {
        const items = filteredBySection[section];
        const rawCount = bySection[section].length;
        const pres = exportStatusPresentation(section);
        if (rawCount === 0) return null;

        return (
          <div key={section} className={`ow-section ow-dashboard-section ow-section--${section}`}>
            <div className="ow-section-header">
              <div className="ow-section-header-left">
                <span className={`ow-section-badge ow-section-badge--${section}`} />
                <h5 className="ow-section-title">
                  {pres.heading}{' '}
                  <span className="ow-count-pill">
                    {items.length}
                    {items.length !== rawCount ? ` of ${rawCount}` : ''}
                  </span>
                </h5>
              </div>
              {section === 'approved' && (
                <ExportActions
                  primaryLabel={`Create drafts for selected (${selectedIds.length})`}
                  primaryDisabled={selectedIds.length === 0 || isDegraded}
                  secondaryLabel={
                    allApprovedSelected ? 'Deselect visible' : `Select visible (${items.length})`
                  }
                  secondaryDisabled={items.length === 0 || isDegraded}
                  busy={busy}
                  onPrimary={() => handleCreateDrafts()}
                  onSecondary={toggleAllApproved}
                  hint={
                    isDegraded
                      ? 'Projection degraded — cannot create drafts'
                      : selectedIds.length === 0
                        ? 'Select approved products above to create ShopSite export drafts.'
                        : undefined
                  }
                />
              )}
            </div>
            <p className="ow-detail ow-section-desc">{pres.description}</p>

            {items.length === 0 && filterText ? (
              <div className="ow-no-matches">
                No items in <em>{pres.heading}</em> match "{filterText}".
              </div>
            ) : viewMode === 'cards' ? (
              /* ── Rich Card Grid View ── */
              <div className="ow-cards-grid">
                {items.map(item => {
                  const isSelected = selectedIds.includes(item.itemId);
                  const isApproved = section === 'approved';
                  return (
                    <div
                      key={item.itemId}
                      className={`ow-product-card ${isSelected ? 'ow-product-card--selected' : ''}`}
                      onClick={() => {
                        if (isApproved) {
                          setSelectedIds(prev =>
                            prev.includes(item.itemId)
                              ? prev.filter(id => id !== item.itemId)
                              : [...prev, item.itemId],
                          );
                        } else {
                          setInspectingItemId(item.itemId);
                        }
                      }}
                    >
                      <div className="ow-card-top">
                        {isApproved && (
                          <div className="ow-card-checkbox-wrapper">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.name}`}
                              checked={isSelected}
                              onChange={e => {
                                e.stopPropagation();
                                setSelectedIds(prev =>
                                  prev.includes(item.itemId)
                                    ? prev.filter(id => id !== item.itemId)
                                    : [...prev, item.itemId],
                                );
                              }}
                            />
                          </div>
                        )}
                        <div className="ow-card-thumb-container">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              className="ow-card-thumb-img"
                              loading="lazy"
                              onError={e => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <span className="ow-card-thumb-placeholder">📦</span>
                          )}
                        </div>
                        <div className="ow-card-info">
                          {item.brand && <span className="ow-card-brand">{item.brand}</span>}
                          <span className="ow-card-title">{item.curatedTitle || item.name}</span>
                          <div className="ow-card-meta">
                            {item.upc ? (
                              <code className="ow-sku-code">UPC {item.upc}</code>
                            ) : (
                              <span className="ow-no-upc">No UPC</span>
                            )}
                            {item.weight && <span className="ow-chip">{item.weight}</span>}
                          </div>
                        </div>
                      </div>

                      <div className="ow-card-bottom">
                        <div>
                          {section === 'completed' && (
                            <span className="ow-status-pill ow-status-pill--completed">
                              ✓ Export Verified
                            </span>
                          )}
                          {section === 'ready_to_export' && (
                            <span className="ow-status-pill ow-status-pill--ready_to_export">
                              Draft in Change Set
                            </span>
                          )}
                          {section === 'approved' && (
                            <span className="ow-status-pill ow-status-pill--approved">
                              Awaiting Draft
                            </span>
                          )}
                        </div>
                        <div className="ow-card-actions">
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            style={{ height: '2rem', padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                            onClick={e => {
                              e.stopPropagation();
                              setInspectingItemId(item.itemId);
                            }}
                          >
                            Inspect XML 🔍
                          </button>
                          {section === 'ready_to_export' && (
                            <a
                              href="?view=changesets"
                              className="btn btn-primary btn-sm"
                              style={{ height: '2rem', padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                              onClick={e => e.stopPropagation()}
                            >
                              Change Sets →
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ── High-Density Table View ── */
              <div className="ow-list ow-dashboard-list">
                {items.map(item => {
                  const isSelected = selectedIds.includes(item.itemId);
                  const isApproved = section === 'approved';
                  return (
                    <div
                      key={item.itemId}
                      className={`ow-row ${isSelected ? 'ow-row--selected' : ''}`}
                      onClick={() => {
                        if (isApproved) {
                          setSelectedIds(prev =>
                            prev.includes(item.itemId)
                              ? prev.filter(id => id !== item.itemId)
                              : [...prev, item.itemId],
                          );
                        } else {
                          setInspectingItemId(item.itemId);
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {isApproved && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.name}`}
                          checked={isSelected}
                          onChange={e => {
                            e.stopPropagation();
                            setSelectedIds(prev =>
                              prev.includes(item.itemId)
                                ? prev.filter(id => id !== item.itemId)
                                : [...prev, item.itemId],
                            );
                          }}
                        />
                      )}
                      <div className="ow-row-thumb">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            className="ow-row-thumb-img"
                            loading="lazy"
                            onError={e => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: '1rem' }}>📦</span>
                        )}
                      </div>
                      <span className="ow-row-main">
                        <span className="ow-row-title">{item.curatedTitle || item.name}</span>
                        <span className="ow-row-sub">
                          {item.brand && <span className="ow-brand-tag">{item.brand}</span>}
                          {item.upc ? (
                            <code className="ow-sku-code">UPC: {item.upc}</code>
                          ) : (
                            <span className="ow-no-upc">No UPC</span>
                          )}
                          {item.weight && <span>{item.weight}</span>}
                        </span>
                      </span>
                      <span className="ow-row-meta">
                        {section === 'completed' && (
                          <span className="ow-chip ow-chip--success">✓ Export verified</span>
                        )}
                        {section === 'ready_to_export' && (
                          <a
                            className="btn btn-primary btn-sm"
                            href="?view=changesets"
                            onClick={e => e.stopPropagation()}
                          >
                            Open Change Set →
                          </a>
                        )}
                        {section === 'approved' && isSelected && (
                          <span className="ow-chip ow-chip--selected">Selected</span>
                        )}
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={e => {
                            e.stopPropagation();
                            setInspectingItemId(item.itemId);
                          }}
                        >
                          Inspect 🔍
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Pre-Export Product Inspector Drawer ── */}
      {inspectingItemId && (
        <ExportInspectorDrawer
          itemId={inspectingItemId}
          workState={inspectingItem}
          onClose={() => setInspectingItemId(null)}
          onCreateDraftSingle={async (id: string) => {
            await handleCreateDrafts([id]);
          }}
          busy={busy}
        />
      )}
    </div>
  );
}
