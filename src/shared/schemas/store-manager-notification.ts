// ---------------------------------------------------------------------------
// Store Manager notification schemas (operations console, Issue 3)
//
// Notifications are durable in-app threshold FACTS, never model prose. A
// deterministic rule engine evaluates collector/report snapshots and emits
// only on threshold crossing or a new source identity. Rows carry a
// per-workspace monotonic sequence for cursor-based SSE with polling
// fallback. No email/SMS/Slack/webhook/browser-push transport in this epic.
// ---------------------------------------------------------------------------

import { z } from 'zod';

export const STORE_MANAGER_NOTIFICATION_BOUNDS = {
  maxRuleIdLength: 100,
  maxRuleKindLength: 50,
  maxFingerprintLength: 400,
  maxTitleLength: 200,
  maxMessageLength: 2000,
  maxSnapshotJsonBytes: 16 * 1024,
  maxThreshold: 1_000_000,
  maxEmittedPerEvaluation: 20,
} as const;

/**
 * Notification rule kinds. Phase A enables the collector-transition rules;
 * `scheduled_report_new_fingerprint` is a Phase B seam (seeded disabled).
 */
export const STORE_MANAGER_NOTIFICATION_RULE_KINDS = [
  'proposal_backlog_exceeded',
  'critical_issue_count_increased',
  'sync_failure_appeared',
  'image_integrity_dropped',
  'scheduled_report_new_fingerprint',
] as const;
export const StoreManagerNotificationRuleKindSchema = z.enum(STORE_MANAGER_NOTIFICATION_RULE_KINDS);
export type StoreManagerNotificationRuleKind = z.infer<typeof StoreManagerNotificationRuleKindSchema>;

/** Explicit per-rule configuration (validated, bounded). */
export const StoreManagerNotificationRuleConfigSchema = z.object({
  /** proposal_backlog_exceeded threshold (catalog health proposals awaiting review). */
  threshold: z.number().int().min(0).max(STORE_MANAGER_NOTIFICATION_BOUNDS.maxThreshold).optional(),
}).strict();
export type StoreManagerNotificationRuleConfig = z.infer<typeof StoreManagerNotificationRuleConfigSchema>;

/** Durable notification row (workspace-scoped, sequence-ordered). */
export const StoreManagerNotificationSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  ruleId: z.string().min(1).max(STORE_MANAGER_NOTIFICATION_BOUNDS.maxRuleIdLength),
  ruleKind: StoreManagerNotificationRuleKindSchema,
  ruleVersion: z.number().int().positive().max(10_000),
  /** Transition fingerprint (sha256 hex) — dedupes chatter. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string().min(1).max(STORE_MANAGER_NOTIFICATION_BOUNDS.maxTitleLength),
  message: z.string().min(1).max(STORE_MANAGER_NOTIFICATION_BOUNDS.maxMessageLength),
  /** Optional link to the Inbox item this notification triages. */
  inboxItemId: z.string().min(1).max(64).nullable(),
  /** Optional originating Store Manager run id (Phase B scheduled reports). */
  sourceRunId: z.string().min(1).max(64).nullable(),
  /** Monotonic per-workspace sequence for cursor SSE/polling. */
  sequence: z.number().int().positive(),
  readAt: z.string().min(1).max(64).nullable(),
  createdAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerNotification = z.infer<typeof StoreManagerNotificationSchema>;

export const StoreManagerNotificationListQuerySchema = z.object({
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();
export type StoreManagerNotificationListQuery = z.infer<typeof StoreManagerNotificationListQuerySchema>;

/** Evaluation result returned to routes/SSE (bounded, never raw snapshots). */
export const StoreManagerNotificationEvaluationSchema = z.object({
  emitted: z.array(StoreManagerNotificationSchema).max(STORE_MANAGER_NOTIFICATION_BOUNDS.maxEmittedPerEvaluation),
  latestSequence: z.number().int().nonnegative(),
}).strict();
export type StoreManagerNotificationEvaluation = z.infer<typeof StoreManagerNotificationEvaluationSchema>;
