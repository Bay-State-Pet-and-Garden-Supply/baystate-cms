import React from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerPreviewDescriptor } from '../../store-manager-api';
import { buildPlanPreviewRows, RISK_LABELS, truncateText } from '../../store-manager-command-logic';

interface PlanPreviewProps {
  objective: string;
  plan: StoreManagerPreviewDescriptor | null;
  loading?: boolean;
  error?: string | null;
}

/**
 * /plan preview: contract-derived only. Shows expected registered tools,
 * pinned scope, risk classes, approval checkpoints, estimated network
 * activity, budgets, and likely artifact kinds. Nothing executes — the labels
 * are explicitly contract estimates, never current facts.
 */
export function PlanPreview({ objective, plan, loading, error }: PlanPreviewProps) {
  if (loading) {
    return (
      <div style={{ fontFamily: fonts.body, color: colors.mulchBrown, fontSize: 13, padding: 4 }}>
        Compiling plan preview…
      </div>
    );
  }
  if (error) {
    return <div style={{ fontFamily: fonts.body, color: colors.signetBurgundy, fontSize: 13, padding: 4 }}>{error}</div>;
  }
  if (!plan) return null;

  const rows = buildPlanPreviewRows(plan);
  return (
    <div
      role="region"
      aria-label="Plan preview"
      style={{
        fontFamily: fonts.body,
        background: colors.feedBagCream,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        padding: 12,
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: rounded.full,
            background: colors.seedlingGreen,
            color: colors.feedBagCream,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          /plan preview
        </span>
        <span style={{ fontSize: 11, color: colors.mulchBrown }}>
          Contract-derived estimate — nothing executed, no reads performed.
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
        {truncateText(objective, 400)}
      </div>
      {plan.expectedTools.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>
            Expected tools
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: colors.ledgerCharcoal }}>
            {plan.expectedTools.slice(0, 12).map((t) => (
              <li key={`${t.name}-${t.version}`}>
                {t.name} v{t.version} · {RISK_LABELS[t.riskClass] ?? t.riskClass}
                {t.requiresApproval ? ' · approval required' : ''}
                {plan.scopeHash != null && !t.scopeSupported ? ' · scope unsupported' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td style={{ padding: '3px 8px 3px 0', color: colors.mulchBrown, fontWeight: 600, width: 140 }}>
                {row.label}
              </td>
              <td
                style={{
                  padding: '3px 0',
                  color:
                    row.tone === 'danger'
                      ? colors.signetBurgundy
                      : row.tone === 'warn'
                        ? colors.mulchBrown
                        : colors.ledgerCharcoal,
                }}
              >
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
