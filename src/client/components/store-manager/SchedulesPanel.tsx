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
export function SchedulesPanel({ open, onClose }: SchedulesPanelProps) {
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

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (schedule: StoreManagerScheduleDefinition) =>
    act(schedule.id, async () => {
      const { setStoreManagerScheduleEnabled } = await import('../../store-manager-api');
      await setStoreManagerScheduleEnabled(schedule.id, !schedule.enabled);
    });

  const runNow = (schedule: StoreManagerScheduleDefinition) =>
    act(schedule.id, async () => {
      const { runStoreManagerScheduleNow } = await import('../../store-manager-api');
      const result = await runStoreManagerScheduleNow(schedule.id);
      if (result.result.status === 'failed' || result.result.status === 'unavailable') {
        throw new Error(`Run failed: ${result.result.errorCode ?? result.result.status}`);
      }
    });

  const create = async () => {
    setCreateError(null);
    setBusyId('__create__');
    try {
      const { createStoreManagerSchedule } = await import('../../store-manager-api');
      await createStoreManagerSchedule({
        templateKind: templateKind as StoreManagerScheduleTemplate['kind'],
        name: name.trim() || (templates.find((t) => t.kind === templateKind)?.name ?? 'Schedule'),
        timezone: timezone.trim() || 'UTC',
        recurrencePreset: preset,
        timeOfDay,
        dayOfWeek: preset === 'weekly' ? dayOfWeek : undefined,
      });
      setCreating(false);
      setName('');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Schedule create failed.');
    } finally {
      setBusyId(null);
    }
  };

  const selectedTemplate = templates.find((t) => t.kind === templateKind);

  return (
    <div
      role="dialog"
      aria-label="Schedules — read-only scheduled runs"
      style={{
        position: 'absolute',
        right: 24,
        top: 64,
        zIndex: 50,
        width: 520,
        maxHeight: '80vh',
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
            Schedules <span style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, marginLeft: 6 }}>READ-ONLY</span>
          </div>
          <div style={{ fontSize: 11, color: colors.mulchBrown }}>
            {schedules.length} schedule(s) · scheduled runs can inspect and report but can never stage, approve, publish, sync, or repair
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Schedules" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
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
          style={{ fontSize: 12, padding: '6px 12px', marginBottom: 12 }}
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
}
