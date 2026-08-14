import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  StoreManagerInboxItem,
  StoreManagerNotification,
  StoreManagerSeverity,
} from '../../store-manager-api';
import {
  sortInboxItems,
  summarizeInbox,
  formatInboxAge,
  isInboxItemStale,
  lifecycleLabel,
  inboxCommandPrefill,
} from '../../store-manager-inbox-logic';
import type { EventStreamStatus } from '../../hooks/useStoreManagerEvents';

interface ManagerInboxProps {
  open: boolean;
  onClose: () => void;
  /** Live notifications from the SSE hook (used for the unread badge + inline list). */
  notifications?: StoreManagerNotification[];
  eventStatus?: EventStreamStatus;
}

const SEVERITY_STYLE: Record<StoreManagerSeverity, { color: string; background: string; label: string }> = {
  critical: { color: '#8b1e2d', background: '#fdeaea', label: 'Critical' },
  warning: { color: '#8a6116', background: '#fdf3dd', label: 'Warning' },
  info: { color: '#2f5d3a', background: '#e9f4ec', label: 'Info' },
};

/**
 * Manager Inbox — the single triage queue. Items are workspace-scoped rows
 * reconciled from deterministic collectors; opening an item re-reads current
 * authority (stale rows stay visible but are flagged). Actions are operator
 * ack/resolve only — nothing here stages, publishes, repairs, or alters
 * onboarding state, and nothing executes automatically on click.
 */
export function ManagerInbox({ open, onClose, notifications = [], eventStatus = 'closed' }: ManagerInboxProps) {
  const [items, setItems] = useState<StoreManagerInboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<{ isCurrent: boolean; currentCount: number | null } | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const { reconcileStoreManagerInbox, fetchStoreManagerInbox } = await import('../../store-manager-api');
      await reconcileStoreManagerInbox();
      const data = await fetchStoreManagerInbox();
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Manager Inbox.');
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  if (!open) return null;

  const summary = summarizeInbox(items);
  const sorted = sortInboxItems(items);

  const openItem = async (item: StoreManagerInboxItem) => {
    setOpenItemId(item.id);
    setOpenDetail(null);
    try {
      const { fetchStoreManagerInboxItem } = await import('../../store-manager-api');
      const result = await fetchStoreManagerInboxItem(item.id);
      setOpenDetail({ isCurrent: result.isCurrent, currentCount: result.current?.count ?? null });
    } catch {
      setOpenDetail(null);
    }
  };

  const act = async (item: StoreManagerInboxItem, action: 'acknowledge' | 'resolve') => {
    setBusyId(item.id);
    setError(null);
    try {
      const api = await import('../../store-manager-api');
      const updated =
        action === 'acknowledge'
          ? await api.acknowledgeStoreManagerInboxItem(item.id)
          : await api.resolveStoreManagerInboxItem(item.id);
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed.`);
    } finally {
      setBusyId(null);
    }
  };

  const unread = notifications.filter((n) => n.readAt === null).length;

  return (
    <div
      role="dialog"
      aria-label="Manager Inbox"
      style={{
        position: 'absolute',
        right: 24,
        top: 64,
        zIndex: 50,
        width: 480,
        maxHeight: '76vh',
        overflowY: 'auto',
        padding: 16,
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Manager Inbox {unread > 0 ? <span style={{ color: colors.signetBurgundy }}>({unread} new)</span> : null}
          </div>
          <div style={{ fontSize: 11, color: colors.mulchBrown }}>
            {summary.total} findings · {summary.critical} critical · {summary.warning} warning · {summary.info} info ·{' '}
            {summary.open} open
            {eventStatus === 'live' ? ' · live' : eventStatus === 'reconnecting' ? ' · reconnecting' : ''}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Manager Inbox" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
      </div>

      {error ? <div style={{ fontSize: 12, color: colors.signetBurgundy, marginBottom: 8 }}>{error}</div> : null}
      {loading && sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>Reconciling inbox…</div>
      ) : null}

      {!loading && sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>No open findings. Deterministic collectors found nothing to triage.</div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((item) => {
          const sev = SEVERITY_STYLE[item.severity];
          const stale = isInboxItemStale(item);
          const prefill = inboxCommandPrefill(item);
          const detail = openItemId === item.id ? openDetail : null;
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              aria-label={`${item.title} (${item.count})`}
              onClick={() => void openItem(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') void openItem(item);
              }}
              style={{
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.md,
                padding: '10px 12px',
                cursor: 'pointer',
                background: colors.whiteSurface,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: sev.color, background: sev.background, padding: '2px 6px', borderRadius: 4 }}>
                  {sev.label}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: colors.ledgerCharcoal, flex: 1 }}>{item.title}</span>
                <span style={{ fontSize: 11, color: colors.mulchBrown }}>{formatInboxAge(item.lastSeenAt)}</span>
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 4 }}>
                {item.summary} · <span style={{ color: colors.ledgerCharcoal, fontWeight: 600 }}>{item.count}</span>
                {item.scope.kind !== 'catalog' && item.scope.kind !== 'sku_set'
                  ? ` · scope ${item.scope.kind}`
                  : ''}
                {' · '}
                <span style={{ fontWeight: 600, color: stale ? colors.signetBurgundy : colors.uniformGreen }}>
                  {stale ? 'stale' : lifecycleLabel(item.lifecycle)}
                </span>
              </div>
              {detail ? (
                <div style={{ fontSize: 11, color: detail.isCurrent ? colors.uniformGreen : colors.signetBurgundy, marginBottom: 4 }}>
                  {detail.isCurrent
                    ? `Current source confirmed (${detail.currentCount ?? item.count}).`
                    : 'This finding is out of date — re-open from the source before acting.'}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {prefill ? (
                  <code style={{ fontSize: 11, color: colors.mulchBrown, background: '#f4f1ea', padding: '2px 6px', borderRadius: 4 }}>{prefill}</code>
                ) : null}
                <div style={{ flex: 1 }} />
                {item.lifecycle === 'open' ? (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    className="btn btn-outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(item, 'acknowledge');
                    }}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    Acknowledge
                  </button>
                ) : null}
                {item.lifecycle === 'open' || item.lifecycle === 'acknowledged' ? (
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    className="btn btn-outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      void act(item, 'resolve');
                    }}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    Resolve
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
