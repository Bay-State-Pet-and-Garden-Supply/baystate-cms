/**
 * Epic #46 — Batch progress summary (UX workstream 1).
 *
 * The four primary operator buckets are the headline: Processing, Needs
 * Attention, Ready for Review, Approved. Needs Attention is the most
 * prominent number whenever it is non-zero. The remaining categories
 * (Waiting on Family, Ready to Export, Completed, Skipped) are secondary.
 */
import React from 'react';
import { colors, fonts, rounded, typography } from '../../theme';
import type { WorkStateCounts } from '../../../shared/schemas/onboarding-work-state';
import {
  attentionIsUrgent,
  formatCount,
  totalItemCount,
  WORK_STATE_CATEGORY_LABELS,
} from './batch-workspace-logic';

export interface BatchProgressSummaryProps {
  counts: WorkStateCounts;
}

interface PrimaryCardDef {
  key: 'processing' | 'needs_attention' | 'ready_for_review' | 'approved';
  label: string;
  hint: string;
}

const PRIMARY_CARDS: PrimaryCardDef[] = [
  { key: 'processing', label: 'Processing', hint: 'Automation is working — no action needed.' },
  { key: 'needs_attention', label: 'Needs Attention', hint: 'Products that need your judgment.' },
  { key: 'ready_for_review', label: 'Ready for Review', hint: 'Completed listings awaiting inspection.' },
  { key: 'approved', label: 'Approved', hint: 'Reviewed and released for export.' },
];

const SECONDARY_KEYS: Array<keyof WorkStateCounts> = [
  'waiting_on_family',
  'ready_to_export',
  'completed',
  'skipped',
];

export function BatchProgressSummary({ counts }: BatchProgressSummaryProps) {
  const urgent = attentionIsUrgent(counts);
  const total = totalItemCount(counts);

  return (
    <section aria-label="Batch progress summary">
      <div className="bws-summary-grid">
        {PRIMARY_CARDS.map(card => {
          const value = counts[card.key];
          const isAttention = card.key === 'needs_attention';
          const cardStyle: React.CSSProperties = {
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.lg,
            padding: '14px 16px',
            boxShadow: '0 1px 3px 0 rgba(33, 20, 20, 0.06)',
          };
          return (
            <div
              key={card.key}
              className={isAttention && urgent ? 'bws-attention-card' : undefined}
              style={cardStyle}
            >
              <div
                style={{
                  ...typography.microTitle,
                  marginBottom: 4,
                  ...(isAttention && urgent ? { color: colors.signetBurgundy } : {}),
                }}
              >
                {card.label}
              </div>
              <div
                className={isAttention && urgent ? 'bws-attention-count' : undefined}
                style={{
                  fontFamily: fonts.display,
                  fontSize: '1.75rem',
                  fontWeight: 700,
                  lineHeight: 1.1,
                  color: colors.ledgerCharcoal,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatCount(value)}
                {isAttention && urgent && (
                  <span
                    role="status"
                    style={{
                      display: 'inline-block',
                      marginLeft: 8,
                      verticalAlign: 'middle',
                      backgroundColor: colors.signetBurgundy,
                      color: colors.feedBagCream,
                      borderRadius: rounded.full,
                      padding: '2px 8px',
                      fontFamily: fonts.body,
                      fontSize: '0.6875rem',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Needs you
                  </span>
                )}
              </div>
              <div
                style={{
                  fontFamily: fonts.body,
                  fontSize: '0.75rem',
                  color: colors.mulchBrown,
                  marginTop: 4,
                }}
              >
                {card.hint}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 20px',
          marginBottom: 16,
          fontFamily: fonts.body,
          fontSize: '0.75rem',
          color: colors.mulchBrown,
        }}
      >
        {SECONDARY_KEYS.map(key => (
          <span key={key}>
            <strong
              style={{
                color: colors.ledgerCharcoal,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600,
              }}
            >
              {formatCount(counts[key])}
            </strong>{' '}
            {WORK_STATE_CATEGORY_LABELS[key]}
          </span>
        ))}
        <span aria-hidden="true">·</span>
        <span>
          <strong
            style={{ color: colors.ledgerCharcoal, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
          >
            {formatCount(total)}
          </strong>{' '}
          total products
        </span>
      </div>
    </section>
  );
}
