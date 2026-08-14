import React, { useCallback, useEffect, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  StoreManagerBulkReviewBatchDetail,
  StoreManagerBulkReviewBatchSummary,
  StoreManagerBulkReviewPreviewResult,
  StoreManagerBulkReviewKind,
} from '../../store-manager-api';
import {
  previewStoreManagerBulkReview,
  fetchStoreManagerBulkReviewBatches,
  fetchStoreManagerBulkReviewBatch,
  denyStoreManagerBulkReviewBatch,
} from '../../store-manager-api';
import {
  bulkReviewGroupTitle,
  bulkReviewDiffLine,
  bulkReviewExclusionSummary,
  renderBulkReviewItems,
  isBulkReviewBatchActionable,
  bulkReviewActionabilityNote,
  bulkReviewApproveObjective,
  bulkReviewBatchStatusLabel,
  bulkReviewBatchStatusTone,
  bulkReviewBatchStatusActionLabel,
} from '../../store-manager-bulk-review-logic';

interface BulkReviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** Send an objective to the Manager chat (approval flow stays in the runtime). */
  onRequestReview: (objective: string) => void;
}

const KIND_OPTIONS: Array<{ value: StoreManagerBulkReviewKind; label: string }> = [
  { value: 'casing', label: 'Casing' },
  { value: 'whitespace', label: 'Whitespace' },
  { value: 'separator', label: 'Separator (audit-proven)' },
];

/**
 * Bulk Review panel — homogeneous deterministic bulk review (Issue 8).
 *
 * Grouping is a server-derived preview only. The panel shows the exact
 * selection, exclusions, per-item drill-down, and staleness state. There is
 * NO "select all proposals" across groups and no applied/published/synced
 * wording: "Approve" routes through the Manager chat so the standard
 * approval-gated runtime tool (bulk_apply_stored_proposals) stages the exact
 * batch into a Change Set — drafts only. Deny records per-item decisions
 * with zero catalog effect.
 */
export function BulkReviewPanel({ open, onClose, onRequestReview }: BulkReviewPanelProps) {
  const [field, setField] = useState('');
  const [kind, setKind] = useState<StoreManagerBulkReviewKind>('casing');
  const [maxItems, setMaxItems] = useState('');
  const [preview, setPreview] = useState<StoreManagerBulkReviewPreviewResult | null>(null);
  const [batches, setBatches] = useState<StoreManagerBulkReviewBatchSummary[]>([]);
  const [detail, setDetail] = useState<StoreManagerBulkReviewBatchDetail | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshBatches = useCallback(async () => {
    try {
      setBatches(await fetchStoreManagerBulkReviewBatches());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batches.');
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
      void refreshBatches();
    }
  }, [open, refreshBatches]);

  const runPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = field.trim();
    if (!trimmed) {
      setError('Enter a ProductField, e.g. ProductField24.');
      return;
    }
    setLoading(true);
    setError(null);
    setPreview(null);
    setDetail(null);
    try {
      const parsedMax = maxItems.trim() === '' ? undefined : Number(maxItems);
      if (parsedMax !== undefined && (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 200)) {
        throw new Error('Max items must be an integer between 1 and 200.');
      }
      const result = await previewStoreManagerBulkReview(trimmed, {
        normalizationKind: kind,
        ...(parsedMax ? { maxItems: parsedMax } : {}),
      });
      setPreview(result);
      await refreshBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setLoading(false);
    }
  };

  const openBatch = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await fetchStoreManagerBulkReviewBatch(id);
      setDetail(d);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch.');
    } finally {
      setBusy(false);
    }
  };

  const denyBatch = async () => {
    if (!detail) return;
    if (!window.confirm('Deny this exact batch? Every proposal is recorded as denied (no catalog change).')) return;
    setBusy(true);
    setError(null);
    try {
      await denyStoreManagerBulkReviewBatch(detail.batch.id, 'Denied by operator from Bulk Review.');
      setNotice('Batch denied. Per-item decisions recorded; no catalog changes were made.');
      setDetail(await fetchStoreManagerBulkReviewBatch(detail.batch.id));
      await refreshBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deny failed.');
    } finally {
      setBusy(false);
    }
  };

  const sendToReview = () => {
    if (!detail) return;
    const label = bulkReviewBatchStatusActionLabel(detail);
    if (label === 'Send to Manager review' && isBulkReviewBatchActionable(detail)) {
      setNotice('Sent to Manager review — the approval card will show the exact diff before anything runs.');
      onRequestReview(bulkReviewApproveObjective(detail.batch.id, detail.batch.field));
    }
  };

  if (!open) return null;

  const detailActionable = detail ? isBulkReviewBatchActionable(detail) : false;
  const detailNote = detail ? bulkReviewActionabilityNote(detail) : null;
  const actionLabel = detail ? bulkReviewBatchStatusActionLabel(detail) : null;
  const itemRows = detail ? renderBulkReviewItems(detail.items) : [];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(18, 24, 18, 0.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Bulk review"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(960px, 94vw)', maxHeight: '86vh', overflow: 'auto', background: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.cardBorder}`, boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}
      >
        <div style={{ padding: '18px 24px', borderBottom: `1px solid ${colors.cardBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 18, color: colors.ledgerCharcoal }}>Bulk Review</div>
            <div style={{ fontSize: 12, color: colors.mulchBrown }}>
              Homogeneous deterministic fixes only — one stale or ineligible proposal refuses the whole batch.
            </div>
          </div>
          <button type="button" className="btn btn-outline" onClick={onClose} style={{ fontSize: 12, padding: '4px 12px' }}>Close</button>
        </div>

        <div style={{ padding: 20 }}>
          {error ? <div style={{ color: '#8b1e2d', fontSize: 12, marginBottom: 12 }}>{error}</div> : null}
          {notice ? <div style={{ color: '#2f5d3a', fontSize: 12, marginBottom: 12 }}>{notice}</div> : null}

          <form onSubmit={runPreview} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.mulchBrown }}>
              ProductField
              <input
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="ProductField24"
                style={{ width: 180, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '8px 10px', color: colors.ledgerCharcoal }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.mulchBrown }}>
              Rule class
              <select value={kind} onChange={(e) => setKind(e.target.value as StoreManagerBulkReviewKind)} style={{ width: 200, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '8px 10px', color: colors.ledgerCharcoal }}>
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.mulchBrown }}>
              Max items
              <input
                value={maxItems}
                onChange={(e) => setMaxItems(e.target.value)}
                placeholder="200"
                inputMode="numeric"
                style={{ width: 90, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '8px 10px', color: colors.ledgerCharcoal }}
              />
            </label>
            <button type="submit" className="btn" disabled={loading} style={{ height: '2.4rem', fontSize: 12 }}>
              {loading ? 'Previewing…' : 'Preview homogeneous group'}
            </button>
          </form>

          {preview ? (
            <div style={{ marginTop: 18, padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
              <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 14, color: colors.ledgerCharcoal }}>
                {bulkReviewGroupTitle(preview.group)}
              </div>
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>
                {bulkReviewDiffLine(preview.diffSummary)}
              </div>
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4 }}>
                Rule: {preview.batch.ruleVersion} · Evidence: {preview.batch.evidenceKey}
              </div>
              {preview.group.truncated ? (
                <div style={{ fontSize: 12, color: '#8a6116', marginTop: 6 }}>
                  Group truncated to {preview.group.proposalCount} items (cap {preview.group.maxItems}).
                </div>
              ) : null}
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 6 }}>
                Excluded: {bulkReviewExclusionSummary(preview.group.exclusions)}
              </div>
              <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 6 }}>
                Expected Change Set state: {preview.diffSummary.changeSetCurrentState ?? 'none'} → {preview.diffSummary.changeSetExpectedState} · Files: {preview.diffSummary.filesTouched.length} product file(s)
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: colors.ledgerCharcoal }}>
                <strong>Batch {preview.batch.id.slice(0, 8)}</strong> persisted — open it below to review items, deny, or send to the Manager for approval.
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 8 }}>Batches</div>
            {batches.length === 0 ? (
              <div style={{ fontSize: 12, color: colors.mulchBrown }}>No bulk-review batches yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: colors.mulchBrown, textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>Field</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>Rule class</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>Proposals</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>SKUs</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>Status</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}>Created</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${colors.cardBorder}` }}></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} style={{ color: colors.ledgerCharcoal }}>
                      <td style={{ padding: '6px 8px' }}>{b.field}</td>
                      <td style={{ padding: '6px 8px' }}>{b.normalizationKind}</td>
                      <td style={{ padding: '6px 8px' }}>{b.proposalCount}</td>
                      <td style={{ padding: '6px 8px' }}>{b.distinctSkuCount}</td>
                      <td style={{ padding: '6px 8px', color: bulkReviewBatchStatusTone(b.status) }}>{bulkReviewBatchStatusLabel(b.status)}</td>
                      <td style={{ padding: '6px 8px' }}>{new Date(b.createdAt).toLocaleString()}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void openBatch(b.id)} style={{ fontSize: 11, padding: '2px 8px' }}>
                          {detail?.batch.id === b.id ? 'Viewing' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {detail ? (
            <div style={{ marginTop: 18, padding: 14, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md }}>
              <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 14, color: colors.ledgerCharcoal }}>
                Batch {detail.batch.id} — {bulkReviewGroupTitle(detail.batch)}
              </div>
              <div style={{ fontSize: 12, color: bulkReviewBatchStatusTone(detail.batch.status), marginTop: 4 }}>
                Status: {bulkReviewBatchStatusLabel(detail.batch.status)}
              </div>
              {detailNote ? (
                <div style={{ fontSize: 12, color: detail.stale ? '#8a6116' : colors.mulchBrown, marginTop: 4 }}>
                  {detailNote}
                </div>
              ) : null}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !detailActionable}
                  onClick={sendToReview}
                  title={detailActionable ? undefined : 'Batch is not actionable (stale or decided).'}
                  style={{ fontSize: 12, padding: '6px 12px' }}
                >
                  {actionLabel ?? 'Batch not actionable'}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={busy || detail.batch.status !== 'pending'}
                  onClick={() => void denyBatch()}
                  style={{ fontSize: 12, padding: '6px 12px', color: '#8b1e2d' }}
                >
                  {detail.batch.status === 'pending' ? 'Deny exact batch' : 'Denied'}
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                  Items ({itemRows.length}) — one decision and Change Set item per proposal
                </div>
                {itemRows.map((row) => {
                  const isOpen = expanded[row.proposalId] ?? false;
                  return (
                    <div key={row.proposalId} style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, background: colors.whiteSurface, marginBottom: 6, padding: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ fontSize: 12, color: colors.ledgerCharcoal, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span style={{ color: colors.mulchBrown }}>{row.oldValue}</span> → <strong>{row.newValue}</strong>
                          <span style={{ color: colors.mulchBrown }}> · {row.skuCount} SKU{row.skuCount === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: row.decision === 'applied' ? '#2f5d3a' : row.decision === 'denied' ? '#8a6116' : colors.mulchBrown }}>
                            {row.statusLabel}
                          </span>
                          <button
                            type="button"
                            className="btn btn-outline"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={() => setExpanded((prev) => ({ ...prev, [row.proposalId]: !isOpen }))}
                          >
                            {isOpen ? 'Hide' : 'Details'}
                          </button>
                        </div>
                      </div>
                      {isOpen ? (
                        <div style={{ marginTop: 8, fontSize: 11, color: colors.mulchBrown, borderTop: `1px solid ${colors.cardBorder}`, paddingTop: 8 }}>
                          <div>Proposal: <code style={{ fontSize: 11 }}>{row.proposalId}</code></div>
                          <div>SKUs: {row.skuSample.join(', ')}{row.skuSampleTruncated ? ` +${row.skuCount - row.skuSample.length} more` : ''}</div>
                          <div>Change Set item: {row.changeSetItemRef ?? 'not yet staged'}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
