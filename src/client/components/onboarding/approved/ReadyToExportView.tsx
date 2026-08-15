/**
 * Epic #46 — Ready to Export view (Phase 8 UI).
 *
 * Approval ≠ export. Language matches the real side effect: ShopSite
 * DRAFT creation via change sets. 'Exported' only appears for the
 * server-verified `completed` category — never invented client-side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState, subscribeBatchEvents } from '../../../onboarding-work-api';
import { promoteBatchItems } from '../../../onboarding-api';
import { ExportActions } from './ExportActions';
import { exportStatusPresentation } from './approved-logic';

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
    try {
      const res = await promoteBatchItems(batchId, selectedIds);
      setDraftResult(res);
      setNotice(
        res.count > 0
          ? `Created export drafts for ${res.count} product${res.count === 1 ? '' : 's'}.`
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

  return (
    <div>
      <div className="ow-header" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <h4 className="ow-panel-title" style={{ margin: 0 }}>Ready to Export</h4>
        <span className="ow-audit-line">
          Approval and export are separate decisions. Export drafts are created
          here; the Change Set Review performs the actual export package.
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
      {draftResult?.changeSetId && (
        <div className="ow-section" style={{ marginBottom: 'var(--spacing-sm)' }}>
          <span className="ow-detail">
            Export drafts were created in change set{' '}
            <a href="?view=changesets" style={{ fontWeight: 600 }}>{draftResult.changeSetId}</a> —
            open the Change Set Review to run the export package.
          </span>
        </div>
      )}

      {SECTIONS.map(section => {
        const items = bySection[section];
        const pres = exportStatusPresentation(section);
        if (items.length === 0) return null;
        return (
          <div key={section} className="ow-section" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <h5 className="ow-section-title">{pres.heading} ({items.length})</h5>
            <p className="ow-detail">{pres.description}</p>

            {section === 'approved' && (
              <ExportActions
                primaryLabel={`Create export drafts (${selectedIds.length})`}
                primaryDisabled={selectedIds.length === 0}
                busy={busy}
                onPrimary={createDrafts}
                hint={selectedIds.length === 0 ? 'Select approved products to create export drafts.' : undefined}
              />
            )}

            <div className="ow-list" style={{ marginTop: 'var(--spacing-sm)' }}>
              {items.map(item => (
                <div key={item.itemId} className="ow-row">
                  {section === 'approved' ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.name}`}
                      checked={selectedIds.includes(item.itemId)}
                      onChange={() =>
                        setSelectedIds(prev =>
                          prev.includes(item.itemId)
                            ? prev.filter(id => id !== item.itemId)
                            : [...prev, item.itemId],
                        )
                      }
                    />
                  ) : null}
                  <span className="ow-row-main">
                    <span className="ow-row-title">{item.name}</span>
                    <span className="ow-row-sub">
                      UPC {item.upc}{item.brand ? ` · ${item.brand}` : ''}
                    </span>
                  </span>
                  <span className="ow-row-meta">
                    {section === 'completed' && (
                      <span className="ow-chip ow-chip--success">Export verified</span>
                    )}
                    {section === 'ready_to_export' && (
                      <a className="btn btn-primary" href="?view=changesets">
                        Open Change Set Review
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
