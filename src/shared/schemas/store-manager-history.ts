// ---------------------------------------------------------------------------
// Store Manager run history / replay / comparison / bounded history-query
// schemas (operations console, Issue 7).
//
// Every field is bounded and redacted. History joins run/session/turn/event/
// artifact rows with the EXISTING ai_model_calls telemetry (no duplicate
// columns). Replay is a NEW current-state run with explicit lineage; it never
// resumes the old session or reuses approvals. Comparison operates only over
// compatible immutable normalized artifacts with deterministic deltas.
// Natural-language history questions resolve to a finite server-owned query
// ID + typed parameters — never agent-generated SQL.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerEntrypointSchema } from './store-manager-operations';

export const STORE_MANAGER_HISTORY_BOUNDS = {
  maxHistoryRuns: 200,
  maxObjectiveDisplayLength: 300,
  maxEventsPerRun: 500,
  maxArtifactsPerRun: 100,
  maxQueryParamKeys: 10,
  maxQueryRows: 200,
  maxQueryColumnNameLength: 100,
  maxQueryValueLength: 1000,
  maxSourceRunIds: 200,
  maxReplayReasonLength: 300,
} as const;

// ---------------------------------------------------------------------------
// Run history list / detail
// ---------------------------------------------------------------------------

export const StoreManagerHistoryRunSchema = z
  .object({
    runId: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(200),
    entrypoint: StoreManagerEntrypointSchema,
    executionMode: z.enum(['interactive', 'unattended_read_only', 'preview']),
    actorClass: z.enum(['operator', 'system_schedule', 'system_event', 'replay', 'preview']),
    objective: z.string().max(STORE_MANAGER_HISTORY_BOUNDS.maxObjectiveDisplayLength),
    status: z.enum(['active', 'terminal']),
    terminalStatus: z.enum(['success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable']).nullable(),
    outcomeReason: z.string().max(300).nullable(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    modelCallId: z.string().min(1).max(64).nullable(),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    lineage: z.unknown().nullable(),
    artifactCount: z.number().int().nonnegative(),
  })
  .strict();
export type StoreManagerHistoryRun = z.infer<typeof StoreManagerHistoryRunSchema>;

export const StoreManagerHistoryModelCallSchema = z
  .object({
    id: z.string().min(1).max(64),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    locality: z.enum(['local', 'cloud']),
    status: z.enum(['started', 'success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable']),
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    estimatedApiCostUsd: z.number().finite().nonnegative().nullable(),
    errorCode: z.string().max(200).nullable(),
    startedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerHistoryModelCall = z.infer<typeof StoreManagerHistoryModelCallSchema>;

export const StoreManagerRunHistoryDetailSchema = z
  .object({
    run: StoreManagerHistoryRunSchema,
    events: z.array(z.unknown()).max(STORE_MANAGER_HISTORY_BOUNDS.maxEventsPerRun),
    artifacts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          kind: z.enum(['report', 'audit', 'candidate_proposal_set', 'diff', 'verification_diff', 'preview', 'outcome']),
          schemaVersion: z.number().int().positive(),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          createdAt: z.string().min(1).max(64),
        }),
      )
      .max(STORE_MANAGER_HISTORY_BOUNDS.maxArtifactsPerRun),
    modelCall: StoreManagerHistoryModelCallSchema.nullable(),
  })
  .strict();
export type StoreManagerRunHistoryDetail = z.infer<typeof StoreManagerRunHistoryDetailSchema>;

export const StoreManagerRunHistoryListSchema = z
  .object({
    runs: z.array(StoreManagerHistoryRunSchema).max(STORE_MANAGER_HISTORY_BOUNDS.maxHistoryRuns),
    nextCursor: z
      .object({ createdAt: z.string().min(1).max(64), id: z.string().min(1).max(64) })
      .nullable(),
  })
  .strict();
export type StoreManagerRunHistoryList = z.infer<typeof StoreManagerRunHistoryListSchema>;

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export const StoreManagerReplayRequestSchema = z
  .object({
    /** Source run id (workspace-scoped; foreign runs refuse). */
    runId: z.string().min(1).max(64),
    /** Explicit model selection for the NEW run (never silent fallback). */
    selectedModel: z.string().min(1).max(200).optional(),
  })
  .strict();
export type StoreManagerReplayRequest = z.infer<typeof StoreManagerReplayRequestSchema>;

export const StoreManagerReplayResultSchema = z
  .object({
    ok: z.boolean(),
    replayRunId: z.string().min(1).max(64),
    replayOfRunId: z.string().min(1).max(64),
    terminalStatus: z.enum(['success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable']),
    /** Bounded drained text summary for interactive replay runs. */
    text: z.string().max(64 * 1024),
    toolResults: z
      .array(
        z.object({
          toolName: z.string().min(1).max(200),
          status: z.enum(['ok', 'error', 'denied']),
        }),
      )
      .max(200),
  })
  .strict();
export type StoreManagerReplayResult = z.infer<typeof StoreManagerReplayResultSchema>;

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const StoreManagerCompareRequestSchema = z
  .object({
    runIdA: z.string().min(1).max(64),
    runIdB: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerCompareRequest = z.infer<typeof StoreManagerCompareRequestSchema>;

export const StoreManagerCompareResultSchema = z
  .object({
    comparable: z.boolean(),
    runIdA: z.string().min(1).max(64),
    runIdB: z.string().min(1).max(64),
    kind: z.enum(['report', 'audit', 'diff', 'verification_diff', 'outcome']).nullable(),
    /** Deterministic delta over normalized artifact fields. */
    delta: z
      .array(
        z.object({
          field: z.string().min(1).max(200),
          before: z.union([z.string().max(1000), z.number(), z.null()]),
          after: z.union([z.string().max(1000), z.number(), z.null()]),
        }),
      )
      .max(200)
      .nullable(),
    /** When not comparable: a clear bounded reason. */
    reason: z.string().max(STORE_MANAGER_HISTORY_BOUNDS.maxReplayReasonLength).nullable(),
  })
  .strict();
export type StoreManagerCompareResult = z.infer<typeof StoreManagerCompareResultSchema>;

// ---------------------------------------------------------------------------
// Bounded history queries (finite server-owned query library)
// ---------------------------------------------------------------------------

export const STORE_MANAGER_HISTORY_QUERY_IDS = [
  'what_got_worse',
  'recurring_issues',
  'proposals_rejected_repeatedly',
  'field_cleanup_work',
] as const;
export const StoreManagerHistoryQueryIdSchema = z.enum(STORE_MANAGER_HISTORY_QUERY_IDS);
export type StoreManagerHistoryQueryId = z.infer<typeof StoreManagerHistoryQueryIdSchema>;

/** Typed parameters are validated per query ID by the query registry. */
export const StoreManagerHistoryQueryParamsSchema = z.record(
  z.string().min(1).max(STORE_MANAGER_HISTORY_BOUNDS.maxQueryParamKeys),
  z.unknown(),
);

export const StoreManagerHistoryQueryRequestSchema = z
  .object({
    queryId: StoreManagerHistoryQueryIdSchema,
    params: StoreManagerHistoryQueryParamsSchema,
  })
  .strict();
export type StoreManagerHistoryQueryRequest = z.infer<typeof StoreManagerHistoryQueryRequestSchema>;

export const StoreManagerHistoryQueryResultSchema = z
  .object({
    queryId: StoreManagerHistoryQueryIdSchema,
    matchedRows: z.number().int().nonnegative(),
    sourceRunIds: z.array(z.string().min(1).max(64)).max(STORE_MANAGER_HISTORY_BOUNDS.maxSourceRunIds),
    columns: z.array(z.string().min(1).max(STORE_MANAGER_HISTORY_BOUNDS.maxQueryColumnNameLength)).max(20),
    rows: z
      .array(z.record(z.string(), z.union([z.string().max(STORE_MANAGER_HISTORY_BOUNDS.maxQueryValueLength), z.number(), z.null()])))
      .max(STORE_MANAGER_HISTORY_BOUNDS.maxQueryRows),
    truncated: z.boolean(),
  })
  .strict();
export type StoreManagerHistoryQueryResult = z.infer<typeof StoreManagerHistoryQueryResultSchema>;

export const StoreManagerHistoryQueryDescriptorSchema = z
  .object({
    queryId: StoreManagerHistoryQueryIdSchema,
    version: z.number().int().positive(),
    description: z.string().max(500),
    /** Bounded zod param-schema description (JSON) for UI rendering. */
    paramSpec: z.unknown(),
  })
  .strict();
export type StoreManagerHistoryQueryDescriptor = z.infer<typeof StoreManagerHistoryQueryDescriptorSchema>;
