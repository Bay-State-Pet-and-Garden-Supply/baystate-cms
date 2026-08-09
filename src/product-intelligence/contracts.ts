/**
 * Product Intelligence execution contracts (PI-1).
 *
 * These are the provider-neutral contracts at the boundary between the CMS
 * workflow and any agent runtime (Pi today, possibly others later). The agent
 * researches and proposes; deterministic CMS code validates, reviews, promotes,
 * and publishes. Ordinary assistant prose must never become the authoritative
 * product result — only a schema-validated terminal submission may.
 *
 * All product input, fetched pages, and tool output must be treated as
 * untrusted data. Field values are validated here; consumers must never
 * interpolate them into instructions.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import { z } from 'zod';
import { TerminalSubmissionSchema, type TerminalSubmission } from './workflow/bundle';

// ---------------------------------------------------------------------------
// Product input
// ---------------------------------------------------------------------------

export const ProductResearchInputSchema = z.object({
  /** Exact GTIN/UPC as printed on the package (digits only, normalized). */
  gtin: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => /^\d{8,14}$/.test(value), {
      message: 'gtin must be 8-14 digits (UPC/GTIN)',
    }),
  /** The store register name as typed by the operator (e.g. "STELLA CHKN BROTH 16OZ"). */
  registerName: z.string().min(1).max(512),
  /** Optional brand hint from the operator. */
  brandHint: z.string().max(256).nullish(),
  /** Optional department hint from the operator. */
  departmentHint: z.string().max(256).nullish(),
  /** Optional unit price as displayed on the register. */
  price: z.string().max(64).nullish(),
  /** Optional pack quantity. */
  quantity: z.number().int().positive().nullish(),
  /** Existing onboarding item the run is linked to (when launched from Onboarding). */
  existingOnboardingItemId: z.string().max(128).nullish(),
});

export type ProductResearchInput = z.infer<typeof ProductResearchInputSchema>;

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

const ExecutionModeSchema = z.enum(['shadow', 'interactive', 'onboarding']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

const NetworkPolicySchema = z.enum(['local_only', 'allowlisted_remote']);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

const DataSharingPolicySchema = z.enum(['local_only', 'cloud_models_only', 'cloud_models_and_sources']);
export type DataSharingPolicy = z.infer<typeof DataSharingPolicySchema>;

/**
 * Built-in tools an agent session may expose. PI-3 adds bounded research tools
 * (search, sitemap, scraper, OCR). For PI-1 only read-only coding tools are
 * allowlisted; the terminal submission tool is always available and is not
 * part of this list.
 */
const AllowedToolSchema = z.enum(['read', 'grep', 'find', 'ls']);
export type AllowedTool = z.infer<typeof AllowedToolSchema>;

const ThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

const ModelRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: ThinkingLevelSchema.default('medium'),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

/**
 * Immutable per-run execution policy. The full policy object must be hashed
 * into `configId` (see `hashCanonicalJson`) and persisted with the run so the
 * exact execution configuration is reproducible.
 */
export const ProductIntelligencePolicySchema = z.object({
  /** SHA-256 of the canonical JSON of the immutable configuration this policy came from. */
  configId: z.string().min(1),
  /** Explicit allowlist of built-in tools. Unknown names are rejected by executors. */
  allowedTools: z.array(AllowedToolSchema).max(8).default([]),
  /**
   * Allowlist of bounded research tools (PI-3). An empty list grants none;
   * unknown names are rejected at session creation.
   */
  researchTools: z.array(z.string().min(1).max(128)).max(64).default([]),
  /**
   * Outbound network policy (PI-5): when non-empty, external fetches are
   * restricted to these domains (hostname suffix match). Private/link-local
   * destinations and non-http(s) protocols are always denied.
   */
  allowedSourceDomains: z.array(z.string().min(1).max(256)).max(64).default([]),
  /** Maximum accepted response body size for gateway-fetched content (PI-5). */
  maxResponseBytes: z.number().int().positive().max(50_000_000).default(5_000_000),
  networkPolicy: NetworkPolicySchema.default('local_only'),
  dataSharingPolicy: DataSharingPolicySchema.default('local_only'),
  /**
   * Model routing. `null` means no model is available: Pi execution must
   * fail closed instead of falling back to an unapproved model.
   */
  modelRoute: ModelRouteSchema.nullable().default(null),
  /** Hard cap on tool calls per run. */
  maxToolCalls: z.number().int().positive().max(1000).default(100),
  /** Optional hard cap on model cost (USD). Enforced by the runtime (PI-5). */
  maxCostUsd: z.number().positive().nullish(),
  /** Hard wall-clock deadline for the whole run, in milliseconds. */
  deadlineMs: z.number().int().positive().max(3_600_000).default(300_000),
});
export type ProductIntelligencePolicy = z.infer<typeof ProductIntelligencePolicySchema>;

export const ProductResearchContextSchema = z.object({
  /** Unique run identifier (assigned by the CMS before execution). */
  runId: z.string().min(1),
  /** Workspace (store) identifier. */
  workspaceId: z.string().min(1),
  /** Absolute path of the workspace directory. */
  workspacePath: z.string().min(1),
  /** Immutable policy snapshot for this run. */
  policy: ProductIntelligencePolicySchema,
  executionMode: ExecutionModeSchema.default('shadow'),
  /** Evidence references from earlier runs that the agent may reuse. */
  existingEvidenceRefs: z.array(z.string()).default([]),
});

/**
 * Runtime-only extension of the durable context: the caller's cancellation
 * signal. It is deliberately not part of the Zod schema because it cannot be
 * serialized or persisted.
 */
export type ProductResearchContext = z.infer<typeof ProductResearchContextSchema> & {
  /** Cancellation signal. When aborted, executors must stop promptly. */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Structured submission (terminal contract)
// ---------------------------------------------------------------------------

const EvidenceSourceKindSchema = z.enum([
  'catalog',
  'supplier',
  'registry',
  'retailer',
  'manufacturer',
  'other',
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKindSchema>;

const EvidenceSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().max(512).nullable(),
  /** Domain of the source (derived from url, duplicated for stable filtering). */
  domain: z.string().max(256),
  kind: EvidenceSourceKindSchema.default('other'),
  accessedAt: z.string().datetime(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

const EvidenceItemSchema = z.object({
  id: z.string().min(1),
  /** Target field this evidence supports (e.g. "title", "brand", "gtin"). */
  field: z.string().min(1).max(128),
  value: z.string().max(4096),
  /** Source ids this evidence was read from. */
  sourceIds: z.array(z.string().min(1)).min(1),
  /** Exact quoted passage, when available. */
  quote: z.string().max(4096).nullish(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** A proposed product detail field. The agent proposes; the CMS validates. */
const ProductFieldProposalSchema = z.object({
  field: z.string().min(1).max(128),
  value: z.string().max(4096),
  evidenceIds: z.array(z.string().min(1)).default([]),
});
export type ProductFieldProposal = z.infer<typeof ProductFieldProposalSchema>;

const ProductProposalSchema = z.object({
  fields: z.array(ProductFieldProposalSchema).max(64).default([]),
});
export type ProductProposal = z.infer<typeof ProductProposalSchema>;

/**
 * Classification proposals. The agent must NOT invent taxonomy, Category Page,
 * attribute, Product Type, or ProductField identifiers — ids may only be
 * supplied when they reference existing CMS-controlled values; otherwise the
 * agent must abstain on that target.
 */
const ClassificationProposalSchema = z.object({
  /** Stable id of an existing internal Product Type, or null to abstain. */
  productTypeId: z.string().min(1).nullable().default(null),
  /** Stable id of an existing Category Page, or null to abstain. */
  categoryPageId: z.string().min(1).nullable().default(null),
  /** Existing ProductField assignments keyed by stable field name. */
  attributes: z
    .array(
      z.object({
        fieldName: z.string().min(1).max(128),
        value: z.string().max(4096),
        evidenceIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .max(64)
    .default([]),
});
export type ClassificationProposal = z.infer<typeof ClassificationProposalSchema>;

const ImageRightsStatusSchema = z.enum(['unknown', 'confirmed', 'conflicting']);
export type ImageRightsStatus = z.infer<typeof ImageRightsStatusSchema>;

const ImageIdentityMatchSchema = z.enum(['unknown', 'exact', 'variant', 'wrong']);
export type ImageIdentityMatch = z.infer<typeof ImageIdentityMatchSchema>;

/**
 * Image proposal with rights and identity provenance. An image whose
 * exact-product match or reuse status is unknown must never be proposed for
 * use — the agent must set `identityMatch: 'unknown'` and let the CMS block it.
 */
const ImageProposalSchema = z.object({
  url: z.string().url(),
  sourceId: z.string().min(1),
  rightsStatus: ImageRightsStatusSchema,
  identityMatch: ImageIdentityMatchSchema,
  /** Why this image is believed to depict the exact product (evidence ids). */
  evidenceIds: z.array(z.string().min(1)).default([]),
  /** Supplier-provided reuse statement when available. */
  rightsNote: z.string().max(1024).nullish(),
});
export type ImageProposal = z.infer<typeof ImageProposalSchema>;

const ConflictSeveritySchema = z.enum(['low', 'medium', 'high']);
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;

const ConflictSchema = z.object({
  id: z.string().min(1),
  severity: ConflictSeveritySchema,
  /** Machine-readable category (e.g. "gtin_mismatch", "title_conflict"). */
  category: z.string().min(1).max(128),
  summary: z.string().min(1).max(2048),
  evidenceIds: z.array(z.string().min(1)).default([]),
  /** Optional proposal for resolving the conflict. Never auto-applied. */
  resolutionProposal: z.string().max(2048).nullish(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

const AbstentionSchema = z.object({
  /** Full abstention, or partial (scope lists the targets abstained on). */
  scope: z.enum(['full', 'partial']),
  reason: z.string().min(1).max(2048),
  /** A concrete next step a human or another run could take. */
  actionableNextStep: z.string().min(1).max(2048),
  /** Targets abstained on when scope is 'partial'. */
  targets: z.array(z.string().min(1)).default([]),
});
export type Abstention = z.infer<typeof AbstentionSchema>;

const GtinMatchStatusSchema = z.enum(['exact', 'variant', 'unknown', 'conflicting']);
export type GtinMatchStatus = z.infer<typeof GtinMatchStatusSchema>;

const IdentityAssessmentSchema = z.object({
  /**
   * Whether sources confirm the GTIN resolves to the exact product (not a
   * variant, kit, or repackage).
   */
  gtinMatch: GtinMatchStatusSchema,
  gtinEvidenceIds: z.array(z.string().min(1)).default([]),
  /** Whether the register name aligns with the resolved product. */
  registerNameMatch: GtinMatchStatusSchema,
  registerNameEvidenceIds: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1).max(2048),
});
export type IdentityAssessment = z.infer<typeof IdentityAssessmentSchema>;

export const StructuredSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  identity: IdentityAssessmentSchema,
  evidenceSources: z.array(EvidenceSourceSchema).max(64).default([]),
  evidenceItems: z.array(EvidenceItemSchema).max(512).default([]),
  productProposal: ProductProposalSchema.default({ fields: [] }),
  classificationProposal: ClassificationProposalSchema.default({
    productTypeId: null,
    categoryPageId: null,
    attributes: [],
  }),
  images: z.array(ImageProposalSchema).max(32).default([]),
  conflicts: z.array(ConflictSchema).max(64).default([]),
  abstention: AbstentionSchema.nullable().default(null),
  /**
   * Self-reported confidence 0..1. This is informational only and can never
   * grant acceptance — deterministic CMS policy decides eligibility.
   */
  confidence: z.number().min(0).max(1).default(0),
});
export type StructuredSubmission = z.infer<typeof StructuredSubmissionSchema>;

// ---------------------------------------------------------------------------
// Execution events
// ---------------------------------------------------------------------------

export const ExecutionEventTypeSchema = z.enum([
  'run_started',
  'executor_selected',
  'session_created',
  'tool_call_started',
  'tool_call_finished',
  'submission_received',
  'agent_finished',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'run_timeout',
]);
export type ExecutionEventType = z.infer<typeof ExecutionEventTypeSchema>;

export const ProductIntelligenceExecutionEventSchema = z.object({
  type: ExecutionEventTypeSchema,
  runId: z.string().min(1),
  /** Monotonic per-run sequence number. */
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  message: z.string().max(2048).nullish(),
  toolName: z.string().max(256).nullish(),
  isError: z.boolean().nullish(),
  /** Actual tool-failure message when isError (diagnostics, PI smoke finding). */
  error: z.string().max(500).nullish(),
  /** Tool-result evidence relayed for durable persistence (smoke finding A). */
  evidence: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.string().nullish(),
        url: z.string().nullish(),
        domain: z.string().nullish(),
        method: z.string().nullish(),
        snippet: z.string().nullish(),
        contentHash: z.string().nullish(),
      }),
    )
    .nullish(),
  /** Small machine-readable payload (e.g. executor name, versions). */
  data: z.unknown().nullish(),
});
export type ProductIntelligenceExecutionEvent = z.infer<
  typeof ProductIntelligenceExecutionEventSchema
>;

// ---------------------------------------------------------------------------
// Terminal result submission (PI-1 envelope + PI-4 workflow submissions)
// ---------------------------------------------------------------------------

/** Any terminal submission the run service persists: the legacy PI-1 evidence envelope or a PI-4 workflow submission. */
export const TerminalResultSubmissionSchema = z.union([StructuredSubmissionSchema, TerminalSubmissionSchema]);

/** Historical union type for parsing persisted rows (legacy + workflow). */
export type HistoricalTerminalSubmission = z.infer<typeof TerminalResultSubmissionSchema>;

/**
 * The LIVE terminal submission type: PI-4 workflow submissions only (review
 * finding 6). The legacy PI-1 envelope is deliberately excluded — a fake or
 * future executor cannot type a legacy envelope through the live result
 * path, and the run-service terminal gate denies non-workflow submissions at
 * runtime. Historical rows keep the full union via HistoricalTerminalSubmission
 * + parseLegacySubmission().
 */
export type TerminalResultSubmission = TerminalSubmission;

/**
 * The legacy PI-1 terminal envelope (schemaVersion 1 structured evidence
 * bundle). Kept for parsing/rendering historical runs only — never presented
 * to live Pi sessions (P0-3); live terminals are the PI-4 workflow tools.
 */
export type LegacyTerminalSubmission = StructuredSubmission;

/** Type narrowing for the legacy PI-1 envelope (historical parsing only). */
export function isLegacyTerminalSubmission(value: unknown): value is LegacyTerminalSubmission {
  return StructuredSubmissionSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

const ResearchOutcomeSchema = z.enum([
  'submitted',
  'abstained',
  'unavailable',
  'failed',
  'cancelled',
  'timed_out',
]);
export type ResearchOutcome = z.infer<typeof ResearchOutcomeSchema>;

const ResearchFailureCodeSchema = z.enum([
  'invalid_input',
  'missing_submission',
  'deadline_exceeded',
  'cancelled',
  'session_error',
  'policy_denied',
  'model_unavailable',
  'validation_error',
  'unknown',
]);
export type ResearchFailureCode = z.infer<typeof ResearchFailureCodeSchema>;

const ResearchFailureSchema = z.object({
  code: ResearchFailureCodeSchema,
  message: z.string().min(1).max(4096),
});
export type ResearchFailure = z.infer<typeof ResearchFailureSchema>;

const ExtensionVersionSchema = z.object({
  name: z.string().min(1),
  /** Exact version when the runtime reports one, otherwise null. */
  version: z.string().nullish(),
});
export type ExtensionVersion = z.infer<typeof ExtensionVersionSchema>;

export const ProductResearchResultSchema = z.object({
  runId: z.string().min(1),
  outcome: ResearchOutcomeSchema,
  /** Executor that produced the result ('pi' | 'legacy' | custom name). */
  executor: z.string().min(1),
  /** Executor implementation version (code-level). */
  executorVersion: z.string().min(1).default('1.0.0'),
  /** Exact Pi runtime version, when a Pi session ran. */
  piVersion: z.string().nullish(),
  /** Exact extension versions of approved extensions loaded into the session. */
  extensionVersions: z.array(ExtensionVersionSchema).default([]),
  /** Immutable configuration id the run executed under. */
  configId: z.string().min(1),
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: z.number().int().nonnegative(),
  /** Model token usage reported by the provider (PI-10; null when unknown). */
  tokenUsage: z
    .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
    .nullish(),
  /** Provider-reported model cost in USD (PI-10; null when unknown). Serves as
   *  both the estimate and the final figure until real billing is available. */
  modelCostUsd: z.number().nonnegative().nullish(),
  /** Terminal submission: PI-4 workflow submission (legacy envelopes are
   *  excluded from the live type — see TerminalResultSubmission). */
  submission: TerminalSubmissionSchema.nullable().default(null),
  /** Terminal failure details when outcome is 'failed'. */
  failure: ResearchFailureSchema.nullable().default(null),
  /** Normalized execution events (PI-2 persists these durably). */
  events: z.array(ProductIntelligenceExecutionEventSchema).default([]),
});
export type ProductResearchResult = z.infer<typeof ProductResearchResultSchema>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const PI_EXECUTOR_NAME = 'pi' as const;
export const LEGACY_EXECUTOR_NAME = 'legacy' as const;

/**
 * The PI-4 workflow terminal tool every Pi research session exposes
 * regardless of policy. Session research ends through exactly one workflow
 * terminal tool (see WORKFLOW_TERMINAL_TOOLS in workflow/bundle); this is
 * the canonical one. Kept as a literal here to avoid a contracts <->
 * workflow import cycle.
 */
export const WORKFLOW_SUBMISSION_TOOL_NAME = 'submit_product_research_bundle' as const;

/** Terminal tools every Pi research session exposes regardless of policy. */
export const TERMINAL_TOOLS: readonly string[] = [WORKFLOW_SUBMISSION_TOOL_NAME];

/** Built-in Pi tools that may be referenced by policy.allowedTools. */
export const KNOWN_BUILTIN_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'];
