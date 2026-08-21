// story: e08 Test slice — Production Tests evidence for Activate (replaces local ValidationMatrix)
import type { MatrixResult } from '../../../onboarding/profile-test-matrix';

type Props = {
  result: MatrixResult | null;
  loading: boolean;
  error: string | null;
  onRevise: (field: string) => void;
  onSelectCell?: (cell: { field: string; sampleId: string } | null) => void;
};

function statusStyle(success: boolean): { bg: string; color: string; border: string } {
  if (success) return { bg: 'var(--color-success-bg)', color: 'var(--color-success-text)', border: 'var(--color-success-border)' };
  return { bg: 'var(--color-danger-bg)', color: 'var(--color-danger-text)', border: 'var(--color-danger-border)' };
}

export function TestMatrix({ result, loading, error, onRevise, onSelectCell }: Props): React.ReactElement {
  if (loading) {
    return <div style={{ padding: 12, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-mulch-brown)' }}>Running production tests…</div>;
  }
  if (error) {
    return <div role="alert" style={{ padding: 12, background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)', borderRadius: 'var(--rounded-md, 6px)', color: 'var(--color-danger-text)', fontFamily: 'var(--font-body)', fontSize: 12 }}>{error}</div>;
  }
  if (!result || result.rows.length === 0) {
    return <div style={{ padding: 12, border: '1px dashed var(--color-card-border)', borderRadius: 'var(--rounded-md, 6px)', background: 'rgba(250,249,242,0.6)', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-mulch-brown)', textAlign: 'center' }}>No production test run yet — click Run Tests to generate evidence for Activate.</div>;
  }
  return (
    <div style={{ border: '1px solid var(--color-card-border)', borderRadius: 'var(--rounded-lg, 8px)', overflow: 'hidden', background: 'var(--color-white-surface)' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-ledger-charcoal)' }}>Production Tests — evidence for Activate</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)' }}>{result.rows.length} samples · {result.draftVersion.slice(0, 8)} · {new Date(result.createdAt).toLocaleString()}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-body)', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--color-feed-bag-cream)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-card-border)', color: 'var(--color-mulch-brown)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sample</th>
              <th style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-card-border)', color: 'var(--color-mulch-brown)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Field — extracted vs expected</th>
              <th style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-card-border)', color: 'var(--color-mulch-brown)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Provenance / artifact</th>
              <th style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-card-border)', color: 'var(--color-mulch-brown)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => row.cells.map((cell) => {
              const s = statusStyle(cell.success);
              return (
                <tr key={`${row.sampleId}-${cell.field}`}>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-card-border)', verticalAlign: 'top', maxWidth: 220 }}>
                    <div style={{ fontWeight: 600, color: 'var(--color-ledger-charcoal)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.sampleUrl}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.sampleId.slice(0, 32)}</div>
                  </td>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-card-border)', verticalAlign: 'top', cursor: onSelectCell ? 'pointer' : 'default' }} onClick={() => onSelectCell?.({ field: cell.field, sampleId: row.sampleId })}>
                    <div style={{ fontWeight: 600, color: cell.success ? 'var(--color-ledger-charcoal)' : 'var(--color-danger-text)' }}>{cell.extracted ?? '—'}</div>
                    <div style={{ color: 'var(--color-mulch-brown)', fontSize: 11 }}>expected: {cell.expected}</div>
                    {cell.failureReason && <div style={{ marginTop: 4, color: 'var(--color-danger-text)', fontSize: 11 }}>{cell.failureReason}</div>}
                  </td>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-card-border)', verticalAlign: 'top' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-ledger-charcoal)' }}>{cell.provenance}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-mulch-brown)', wordBreak: 'break-all' }}>{cell.artifactHash}</div>
                  </td>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-card-border)', verticalAlign: 'top' }}>
                    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, border: `1px solid ${s.border}`, background: s.bg, color: s.color, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{cell.success ? 'pass' : 'fail'}</span>
                    {!cell.success && (
                      <button type="button" onClick={() => onRevise(cell.field)} style={{ marginLeft: 8, padding: '4px 8px', borderRadius: 'var(--rounded-sm, 4px)', border: '1px solid var(--color-card-border)', background: 'var(--color-white-surface)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                        Revise {cell.field}
                      </button>
                    )}
                  </td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
