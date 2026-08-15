/**
 * Epic #46 — Review classification panel (Phase 6).
 *
 * Renders classification proposals (Product Type, Category Pages, attribute
 * assignments) with accept/reject affordances for pending proposals, exposing
 * subsurfaces that require a human decision before review completes.
 */
import { useState } from 'react';
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';

export interface ReviewClassificationPanelProps {
  detail: ItemDetailResponse | null;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  /** Item id currently performing a decision write (disables row buttons). */
  busyDecisionId: string | null;
}

export const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  primary_product_type: 'Primary Product Type',
  category_page: 'Category Page',
  field_assignment: 'Attribute',
  configuration_gap: 'Configuration gap',
  reviewable_abstention: 'Reviewable abstention',
};

function proposalSummary(proposal: ClassificationProposal): string {
  const raw = proposal.revisedValue ?? proposal.proposedValue;
  if (raw === null || raw === undefined) return '—';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map(value => proposalValueText(value)).join(', ');
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const label =
      obj.label ?? obj.name ?? obj.value ?? obj.pageName ?? obj.productTypeLabel ?? obj.fieldLabel;
    if (typeof label === 'string' && label) return label;
    const id = obj.id ?? obj.pageId ?? obj.typeId ?? obj.fieldId;
    if (typeof id === 'string') {
      const extra =
        typeof obj.confidence === 'number' ? ` (${Math.round(obj.confidence * 100)}%)` : '';
      return `${id}${extra}`;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function proposalValueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const label = obj.label ?? obj.name ?? obj.value ?? obj.pageName;
    if (typeof label === 'string' && label) return label;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ReviewClassificationPanel({
  detail,
  onDecision,
  busyDecisionId,
}: ReviewClassificationPanelProps) {
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const curation = detail?.item.curationData ?? null;
  const proposals = curation?.classificationProposals ?? [];
  const suggestedPages = curation?.suggestedPages ?? [];
  const suggestions = suggestedPages.length > 0;
  const withoutResults = proposals.length === 0 && !suggestions;

  const handleDecision = async (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => {
    setDecisionError(null);
    try {
      await onDecision(proposal, decision);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : String(err));
    }
  };

  const primary = proposals.find(p => p.proposalType === 'primary_product_type');
  const pending = proposals.filter(p => p.status === 'pending');
  const settled = proposals.filter(p => p.status !== 'pending');

  return (
    <section className="rv-panel" aria-label="Classification">
      <header className="rv-panel-head">Classification</header>
      <div className="rv-panel-body">
        {withoutResults && <div className="rv-empty">No classification proposals or category suggestions yet.</div>}

        {primary && (
          <div className="rv-field">
            <div className="rv-field-label">Primary Product Type</div>
            <ReviewProposalRow proposal={primary} onDecision={handleDecision} busy={busyDecisionId} />
          </div>
        )}

        {pending.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Decisions needed ({pending.length})</div>
            {pending.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
              />
            ))}
          </div>
        )}

        {settled.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Settled decisions</div>
            {settled.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
              />
            ))}
          </div>
        )}

        {suggestions && (
          <div className="rv-field" style={{ marginTop: '0.875rem' }}>
            <div className="rv-field-label">Suggested Category Pages</div>
            <div className="rv-field-value">{suggestedPages.join(', ') || '—'}</div>
          </div>
        )}

        {decisionError && <div className="rv-error-banner" style={{ marginTop: '0.625rem' }}>{decisionError}</div>}
      </div>
    </section>
  );
}

function ReviewProposalRow({
  proposal,
  onDecision,
  busy,
}: {
  proposal: ClassificationProposal;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  busy: string | null;
}) {
  return (
    <div className="rv-proposal">
      <div className="rv-proposal-head">
        <span className="rv-proposal-type">
          {PROPOSAL_TYPE_LABELS[proposal.proposalType] ?? proposal.proposalType}
        </span>
        <span className={`rv-proposal-status rv-proposal-status-${proposal.status}`}>
          {proposal.status}
        </span>
      </div>
      <div className="rv-proposal-value">
        {proposalSummary(proposal)}
        {typeof proposal.confidence === 'number' && proposal.status === 'pending' && (
          <span style={{ color: 'var(--color-mulch-brown)', fontSize: '0.75rem' }}> · {Math.round(proposal.confidence * 100)}% confidence</span>
        )}
      </div>
      {proposal.status === 'pending' ? (
        <div className="rv-proposal-actions">
          <button
            type="button"
            className="rv-btn rv-btn-primary"
            disabled={busy === proposal.id}
            onClick={() => void onDecision(proposal, 'accepted')}
          >
            {busy === proposal.id ? 'Saving…' : 'Accept'}
          </button>
          <button
            type="button"
            className="rv-btn rv-btn-danger"
            disabled={busy === proposal.id}
            onClick={() => void onDecision(proposal, 'rejected')}
          >
            {busy === proposal.id ? 'Saving…' : 'Reject'}
          </button>
        </div>
      ) : null}
    </div>
  );
}