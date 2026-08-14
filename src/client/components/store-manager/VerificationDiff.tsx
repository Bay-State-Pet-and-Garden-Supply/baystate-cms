import React from 'react';
import { colors, fonts, rounded } from '../../theme';

interface PerSkuVerification {
  sku: string;
  status: 'verified' | 'skipped' | 'error';
  note?: string;
}

interface VerificationDiffProps {
  verification: {
    verifiedSkuCount: number;
    perSku: PerSkuVerification[];
    perSkuTruncated: boolean;
    verificationHash: string;
    generatedAt: string;
    toolName: string;
    changeSet?: { id?: string; currentState?: string | null } | null;
  } | null;
}

const STATUS_COLOR: Record<string, string> = {
  verified: '#2f5d3a',
  skipped: colors.mulchBrown,
  error: '#8b1e2d',
};

/**
 * Authoritative verification diff shown AFTER a persistent action. A tool
 * success result alone is never "verified" — this renders the verification
 * artifact the runtime produced from declared read tools.
 */
export function VerificationDiff({ verification }: VerificationDiffProps) {
  if (!verification) {
    return (
      <div style={{ color: colors.mulchBrown, fontFamily: fonts.body, fontSize: 13 }}>
        No verification diff recorded for this action.
      </div>
    );
  }
  return (
    <div
      style={{
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        padding: 12,
        background: '#f4fbf4',
        fontFamily: fonts.body,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 14 }}>Verification — {verification.toolName}</strong>
        <span style={{ color: colors.mulchBrown, fontSize: 12 }}>{verification.verificationHash.slice(0, 12)}</span>
      </div>
      <div style={{ marginBottom: 6, color: '#2f5d3a' }}>
        <strong>{verification.verifiedSkuCount} SKU{verification.verifiedSkuCount === 1 ? '' : 's'} verified</strong>
      </div>
      {verification.perSku.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Per-SKU verification">
          <tbody>
            {verification.perSku.map((row, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${colors.cardBorder}` }}>
                <td style={{ padding: '4px 6px' }}>{row.sku}</td>
                <td style={{ padding: '4px 6px', color: STATUS_COLOR[row.status] ?? colors.mulchBrown }}>{row.status}</td>
                {row.note ? <td style={{ padding: '4px 6px' }}>{row.note}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ color: colors.mulchBrown }}>No per-SKU detail returned by the verification reads.</div>
      )}
      {verification.perSkuTruncated ? (
        <div style={{ color: colors.mulchBrown, fontSize: 12, marginTop: 4 }}>Per-SKU list truncated.</div>
      ) : null}
      {verification.changeSet?.id ? (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          Change Set <strong>{verification.changeSet.id}</strong> state: {verification.changeSet.currentState ?? 'unknown'}
        </div>
      ) : null}
    </div>
  );
}
