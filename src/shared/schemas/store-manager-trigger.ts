// ---------------------------------------------------------------------------
// Store Manager event-trigger schemas (operations console, Issue 5).
//
// Durable event-triggered READ-ONLY runs. A trigger is a workspace-owned
// definition with a stable id, immutable versions, a locked kind, and a
// bounded deterministic config. Triggers observe only committed durable
// state through repositories; occurrences are restart-safe via a unique
// per-workspace occurrence key; observation is at-least-once with idempotent
// occurrence keys (exact-once is NOT claimed). Every occurrence enters the
// single runtime runner with entrypoint `event` and the unattended read-only
// policy — the runtime derives the read-only allowlist and denies persistent
// adapters at registry dispatch, so no trigger can stage, approve, publish,
// sync, repair, or push even if the model requests it. `diagnostic`
// occurrences record "no run" outcomes (unprovable import terminality,
// unknown SKUs) so missing/ambiguous evidence never produces a guessed run.
// All fields are bounded and redacted by construction; unknown keys fail.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema } from './store-manager-operations';

export const STORE_MANAGER_TRIGGER_BOUNDS = {
  maxNameLength: 100,
  maxObjectiveLength: 2000,
  maxOccurrenceKeyLength: 240,
  maxErrorCodeLength: 100,
  maxRetries: 10,
  maxCatchUpOccurrences: 200,
  maxSourceIdLength: 200,
  maxSourceKindLength: 50,
  maxBaselineJsonBytes: 64 * 1024,
  maxThreshold: 10_000,
  maxEvidencesPerRun: 50,
} as const;

/** The four locked trigger kinds (plan Locked Decision 8). */
export const STORE_MANAGER_TRIGGER_KINDS = [
  'import_finished',
  'change_set_approved',
  'sync_failed',
  'product_field_drift',
] as const;
export const StoreManagerTriggerKindSchema = z.enum(STORE_MANAGER_TRIGGER_KINDS);
export type StoreManagerTriggerKind = z.infer<typeof StoreManagerTriggerKindSchema>;

/**
 * Deterministic bounded per-kind config. Unknown keys fail; every field is
 * bounded. `import_finished.batchId` is optional: null observes every batch
 * in the workspace (each batch is a separate source cursor).
 */
export const StoreManagerTriggerConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('import_finished'),
    /** Optional batch pin. null = observe every batch in the workspace. */
    batchId: z.string().trim().min(1).max(64).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('change_set_approved'),
  }).strict(),
  z.object({
    kind: z.literal('sync_failed'),
  }).strict(),
  z.object({
    kind: z.literal('product_field_drift'),
    /** Deterministic delta in compatible artifact counts that triggers a run. */
    threshold: z.number().int().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxThreshold),
  }).strict(),
]);
export type StoreManagerTriggerConfig = z.infer<typeof StoreManagerTriggerConfigSchema>;

/** Durable occurrence statuses. `diagnostic` is a durable "no run" record. */
export const STORE_MANAGER_TRIGGER_OCCURRENCE_STATUSES = [
  'pending',
  'claimed',
  'completed',
  'failed',
  'unavailable',
  'cancelled',
  'diagnostic',
] as const;
export const StoreManagerTriggerOccurrenceStatusSchema = z.enum(STORE_MANAGER_TRIGGER_OCCURRENCE_STATUSES);
export type StoreManagerTriggerOccurrenceStatus = z.infer<typeof StoreManagerTriggerOccurrenceStatusSchema>;

/** Bounded source reference of one observation (authoritative row identity). */
export const StoreManagerTriggerSourceRefSchema = z.object({
  kind: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxSourceKindLength),
  id: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxSourceIdLength),
}).strict();
export type StoreManagerTriggerSourceRef = z.infer<typeof StoreManagerTriggerSourceRefSchema>;

/**
 * A workspace-owned trigger definition. `version` increments on every
 * immutable definition edit; runs capture version + definition hash so they
 * can never observe later edits.
 */
export const StoreManagerTriggerDefinitionSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxNameLength),
  version: z.number().int().positive(),
  kind: StoreManagerTriggerKindSchema,
  enabled: z.boolean(),
  config: StoreManagerTriggerConfigSchema,
  scope: StoreManagerPinnedScopeSchema.nullable(),
  selectedModel: z.string().min(1).max(200).nullable(),
  objective: z.string().trim().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxObjectiveLength),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  lastScanAt: z.string().min(1).max(64).nullable(),
  lastScanStatus: z.enum(['completed', 'failed', 'unavailable', 'diagnostic']).nullable(),
  lastRunId: z.string().min(1).max(64).nullable(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerTriggerDefinition = z.infer<typeof StoreManagerTriggerDefinitionSchema>;

/**
 * One durable trigger occurrence. `occurrenceKey` is unique per workspace and
 * is the restart-safety primitive. A `diagnostic` occurrence records that the
 * observation was not terminal (import not finished / SKUs unknown) — durable
 * and inspectable, but it never becomes a run.
 */
export const StoreManagerTriggerOccurrenceSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  triggerId: z.string().min(1).max(64),
  triggerVersion: z.number().int().positive(),
  occurrenceKey: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxOccurrenceKeyLength),
  sourceRef: StoreManagerTriggerSourceRefSchema,
  scopeJson: z.string().min(1).max(4096).nullable(),
  scheduledAt: z.string().min(1).max(64),
  status: StoreManagerTriggerOccurrenceStatusSchema,
  runId: z.string().min(1).max(64).nullable(),
  errorCode: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxErrorCodeLength).nullable(),
  retryCount: z.number().int().min(0).max(STORE_MANAGER_TRIGGER_BOUNDS.maxRetries),
  claimedAt: z.string().min(1).max(64).nullable(),
  leaseExpiresAt: z.string().min(1).max(64).nullable(),
  heartbeatAt: z.string().min(1).max(64).nullable(),
  completedAt: z.string().min(1).max(64).nullable(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerTriggerOccurrence = z.infer<typeof StoreManagerTriggerOccurrenceSchema>;

/**
 * Per-source observation cursor. `fingerprint` is the last-seen committed
 * source fingerprint (out-of-order updates are handled by comparing against
 * the fingerprint, not a raw timestamp); `baselineJson` holds the bounded
 * deterministic baseline (e.g. per-field proposal counts for drift).
 */
export const StoreManagerSourceCursorSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  sourceKind: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxSourceKindLength),
  sourceId: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxSourceIdLength),
  fingerprint: z.string().min(1).max(128),
  baselineJson: z.string().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxBaselineJsonBytes).nullable(),
  terminalObserved: z.boolean(),
  lastObservedAt: z.string().min(1).max(64),
  evalCount: z.number().int().min(0),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerSourceCursor = z.infer<typeof StoreManagerSourceCursorSchema>;

// ---------------------------------------------------------------------------
// Trigger templates (server-owned registry descriptors)
// ---------------------------------------------------------------------------

/** Locked trigger template descriptor (mirrors schedule templates). */
export const StoreManagerTriggerTemplateSchema = z.object({
  kind: StoreManagerTriggerKindSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  objective: z.string().trim().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxObjectiveLength),
  defaultConfig: StoreManagerTriggerConfigSchema,
  /** Human-readable scope expectation for the UI. */
  scopeSummary: z.string().trim().min(1).max(500),
  readOnly: z.literal(true),
}).strict();
export type StoreManagerTriggerTemplate = z.infer<typeof StoreManagerTriggerTemplateSchema>;

// ---------------------------------------------------------------------------
// Request schemas (routes)
// ---------------------------------------------------------------------------

/** Create a trigger from one of the four locked templates. */
export const StoreManagerTriggerCreateRequestSchema = z.object({
  kind: StoreManagerTriggerKindSchema,
  name: z.string().trim().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxNameLength),
  config: StoreManagerTriggerConfigSchema.optional(),
  scope: StoreManagerPinnedScopeSchema.optional(),
  selectedModel: z.string().min(1).max(200).optional(),
}).strict();
export type StoreManagerTriggerCreateRequest = z.infer<typeof StoreManagerTriggerCreateRequestSchema>;

/** Update editable fields (name/config/scope/model). Never the kind. */
export const StoreManagerTriggerUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(STORE_MANAGER_TRIGGER_BOUNDS.maxNameLength).optional(),
  config: StoreManagerTriggerConfigSchema.optional(),
  scope: StoreManagerPinnedScopeSchema.nullable().optional(),
  selectedModel: z.string().min(1).max(200).nullable().optional(),
}).strict();
export type StoreManagerTriggerUpdateRequest = z.infer<typeof StoreManagerTriggerUpdateRequestSchema>;

/** Run-now request: optional model override (still system read-only). */
export const StoreManagerTriggerRunNowRequestSchema = z.object({
  selectedModel: z.string().min(1).max(200).optional(),
}).strict();
export type StoreManagerTriggerRunNowRequest = z.infer<typeof StoreManagerTriggerRunNowRequestSchema>;

/** Occurrence listing query (bounded, optional status filter). */
export const StoreManagerTriggerOccurrenceListQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  status: StoreManagerTriggerOccurrenceStatusSchema.optional(),
}).strict();
export type StoreManagerTriggerOccurrenceListQuery = z.infer<typeof StoreManagerTriggerOccurrenceListQuerySchema>;
