/**
 * Epic #46 Phase 4 — one Needs Attention row answering the four operator
 * questions plainly:
 *   1. WHAT product is blocked?
 *   2. WHY did automation stop?
 *   3. WHAT decision/action is required?
 *   4. WHAT will happen after I resolve it?
 *
 * Presentational only — all text comes from the server projection
 * (label/detail) and the deterministic attention-logic helpers.
 */
import React from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import {
  getAttentionActionLabel,
  getAttentionConsequence,
  getAttentionGroupLabel,
} from './attention-logic';

interface AttentionRowProps {
  workState: OnboardingWorkState;
  /** Clicking anywhere on the row (or the Resolve button) opens the workspace. */
  onResolve: (itemId: string) => void;
  /** When true the Resolve button shows an in-flight state. */
  resolving?: boolean;
}

export function AttentionRow({ workState, onResolve, resolving = false }: AttentionRowProps): React.ReactElement {
  const { attentionReason, attentionAction, label, detail, upc, name, brand, itemId } = workState;
  const reasonLabel = attentionReason ? getAttentionGroupLabel(attentionReason) : label;
  const actionLabel = attentionAction ? getAttentionActionLabel(attentionAction) : 'Resolve';
  const consequence = getAttentionConsequence(attentionReason, detail);

  return (
    <article
      className="attn-row"
      role="button"
      tabIndex={0}
      aria-label={`Resolve ${name}`}
      onClick={() => onResolve(itemId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onResolve(itemId);
        }
      }}
    >
      <div className="attn-row-top">
        <div className="attn-row-identity">
          <div className="attn-row-name">{name}</div>
          <div className="attn-row-meta">
            <span>{upc}</span>
            {brand ? <span>{brand}</span> : null}
            <span className="attn-action-chip">{reasonLabel}</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flexShrink: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            onResolve(itemId);
          }}
          disabled={resolving}
        >
          {resolving ? 'Working…' : actionLabel}
        </button>
      </div>

      <div className="attn-row-four">
        <div className="attn-answer">
          <span className="attn-answer-label">Why it stopped</span>
          <span className="attn-answer-text">{label}</span>
        </div>
        <div className="attn-answer">
          <span className="attn-answer-label">Action needed</span>
          <span className="attn-answer-text">{attentionAction ? actionLabel : reasonLabel}</span>
        </div>
        <div className="attn-answer">
          <span className="attn-answer-label">What happens next</span>
          <span className="attn-answer-text">{consequence}</span>
        </div>
      </div>

      {detail ? (
        <div className="attn-answer">
          <span className="attn-answer-label">Detail</span>
          <span className="attn-answer-text">{detail}</span>
        </div>
      ) : null}
    </article>
  );
}
