import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  StoreManagerTriggerDefinition,
  StoreManagerTriggerTemplate,
  StoreManagerTriggerKind,
  StoreManagerTriggerOccurrence,
  StoreManagerTriggerOccurrenceStatus,
  StoreManagerTriggerConfig,
} from '../../store-manager-api';
import {
  fetchStoreManagerTriggers,
  fetchStoreManagerTriggerTemplates,
  fetchStoreManagerTriggerOccurrences,
  createStoreManagerTrigger,
  setStoreManagerTriggerEnabled,
  runStoreManagerTriggerNow,
} from '../../store-manager-api';

interface TriggersPanelProps {
  open: boolean;
  onClose: () => void;
  variant?: 'modal' | 'inline';
}

const TONE_COLOR: Record<string, string> = {
  ok: '#2f5d3a',
  warn: '#8a6116',
  bad: '#8b1e2d',
  neutral: '#5b534b',
};

const KIND_OPTIONS: StoreManagerTriggerKind[] = [
  'import_finished',
  'change_set_approved',
  'sync_failed',
  'product_field_drift',
];

// ---------------------------------------------------------------------------
// Pure derivation helpers (display-only; no client-side trigger execution)
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<StoreManagerTriggerKind, string> = {
  import_finished: 'Import finished',
  change_set_approved: 'Change Set approved',
  sync_failed: 'Sync failed',
  product_field_drift: 'ProductField drift',
};

const KIND_DESCRIPTION: Record<StoreManagerTriggerKind, string> = {
  import_finished:
    'When an Onboarding Batch is provably terminal (every item finished, all Product SKUs known), audit its products read-only. Unprovable batches record a diagnostic — never a guessed completion.',
  change_set_approved:
    'When a Change Set becomes approved, prepare a read-only verification offer/report. Never pushes, publishes, or syncs.',
  sync_failed:
    'When a sync job fails, investigate the recorded redacted failure evidence and prepare a remediation report. Never retries or re-runs the sync.',
  product_field_drift:
    'When pending review work for a ProductField grows by at least the configured threshold between observations, generate a deterministic review set/report.',
};

const SCOPE_SUMMARY: Record<StoreManagerTriggerKind, string> = {
  import_finished: 'scope: imported SKUs (batch-derived, bounded)',
  change_set_approved: 'scope: change set',
  sync_failed: 'scope: sync job (redacted evidence)',
  product_field_drift: 'scope: ProductField',
};

const STATUS_LABEL: Record<StoreManagerTriggerOccurrenceStatus, string> = {
  pending: 'pending',
  claimed: 'claimed',
  completed: 'ok',
  failed: 'failed',
  unavailable: 'unavailable',
  cancelled: 'cancelled',
  diagnostic: 'diagnostic',
};

const STATUS_TONE: Record<string, string> = {
  completed: 'ok',
  diagnostic: 'warn',
  failed: 'bad',
  unavailable: 'warn',
  cancelled: 'neutral',
  pending: 'neutral',
  claimed: 'neutral',
};

function triggerKindLabel(kind: StoreManagerTriggerKind): string {
  return KIND_LABEL[kind] ?? kind;
}

function triggerKindDescription(kind: StoreManagerTriggerKind): string {
  return KIND_DESCRIPTION[kind] ?? '';
}

function triggerScopeSummary(kind: StoreManagerTriggerKind): string {
  return SCOPE_SUMMARY[kind] ?? '';
}

function triggerOccurrenceStatusLabel(status: StoreManagerTriggerOccurrenceStatus | 'completed' | 'failed' | 'unavailable' | 'diagnostic'): string {
  return STATUS_LABEL[status] ?? status;
}

function triggerOccurrenceStatusTone(status: StoreManagerTriggerOccurrenceStatus | 'completed' | 'failed' | 'unavailable' | 'diagnostic'): string {
  return STATUS_TONE[status] ?? 'neutral';
}

function triggerConfigSummary(config: StoreManagerTriggerConfig): string {
  if (config.kind === 'import_finished') return config.batchId ? `batch ${config.batchId.slice(0, 24)}` : 'all batches';
  if (config.kind === 'product_field_drift') return `threshold ${config.threshold}`;
  return '—';
}

interface OccurrenceSummary {
  total: number;
  completed: number;
  failed: number;
  diagnostics: number;
}

function summarizeTriggerOccurrences(occurrences: StoreManagerTriggerOccurrence[]): OccurrenceSummary {
  let completed = 0;
  let failed = 0;
  let diagnostics = 0;
  for (const o of occurrences) {
    if (o.status === 'completed') completed += 1;
    else if (o.status === 'failed' || o.status === 'unavailable') failed += 1;
    else if (o.status === 'diagnostic') diagnostics += 1;
  }
  return { total: occurrences.length, completed, failed, diagnostics };
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

/**
 * Triggers Panel — durable event-triggered READ-ONLY runs (Issue 5). Every
 * trigger is created disabled (automation inert until explicitly enabled),
 * every occurrence is system read-only, and "Run now" is not an approval
 * shortcut. The UI shows the kind, config, scope, last scan, and occurrence
 * history — including `diagnostic` occurrences (observation refused a run).
 * Trigger observation happens server-side; this component only renders and
 * calls the API.
 */
export function TriggersPanel({ open, onClose, variant = 'inline' }: TriggersPanelProps) {
  const [triggers, setTriggers] = useState<StoreManagerTriggerDefinition[]>([]);
  const [templates, setTemplates] = useState<StoreManagerTriggerTemplate[]>([]);
  const [occurrences, setOccurrences] = useState<Record<string, StoreManagerTriggerOccurrence[]>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [kind, setKind] = useState<StoreManagerTriggerKind>('import_finished');
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState(5);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const [items, tpls] = await Promise.all([
        fetchStoreManagerTriggers(),
        fetchStoreManagerTriggerTemplates(),
      ]);
      setTriggers(items);
      setTemplates(tpls);
      const occMap: Record<string, StoreManagerTriggerOccurrence[]> = {};
      for (const t of items) {
        occMap[t.id] = await fetchStoreManagerTriggerOccurrences(t.id, { limit: 20 });
      }
      setOccurrences(occMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshOccurrences = useCallback(async (id: string) => {
    const occ = await fetchStoreManagerTriggerOccurrences(id, { limit: 20 });
    setOccurrences((prev) => ({ ...prev, [id]: occ }));
  }, []);

  const toggle = useCallback(
    async (trigger: StoreManagerTriggerDefinition) => {
      setBusyId(trigger.id);
      setError(null);
      try {
        const updated = await setStoreManagerTriggerEnabled(trigger.id, !trigger.enabled);
        setTriggers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const runNow = useCallback(
    async (trigger: StoreManagerTriggerDefinition) => {
      setBusyId(trigger.id);
      setError(null);
      try {
        await runStoreManagerTriggerNow(trigger.id);
        await refreshOccurrences(trigger.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refreshOccurrences],
  );

  const create = useCallback(async () => {
    setBusyId('__create__');
    setCreateError(null);
    try {
      const config: StoreManagerTriggerConfig =
        kind === 'import_finished'
          ? { kind, batchId: null }
          : kind === 'product_field_drift'
            ? { kind, threshold }
            : { kind };
      await createStoreManagerTrigger({ kind, name, config });
      setCreating(false);
      setName('');
      setThreshold(5);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [kind, name, threshold, load]);

  if (!open) return null;

  const isInline = variant === 'inline';

  const cardContent = (
    <div
      role={isInline ? 'region' : 'dialog'}
      aria-modal={isInline ? undefined : true}
      aria-label="Event triggers"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: '100%',
        maxWidth: isInline ? 900 : 640,
        maxHeight: isInline ? undefined : '80vh',
        overflowY: 'auto',
        backgroundColor: colors.whiteSurface,
        borderRadius: rounded.lg,
        padding: 24,
        border: `1px solid ${colors.cardBorder}`,
        boxShadow: isInline ? '0 1px 3px rgba(33,20,20,0.04)' : '0 8px 30px rgba(33,20,20,0.18)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, flex: 1 }}>
          Event Triggers
        </span>
        {isInline ? null : (
          <button type="button" onClick={onClose} className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
            Close
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 12 }}>
        Read-only runs fired by durable committed-state transitions (import finished, Change Set approved, sync failed, ProductField drift). Every run is system read-only; nothing is staged, approved, published, synced, or repaired automatically. Triggers are disabled by default.
      </div>

      {error ? <div style={{ fontSize: 12, color: colors.signetBurgundy, marginBottom: 8 }}>{error}</div> : null}

      <button type="button" onClick={() => { setCreating((v) => !v); setCreateError(null); }} className="btn btn-outline" style={{ fontSize: 12, padding: '6px 12px', marginBottom: 12 }}>
        {creating ? 'Cancel' : '+ New trigger'}
      </button>

      {creating ? (
        <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: colors.mulchBrown }}>
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as StoreManagerTriggerKind)}
              style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{triggerKindLabel(k)}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 8, display: 'block' }}>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={templates.find((t) => t.kind === kind)?.name ?? 'Trigger name'}
              style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
            />
          </label>
          {kind === 'product_field_drift' ? (
            <label style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 8, display: 'block' }}>
              Drift threshold (delta in pending review counts)
              <input
                type="number"
                min={1}
                max={10000}
                value={threshold}
                onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
              />
            </label>
          ) : null}
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 8 }}>
            {triggerKindDescription(kind)}
          </div>
          {createError ? <div style={{ fontSize: 12, color: colors.signetBurgundy, marginTop: 6 }}>{createError}</div> : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => void create()} disabled={busyId === '__create__'} className="btn btn-primary" style={{ fontSize: 12, padding: '6px 12px' }}>
              {busyId === '__create__' ? 'Creating…' : 'Create (disabled until enabled)'}
            </button>
            <button type="button" onClick={() => { setCreating(false); setCreateError(null); }} className="btn btn-outline" style={{ fontSize: 12, padding: '6px 12px' }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {triggers.map((trigger) => {
          const occ = occurrences[trigger.id] ?? [];
          const summary = summarizeTriggerOccurrences(occ);
          const tone = triggerOccurrenceStatusTone(trigger.lastScanStatus ?? 'diagnostic');
          return (
            <div key={trigger.id} style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, flex: 1 }}>{trigger.name}</span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: trigger.enabled ? '#2f5d3a' : colors.mulchBrown,
                    background: trigger.enabled ? '#e9f4ec' : '#f0ede8',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  {trigger.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <span style={{ fontSize: 11, color: TONE_COLOR[tone] ?? colors.mulchBrown }}>
                  Last scan: {trigger.lastScanAt ? triggerOccurrenceStatusLabel(trigger.lastScanStatus ?? 'diagnostic') : 'never'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 4 }}>
                {triggerKindLabel(trigger.kind)} · {triggerConfigSummary(trigger.config)} · {triggerScopeSummary(trigger.kind)}
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 6 }}>
                {summary.total > 0
                  ? `History: ${summary.completed} ok, ${summary.failed} failed, ${summary.diagnostics} diagnostics`
                  : 'No occurrences yet.'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={busyId === trigger.id} onClick={() => void toggle(trigger)} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }}>
                  {busyId === trigger.id ? '…' : trigger.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" disabled={busyId === trigger.id || !trigger.enabled} onClick={() => void runNow(trigger)} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} title="Run now (read-only, system policy)">
                  Run now (read-only)
                </button>
              </div>
              {trigger.enabled ? null : (
                <div style={{ fontSize: 10, color: colors.mulchBrown, marginTop: 6 }}>
                  Created {new Date(trigger.createdAt).toISOString().slice(0, 10)} · version {trigger.version} · inert until enabled
                </div>
              )}
              {occ.length > 0 ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ fontSize: 11, color: colors.ledgerCharcoal, cursor: 'pointer' }}>
                    Occurrence history ({occ.length})
                  </summary>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11, color: colors.mulchBrown }}>
                    {occ.slice(0, 10).map((o) => (
                      <li key={o.id}>
                        {triggerOccurrenceStatusLabel(o.status)}
                        {o.status === 'diagnostic' ? ` — ${o.errorCode ?? 'diagnostic'}` : ''}
                        {' · '}
                        {o.sourceRef.id.slice(0, 24)}
                        {o.completedAt ? ` · ${new Date(o.completedAt).toISOString().slice(0, 16)}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>

      {!loading && triggers.length === 0 && !creating ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>
          No triggers yet. Triggers run read-only and are disabled by default.
        </div>
      ) : null}
    </div>
  );

  if (isInline) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', background: colors.feedBagCream }}>
        {cardContent}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(33,20,20,0.35)',
        padding: 24,
      }}
    >
      {cardContent}
    </div>
  );
}
