/**
 * Epic #46 — Bulk approval view (Phase 7 UI).
 *
 * A deliberate release decision after inspection. Only reviewed items are
 * eligible (server enforces the gate; the UI only fetches reviewed items).
 * Approval NEVER exports. Per-item structured outcomes; partial failures
 * visible and retryable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OnboardingWorkState, ApproveItemsResponse } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState, approveItems, subscribeBatchEvents } from '../../../onboarding-work-api';
import { ExportActions } from './ExportActions';
import { ApprovedQueue } from './ApprovedQueue';
import {
  allSelected,
  clearSelection,
  pruneSelection,
  selectAll,
  summarizeOutcomes,
  toggleSelection,
  type SelectionState,
} from './approved-logic';

interface ApprovedViewProps {
  batchId: string;
}

const PAGE_SIZE = 200;

export function ApprovedView({ batchId }: ApprovedViewProps) {
  const [eligible, setEligible] = useState<OnboardingWorkState[]>([]);
  const [selection, setSelection] = useState<SelectionState>({ selectedIds: [], allEligibleIds: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApproveItemsResponse | null>(null);
  const [showApproveAllConfirm, setShowApproveAllConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadEligible = useCallback(async () => {
    try {
      setError(null);
      const collected: OnboardingWorkState[] = [];
      let offset = 0;
      for (;;) {
        const res = await getBatchWorkState(batchId, {
          category: 'ready_for_review',
          reviewState: 'reviewed',
          limit: PAGE_SIZE,
          offset,
        });
        collected.push(...res.items);
        if (collected.length >= res.total) break;
        offset += PAGE_SIZE;
      }
      setEligible(collected);
      setSelection(prev => pruneSelection(prev, collected.map(it => it.itemId)));
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
        const first = await getBatchWorkState(batchId, {
          category: 'ready_for_review',
          reviewState: 'reviewed',
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        const collected = [...first.items];
        for (let offset = PAGE_SIZE; offset < first.total; offset += PAGE_SIZE) {
          const page = await getBatchWorkState(batchId, {
            category: 'ready_for_review',
            reviewState: 'reviewed',
            limit: PAGE_SIZE,
            offset,
          });
          if (cancelled) return;
          collected.push(...page.items);
        }
        setEligible(collected);
        setSelection(prev => pruneSelection(prev, collected.map(it => it.itemId)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const unsubscribe = subscribeBatchEvents(batchId, event => {
      if (event.type === 'item:status' || event.type === 'batch:progress') loadEligible();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [batchId, loadEligible]);

  const executeApproval = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await approveItems(batchId, ids);
        setResult(res);
        const summary = summarizeOutcomes(res.results);
        if (summary.rejectedCount === 0) {
          setNotice(`${res.approvedCount} product${res.approvedCount === 1 ? '' : 's'} approved.`);
        } else {
          setNotice(
            `${res.approvedCount} approved, ${res.rejectedCount} rejected — see reasons below.`,
          );
        }
        await loadEligible();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setShowApproveAllConfirm(false);
      }
    },
    [batchId, loadEligible],
  );

  const outcomeSummary = useMemo(() => (result ? summarizeOutcomes(result.results) : null), [result]);
  const rejectedById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of result?.rejected ?? []) map.set(r.itemId, r.reason ?? 'Rejected');
    return map;
  }, [result]);

  if (loading) return <div className="ow-loading">Loading approved products…</div>;
  if (error && eligible.length === 0) {
    return (
      <div className="ow-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline" onClick={loadEligible}>Retry</button>
      </div>
    );
  }

  const selectedCount = selection.selectedIds.length;
  const hint = selectedCount === 0 ? 'No reviewed items selected.' : undefined;

  return (
    <div>
      <div className="ow-header" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <h4 className="ow-panel-title" style={{ margin: 0 }}>Bulk approval</h4>
        <span className="ow-audit-line">
          Approval is recorded with actor + time. Approval does not export anything.
        </span>
      </div>

      {notice && (
        <div className="ow-section" style={{ background: 'var(--color-success-bg)', borderColor: 'var(--color-success-border)' }}>
          <span style={{ color: 'var(--color-success-text)' }}>{notice}</span>
        </div>
      )}
      {error && (
        <div className="ow-error" role="alert">
          <span>{error}</span>
        </div>
      )}

      {eligible.length === 0 ? (
        <div className="ow-empty">
          <strong>No reviewed products waiting for approval.</strong>
          <span>
            Products appear here after they are reviewed in the Review tab.
            Unreviewed products can never be bulk-approved.
          </span>
        </div>
      ) : (
        <>
          <ExportActions
            primaryLabel={`Approve selected (${selectedCount})`}
            secondaryLabel="Approve all reviewed"
            primaryDisabled={selectedCount === 0}
            secondaryDisabled={busy}
            busy={busy}
            onPrimary={() => executeApproval(selection.selectedIds)}
            onSecondary={() => setShowApproveAllConfirm(true)}
            hint={hint}
          />

          <ApprovedQueue
            items={eligible}
            selection={selection}
            rejectedReasons={rejectedById}
            onToggle={itemId => setSelection(toggleSelection(selection, itemId))}
            onToggleAll={() =>
              setSelection(allSelected(selection) ? clearSelection(selection) : selectAll(selection))
            }
          />
        </>
      )}

      {outcomeSummary && outcomeSummary.rejectedCount > 0 && (
        <div className="ow-section" style={{ marginTop: 'var(--spacing-sm)' }}>
          <h5 className="ow-section-title">Approval outcome</h5>
          <p className="ow-detail">
            {outcomeSummary.approvedCount} approved · {outcomeSummary.rejectedCount} rejected.
            Rejected products stay above with their reason — resolve and re-approve.
          </p>
        </div>
      )}

      {showApproveAllConfirm && (
        <div
          className="ow-dialog-backdrop"
          role="presentation"
          onMouseDown={e => {
            if (e.target === e.currentTarget) setShowApproveAllConfirm(false);
          }}
        >
          <div className="ow-dialog" role="dialog" aria-modal="true" aria-labelledby="approve-all-title">
            <h3 id="approve-all-title" className="ow-dialog-title">Approve all reviewed products?</h3>
            <p className="ow-detail">
              Approve all {eligible.length} reviewed products in this batch?
              Approval creates no exports — products move to Ready to Export
              and you release them separately.
            </p>
            <div className="ow-dialog-actions">
              <button type="button" className="btn btn-outline" onClick={() => setShowApproveAllConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => executeApproval(eligible.map(it => it.itemId))}
              >
                Approve all {eligible.length}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
