/**
 * Store Manager schedule pure client derivation (operations console, Issue 4).
 *
 * Pure functions only — no fetch, no hooks, no React. All new schedule UI
 * derivation lives here (the dirty store-manager-logic.ts is untouched).
 */

import type {
  StoreManagerRecurrencePreset,
  StoreManagerScheduleDefinition,
  StoreManagerScheduleOccurrence,
  StoreManagerScheduleTemplate,
  StoreManagerOccurrenceStatus,
} from './store-manager-api';

const RECURRENCE_LABEL: Record<StoreManagerRecurrencePreset, string> = {
  daily: 'Daily',
  nightly: 'Nightly',
  weekly: 'Weekly',
};

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function recurrenceLabel(preset: StoreManagerRecurrencePreset): string {
  return RECURRENCE_LABEL[preset] ?? preset;
}

export function dayOfWeekLabel(day: number | null): string {
  if (day == null || day < 1 || day > 7) return '—';
  return WEEKDAY_NAMES[day - 1] ?? '—';
}

/** e.g. "Daily at 06:00" or "Weekly Mon at 07:00" */
export function scheduleScheduleLabel(schedule: StoreManagerScheduleDefinition): string {
  if (schedule.recurrencePreset === 'weekly') {
    return `Weekly ${dayOfWeekLabel(schedule.dayOfWeek)} at ${schedule.timeOfDay}`;
  }
  return `${recurrenceLabel(schedule.recurrencePreset)} at ${schedule.timeOfDay}`;
}

/** Relative "in N h" or absolute short date label for nextRunAt. */
export function formatNextRun(nextRunAt: string | null, now: number = Date.now()): string {
  if (!nextRunAt) return '—';
  const then = new Date(nextRunAt).getTime();
  if (!Number.isFinite(then)) return '—';
  const deltaMs = then - now;
  if (deltaMs <= 0) return 'due now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `in ${days}d`;
  return new Date(then).toISOString().slice(0, 10);
}

export function formatLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return 'never';
  return new Date(lastRunAt).toISOString().slice(0, 16).replace('T', ' ');
}

const OCCURRENCE_STATUS_LABEL: Record<StoreManagerOccurrenceStatus, string> = {
  pending: 'Pending',
  claimed: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  unavailable: 'Unavailable',
  cancelled: 'Cancelled',
};

export function occurrenceStatusLabel(status: StoreManagerOccurrenceStatus): string {
  return OCCURRENCE_STATUS_LABEL[status] ?? status;
}

export function occurrenceStatusTone(status: StoreManagerOccurrenceStatus): 'ok' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'pending':
    case 'claimed':
      return 'neutral';
    case 'unavailable':
    case 'cancelled':
      return 'warn';
    case 'failed':
      return 'bad';
  }
}

/** Sort schedules by enabled first, then nextRunAt (ascending). */
export function sortSchedules(schedules: StoreManagerScheduleDefinition[]): StoreManagerScheduleDefinition[] {
  return [...schedules].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aNext = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bNext = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aNext - bNext;
  });
}

/** Template descriptor minus the objective (kept bounded in the UI). */
export function templateSummary(template: StoreManagerScheduleTemplate): string {
  return template.description.length > 140
    ? `${template.description.slice(0, 140)}…`
    : template.description;
}

/** Recent occurrences grouped by status for the panel summary. */
export function summarizeOccurrences(occurrences: StoreManagerScheduleOccurrence[]): {
  total: number;
  completed: number;
  failed: number;
  unavailable: number;
} {
  return {
    total: occurrences.length,
    completed: occurrences.filter((o) => o.status === 'completed').length,
    failed: occurrences.filter((o) => o.status === 'failed').length,
    unavailable: occurrences.filter((o) => o.status === 'unavailable').length,
  };
}
