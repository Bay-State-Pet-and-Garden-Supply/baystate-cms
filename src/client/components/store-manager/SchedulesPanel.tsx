import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  StoreManagerScheduleDefinition,
  StoreManagerScheduleTemplate,
  StoreManagerScheduleOccurrence,
  StoreManagerRecurrencePreset,
} from '../../store-manager-api';
import {
  sortSchedules,
  scheduleScheduleLabel,
  formatNextRun,
  formatLastRun,
  occurrenceStatusLabel,
  occurrenceStatusTone,
  summarizeOccurrences,
  recurrenceLabel,
  dayOfWeekLabel,
} from '../../store-manager-schedule-logic';

interface SchedulesPanelProps {
  open: boolean;
  onClose: () => void;
  variant?: 'modal' | 'inline';
}

const TONE_COLOR: Record<string, string> = {
  ok: '#2f5d3a',
  warn: '#8a6116',
  bad: '#8b1e2d',
  neutral: colors.mulchBrown,
};

const PRESET_OPTIONS: StoreManagerRecurrencePreset[] = ['daily', 'nightly', 'weekly'];

/**
 * Schedules Panel — leased read-only scheduled runs. Every schedule is
 * created disabled (automation inert until explicitly enabled), every run is
 * system read-only, and "Run now" is not an approval shortcut. UI shows the
 * timezone, next run, last run, read-only posture, and occurrence history.
 */
export function SchedulesPanel({ open, onClose, variant = 'inline' }: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<StoreManagerScheduleDefinition[]>([]);
  const [templates, setTemplates] = useState<StoreManagerScheduleTemplate[]>([]);
  const [occurrences, setOccurrences] = useState<Record<string, StoreManagerScheduleOccurrence[]>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [templateKind, setTemplateKind] = useState<string>('daily_catalog_health');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [preset, setPreset] = useState<StoreManagerRecurrencePreset>('daily');
  const [timeOfDay, setTimeOfDay] = useState('06:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const api = await import('../../store-manager-api');
      const [scheds, tmpls] = await Promise.all([
        api.fetchStoreManagerSchedules(),
        api.fetchStoreManagerScheduleTemplates(),
      ]);
      setSchedules(scheds);
      setTemplates(tmpls);
      const occ: Record<string, StoreManagerScheduleOccurrence[]> = {};
      for (const s of scheds.slice(0, 10)) {
        occ[s.id] = await api.fetchStoreManagerScheduleOccurrences(s.id, { limit: 10 });
      }
      setOccurrences(occ);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules.');
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!open) return null;

  const sorted = sortSchedules(schedules);
  const selectedTemplate = templates.find((t) => t.kind === templateKind);

  const toggle = async (schedule: StoreManagerScheduleDefinition) => {
    setBusyId(schedule.id);
    setError(null);
    try {
      const { setStoreManagerScheduleEnabled } = await import('../../store-manager-api');
      await setStoreManagerScheduleEnabled(schedule.id, !schedule.enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed.');
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (schedule: StoreManagerScheduleDefinition) => {
    setBusyId(schedule.id);
    setError(null);
    try {
      const { runStoreManagerScheduleNow } = await import('../../store-manager-api');
      const result = await runStoreManagerScheduleNow(schedule.id);
      if (result.result.status === 'failed' || result.result.status === 'unavailable') {
        throw new Error(`Run failed: ${result.result.errorCode ?? result.result.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed.');
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    setCreateError(null);
    if (!name.trim()) {
      setCreateError('Name is required.');
      return;
    }
    setBusyId('__create__');
    try {
      const { createStoreManagerSchedule } = await import('../../store-manager-api');
      await createStoreManagerSchedule({
        templateKind: templateKind as StoreManagerScheduleTemplate['kind'],
        name: name.trim(),
        timezone: timezone.trim() || 'UTC',
        recurrencePreset: preset,
        timeOfDay,
        dayOfWeek: preset === 'weekly' ? dayOfWeek : undefined,
      });
      setCreating(false);
      setName('');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setBusyId(null);
    }
  };

  const isInline = variant === 'inline';

  const cardContent = (
    <div
      role={isInline ? 'region' : 'dialog'}
      aria-modal={isInline ? undefined : true}
      aria-label="Schedules — read-only scheduled runs"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: '100%',
        maxWidth: isInline ? 900 : 580,
        maxHeight: isInline ? undefined : '85vh',
        overflowY: 'auto',
        padding: 24,
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: isInline ? '0 1px 3px rgba(33,20,20,0.04)' : '0 20px 25px -5px rgba(0, 0, 0, 0.15)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal }}>
            Schedules <span style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, marginLeft: 6 }}>READ-ONLY</span>
          </div>
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 2 }}>
            {schedules.length} schedule(s) · scheduled runs can inspect and report but can never stage, approve, publish, sync, or repair
          </div>
        </div>
        {isInline ? null : (
          <button type="button" onClick={onClose} aria-label="Close Schedules" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
            ✕ Close
          </button>
        )}
      </div>

      {error ? <div style={{ fontSize: 12, color: colors.signetBurgundy, marginBottom: 8 }}>{error}</div> : null}
      {loading && schedules.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>Loading schedules…</div>
      ) : null}

      {!creating && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="btn btn-primary"
          style={{ fontSize: 12, padding: '6px 14px', marginBottom: 12 }}
        >
          + New schedule
        </button>
      )}

      {creating ? (
        <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal }}>Create schedule from template</div>
          {selectedTemplate ? (
            <div style={{ fontSize: 11, color: colors.mulchBrown }}>{selectedTemplate.description}</div>
          ) : null}
          <label style={{ fontSize: 11, color: colors.mulchBrown }}>
            Template
            <select
              value={templateKind}
              onChange={(e) => setTemplateKind(e.target.value)}
              style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
            >
              {templates.map((t) => (
                <option key={t.kind} value={t.kind}>{t.name}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, color: colors.mulchBrown }}>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={templates.find((t) => t.kind === templateKind)?.name ?? 'Schedule name'}
              style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ fontSize: 11, color: colors.mulchBrown, flex: 1 }}>
              Recurrence
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as StoreManagerRecurrencePreset)}
                style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
              >
                {PRESET_OPTIONS.map((p) => <option key={p} value={p}>{recurrenceLabel(p)}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11, color: colors.mulchBrown, flex: 1 }}>
              Time (HH:MM)
              <input
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                placeholder="06:00"
                style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
              />
            </label>
            {preset === 'weekly' ? (
              <label style={{ fontSize: 11, color: colors.mulchBrown, flex: 1 }}>
                Day
                <select
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
                >
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{dayOfWeekLabel(d)}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          <label style={{ fontSize: 11, color: colors.mulchBrown }}>
            Timezone (IANA)
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
              style={{ width: '100%', marginTop: 4, padding: '4px 6px', fontSize: 12, borderRadius: 4, border: `1px solid ${colors.cardBorder}` }}
            />
          </label>
          {createError ? <div style={{ fontSize: 12, color: colors.signetBurgundy }}>{createError}</div> : null}
          <div style={{ display: 'flex', gap: 8 }}>
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
        {sorted.map((schedule) => {
          const occ = occurrences[schedule.id] ?? [];
          const summary = summarizeOccurrences(occ);
          const tone = occurrenceStatusTone(schedule.lastRunStatus ?? 'pending');
          return (
            <div key={schedule.id} style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, flex: 1 }}>{schedule.name}</span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: schedule.enabled ? '#2f5d3a' : colors.mulchBrown,
                    background: schedule.enabled ? '#e9f4ec' : '#f0ede8',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  {schedule.enabled ? 'Enabled' : 'Disabled'}
                </span>
                <span style={{ fontSize: 11, color: TONE_COLOR[tone] ?? colors.mulchBrown }}>
                  Last: {schedule.lastRunAt ? occurrenceStatusLabel(schedule.lastRunStatus ?? 'pending') : 'never'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 6 }}>
                {scheduleScheduleLabel(schedule)} · {schedule.timezone} · Next: {formatNextRun(schedule.nextRunAt)}
                {schedule.lastRunAt ? ` · Last run ${formatLastRun(schedule.lastRunAt)}` : ''}
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 6 }}>
                {summary.total > 0
                  ? `History: ${summary.completed} ok, ${summary.failed} failed, ${summary.unavailable} unavailable`
                  : 'No occurrences yet.'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={busyId === schedule.id} onClick={() => void toggle(schedule)} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }}>
                  {busyId === schedule.id ? '…' : schedule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" disabled={busyId === schedule.id || !schedule.enabled} onClick={() => void runNow(schedule)} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} title="Run now (read-only, system policy)">
                  Run now (read-only)
                </button>
              </div>
              {schedule.enabled ? null : (
                <div style={{ fontSize: 10, color: colors.mulchBrown, marginTop: 6 }}>
                  Created {new Date(schedule.createdAt).toISOString().slice(0, 10)} · version {schedule.version} · inert until enabled
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!loading && schedules.length === 0 && !creating ? (
        <div style={{ fontSize: 12, color: colors.mulchBrown, padding: 12 }}>
          No schedules yet. Schedules run read-only and are disabled by default.
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
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(33, 20, 20, 0.45)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      {cardContent}
    </div>
  );
}
