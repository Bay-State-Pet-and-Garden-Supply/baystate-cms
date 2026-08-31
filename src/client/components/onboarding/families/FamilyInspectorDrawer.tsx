/**
 * Task 3 — Family / Cohort Inspector Drawer.
 *
 * Operate mode: side-by-side sibling comparison for a multi-item family
 * during curation. Lists every sibling in the cohort with title, OCR,
 * pages and attributes.
 *
 * Data mapping (canonical):
 *  - pages  → curationData.suggestedPages (string[]), NOT curatedPages
 *  - attributes → classificationProposals (proposalType field_assignment) + classificationDecisions for values; fallback to extractionData.variantAttributes labeled as extracted
 *  - OCR → extractionData.ocrOutcome.status (Sourcing/Discovery OCR), never curationData packagingOcrStatus
 *  - No invented frozen invariants — only shows "Current values" per sibling unless family carries a frozen projection
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getBatchWorkState } from '../../../onboarding-work-api';
import { getItemDetail } from '../../../onboarding-api';
import type { CurationData, ExtractionData } from '../../../../shared/schemas/onboarding';
import './family-inspector.css';

interface FamilyInspectorDrawerProps {
  cohortId: string;
  batchId: string;
  onClose: () => void;
}

interface SiblingDetail {
  workState: OnboardingWorkState;
  curatedTitle: string | null;
  imageUrl: string | null;
  ocrStatus: string | null;
  ocrDetail: string | null;
  pages: string[];
  attributes: Array<{ key: string; value: string; provenance: 'curated' | 'extracted' }>;
}

function deriveAttributes(
  curationData: CurationData | null,
  extractionData: ExtractionData | null,
): Array<{ key: string; value: string; provenance: 'curated' | 'extracted' }> {
  const rows: Array<{ key: string; value: string; provenance: 'curated' | 'extracted' }> = [];
  if (curationData) {
    const proposals = (curationData.classificationProposals as Array<Record<string, unknown>> | undefined) ?? [];
    // field_assignment proposals carry targetId + proposedValue (+ revisedValue if corrected)
    for (const p of proposals) {
      const targetId = typeof p.targetId === 'string' ? p.targetId : (typeof p.attributeId === 'string' ? p.attributeId : null);
      if (!targetId) continue;
      // Skip non-field proposals (product_type, category_page)
      const type = typeof p.proposalType === 'string' ? p.proposalType : '';
      if (type && type !== 'field_assignment') continue;
      // Use hasRevisedValue when present: explicit null correction clears the value
      const hasRevised = p.hasRevisedValue === true || (p as Record<string, unknown>).hasRevisedValue === true;
      const raw = hasRevised ? (p as Record<string, unknown>).revisedValue : (p as Record<string, unknown>).proposedValue;
      if (raw == null || String(raw).trim() === '') continue;
      // Avoid duplicates
      if (rows.some((r) => r.key === targetId)) continue;
      rows.push({ key: targetId, value: String(raw), provenance: 'curated' });
    }
    // Also surface classificationDecisions that may have revised values not yet in proposals array shape
    // decisions already reflected via revisedValue above, so no extra pass needed.
  }
  if (rows.length === 0 && extractionData) {
    const va = (extractionData.variantAttributes as Record<string, unknown> | undefined) ?? {};
    for (const [k, v] of Object.entries(va)) {
      if (v != null && String(v).trim()) rows.push({ key: k, value: String(v), provenance: 'extracted' });
    }
  }
  return rows;
}

export function FamilyInspectorDrawer({ cohortId, batchId, onClose }: FamilyInspectorDrawerProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<SiblingDetail[]>([]);
  const [familyLabel, setFamilyLabel] = useState<string | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getBatchWorkState(batchId, { cohortId, limit: 500 });
      if (res.items.length === 0) {
        setError('No members found for this family.');
        setLoading(false);
        return;
      }
      setFamilyLabel(res.items[0]?.family?.label ?? null);
      const details: SiblingDetail[] = await Promise.all(
        res.items.map(async (ws) => {
          let curation: CurationData | null = null;
          let extraction: ExtractionData | null = null;
          let pages: string[] = [];
          let ocrStatus: string | null = null;
          let ocrDetail: string | null = null;
          try {
            const d = await getItemDetail(ws.itemId);
            curation = (d.item.curationData as CurationData | null) ?? null;
            extraction = (d.item.extractionData as ExtractionData | null) ?? null;
            if (curation) {
              const cp = curation.suggestedPages;
              if (Array.isArray(cp)) pages = cp.filter((p): p is string => typeof p === 'string' && p.length > 0);
            }
            if (extraction?.ocrOutcome) {
              ocrStatus = extraction.ocrOutcome.status ?? null;
              // surface reason/error at detail level without conflating blocked semantic validation
              ocrDetail = extraction.ocrOutcome.reason ?? extraction.ocrOutcome.error ?? null;
            }
          } catch {
            // work-state fallback
          }
          return {
            workState: ws,
            curatedTitle: ws.curatedTitle ?? null,
            imageUrl: ws.imageUrl ?? null,
            ocrStatus,
            ocrDetail,
            pages,
            attributes: deriveAttributes(curation, extraction),
          };
        }),
      );
      // Stable sort: by curatedTitle/name then UPC so order doesn't jump
      details.sort((a, b) => (a.workState.curatedTitle ?? a.workState.name).localeCompare(b.workState.curatedTitle ?? b.workState.name));
      setSiblings(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load family');
    } finally {
      setLoading(false);
    }
  }, [batchId, cohortId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus management — mirror BatchWorkspace FocusTrap pattern: move focus to close button, trap Tab, restore on close, lock scroll
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const btn = closeBtnRef.current;
    if (btn) btn.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = drawerRef.current;
      if (!el) return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((f) => !f.hasAttribute('disabled'));
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
    },
    [onClose],
  );

  return (
    <div className="fid-overlay" role="presentation" onClick={onClose}>
      <div
        className="fid-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={familyLabel ? `Family: ${familyLabel}` : 'Family inspector'}
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="fid-header">
          <div>
            <span className="fid-eyebrow">Family inspector</span>
            <h3 className="fid-title" title={familyLabel ?? cohortId}>
              {familyLabel ?? cohortId}
            </h3>
            <span className="fid-subtitle">
              {siblings.length ? `${siblings.length} sibling${siblings.length === 1 ? '' : 's'} · cohort ${cohortId.slice(0, 8)}…` : `cohort ${cohortId.slice(0, 8)}…`}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-outline fid-close"
            onClick={onClose}
            aria-label="Close family inspector"
            ref={closeBtnRef}
          >
            ✕
          </button>
        </header>

        <section className="fid-current-values-note" aria-label="Current values note">
          <p>Current values (not frozen invariant) — each sibling’s actual brand, title, and pages as of last curation. Frozen invariants will appear here when the server projects them.</p>
        </section>

        <div className="fid-body">
          {loading ? (
            <div className="fid-loading" role="status" aria-label="Loading family">
              <div className="fid-skeleton" />
              <div className="fid-skeleton" />
              <div className="fid-skeleton" />
            </div>
          ) : error ? (
            <div className="fid-error" role="alert">
              {error}
              <button type="button" className="btn btn-outline" onClick={() => void load()} style={{ marginTop: 8 }}>
                Retry
              </button>
            </div>
          ) : (
            <ul className="fid-list" aria-label="Siblings">
              {siblings.map((s) => (
                <li key={s.workState.itemId} className="fid-card">
                  <div className="fid-card-top">
                    <div className="fid-card-identity">
                      <p className="fid-card-name" title={s.curatedTitle ?? s.workState.name}>
                        {s.curatedTitle ?? s.workState.name}
                      </p>
                      <span className="fid-card-meta">
                        {s.workState.upc} {s.workState.brand ? `· ${s.workState.brand}` : ''} · {s.workState.stage}/{s.workState.stageStatus}
                      </span>
                    </div>
                    {s.imageUrl ? <img src={s.imageUrl} alt="" className="fid-thumb" loading="lazy" /> : null}
                  </div>

                  <dl className="fid-fields">
                    <div className="fid-field">
                      <dt>Brand</dt>
                      <dd>{s.workState.brand ?? '—'}</dd>
                    </div>
                    <div className="fid-field">
                      <dt>Title</dt>
                      <dd>{s.curatedTitle ?? s.workState.name}</dd>
                    </div>
                    <div className="fid-field">
                      <dt>OCR</dt>
                      <dd>
                        {s.ocrStatus ?? '—'}
                        {s.ocrDetail ? <span className="fid-ocr-detail"> · {s.ocrDetail}</span> : null}
                      </dd>
                    </div>
                    <div className="fid-field">
                      <dt>Category pages</dt>
                      <dd>{s.pages.length > 0 ? s.pages.join(', ') : '— not assigned'}</dd>
                    </div>
                    <div className="fid-field">
                      <dt>Attributes</dt>
                      <dd>
                        {s.attributes.length > 0 ? (
                          <ul className="fid-attr-list">
                            {s.attributes.map((a) => (
                              <li key={a.key}>
                                <span className="fid-attr-key">{a.key}</span> {a.value}
                                {a.provenance === 'extracted' ? <span className="fid-attr-provenance"> · extracted (not yet curated)</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="fid-footer">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
