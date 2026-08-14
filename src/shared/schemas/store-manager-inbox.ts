// ---------------------------------------------------------------------------
// Store Manager Inbox schemas (operations console, Issue 3)
//
// One workspace-scoped triage queue with durable lifecycle
// (open | acknowledged | resolved | superseded) and deterministic collectors.
// Everything stored is bounded and redacted by construction; unknown keys are
// rejected (.strict()). The model has NO tool that can create, acknowledge,
// resolve, or hide Inbox items — only operators via the API routes.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema } from './store-manager-operations';

export const STORE_MANAGER_INBOX_BOUNDS = {
  maxTitleLength: 200,
  maxSummaryLength: 2000,
  maxScopeJsonBytes: 4096,
  maxRefKindLength: 50,
  maxRefIdLength: 200,
  maxSourceRefs: 200,
  maxDedupeKeyLength: 400,
  maxCount: 1_000_000,
} as const;

/** The six deterministic collector classes (exact, stable vocabulary).
 * `scheduled_run_failed` is the additive Issue 4 kind: a deduped operational
 * item for a scheduled run that failed/unavailable/deadline-terminalized. */
export const STORE_MANAGER_INBOX_KINDS = [
  'high_severity_catalog_issues',
  'proposals_awaiting_review',
  'failed_sync_jobs',
  'image_repairs_recommended',
  'curation_stalled',
  'scheduled_run_failed',
] as const;
export const StoreManagerInboxKindSchema = z.enum(STORE_MANAGER_INBOX_KINDS);
export type StoreManagerInboxKind = z.infer<typeof StoreManagerInboxKindSchema>;

/** Durable lifecycle. `resolved`/`superseded` rows stay auditable forever. */
export const STORE_MANAGER_INBOX_LIFECYCLES = ['open', 'acknowledged', 'resolved', 'superseded'] as const;
export const StoreManagerInboxLifecycleSchema = z.enum(STORE_MANAGER_INBOX_LIFECYCLES);
export type StoreManagerInboxLifecycle = z.infer<typeof StoreManagerInboxLifecycleSchema>;

/** Finding severity for triage grouping. */
export const STORE_MANAGER_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const StoreManagerSeveritySchema = z.enum(STORE_MANAGER_SEVERITIES);
export type StoreManagerSeverity = z.infer<typeof StoreManagerSeveritySchema>;

/** Bounded scope identifying WHAT the finding is about. */
export const StoreManagerInboxScopeSchema = z.union([
  z.object({ kind: z.literal('catalog') }).strict(),
  StoreManagerPinnedScopeSchema,
]);
export type StoreManagerInboxScope = z.infer<typeof StoreManagerInboxScopeSchema>;

/** Bounded source reference (authoritative row the finding derives from). */
export const StoreManagerInboxSourceRefSchema = z.object({
  kind: z.string().min(1).max(STORE_MANAGER_INBOX_BOUNDS.maxRefKindLength),
  id: z.string().min(1).max(STORE_MANAGER_INBOX_BOUNDS.maxRefIdLength),
}).strict();
export type StoreManagerInboxSourceRef = z.infer<typeof StoreManagerInboxSourceRefSchema>;

/** Durable Inbox item (workspace-scoped). */
export const StoreManagerInboxItemSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  kind: StoreManagerInboxKindSchema,
  /** Stable dedupe key: {kind}:{sourceKey}:v{ruleVersion} (unique per workspace). */
  dedupeKey: z.string().min(1).max(STORE_MANAGER_INBOX_BOUNDS.maxDedupeKeyLength),
  severity: StoreManagerSeveritySchema,
  title: z.string().min(1).max(STORE_MANAGER_INBOX_BOUNDS.maxTitleLength),
  summary: z.string().min(1).max(STORE_MANAGER_INBOX_BOUNDS.maxSummaryLength),
  scope: StoreManagerInboxScopeSchema,
  count: z.number().int().min(0).max(STORE_MANAGER_INBOX_BOUNDS.maxCount),
  sourceRefs: z.array(StoreManagerInboxSourceRefSchema).max(STORE_MANAGER_INBOX_BOUNDS.maxSourceRefs),
  /** Content fingerprint (sha256) — changes when the finding changes. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  lifecycle: StoreManagerInboxLifecycleSchema,
  /** Newest authoritative source timestamp captured at collection time. */
  sourceUpdatedAt: z.string().min(1).max(64),
  firstSeenAt: z.string().min(1).max(64),
  lastSeenAt: z.string().min(1).max(64),
  acknowledgedAt: z.string().min(1).max(64).nullable(),
  resolvedAt: z.string().min(1).max(64).nullable(),
  supersededAt: z.string().min(1).max(64).nullable(),
  /** Why the row resolved: 'disappeared' (collector) or 'operator'. */
  resolvedReason: z.enum(['disappeared', 'operator']).nullable(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerInboxItem = z.infer<typeof StoreManagerInboxItemSchema>;

/** Open-item revalidation result: current authority vs the stored finding. */
export const StoreManagerInboxOpenResultSchema = z.object({
  item: StoreManagerInboxItemSchema,
  /** Current candidate with the same dedupe key (null when the finding is gone). */
  current: StoreManagerInboxItemSchema.nullable(),
  /** True when the stored finding matches the current authoritative state. */
  isCurrent: z.boolean(),
}).strict();
export type StoreManagerInboxOpenResult = z.infer<typeof StoreManagerInboxOpenResultSchema>;

export const StoreManagerInboxListQuerySchema = z.object({
  lifecycle: StoreManagerInboxLifecycleSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();
export type StoreManagerInboxListQuery = z.infer<typeof StoreManagerInboxListQuerySchema>;
