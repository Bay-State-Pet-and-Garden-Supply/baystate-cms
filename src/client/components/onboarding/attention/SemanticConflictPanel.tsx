/**
 * Task 3 — Conflict Inspector for curation semantic blocks.
 *
 * Operate mode: scanable, consistency-first, no marketing chrome.
 * One honest primary action: re-run family curation (POST /api/onboarding/cohorts/:id/re-run).
 * No per-value "Confirm Brand" buttons — no persistence endpoint exists for value-level confirms.
 * Secondary guidance directs operator to edit product then retry.
 */
import React, { useCallback, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import { getAttentionConsequence } from './attention-logic';
import { retryItem } from '../../../onboarding-api';
import './semantic-conflict.css';

interface SemanticConflictPanelProps {
  item: OnboardingWorkState;
  batchId: string;
  onActionComplete?: () => void;
}

const FINDING_LABELS: Record<string, string> = {
  family_brand: 'Brand conflict — family_brand',
  family_product_type: 'Product type split — family_product_type',
  coordinated_title: 'Title mismatch — coordinated_title',
  coordinated_page: 'Category page conflict — coordinated_page',
  coordinated_page_name_mismatch: 'Page name mismatch — coordinated_page_name_mismatch',
  member_attribute_applicability: 'Attribute applicability — member_attribute_applicability',
  member_cardinality: 'Attribute cardinality — member_cardinality',
};

function humanLabel(code: string | null): string {
  if (!code) return 'Curation conflict';
  return FINDING_LABELS[code] ?? code.replace(/_/g, ' ');
}

export function SemanticConflictPanel({ item, onActionComplete }: SemanticConflictPanelProps): React.ReactElement {
  const { findingCode, findingSummary, conflictingValues, findingDetails, attentionReason, detail, family, itemId } = item;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const consequence = getAttentionConsequence(attentionReason, detail);

  const handleRerun = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (family?.cohortId) {
        const res = await fetch(`/api/onboarding/cohorts/${encodeURIComponent(family.cohortId)}/re-run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        if (!res.ok) {
          const msg = typeof data.error === 'string' ? data.error : 'Could not re-run family curation. Fix the underlying data and try again.';
          throw new Error(msg);
        }
      } else {
        await retryItem(itemId);
      }
      setDone(true);
      onActionComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [family?.cohortId, itemId, onActionComplete]);

  const hasStructured = Boolean(findingCode || findingDetails?.length);

  return (
    <div className="scp-card" role="region" aria-label={hasStructured ? humanLabel(findingCode) : 'Curation conflict'}>
      <div className="scp-header">
        <span className="scp-eyebrow">Curation · needs attention</span>
        <h4 className="scp-title">{humanLabel(findingCode)}</h4>
        {findingSummary ? <p className="scp-summary">{findingSummary}</p> : detail ? <p className="scp-summary">{detail}</p> : null}
      </div>

      {conflictingValues && conflictingValues.length > 0 ? (
        <div className="scp-evidence" aria-label="Competing evidence">
          <span className="scp-evidence-label">Detected values</span>
          <div className="scp-values">
            {conflictingValues.map((v, i) => (
              <React.Fragment key={`${v}-${i}`}>
                <span className="scp-value-chip" title={v}>
                  {v}
                </span>
                {i < conflictingValues.length - 1 ? <span className="scp-vs" aria-hidden="true">vs</span> : null}
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}

      {findingDetails && findingDetails.length > 0 ? (
        <ul className="scp-findings" aria-label="All findings">
          {findingDetails.map((f, idx) => (
            <li className="scp-finding" key={`${f.code}-${f.memberSku}-${idx}`}>
              <div className="scp-finding-head">
                <span className="scp-finding-code">{FINDING_LABELS[f.code] ?? f.code.replace(/_/g, ' ')}</span>
                {f.memberSku ? <span className="scp-finding-sku">SKU {f.memberSku}</span> : null}
              </div>
              <p className="scp-finding-msg">{f.message}</p>
              {f.conflictingValues && f.conflictingValues.length > 0 ? (
                <div className="scp-values scp-values-sm">
                  {(f.conflictingValues as string[]).map((v, i) => (
                    <React.Fragment key={`${v}-${i}`}>
                      <span className="scp-value-chip scp-value-chip-sm">{v}</span>
                      {i < f.conflictingValues!.length - 1 ? <span className="scp-vs">vs</span> : null}
                    </React.Fragment>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="scp-actions">
        <button type="button" className="btn btn-primary scp-action" onClick={() => void handleRerun()} disabled={busy}>
          {busy ? 'Working…' : 'Re-run family curation'}
        </button>
        <p className="scp-secondary-guidance">
          To change brand or product type, edit the product data and then re-run. Re-running without fixing the underlying data will block again with fresh findings.
        </p>
      </div>

      {error ? (
        <div className="scp-error" role="alert">
          {error}
        </div>
      ) : null}
      {done ? (
        <div className="scp-done" role="status">
          ✓ Re-queued — family curation will re-run automatically. This product returns to Review once findings are resolved.
        </div>
      ) : null}

      <div className="scp-consequence">
        <span className="scp-consequence-icon" aria-hidden="true">→</span>
        <span>{consequence}</span>
      </div>
    </div>
  );
}
