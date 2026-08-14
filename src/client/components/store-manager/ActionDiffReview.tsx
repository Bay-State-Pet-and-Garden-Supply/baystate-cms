import React from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerActionDiff } from '../../store-manager-api';
import { diffAffectedSkuText, diffNetworkSummary, diffRenderRows } from '../../store-manager-history-logic';

interface ActionDiffReviewProps {
  diff: StoreManagerActionDiff;
  onApprove?: () => void;
  onDeny?: () => void;
  busy?: boolean;
  /** Show the PR-like review chrome (approve/deny) or a read-only preview. */
  reviewMode?: boolean;
}

const RISK_LABELS: Record<string, string> = {
  read: 'Read',
  proposal_write: 'Proposal write',
  catalog_mutation: 'Catalog / Change Set mutation',
  network_filesystem_repair: 'Network + filesystem repair',
};

/**
 * Diff-first action review. Shows EXACTLY what will happen before any
 * approval: affected SKUs, before/after values, files, Change Set state, and
 * estimated network activity. "Unknown" dimensions are displayed explicitly.
 */
export function ActionDiffReview({ diff, onApprove, onDeny, busy, reviewMode = true }: ActionDiffReviewProps) {
  const rows = diffRenderRows(diff);
  return (
    <div
      style={{
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        padding: 12,
        background: '#fffdf7',
        fontFamily: fonts.body,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 14 }}>
          {RISK_LABELS[diff.riskClass] ?? diff.riskClass} — {diff.toolName} v{diff.toolVersion}
        </strong>
        <span style={{ color: colors.mulchBrown, fontSize: 12 }}>diff {diff.diffHash.slice(0, 12)}</span>
      </div>

      <div style={{ marginBottom: 6, color: '#2f5d3a' }}>
        <strong>{diffAffectedSkuText(diff)}</strong>
      </div>

      {rows.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }} aria-label="Before/after values">
          <thead>
            <tr style={{ textAlign: 'left', color: colors.mulchBrown, fontSize: 12 }}>
              <th style={{ padding: '4px 6px' }}>Field</th>
              <th style={{ padding: '4px 6px' }}>Before</th>
              <th style={{ padding: '4px 6px' }}>After</th>
              <th style={{ padding: '4px 6px' }}>Affected</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${colors.cardBorder}` }}>
                <td style={{ padding: '4px 6px' }}>{row.field}</td>
                <td style={{ padding: '4px 6px' }}>{row.before}</td>
                <td style={{ padding: '4px 6px' }}>{row.after}</td>
                <td style={{ padding: '4px 6px' }}>{row.affectedCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ color: colors.mulchBrown, marginBottom: 8 }}>No value-level changes in this diff.</div>
      )}

      {diff.filesTouched.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <strong style={{ fontSize: 12 }}>Files touched:</strong>{' '}
          <span style={{ fontSize: 12 }}>
            {diff.filesTouched.slice(0, 5).map((f) => f.path).join(', ')}
            {diff.filesTouched.length > 5 ? ` +${diff.filesTouched.length - 5} more` : ''}
          </span>
        </div>
      )}

      <div style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>Change Set state:</strong>{' '}
        <span style={{ fontSize: 12 }}>
          {diff.changeSet
            ? `${diff.changeSet.currentState ?? 'unknown'} → ${diff.changeSet.expectedState ?? '—'}${diff.changeSet.itemCount !== undefined ? ` (${diff.changeSet.itemCount} items)` : ''}`
            : 'Unknown (no Change Set binding in this preview)'}
        </span>
      </div>

      <div style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>Network activity:</strong>{' '}
        <span style={{ fontSize: 12 }}>{diffNetworkSummary(diff)}</span>
      </div>

      {reviewMode && onApprove && onDeny && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onDeny}
            disabled={busy}
            className="btn btn-outline"
            style={{ fontSize: 12, padding: '4px 10px', color: '#8b1e2d' }}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {busy ? 'Working…' : 'Approve exact diff'}
          </button>
        </div>
      )}
    </div>
  );
}
