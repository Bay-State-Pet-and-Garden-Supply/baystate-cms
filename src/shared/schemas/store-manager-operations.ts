// ---------------------------------------------------------------------------
// Store Manager operations-console schemas (epic: operations console, Issue 1)
//
// Single cross-boundary contract shared by the server runtime and the client
// wire types. Every field is bounded and redacted by construction; unknown
// keys are rejected (`.strict()`). No raw prompts, chain of thought, secrets,
// credentials, absolute paths, or raw payloads ever enter these shapes.
// ---------------------------------------------------------------------------

import { z } from 'zod';

export const STORE_MANAGER_OPERATIONS_BOUNDS = {
  maxRunIdLength: 64,
  maxWorkspaceIdLength: 200,
  maxWorkspacePathLength: 500,
  maxThreadIdLength: 200,
  maxObjectiveLength: 2000,
  maxScopeJsonBytes: 4096,
  maxLineageJsonBytes: 4096,
  maxPromptVersionLength: 100,
  maxModelIdLength: 200,
  maxConnectionIdLength: 200,
  maxPolicySnapshotJsonBytes: 32 * 1024,
  maxArtifactContentBytes: 128 * 1024,
  maxArtifactKindLength: 64,
  maxSkuIdLength: 128,
  maxVendorIdLength: 200,
  maxFieldIdLength: 200,
  maxBatchIdLength: 200,
  maxChangeSetIdLength: 200,
  maxPinnedSkus: 200,
  maxTriggerKindLength: 100,
  maxOccurrenceKeyLength: 200,
  maxCommandNameLength: 100,
  maxPlaybookIdLength: 100,
  maxResultCount: 200,
} as const;

// ---------------------------------------------------------------------------
// Entrypoint / mode / actor vocabulary
// ---------------------------------------------------------------------------

/** Every executable Store Manager entrypoint. One authority model for all. */
export const STORE_MANAGER_ENTRYPOINTS = ['chat', 'command', 'schedule', 'event', 'playbook', 'replay', 'plan_preview'] as const;
export const StoreManagerEntrypointSchema = z.enum(STORE_MANAGER_ENTRYPOINTS);
export type StoreManagerEntrypoint = z.infer<typeof StoreManagerEntrypointSchema>;

/** Execution mode carried into the immutable policy snapshot. */
export const STORE_MANAGER_EXECUTION_MODES = ['interactive', 'unattended_read_only', 'preview'] as const;
export const StoreManagerExecutionModeSchema = z.enum(STORE_MANAGER_EXECUTION_MODES);
export type StoreManagerExecutionMode = z.infer<typeof StoreManagerExecutionModeSchema>;

/** Who initiated the run. Unattended actors never carry human approval authority. */
export const STORE_MANAGER_ACTOR_CLASSES = ['operator', 'system_schedule', 'system_event', 'replay', 'preview'] as const;
export const StoreManagerActorClassSchema = z.enum(STORE_MANAGER_ACTOR_CLASSES);
export type StoreManagerActorClass = z.infer<typeof StoreManagerActorClassSchema>;

/** Pinned conversational scope kinds (bounded identifiers only). */
export const STORE_MANAGER_SCOPE_KINDS = ['onboarding_batch', 'change_set', 'product_field', 'vendor', 'sku_set'] as const;
export const StoreManagerScopeKindSchema = z.enum(STORE_MANAGER_SCOPE_KINDS);
export type StoreManagerScopeKind = z.infer<typeof StoreManagerScopeKindSchema>;

/**
 * Store Manager model selection wire contract.
 *
 * - `string`: legacy explicit model-id selection (registry-resolved, NEVER
 *   falls back). Kept for persisted trigger/schedule/playbook definitions and
 *   older clients.
 * - `{ mode: 'route_default' }`: follow the configured `storeManager` workload
 *   route (primary + configured fallback). This is the UI default — the
 *   server picks the configured primary and keeps its fallback semantics.
 * - `{ mode: 'explicit', target }`: connection-addressed manual override.
 *   Disables route fallback (the operator picked a specific target).
 */
export const StoreManagerModelSelectionSchema = z.union([
  z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxModelIdLength),
  z.object({ mode: z.literal('route_default') }),
  z.object({
    mode: z.literal('explicit'),
    target: z.object({
      connectionId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxConnectionIdLength),
      modelId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxModelIdLength),
    }),
  }),
]);
export type StoreManagerModelSelection = z.infer<typeof StoreManagerModelSelectionSchema>;

const boundId = (max: number) => z.string().trim().min(1).max(max);

const scopeVariants = [
  z.object({
    kind: z.literal('onboarding_batch'),
    batchId: boundId(STORE_MANAGER_OPERATIONS_BOUNDS.maxBatchIdLength),
  }).strict(),
  z.object({
    kind: z.literal('change_set'),
    changeSetId: boundId(STORE_MANAGER_OPERATIONS_BOUNDS.maxChangeSetIdLength),
  }).strict(),
  z.object({
    kind: z.literal('product_field'),
    field: boundId(STORE_MANAGER_OPERATIONS_BOUNDS.maxFieldIdLength),
  }).strict(),
  z.object({
    kind: z.literal('vendor'),
    vendorId: boundId(STORE_MANAGER_OPERATIONS_BOUNDS.maxVendorIdLength),
  }).strict(),
  z.object({
    kind: z.literal('sku_set'),
    skus: z
      .array(boundId(STORE_MANAGER_OPERATIONS_BOUNDS.maxSkuIdLength))
      .min(1)
      .max(STORE_MANAGER_OPERATIONS_BOUNDS.maxPinnedSkus),
  }).strict(),
] as const;

export const StoreManagerPinnedScopeSchema = z.discriminatedUnion('kind', scopeVariants);
export type StoreManagerPinnedScope = z.infer<typeof StoreManagerPinnedScopeSchema>;

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/**
 * Source lineage for a run. Fields are bounded identifiers only; at most one
 * lineage source family is expected per run, but the schema accepts any
 * combination (all optional) and the runtime emits whichever apply.
 */
export const StoreManagerLineageSchema = z.object({
  commandName: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxCommandNameLength).optional(),
  commandVersion: z.number().int().positive().max(10_000).optional(),
  scheduleId: z.string().min(1).max(100).optional(),
  scheduleVersion: z.number().int().positive().max(10_000).optional(),
  triggerKind: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxTriggerKindLength).optional(),
  occurrenceKey: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxOccurrenceKeyLength).optional(),
  playbookId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxPlaybookIdLength).optional(),
  playbookVersion: z.number().int().positive().max(10_000).optional(),
  /** Playbook step lineage (Issue 7): bounded step id + kind for step runs. */
  stepId: z.string().min(1).max(64).optional(),
  stepKind: z.string().min(1).max(64).optional(),
  replayOfRunId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxRunIdLength).optional(),
}).strict();
export type StoreManagerLineage = z.infer<typeof StoreManagerLineageSchema>;

// ---------------------------------------------------------------------------
// Execution request
// ---------------------------------------------------------------------------

/**
 * Server-owned policy narrowing. Only the executor/route may pass these; a
 * request or model message can never widen them. Mirrors the runtime policy
 * budget fields so preview/audit can show the effective budget.
 */
export const StoreManagerPolicyProfileSchema = z.object({
  deadlineMs: z.number().int().positive().max(3_600_000).optional(),
  maxToolCalls: z.number().int().positive().max(200).optional(),
  maxOutputBytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  maxModelCostUsd: z.number().finite().nonnegative().max(1000).optional(),
  perCallTimeoutMs: z.number().int().positive().max(600_000).optional(),
}).strict();
export type StoreManagerPolicyProfile = z.infer<typeof StoreManagerPolicyProfileSchema>;

/**
 * Strict execution request for every entrypoint. `runId` is server-generated
 * (factory) but validated here so forged/oversized values fail before any
 * model/tool work. Unknown keys are rejected.
 */
export const StoreManagerExecutionRequestSchema = z.object({
  runId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxRunIdLength),
  workspaceId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxWorkspaceIdLength),
  workspacePath: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxWorkspacePathLength),
  threadId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxThreadIdLength).nullable().optional(),
  entrypoint: StoreManagerEntrypointSchema,
  objective: z.string().trim().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxObjectiveLength),
  executionMode: StoreManagerExecutionModeSchema,
  actorClass: StoreManagerActorClassSchema.optional(),
  pinnedScope: StoreManagerPinnedScopeSchema.optional(),
  lineage: StoreManagerLineageSchema.optional(),
  selectedModel: StoreManagerModelSelectionSchema.optional(),
  policyProfile: StoreManagerPolicyProfileSchema.optional(),
}).strict();
export type StoreManagerExecutionRequest = z.infer<typeof StoreManagerExecutionRequestSchema>;

export class StoreManagerExecutionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreManagerExecutionRequestError';
  }
}

/** Strict validation; throws StoreManagerExecutionRequestError on any failure. */
export function validateStoreManagerExecutionRequest(input: unknown): StoreManagerExecutionRequest {
  const result = StoreManagerExecutionRequestSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new StoreManagerExecutionRequestError(
      `Invalid Store Manager execution request: ${first?.path.join('.') ?? 'unknown'} ${first?.message ?? 'schema mismatch'}`,
    );
  }
  return result.data;
}

/** Deterministic actor-class derivation (entrypoint/mode → actor). */
export function deriveStoreManagerActorClass(
  entrypoint: StoreManagerEntrypoint,
  executionMode: StoreManagerExecutionMode,
): StoreManagerActorClass {
  if (executionMode === 'preview') return 'preview';
  if (entrypoint === 'replay') return 'replay';
  if (entrypoint === 'schedule') return 'system_schedule';
  if (entrypoint === 'event') return 'system_event';
  return 'operator';
}

// ---------------------------------------------------------------------------
// Run outcome / artifact vocabulary
// ---------------------------------------------------------------------------

export const STORE_MANAGER_TERMINAL_STATUSES = ['success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable'] as const;
export const StoreManagerTerminalStatusSchema = z.enum(STORE_MANAGER_TERMINAL_STATUSES);
export type StoreManagerTerminalStatus = z.infer<typeof StoreManagerTerminalStatusSchema>;

export const STORE_MANAGER_ARTIFACT_KINDS = ['report', 'audit', 'candidate_proposal_set', 'diff', 'verification_diff', 'preview', 'outcome'] as const;
export const StoreManagerArtifactKindSchema = z.enum(STORE_MANAGER_ARTIFACT_KINDS);
export type StoreManagerArtifactKind = z.infer<typeof StoreManagerArtifactKindSchema>;

/** Immutable run artifact contract. Content is content-addressed and bounded. */
export const StoreManagerArtifactSchema = z.object({
  id: z.string().min(1).max(64),
  runId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxRunIdLength),
  workspaceId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxWorkspaceIdLength),
  kind: StoreManagerArtifactKindSchema,
  schemaVersion: z.number().int().positive().max(10_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerArtifact = z.infer<typeof StoreManagerArtifactSchema>;

/** Bounded descriptor produced by /plan-style preview compilation (zero execution). */
export const StoreManagerPreviewDescriptorSchema = z.object({
  entrypoint: StoreManagerEntrypointSchema,
  executionMode: StoreManagerExecutionModeSchema,
  actorClass: StoreManagerActorClassSchema,
  runId: z.string().min(1).max(STORE_MANAGER_OPERATIONS_BOUNDS.maxRunIdLength),
  objectiveHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  expectedTools: z.array(
    z.object({
      name: z.string().min(1).max(200),
      version: z.number().int().positive(),
      riskClass: z.enum(['read', 'proposal_write', 'catalog_mutation', 'network_filesystem_repair']),
      requiresApproval: z.boolean(),
      allowedPhases: z.array(z.enum(['investigate', 'approve', 'verify'])),
      scopeSupported: z.boolean(),
    }),
  ),
  expectedApprovals: z.array(
    z.object({
      toolName: z.string().min(1).max(200),
      toolVersion: z.number().int().positive(),
    }),
  ),
  persistentToolsDenied: z.boolean(),
  budgets: z.object({
    maxToolCalls: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    maxModelCostUsd: z.number().finite().nonnegative(),
    perCallTimeoutMs: z.number().int().positive(),
  }),
  networkActivity: z.enum(['none', 'bounded']),
  modelCalls: z.literal(0),
  toolDispatches: z.literal(0),
}).strict();
export type StoreManagerPreviewDescriptor = z.infer<typeof StoreManagerPreviewDescriptorSchema>;
