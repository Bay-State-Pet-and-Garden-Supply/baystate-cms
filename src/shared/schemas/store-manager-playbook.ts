// ---------------------------------------------------------------------------
// Store Manager playbook schemas (operations console, Issue 6).
//
// A playbook is versioned DATA, never executable code or a trusted prompt.
// The DSL is a strict bounded schema: each step is one of `read`,
// `summarize`, `propose`, `approval_checkpoint`, `execute`, or `verify`, and
// every tool reference is an exact registered `{toolName, toolVersion}` pair.
// No loops, no branching beyond the declared step sequence, no dynamic tool
// names, no free-form prompt/code. Unknown keys fail (`.strict()`), every
// field is bounded, and mutation authority is never implied: an `execute`
// step only means "dispatch this exact persistent tool after an approval
// checkpoint bound to a diff" — the runtime (Issue 7) still enforces the
// policy/approval gates.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema, StoreManagerScopeKindSchema } from './store-manager-operations';

export const STORE_MANAGER_PLAYBOOK_BOUNDS = {
  maxNameLength: 100,
  maxDescriptionLength: 500,
  maxObjectiveLength: 2000,
  maxStepCount: 20,
  maxStepIdLength: 64,
  maxToolNameLength: 200,
  maxTemplateKeys: 20,
  maxTemplateValueBytes: 4000,
  maxVerifyTools: 5,
  maxVariables: 10,
  maxVariableNameLength: 64,
  maxDependsOn: 3,
  maxScopeKinds: 5,
  maxSkusInScope: 200,
  maxDefinitionJsonBytes: 32 * 1024,
  maxVersionNumber: 10_000,
} as const;

/** Step kinds (plan Locked Decision 10). */
export const STORE_MANAGER_PLAYBOOK_STEP_KINDS = [
  'read',
  'summarize',
  'propose',
  'approval_checkpoint',
  'execute',
  'verify',
] as const;
export const StoreManagerPlaybookStepKindSchema = z.enum(STORE_MANAGER_PLAYBOOK_STEP_KINDS);
export type StoreManagerPlaybookStepKind = z.infer<typeof StoreManagerPlaybookStepKindSchema>;

/** Tool risk classes (mirror of the adapter metadata vocabulary). */
export const STORE_MANAGER_PLAYBOOK_RISK_CLASSES = [
  'read',
  'proposal_write',
  'catalog_mutation',
  'network_filesystem_repair',
] as const;
export const StoreManagerPlaybookRiskClassSchema = z.enum(STORE_MANAGER_PLAYBOOK_RISK_CLASSES);
export type StoreManagerPlaybookRiskClass = z.infer<typeof StoreManagerPlaybookRiskClassSchema>;

/** Variable value types the DSL accepts (bounded, typed). */
export const STORE_MANAGER_PLAYBOOK_VARIABLE_TYPES = [
  'string',
  'product_field',
  'change_set_id',
  'sku',
  'vendor_id',
] as const;
export const StoreManagerPlaybookVariableTypeSchema = z.enum(STORE_MANAGER_PLAYBOOK_VARIABLE_TYPES);
export type StoreManagerPlaybookVariableType = z.infer<typeof StoreManagerPlaybookVariableTypeSchema>;

export const STORE_MANAGER_PLAYBOOK_STATUSES = ['draft', 'active'] as const;
export const StoreManagerPlaybookStatusSchema = z.enum(STORE_MANAGER_PLAYBOOK_STATUSES);
export type StoreManagerPlaybookStatus = z.infer<typeof StoreManagerPlaybookStatusSchema>;

export const STORE_MANAGER_PLAYBOOK_TEMPLATE_KINDS = [
  'weekly_taxonomy_cleanup',
  'new_vendor_import_review',
  'image_integrity_pass',
  'launch_readiness_check',
] as const;
export const StoreManagerPlaybookTemplateKindSchema = z.enum(STORE_MANAGER_PLAYBOOK_TEMPLATE_KINDS);
export type StoreManagerPlaybookTemplateKind = z.infer<typeof StoreManagerPlaybookTemplateKindSchema>;

// ---------------------------------------------------------------------------
// Step DSL
// ---------------------------------------------------------------------------

const exactToolRef = z
  .object({
    toolName: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxToolNameLength),
    toolVersion: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
  })
  .strict();
export type StoreManagerPlaybookToolRef = z.infer<typeof exactToolRef>;

const boundedTemplate = z
  .record(z.string().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxTemplateKeys), z.unknown())
  .refine(
    (value) => JSON.stringify(value)?.length <= STORE_MANAGER_PLAYBOOK_BOUNDS.maxTemplateValueBytes,
    `inputTemplate serialized size exceeds ${STORE_MANAGER_PLAYBOOK_BOUNDS.maxTemplateValueBytes} bytes`,
  );
export type StoreManagerPlaybookInputTemplate = z.infer<typeof boundedTemplate>;

const baseStep = {
  stepId: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxStepIdLength),
  description: z.string().trim().min(1).max(300).optional(),
  /**
   * Optional ordering constraint (bounded). A step may only depend on steps
   * declared EARLIER in the sequence; the validator rejects unknown, forward,
   * or self references — which also makes cycles structurally impossible.
   */
  dependsOnStepIds: z
    .array(z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxStepIdLength))
    .max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxDependsOn)
    .optional(),
};

const readStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('read'),
    toolName: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxToolNameLength),
    toolVersion: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
    inputTemplate: boundedTemplate,
  })
  .strict();

const summarizeStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('summarize'),
    /**
     * `deterministic`: aggregate typed step outputs into a summary artifact
     * without a model. `model_bounded`: bounded model summary over prior
     * structured outputs (still inside the runtime policy; never raw data).
     */
    mode: z.enum(['deterministic', 'model_bounded']),
  })
  .strict();

const proposeStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('propose'),
    /** Transient preview by default. Persistent stored proposals require an explicit declaration below. */
    mode: z.enum(['transient_preview', 'persistent_stored']),
    /**
     * Required when mode is `persistent_stored`: a version explicitly
     * declares the proposal-write risk. Without it, the validator rejects the
     * playbook (a playbook can never hide a registered tool's risk).
     */
    proposalWriteRiskDeclared: z.boolean().optional(),
  })
  .strict();

const approvalCheckpointStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('approval_checkpoint'),
    /** Approval without a diff is structurally impossible: the diff is mandatory. */
    diffRequired: z.literal(true),
  })
  .strict();

const executeStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('execute'),
    toolName: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxToolNameLength),
    toolVersion: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
    inputTemplate: boundedTemplate,
    /**
     * Optional author claim about the tool's risk class. If present and it
     * disagrees with the CURRENT registry metadata, the validator rejects the
     * definition (`risk_downgrade_forgery`) — a playbook cannot assert a
     * lower risk than the registered adapter.
     */
    declaredRiskClass: StoreManagerPlaybookRiskClassSchema.optional(),
  })
  .strict();

const verifyStepSchema = z
  .object({
    ...baseStep,
    kind: z.literal('verify'),
    toolNames: z
      .array(exactToolRef)
      .min(1)
      .max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVerifyTools),
  })
  .strict();

export const StoreManagerPlaybookStepSchema = z.discriminatedUnion('kind', [
  readStepSchema,
  summarizeStepSchema,
  proposeStepSchema,
  approvalCheckpointStepSchema,
  executeStepSchema,
  verifyStepSchema,
]);
export type StoreManagerPlaybookStep = z.infer<typeof StoreManagerPlaybookStepSchema>;

// ---------------------------------------------------------------------------
// Playbook definition
// ---------------------------------------------------------------------------

/**
 * Scope input contract: the scope kinds this playbook may run under (empty =
 * catalog-wide only) and the SKU cap for sku_set scopes. A child scope pinned
 * at runtime may be narrower, never wider (Issue 7 enforces the pin).
 */
export const StoreManagerPlaybookScopeInputSchema = z
  .object({
    allowedKinds: z.array(StoreManagerScopeKindSchema).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxScopeKinds),
    maxSkus: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxSkusInScope).default(STORE_MANAGER_PLAYBOOK_BOUNDS.maxSkusInScope),
  })
  .strict();
export type StoreManagerPlaybookScopeInput = z.infer<typeof StoreManagerPlaybookScopeInputSchema>;

export const StoreManagerPlaybookVariableSchema = z
  .object({
    name: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVariableNameLength),
    type: StoreManagerPlaybookVariableTypeSchema,
    required: z.boolean().default(true),
  })
  .strict();
export type StoreManagerPlaybookVariable = z.infer<typeof StoreManagerPlaybookVariableSchema>;

/**
 * The immutable content-addressed playbook definition. `definitionHash` is the
 * SHA-256 of the canonical JSON of `steps`/`variables`/`scopeInput` (without
 * the hash field itself) and is verified on every read (tamper detection).
 * `status` is `draft` until an explicit reviewed activation flips it to
 * `active`; a playbook never runs unless active (Issue 7 gate).
 */
export const StoreManagerPlaybookDefinitionSchema = z
  .object({
    id: z.string().min(1).max(100),
    workspaceId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxNameLength),
    description: z.string().trim().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxDescriptionLength).optional(),
    templateKind: StoreManagerPlaybookTemplateKindSchema.nullable(),
    version: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
    status: StoreManagerPlaybookStatusSchema,
    scopeInput: StoreManagerPlaybookScopeInputSchema,
    variables: z.array(StoreManagerPlaybookVariableSchema).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVariables),
    steps: z.array(StoreManagerPlaybookStepSchema).min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxStepCount),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    activatedAt: z.string().min(1).max(64).nullable(),
    activatedBy: z.string().min(1).max(200).nullable(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerPlaybookDefinition = z.infer<typeof StoreManagerPlaybookDefinitionSchema>;

/** Immutable version row content (what was captured at that version). */
export const StoreManagerPlaybookVersionSchema = StoreManagerPlaybookDefinitionSchema.extend({
  versionId: z.string().min(1).max(100),
}).strict();
export type StoreManagerPlaybookVersion = z.infer<typeof StoreManagerPlaybookVersionSchema>;

/** Logical playbook row (current pointer + activation audit). */
export const StoreManagerPlaybookSummarySchema = z
  .object({
    id: z.string().min(1).max(100),
    workspaceId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxNameLength),
    templateKind: StoreManagerPlaybookTemplateKindSchema.nullable(),
    currentVersion: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
    status: StoreManagerPlaybookStatusSchema,
    activeVersion: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber).nullable(),
    activeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    activatedAt: z.string().min(1).max(64).nullable(),
    activatedBy: z.string().min(1).max(200).nullable(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerPlaybookSummary = z.infer<typeof StoreManagerPlaybookSummarySchema>;

// ---------------------------------------------------------------------------
// Request schemas (routes)
// ---------------------------------------------------------------------------

/** Copy a code-owned starter template into a workspace draft. */
export const StoreManagerPlaybookCreateRequestSchema = z
  .object({
    templateKind: StoreManagerPlaybookTemplateKindSchema,
    name: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxNameLength).optional(),
  })
  .strict();
export type StoreManagerPlaybookCreateRequest = z.infer<typeof StoreManagerPlaybookCreateRequestSchema>;

/**
 * Save a new immutable draft version. The definition must carry the playbook
 * id/workspace and a `definitionHash` computed by the server (the service
 * recomputes and rejects mismatches). `version` is server-assigned.
 */
export const StoreManagerPlaybookSaveDraftRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxNameLength),
    description: z.string().trim().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxDescriptionLength).optional(),
    scopeInput: StoreManagerPlaybookScopeInputSchema,
    variables: z.array(StoreManagerPlaybookVariableSchema).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVariables),
    steps: z.array(StoreManagerPlaybookStepSchema).min(1).max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxStepCount),
  })
  .strict();
export type StoreManagerPlaybookSaveDraftRequest = z.infer<typeof StoreManagerPlaybookSaveDraftRequestSchema>;

/** Activate a specific immutable version (explicit reviewed operation). */
export const StoreManagerPlaybookActivateRequestSchema = z
  .object({
    version: z.number().int().positive().max(STORE_MANAGER_PLAYBOOK_BOUNDS.maxVersionNumber),
  })
  .strict();
export type StoreManagerPlaybookActivateRequest = z.infer<typeof StoreManagerPlaybookActivateRequestSchema>;
