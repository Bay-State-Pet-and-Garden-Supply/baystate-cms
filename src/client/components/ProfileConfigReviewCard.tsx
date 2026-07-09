/**
 * ProfileConfigReviewCard.tsx — displays non-selector config items.
 *
 * Shows variant strategy, sitemap pattern, Shopify JSON flag, and runtime
 * in a compact card with change indicators and approval controls where
 * the backend supports promotion.
 */

import React from 'react';
import type { ConfigReviewRow } from '../profile-review-utils';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProfileConfigReviewCardProps {
  rows: ConfigReviewRow[];
  approvedFields: Record<string, boolean>;
  onToggleApprove?: (key: string, approve: boolean) => void;
  disabled?: boolean;
}

// ─── Style helpers ───────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 0',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 13,
};

const lastFieldStyle: React.CSSProperties = {
  ...fieldStyle,
  borderBottom: 'none',
  paddingBottom: 0,
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileConfigReviewCard(
  props: ProfileConfigReviewCardProps,
): React.ReactElement {
  const { rows, approvedFields, onToggleApprove, disabled = false } = props;

  if (rows.length === 0) return <></>;

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 14,
        background: '#fafafa',
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        Configuration
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
        Non-selector proposal data
      </div>

      {rows.map((row, idx) => {
        const isLast = idx === rows.length - 1;
        const approved = approvedFields[row.key] === true;

        return (
          <div
            key={row.key}
            style={isLast ? lastFieldStyle : fieldStyle}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 2 }}>
                {row.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: '#6b7280',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.displayValue}
              </div>
              {row.changed && (
                <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2 }}>
                  Changed from: {typeof row.activeValue === 'string' ? row.activeValue : JSON.stringify(row.activeValue)}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 8 }}>
              {!row.promotable && (
                <span
                  style={{
                    fontSize: 10,
                    color: '#9ca3af',
                    fontStyle: 'italic',
                  }}
                >
                  Info only
                </span>
              )}
              {row.promotable && onToggleApprove && (
                <button
                  type="button"
                  onClick={() => onToggleApprove(row.key, !approved)}
                  disabled={disabled}
                  style={{
                    padding: '2px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    border: `1px solid ${approved ? '#16a34a' : '#d1d5db'}`,
                    borderRadius: 4,
                    background: approved ? '#dcfce7' : '#fff',
                    color: approved ? '#16a34a' : '#6b7280',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.5 : 1,
                  }}
                >
                  {approved ? '✓ Approved' : 'Approve'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
