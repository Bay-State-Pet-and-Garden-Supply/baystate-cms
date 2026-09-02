/**
 * Epic #46 — Ready to Export view (Phase 8 UI).
 *
 * Approval ≠ export. Language matches the real side effect: ShopSite
 * DRAFT creation via change sets. 'Exported' only appears for the
 * server-verified `completed` category — never invented client-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState, getBatchWorkStateCounts, subscribeBatchEvents, createExportDrafts } from '../../../onboarding-work-api';
import { ExportActions } from './ExportActions';
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
  const [draftResult, setDraftResult] = useState<{ count: number; changeSetId: string | null } | null>(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | SectionKey>('all');
  const exportIdempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    exportIdempotencyKeyRef.current = null;
  }, [JSON.stringify(selectedIds)]);

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
      } catch { setIsDegraded(false); }
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

  const createDrafts = useCallback(async () => {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setDraftResult(null);
    if (!exportIdempotencyKeyRef.current) {
      try {
        exportIdempotencyKeyRef.current = typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
          ? (crypto as any).randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      } catch {
        exportIdempotencyKeyRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
    }
    const currentKey = exportIdempotencyKeyRef.current as string;
    try {
      const res = await createExportDrafts(batchId, selectedIds, { idempotencyKey: currentKey });
      exportIdempotencyKeyRef.current = null;
      setDraftResult({ count: res.createdCount, changeSetId: res.changeSetId });
      setNotice(
        res.createdCount > 0
          ? `Created export drafts for ${res.createdCount} product${res.createdCount === 1 ? '' : 's'}.`
          : 'No export drafts were created — check the products above.',
      );
      await loadSections();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [batchId, selectedIds, loadSections]);

  const total = useMemo(
    () => bySection.approved.length + bySection.ready_to_export.length + bySection.completed.length,
    [bySection],
  );

  const filteredBySection = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return bySection;
    const filterItem = (it: OnboardingWorkState) =>
      it.name.toLowerCase().includes(query) ||
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

  if (loading) return <div className="ow-loading">Loading export status…</div>;
  if (error && total === 0) {
    return (
      <div className="ow-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline" onClick={loadSections}>Retry</button>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="ow-empty">
        <strong>Nothing approved yet.</strong>
        <span>
          Reviewed products that receive the bulk approval decision appear here,
          then move to Ready to Export when export drafts are created.
        </span>
      </div>
    );
  }

  const sectionsToRender = activeTab === 'all' ? SECTIONS : [activeTab];

  return (
    <div className="ow-export-dashboard">
      {/* Operative Funnel Header */}
      <div className="ow-funnel-header">
        <div className="ow-funnel-title-area">
          <h4 className="ow-panel-title">Export Draft Management</h4>
          <span className="ow-audit-line">
            Separate stages ensure catalog changes are audited before creating ShopSite export drafts.
          </span>
        </div>

        <div className="ow-funnel-metrics">
          <button
            type="button"
            className={`ow-funnel-stat ${activeTab === 'all' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <span className="ow-funnel-num">{total}</span>
            <span className="ow-funnel-label">Total Items</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            className={`ow-funnel-stat ow-funnel-stat--approved ${activeTab === 'approved' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('approved')}
          >
            <span className="ow-funnel-num">{bySection.approved.length}</span>
            <span className="ow-funnel-label">Awaiting Drafts</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            className={`ow-funnel-stat ow-funnel-stat--ready ${activeTab === 'ready_to_export' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('ready_to_export')}
          >
            <span className="ow-funnel-num">{bySection.ready_to_export.length}</span>
            <span className="ow-funnel-label">Ready to Export</span>
          </button>
          <div className="ow-funnel-arrow">→</div>
          <button
            type="button"
            className={`ow-funnel-stat ow-funnel-stat--completed ${activeTab === 'completed' ? 'ow-funnel-stat--active' : ''}`}
            onClick={() => setActiveTab('completed')}
          >
            <span className="ow-funnel-num">{bySection.completed.length}</span>
            <span className="ow-funnel-label">Export Verified</span>
          </button>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="ow-toolbar">
        <div className="ow-search-box">
          <svg className="ow-search-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            type="search"
            className="ow-search-input"
            placeholder="Search items by title, brand, or UPC..."
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          {filterText && (
            <button type="button" className="ow-search-clear" onClick={() => setFilterText('')}>
              Clear
            </button>
          )}
        </div>

        {bySection.approved.length > 0 && (
          <div className="ow-toolbar-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={toggleAllApproved}
              disabled={isDegraded || visibleApproved.length === 0}
            >
              {allApprovedSelected ? 'Deselect All Approved' : `Select All Awaiting (${visibleApproved.length})`}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={createDrafts}
              disabled={selectedIds.length === 0 || isDegraded || busy}
            >
              {busy ? 'Creating Drafts…' : `Create Export Drafts (${selectedIds.length})`}
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className="ow-section ow-notice-banner" style={{ background: 'var(--color-success-bg)', borderColor: 'var(--color-success-border)' }}>
          <span style={{ color: 'var(--color-success-text)' }}>{notice}</span>
        </div>
      )}
      {error && (
        <div className="ow-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {draftResult?.changeSetId && (
        <div className="ow-section ow-changeset-alert">
          <span className="ow-detail">
            Export drafts were created in change set{' '}
            <a href="?view=changesets" style={{ fontWeight: 600, color: 'var(--color-uniform-green)' }}>
              {draftResult.changeSetId}
            </a> — open the Change Set Review to run the export package.
          </span>
        </div>
      )}

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
                  {pres.heading} <span className="ow-count-pill">{items.length}{items.length !== rawCount ? ` of ${rawCount}` : ''}</span>
                </h5>
              </div>
              {section === 'approved' && (
                <ExportActions
                  primaryLabel={`Create drafts for selected (${selectedIds.length})`}
                  primaryDisabled={selectedIds.length === 0 || isDegraded}
                  secondaryLabel={allApprovedSelected ? 'Deselect visible' : `Select visible (${items.length})`}
                  secondaryDisabled={items.length === 0 || isDegraded}
                  busy={busy}
                  onPrimary={createDrafts}
                  onSecondary={toggleAllApproved}
                  hint={isDegraded ? 'Projection degraded — cannot create drafts' : selectedIds.length === 0 ? 'Select approved products to create export drafts.' : undefined}
                />
              )}
            </div>
            <p className="ow-detail ow-section-desc">{pres.description}</p>

            {items.length === 0 && filterText ? (
              <div className="ow-no-matches">
                No items in <em>{pres.heading}</em> match "{filterText}".
              </div>
            ) : (
              <div className="ow-list ow-dashboard-list">
                {items.map(item => (
                  <div
                    key={item.itemId}
                    className={`ow-row ${selectedIds.includes(item.itemId) ? 'ow-row--selected' : ''}`}
                    onClick={() => {
                      if (section === 'approved') {
                        setSelectedIds(prev =>
                          prev.includes(item.itemId)
                            ? prev.filter(id => id !== item.itemId)
                            : [...prev, item.itemId],
                        );
                      }
                    }}
                    style={{ cursor: section === 'approved' ? 'pointer' : 'default' }}
                  >
                    {section === 'approved' ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.name}`}
                        checked={selectedIds.includes(item.itemId)}
                        onChange={e => {
                          e.stopPropagation();
                          setSelectedIds(prev =>
                            prev.includes(item.itemId)
                              ? prev.filter(id => id !== item.itemId)
                              : [...prev, item.itemId],
                          );
                        }}
                      />
                    ) : null}
                    <span className="ow-row-main">
                      <span className="ow-row-title">{item.name}</span>
                      <span className="ow-row-sub">
                        {item.upc ? <code className="ow-sku-code">UPC: {item.upc}</code> : <span className="ow-no-upc">No UPC</span>}
                        {item.brand ? <span className="ow-brand-tag"> · {item.brand}</span> : ''}
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
                          Open Change Set Review →
                        </a>
                      )}
                      {section === 'approved' && selectedIds.includes(item.itemId) && (
                        <span className="ow-chip ow-chip--selected">Selected</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
