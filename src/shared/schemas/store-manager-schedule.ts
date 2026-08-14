// ---------------------------------------------------------------------------
// Store Manager schedule schemas (operations console, Issue 4).
//
// A schedule is a workspace-owned definition with a stable id, immutable
// versions, a constrained recurrence preset (daily/nightly/weekly — no
// arbitrary cron or executable code), an IANA timezone, and an objective
// template. Schedules run read-only: the runtime enforces the unattended
// read-only policy, so no schedule can stage, approve, publish, sync, or
// repair. Every field is bounded and redacted by construction; unknown keys
// fail.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema } from './store-manager-operations';
import { StoreManagerPolicyProfileSchema } from './store-manager-operations';

export const STORE_MANAGER_SCHEDULE_BOUNDS = {
  maxNameLength: 100,
  maxTimezoneLength: 100,
  maxObjectiveLength: 2000,
  maxOccurrenceKeyLength: 200,
  maxErrorCodeLength: 100,
  maxRetries: 10,
  maxCatchUpOccurrences: 200,
} as const;

/** Constrained recurrence presets. No arbitrary cron or code. */
export const STORE_MANAGER_RECURRENCE_PRESETS = ['daily', 'nightly', 'weekly'] as const;
export const StoreManagerRecurrencePresetSchema = z.enum(STORE_MANAGER_RECURRENCE_PRESETS);
export type StoreManagerRecurrencePreset = z.infer<typeof StoreManagerRecurrencePresetSchema>;

/** The five initial schedule templates (locked in the plan). */
export const STORE_MANAGER_SCHEDULE_TEMPLATE_KINDS = [
  'daily_catalog_health',
  'weekly_cleanup_report',
  'nightly_anomalies',
  'failed_sync_digest',
  'stale_proposal_review',
] as const;
export const StoreManagerScheduleTemplateKindSchema = z.enum(STORE_MANAGER_SCHEDULE_TEMPLATE_KINDS);
export type StoreManagerScheduleTemplateKind = z.infer<typeof StoreManagerScheduleTemplateKindSchema>;

/** Durable occurrence statuses (never 'running' as a stuck state). */
export const STORE_MANAGER_OCCURRENCE_STATUSES = [
  'pending',
  'claimed',
  'completed',
  'failed',
  'unavailable',
  'cancelled',
] as const;
export const StoreManagerOccurrenceStatusSchema = z.enum(STORE_MANAGER_OCCURRENCE_STATUSES);
export type StoreManagerOccurrenceStatus = z.infer<typeof StoreManagerOccurrenceStatusSchema>;

const timeOfDayRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const TimeOfDaySchema = z.string().regex(timeOfDayRegex, 'timeOfDay must be "HH:MM" (24h)');
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

/**
 * A workspace-owned schedule definition. `version` increments on every
 * immutable definition edit; runs always capture the version + definition
 * hash so they can never observe later edits.
 */
export const StoreManagerScheduleDefinitionSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxNameLength),
  version: z.number().int().positive(),
  templateKind: StoreManagerScheduleTemplateKindSchema,
  enabled: z.boolean(),
  /** IANA timezone identifier (validated server-side with Intl). */
  timezone: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxTimezoneLength),
  recurrencePreset: StoreManagerRecurrencePresetSchema,
  timeOfDay: TimeOfDaySchema,
  /** 1 (Monday) .. 7 (Sunday); required for weekly presets. */
  dayOfWeek: z.number().int().min(1).max(7).nullable(),
  scope: StoreManagerPinnedScopeSchema.nullable(),
  selectedModel: z.string().min(1).max(200).nullable(),
  objective: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxObjectiveLength),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  policyProfile: StoreManagerPolicyProfileSchema.nullable(),
  nextRunAt: z.string().min(1).max(64).nullable(),
  lastRunAt: z.string().min(1).max(64).nullable(),
  lastRunStatus: StoreManagerOccurrenceStatusSchema.nullable(),
  lastRunId: z.string().min(1).max(64).nullable(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerScheduleDefinition = z.infer<typeof StoreManagerScheduleDefinitionSchema>;

/** Immutable version row content (what the schedule captured at that version). */
export const StoreManagerScheduleVersionSchema = StoreManagerScheduleDefinitionSchema.extend({
  versionId: z.string().min(1).max(64),
}).strict();
export type StoreManagerScheduleVersion = z.infer<typeof StoreManagerScheduleVersionSchema>;

/**
 * One scheduled occurrence. `occurrenceKey` is unique per workspace and is the
 * restart-safety primitive: the same key can never run twice.
 */
export const StoreManagerScheduleOccurrenceSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  scheduleId: z.string().min(1).max(64),
  scheduleVersion: z.number().int().positive(),
  occurrenceKey: z.string().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxOccurrenceKeyLength),
  scheduledAt: z.string().min(1).max(64),
  status: StoreManagerOccurrenceStatusSchema,
  runId: z.string().min(1).max(64).nullable(),
  errorCode: z.string().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxErrorCodeLength).nullable(),
  retryCount: z.number().int().min(0).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxRetries),
  claimedAt: z.string().min(1).max(64).nullable(),
  leaseExpiresAt: z.string().min(1).max(64).nullable(),
  heartbeatAt: z.string().min(1).max(64).nullable(),
  completedAt: z.string().min(1).max(64).nullable(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerScheduleOccurrence = z.infer<typeof StoreManagerScheduleOccurrenceSchema>;

// ---------------------------------------------------------------------------
// Request schemas (routes)
// ---------------------------------------------------------------------------

/** Create a schedule from one of the five locked templates. */
export const StoreManagerScheduleCreateRequestSchema = z.object({
  templateKind: StoreManagerScheduleTemplateKindSchema,
  name: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxNameLength),
  timezone: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxTimezoneLength),
  recurrencePreset: StoreManagerRecurrencePresetSchema,
  timeOfDay: TimeOfDaySchema,
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  scope: StoreManagerPinnedScopeSchema.optional(),
  selectedModel: z.string().min(1).max(200).optional(),
}).strict();
export type StoreManagerScheduleCreateRequest = z.infer<typeof StoreManagerScheduleCreateRequestSchema>;

/** Update editable fields (timezone/time/day/name/scope/model). No cron. */
export const StoreManagerScheduleUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxNameLength).optional(),
  timezone: z.string().trim().min(1).max(STORE_MANAGER_SCHEDULE_BOUNDS.maxTimezoneLength).optional(),
  recurrencePreset: StoreManagerRecurrencePresetSchema.optional(),
  timeOfDay: TimeOfDaySchema.optional(),
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  scope: StoreManagerPinnedScopeSchema.nullable().optional(),
  selectedModel: z.string().min(1).max(200).nullable().optional(),
}).strict();
export type StoreManagerScheduleUpdateRequest = z.infer<typeof StoreManagerScheduleUpdateRequestSchema>;

/** Run-now request: optional scope/model override (still system read-only). */
export const StoreManagerScheduleRunNowRequestSchema = z.object({
  selectedModel: z.string().min(1).max(200).optional(),
}).strict();
export type StoreManagerScheduleRunNowRequest = z.infer<typeof StoreManagerScheduleRunNowRequestSchema>;

/** Occurrence listing query (cursor pagination, bounded). */
export const StoreManagerOccurrenceListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  status: StoreManagerOccurrenceStatusSchema.optional(),
}).strict();
export type StoreManagerOccurrenceListQuery = z.infer<typeof StoreManagerOccurrenceListQuerySchema>;
