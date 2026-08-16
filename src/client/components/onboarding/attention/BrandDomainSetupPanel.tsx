/**
 * ADR 0017 — batch-level 'Resolve Brand Domains' setup queue.
 *
 * Mirrors the DomainBlockerPanel pattern (epic #46 follow-up): instead of N
 * indistinguishable attention rows, the operator sees one task per brand —
 * "assign domain for BUTCHERS — unblocks 7 products". Entering the official
 * domain upserts the brand→domain mapping via the same guarded service the
 * per-item Assign Domain action uses, and the server re-queues every blocked
 * discovery item for the brand; the panel refreshes and the row disappears.
 *
 * Renders nothing when the batch has no unmapped-brand blockers.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrandDomainSetupBlocker,
  BrandDomainSetupResponse,
} from '../../../../shared/schemas/onboarding-work-state';
import { getBrandDomainBlockers, assignBatchBrandDomain } from '../../../onboarding-work-api';
import './attention.css';

interface BrandDomainSetupPanelProps {
  batchId: string;
}

interface RowState {
  domain: string;
  saving: boolean;
  error: string | null;
}

export function BrandDomainSetupPanel({ batchId }: BrandDomainSetupPanelProps): React.ReactElement | null {
  const [blockers, setBlockers] = useState<BrandDomainSetupBlocker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-brand draft state: domain input value, in-flight save flag, error.
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const mounted = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res: BrandDomainSetupResponse = await getBrandDomainBlockers(batchId);
      if (!mounted.current) return;
      setBlockers(res.blockers);
      // Seed drafts for new blockers (prefilled with any existing mapping);
      // keep the operator's in-progress input for brands that persist.
      setRows(prev => {
        const next: Record<string, RowState> = {};
        for (const blocker of res.blockers) {
          next[blocker.brand] = prev[blocker.brand] ?? {
            domain: blocker.existingMapping ?? '',
            saving: false,
            error: null,
          };
        }
        return next;
      });
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not load brand domain setup queue');
    }
  }, [batchId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const updateDraft = useCallback((brand: string, domain: string) => {
    setRows(prev => ({ ...prev, [brand]: { ...prev[brand], domain, error: null } }));
  }, []);

  const handleSave = useCallback(
    async (brand: string) => {
      const draft = rows[brand];
      if (!draft || draft.saving) return;
      const domain = draft.domain;
      setRows(prev => ({ ...prev, [brand]: { ...prev[brand], saving: true, error: null } }));
      try {
        await assignBatchBrandDomain(batchId, brand, domain);
        if (!mounted.current) return;
        // The mapped brand's blocker row is gone once its items are re-queued;
        // drop the draft so a stale value never resurfaces for the brand.
        setRows(prev => {
          const next = { ...prev };
          delete next[brand];
          return next;
        });
        void load();
      } catch (err) {
        if (!mounted.current) return;
        setRows(prev => ({
          ...prev,
          [brand]: {
            ...prev[brand],
            saving: false,
            error: err instanceof Error ? err.message : 'Could not save domain',
          },
        }));
      }
    },
    [batchId, rows, load],
  );

  if (error) {
    return (
      <div className="attn-error" role="alert" style={{ margin: '0 0 12px' }}>
        {error}
      </div>
    );
  }

  if (!blockers || blockers.length === 0) return null;

  return (
    <section className="attn-domain-queue" aria-label="Brand domain setup queue">
      <div className="attn-domain-queue-title">
        <strong>Resolve Brand Domains</strong>
        <span className="attn-domain-queue-sub">
          Each brand's products stopped in Discovery because no official domain is mapped. Map the brand's
          official domain and every blocked product re-runs guided discovery automatically.
        </span>
      </div>
      <ul className="attn-domain-queue-list">
        {blockers.map(blocker => {
          const row = rows[blocker.brand];
          const draft = row?.domain ?? blocker.existingMapping ?? '';
          const saving = row?.saving ?? false;
          const rowError = row?.error ?? null;
          return (
            <li className="attn-domain-queue-row" key={blocker.brand}>
              <div className="attn-domain-queue-main">
                <span className="attn-domain-queue-domain">{blocker.brand}</span>
                <span className="attn-domain-queue-count">
                  {blocker.blockedItemCount} product{blocker.blockedItemCount === 1 ? '' : 's'} blocked
                </span>
                {blocker.sampleItems.length > 0 && (
                  <span className="attn-domain-queue-samples">
                    e.g. {blocker.sampleItems.map(s => s.name).join(' · ')}
                  </span>
                )}
                <input
                  type="text"
                  value={draft}
                  placeholder="official brand domain (e.g. frommfamily.com)"
                  aria-label={`Official domain for ${blocker.brand}`}
                  style={{ minWidth: 220, flex: '1 1 260px' }}
                  onChange={e => updateDraft(blocker.brand, e.target.value)}
                />
                {rowError && (
                  <span
                    role="alert"
                    style={{ flexBasis: '100%', fontSize: '0.75rem', color: 'var(--color-danger-text)' }}
                  >
                    {rowError}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void handleSave(blocker.brand)}
                disabled={saving || draft.trim().length === 0}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
