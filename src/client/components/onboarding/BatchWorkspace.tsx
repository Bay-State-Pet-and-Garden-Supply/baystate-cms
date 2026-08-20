import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colors, fonts, rounded, typography } from '../../theme';
import {
  getBatchWorkState,
  subscribeBatchEvents,
  type WorkStateFilters,
} from '../../onboarding-work-api';
import type {
  BatchWorkState,
  OnboardingWorkState,
  ReviewState,
  WorkStateCounts,
} from '../../../shared/schemas/onboarding-work-state';
import {
  buildWorkStateFilters,
  formatCount,
  hasActiveFilters,
  reviewStateLabel,
  sourceTypeLabel,
  totalItemCount,
  WORK_STATE_CATEGORY_LABELS,
  workspaceTabForCategory,
  type WorkspaceFilterInput,
  type WorkspaceTabId,
} from './batch-workspace-logic';
import { WorkStateTabs } from './WorkStateTabs';

// ── Sibling feature views (epic #46 wave 2 contract) ─────────────────────────
import { AttentionQueueView } from './attention/AttentionQueueView';
import { OfficialSiteResolutionWorkspace } from './attention/OfficialSiteResolutionWorkspace';
import { ProcessingView } from './processing/ProcessingView';
import { FamilyWaitingView } from './families/FamilyWaitingView';
import { ReviewWorkspace } from './review/ReviewWorkspace';
import { ApprovedView } from './approved/ApprovedView';
import { ReadyToExportView } from './approved/ReadyToExportView';

import './onboarding-workspace.css';

const COUNT_REFRESH_DEBOUNCE_MS = 400;
const FILTER_PAGE_SIZE = 200;

export interface BatchWorkspaceProps {
  batchId: string;
  batchName: string;
  onBack: () => void;
  /** Opens the Onboarding settings page (extractor profiles, distributors…). */
  onOpenSettings?: () => void;
  /** Opens the Preflight & Release Review modal. */
  onOpenPreflight?: () => void;
}

/**
 * Epic #46 — Batch Workspace (UX workstream 1).
 *
 * The Store Manager's primary onboarding surface. Automation owns
 * progression; this shell shows exactly where the operator is needed
 * (Needs Attention), what is progressing on its own (Processing), what is
 * gated on families (Waiting on Family), what awaits final inspection
 * (Review), and what has been released (Approved / Ready to Export).
 *
 * Raw pipeline stage/stage_status are secondary diagnostics only.
 */
export function BatchWorkspace({ batchId, batchName, onBack, onOpenSettings, onOpenPreflight }: BatchWorkspaceProps) {
  const [counts, setCounts] = useState<WorkStateCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('needs_attention');
  const [updating, setUpdating] = useState(false);

  // Cross-category filters (server-owned filtering).
  const [filterInput, setFilterInput] = useState<WorkspaceFilterInput>({});

  // Attention resolution modal.
  const [attentionItemId, setAttentionItemId] = useState<string | null>(null);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshCounts = useCallback(async () => {
    try {
      const res = await getBatchWorkState(batchId, { limit: 1 });
      setCounts(res.counts);
      setCountsError(null);
    } catch (err) {
      setCountsError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  }, [batchId]);

  // Initial load + batch change.
  useEffect(() => {
    setCounts(null);
    setFilterInput({});
    setAttentionItemId(null);
    refreshCounts();
  }, [refreshCounts]);

  // SSE-driven refresh (debounced) — resolved blockers disappear automatically.
  useEffect(() => {
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      setUpdating(true);
      refreshTimer.current = setTimeout(() => {
        refreshCounts();
      }, COUNT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [batchId, refreshCounts]);

  const filters = useMemo(() => buildWorkStateFilters(filterInput), [filterInput]);
  const showFilteredResults = hasActiveFilters(filters);

  const handleOpenItem = useCallback((itemId: string) => {
    setAttentionItemId(itemId);
  }, []);

  const handleFamilyOpenItem = useCallback((itemId: string) => {
    // Blocking siblings live in Needs Attention — jump there and open them.
    setActiveTab('needs_attention');
    setAttentionItemId(itemId);
  }, []);

  const handleResolved = useCallback(() => {
    setAttentionItemId(null);
    refreshCounts();
  }, [refreshCounts]);

  return (
    <div style={{ padding: '16px 24px 32px 24px', fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
      {/* ── Batch header ── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              backgroundColor: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.md,
              padding: '0.4375rem 0.75rem',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: colors.uniformGreen,
              cursor: 'pointer',
              minHeight: 36,
              marginTop: 6,
            }}
            aria-label="Back to batches"
          >
            ← Batches
          </button>
          <div>
            <h1 style={{ ...typography.viewTitle, margin: 0 }}>{batchName}</h1>
            <p style={{ ...typography.viewSubtitle, margin: '0.25rem 0 0 0' }}>
              {counts ? `${formatCount(totalItemCount(counts))} products` : 'Loading…'}
              {updating ? ' · updating…' : ''}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {onOpenPreflight && (
            <button
              type="button"
              onClick={onOpenPreflight}
              style={{
                backgroundColor: colors.uniformGreen,
                border: 'none',
                borderRadius: rounded.md,
                padding: '0.4375rem 0.875rem',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: colors.feedBagCream,
                cursor: 'pointer',
                minHeight: 36,
                boxShadow: 'var(--shadow-sm)',
              }}
              title="Open Preflight & Brand Resolution Review"
            >
              ⚡ Preflight Review
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              style={{
                backgroundColor: 'transparent',
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.md,
                padding: '0.4375rem 0.75rem',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: colors.mulchBrown,
                cursor: 'pointer',
                minHeight: 36,
              }}
            >
              Settings
            </button>
          )}
        </div>
      </div>

      {countsError && (
        <div
          role="alert"
          style={{
            backgroundColor: colors.signetBurgundy,
            color: colors.feedBagCream,
            borderRadius: rounded.md,
            padding: '10px 14px',
            marginBottom: 14,
            fontSize: '0.8125rem',
          }}
        >
          Could not load batch progress: {countsError}
        </div>
      )}

      {counts && (
        <>
          {/* ── Filter bar (server-owned filtering) ── */}
          <div className="bws-filter-bar" role="search" aria-label="Filter products">
            <input
              type="search"
              className="bws-filter-input"
              placeholder="Search UPC, name, or brand…"
              aria-label="Search by UPC, name, or brand"
              value={filterInput.q ?? ''}
              onChange={e => setFilterInput(prev => ({ ...prev, q: e.target.value }))}
              style={{ flex: '1 1 240px', minWidth: 200 }}
            />
            <select
              className="bws-filter-input"
              aria-label="Filter by review state"
              value={filterInput.reviewState ?? ''}
              onChange={e =>
                setFilterInput(prev => ({
                  ...prev,
                  reviewState: (e.target.value || '') as ReviewState | '',
                }))
              }
            >
              <option value="">Any review state</option>
              <option value="unreviewed">Unreviewed</option>
              <option value="reviewed">Reviewed</option>
              <option value="approved">Approved</option>
              <option value="not_ready">Not ready</option>
            </select>
            <select
              className="bws-filter-input"
              aria-label="Filter by source type"
              value={filterInput.sourceType ?? ''}
              onChange={e =>
                setFilterInput(prev => ({
                  ...prev,
                  sourceType: (e.target.value || '') as 'official_page' | 'distributor_record' | '',
                }))
              }
            >
              <option value="">Any source</option>
              <option value="distributor_record">Distributor record</option>
              <option value="official_page">Official page</option>
            </select>
            {showFilteredResults && (
              <button
                type="button"
                className="bws-filter-input"
                style={{ cursor: 'pointer', fontWeight: 600, color: colors.uniformGreen }}
                onClick={() => setFilterInput({})}
              >
                Clear filters
              </button>
            )}
          </div>

          {/* ── Tabs ── */}
          <WorkStateTabs activeId={activeTab} counts={counts} onChange={setActiveTab} />

          <div id="bws-tabpanel" role="tabpanel" aria-labelledby={`bws-tab-${activeTab}`}>
            {showFilteredResults ? (
              <FilteredResultsList batchId={batchId} filters={filters} onOpenItem={handleOpenItem} />
            ) : (
              <TabContent
                tabId={activeTab}
                batchId={batchId}
                onOpenItem={handleOpenItem}
                onOpenFamilyItem={handleFamilyOpenItem}
              />
            )}
          </div>
        </>
      )}

      {!counts && !countsError && (
        <div style={{ padding: 48, textAlign: 'center', color: colors.mulchBrown }}>
          Loading batch progress…
        </div>
      )}

      {/* ── Attention resolution modal (focus-trapped) ── */}
      {attentionItemId && (
        <FocusTrap onClose={() => setAttentionItemId(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Resolve product blocker"
            className="bws-drawer"
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 16px',
                backgroundColor: colors.uniformGreen,
                color: colors.feedBagCream,
              }}
            >
              <strong style={{ fontFamily: fonts.body, fontSize: '0.875rem' }}>
                Resolve product blocker
              </strong>
              <button
                type="button"
                onClick={() => setAttentionItemId(null)}
                aria-label="Close resolution workspace"
                style={{
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: colors.feedBagCream,
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  lineHeight: 1,
                  padding: '0.25rem 0.5rem',
                  minHeight: 32,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              <OfficialSiteResolutionWorkspace
                batchId={batchId}
                itemId={attentionItemId}
                onResolved={handleResolved}
              />
            </div>
          </div>
        </FocusTrap>
      )}
    </div>
  );
}

// ─── Tab content ───────────────────────────────────────────────────────────────

function TabContent({
  tabId,
  batchId,
  onOpenItem,
  onOpenFamilyItem,
}: {
  tabId: WorkspaceTabId;
  batchId: string;
  onOpenItem: (itemId: string) => void;
  onOpenFamilyItem: (itemId: string) => void;
}) {
  switch (tabId) {
    case 'needs_attention':
      return <AttentionQueueView batchId={batchId} onOpenItem={onOpenItem} />;
    case 'processing':
      return <ProcessingView batchId={batchId} />;
    case 'waiting_on_family':
      return <FamilyWaitingView batchId={batchId} onOpenItem={onOpenFamilyItem} />;
    case 'review':
      return <ReviewWorkspace batchId={batchId} />;
    case 'approved':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ApprovedView batchId={batchId} />
          <ReadyToExportView batchId={batchId} />
        </div>
      );
    default:
      return null;
  }
}

// ─── Cross-category filtered results ───────────────────────────────────────────

function FilteredResultsList({
  batchId,
  filters,
  onOpenItem,
}: {
  batchId: string;
  filters: WorkStateFilters;
  onOpenItem: (itemId: string) => void;
}) {
  const [data, setData] = useState<BatchWorkState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      try {
        const res = await getBatchWorkState(batchId, {
          ...filters,
          limit: FILTER_PAGE_SIZE,
          offset: nextOffset,
        });
        setData(prev =>
          prev && nextOffset > 0
            ? { ...res, items: [...prev.items, ...res.items] }
            : res,
        );
        setOffset(nextOffset);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [batchId, filters],
  );

  useEffect(() => {
    setData(null);
    setOffset(0);
    load(0);
    // Key on the serialized filter shape so object identity churn never
    // retriggers the fetch; only actual filter changes do.
  }, [JSON.stringify(filters)]);

  if (error) {
    return (
      <div role="alert" style={{ color: colors.signetBurgundy, padding: '1rem 0' }}>
        Failed to load results: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="bws-muted" style={{ padding: '1rem 0' }}>Loading results…</div>;
  }
  if (data.items.length === 0) {
    return (
      <div className="bws-muted" style={{ padding: '2rem 1rem', textAlign: 'center' }}>
        No products match your filters.
      </div>
    );
  }

  return (
    <div>
      <p className="bws-muted" style={{ margin: '0 0 8px 0', fontSize: '0.8125rem' }}>
        {formatCount(data.total)} matching {data.total === 1 ? 'product' : 'products'}
      </p>
      <table className="bws-results-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Work state</th>
            <th>Review</th>
            <th>Source</th>
            <th>Family</th>
            <th>Stage</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map(item => (
            <ResultRow key={item.itemId} item={item} onOpenItem={onOpenItem} />
          ))}
        </tbody>
      </table>
      {data.total > data.items.length && (
        <button
          type="button"
          onClick={() => load(offset + FILTER_PAGE_SIZE)}
          disabled={loading}
          style={{
            marginTop: 12,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.5rem 0.875rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 36,
          }}
        >
          {loading ? 'Loading…' : `Load more (${formatCount(data.total - data.items.length)} remaining)`}
        </button>
      )}
    </div>
  );
}

function ResultRow({
  item,
  onOpenItem,
}: {
  item: OnboardingWorkState;
  onOpenItem: (itemId: string) => void;
}) {
  const tab = workspaceTabForCategory(item.category);
  const urgent = item.category === 'needs_attention';
  const canOpen = urgent && tab === 'needs_attention';
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{item.name || item.upc}</div>
        <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
          {item.upc}
          {item.brand ? ` · ${item.brand}` : ''}
        </div>
      </td>
      <td>
        <div style={{ fontWeight: 600, color: urgent ? colors.signetBurgundy : colors.uniformGreen }}>
          {WORK_STATE_CATEGORY_LABELS[item.category]}
        </div>
        <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
          {item.label}
        </div>
        {canOpen && (
          <button
            type="button"
            onClick={() => onOpenItem(item.itemId)}
            style={{
              marginTop: 4,
              backgroundColor: 'transparent',
              border: 'none',
              color: colors.uniformGreen,
              fontWeight: 600,
              fontSize: '0.75rem',
              cursor: 'pointer',
              padding: 0,
              minHeight: 28,
              textAlign: 'left',
            }}
          >
            Resolve →
          </button>
        )}
      </td>
      <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
        {item.reviewState ? reviewStateLabel(item.reviewState) : '—'}
      </td>
      <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
        {sourceTypeLabel(item.sourceType)}
        {item.domain ? <div style={{ fontSize: '0.6875rem' }}>{item.domain}</div> : null}
      </td>
      <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
        {item.family
          ? `${item.family.readyCount}/${item.family.memberCount} ready`
          : '—'}
      </td>
      <td>
        <span className="bws-stage-badge" title={`Raw pipeline state: ${item.stage} / ${item.stageStatus}`}>
          {item.stage}
        </span>
      </td>
    </tr>
  );
}

// ─── Focus trap for the resolution modal ───────────────────────────────────────

function FocusTrap({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const el = containerRef.current;
    if (el) {
      const focusables = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = Array.from(focusables).find(f => !f.hasAttribute('disabled'));
      if (first) first.focus();
      else el.focus();
    }
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = containerRef.current;
    if (!el) return;
    const focusables = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(f => !f.hasAttribute('disabled'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !el.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !el.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="bws-overlay" ref={containerRef} onKeyDown={handleKeyDown} role="presentation">
      {children}
    </div>
  );
}
