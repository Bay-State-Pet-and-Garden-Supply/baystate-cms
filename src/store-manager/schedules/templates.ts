/**
 * Store Manager schedule templates (operations console, Issue 4).
 *
 * Five locked read-only templates. Each template is a server-owned descriptor:
 * a bounded objective the model is asked to pursue inside the unattended
 * read-only runtime policy (persistent adapters are denied at registry
 * dispatch before any side effect). Templates are inert until copied into a
 * workspace schedule and enabled; users may only change supported time/day/
 * timezone/scope/thresholds — never the objective or the read-only posture.
 */

import type {
  StoreManagerRecurrencePreset,
  StoreManagerScheduleTemplateKind,
} from '../../shared/schemas/store-manager-schedule';

export interface StoreManagerScheduleTemplate {
  kind: StoreManagerScheduleTemplateKind;
  name: string;
  description: string;
  /** Server-owned objective template (static, bounded, read-only framed). */
  objective: string;
  defaultRecurrencePreset: StoreManagerRecurrencePreset;
  defaultTimeOfDay: string;
  /** Required (non-null) for weekly presets. */
  defaultDayOfWeek?: number;
}

export const STORE_MANAGER_SCHEDULE_TEMPLATES: readonly StoreManagerScheduleTemplate[] = [
  {
    kind: 'daily_catalog_health',
    name: 'Daily catalog health scan',
    description:
      'Read-only daily catalog-health scan: identify and summarize high-severity issues and any anomalies in the current catalog.',
    objective:
      'Run a read-only catalog health scan for the current workspace. Inspect authoritative catalog-health evidence and summarize high-severity issues, counts, and affected products. Do not stage, approve, publish, sync, or repair anything.',
    defaultRecurrencePreset: 'daily',
    defaultTimeOfDay: '06:00',
  },
  {
    kind: 'weekly_cleanup_report',
    name: 'Weekly cleanup report',
    description:
      'Read-only weekly cleanup report: summarize ProductField normalization opportunities and categorize cleanup work by field and rule.',
    objective:
      'Produce a read-only weekly cleanup report for the current workspace. Inspect ProductField audit evidence and normalization opportunities, then summarize them grouped by field and rule with counts and examples. Do not stage, approve, publish, sync, or repair anything.',
    defaultRecurrencePreset: 'weekly',
    defaultTimeOfDay: '07:00',
    defaultDayOfWeek: 1, // Monday
  },
  {
    kind: 'nightly_anomalies',
    name: 'Nightly new anomalies',
    description:
      'Read-only nightly run: identify catalog anomalies that appeared since yesterday and summarize them.',
    objective:
      'Identify catalog anomalies that appeared since the previous day in the current workspace (read-only). Summarize new anomalies with counts, severity, and affected products. Do not stage, approve, publish, sync, or repair anything.',
    defaultRecurrencePreset: 'nightly',
    defaultTimeOfDay: '02:00',
  },
  {
    kind: 'failed_sync_digest',
    name: 'Failed-sync digest',
    description:
      'Read-only digest of recently failed sync jobs: record redacted failure evidence and summarize causes.',
    objective:
      'Review recently failed sync jobs in the current workspace (read-only). Using recorded failure evidence only, summarize failed jobs, their error classes, and any repeated patterns. Never retry, re-run, or trigger a sync. Do not stage, approve, publish, sync, or repair anything.',
    defaultRecurrencePreset: 'nightly',
    defaultTimeOfDay: '03:00',
  },
  {
    kind: 'stale_proposal_review',
    name: 'Stale-proposal review',
    description:
      'Read-only review of stored catalog-health proposals that have been awaiting review for a long time.',
    objective:
      'Review stored catalog-health proposals in the current workspace that are awaiting review (read-only). Summarize the backlog, oldest proposals, and fields with the most pending work. Do not stage, approve, publish, sync, repair, or store anything.',
    defaultRecurrencePreset: 'weekly',
    defaultTimeOfDay: '08:00',
    defaultDayOfWeek: 3, // Wednesday
  },
];

export function getScheduleTemplate(kind: StoreManagerScheduleTemplateKind): StoreManagerScheduleTemplate | null {
  return STORE_MANAGER_SCHEDULE_TEMPLATES.find((t) => t.kind === kind) ?? null;
}

export function listScheduleTemplates(): readonly StoreManagerScheduleTemplate[] {
  return STORE_MANAGER_SCHEDULE_TEMPLATES;
}
