/**
 * Agent Lab: Agent Training & Alignment Schemas.
 *
 * Defines Zod schemas and TypeScript contracts for immutable version snapshots,
 * workspace lifecycle states, corrections, teaching events, evaluation snapshots,
 * granular paired evaluation cases, and promotion requests.
 */
import { z } from 'zod';

/** Difficulty tags — canonical home here (relocated from product-intelligence/evaluation/gold.ts, ADR-0030 PR 1.3). */
export const PiDifficultyTagSchema = z.enum([
  'upc_normalization',
  'json_ld_static',
  'shopify_variant',
  'woocommerce_variant',
  'multi_variant',
  'product_family',
  'xhr_only',
  'interaction_required',
  'packaging_redesign',
  'wrong_size_retailer',
  'discontinued',
  'ambiguous_brand',
  'blocked_official',
  'distributor_conflict',
  'image_rights_uncertainty',
  'abstention_correct',
]);
export type PiDifficultyTag = z.infer<typeof PiDifficultyTagSchema>;

// ─── Instruction & Example Schemas ──────────────────────────────────────────

export const AgentInstructionCategorySchema = z.enum([
  'identity',
  'extraction',
  'facts',
  'classification',
  'sources',
  'abstention',
]);
export type AgentInstructionCategory = z.infer<typeof AgentInstructionCategorySchema>;

export const AgentInstructionRuleSchema = z.object({
  id: z.string().min(1),
  category: AgentInstructionCategorySchema,
  rule: z.string().min(1),
  motivationCorrectionId: z.string().nullish(),
  createdAt: z.string(),
});
export type AgentInstructionRule = z.infer<typeof AgentInstructionRuleSchema>;

export const AgentFewShotExampleSchema = z.object({
  id: z.string().min(1),
  gtin: z.string().min(1),
  registerName: z.string(),
  brandHint: z.string().nullish(),
  departmentHint: z.string().nullish(),
  price: z.string().nullish(),
  quantity: z.number().int().nullish(),
  explanation: z.string(),
  expectedOutput: z.object({
    title: z.string().nullish(),
    brand: z.string().nullish(),
    facts: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
    preferredSourceDomain: z.string().nullish(),
    forbiddenSourceDomains: z.array(z.string()).default([]),
    productType: z.string().nullish(),
    categoryPages: z.array(z.string()).default([]),
    shouldAbstain: z.boolean().default(false),
    abstentionReason: z.string().nullish(),
  }),
  difficultyTags: z.array(PiDifficultyTagSchema).default([]),
  tokenCount: z.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
  createdAt: z.string(),
});
export type AgentFewShotExample = z.infer<typeof AgentFewShotExampleSchema>;

// ─── Version Snapshot & Lifecycle State ─────────────────────────────────────

export const AgentLifecycleStatusSchema = z.enum([
  'draft',
  'evaluating',
  'qualified',
  'active',
  'retired',
]);
export type AgentLifecycleStatus = z.infer<typeof AgentLifecycleStatusSchema>;

export const AgentVersionSnapshotSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  versionNumber: z.number().int().positive(),
  revisionNumber: z.number().int().positive(),
  parentVersionId: z.string().nullish(),
  compilerVersion: z.string().min(1),
  instructions: z.array(AgentInstructionRuleSchema),
  fewShotExamples: z.array(AgentFewShotExampleSchema),
  fewShotTokenBudget: z.number().int().positive().default(4000),
  policyConfigId: z.string().min(1),
  contentHash: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  changeSummary: z.string().default(''),
});
export type AgentVersionSnapshot = z.infer<typeof AgentVersionSnapshotSchema>;

export const AgentVersionStateSchema = z.object({
  versionId: z.string().min(1),
  workspaceId: z.string().min(1),
  lifecycleStatus: AgentLifecycleStatusSchema,
  activeEvaluationId: z.string().nullish(),
  activatedAt: z.string().nullish(),
  retiredAt: z.string().nullish(),
  updatedAt: z.string(),
});
export type AgentVersionState = z.infer<typeof AgentVersionStateSchema>;

export const AgentVersionSummarySchema = z.object({
  snapshot: AgentVersionSnapshotSchema,
  state: AgentVersionStateSchema,
});
export type AgentVersionSummary = z.infer<typeof AgentVersionSummarySchema>;

// ─── Correction & Teaching Schemas ──────────────────────────────────────────

export const AgentCorrectionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  runId: z.string().min(1),
  versionId: z.string().min(1),
  originalResultHash: z.string().min(1),
  correctedFields: z.object({
    title: z.string().nullish(),
    brand: z.string().nullish(),
    packCount: z.number().int().positive().nullish(),
    unitPrice: z.string().nullish(),
    facts: z.array(z.object({ field: z.string(), value: z.string() })).nullish(),
    productType: z.string().nullish(),
    categoryPages: z.array(z.string()).nullish(),
    selectedImageCandidateId: z.string().nullish(),
    abstentionReason: z.string().nullish(),
  }),
  failureMode: z.string().min(1),
  notes: z.string().default(''),
  createdBy: z.string().min(1),
  createdAt: z.string(),
});
export type AgentCorrection = z.infer<typeof AgentCorrectionSchema>;

export const TeachingActionItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_rule'),
    category: AgentInstructionCategorySchema,
    rule: z.string().min(1),
  }),
  z.object({
    type: z.literal('remove_rule'),
    ruleId: z.string().min(1),
  }),
  z.object({
    type: z.literal('add_few_shot'),
    gtin: z.string().min(1),
    registerName: z.string().min(1),
    brandHint: z.string().nullish(),
    price: z.string().nullish(),
    quantity: z.number().nullish(),
    expectedOutput: z.record(z.string(), z.unknown()),
    explanation: z.string().min(1),
    difficultyTags: z.array(PiDifficultyTagSchema).default([]),
  }),
  z.object({
    type: z.literal('remove_few_shot'),
    exampleId: z.string().min(1),
  }),
  z.object({
    type: z.literal('add_negative_pattern'),
    domain: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('add_to_train_dataset'),
    difficultyTags: z.array(PiDifficultyTagSchema).default([]),
  }),
]);
export type TeachingActionItem = z.infer<typeof TeachingActionItemSchema>;
export type AgentTeachingAction = TeachingActionItem;

export const TeachingRequestSchema = z.object({
  correctionId: z.string().min(1),
  baseVersionId: z.string().nullish(),
  rationale: z.string().min(1),
  actions: z.array(TeachingActionItemSchema).min(1),
  createdBy: z.string().min(1).default('operator'),
});
export type TeachingRequest = z.infer<typeof TeachingRequestSchema>;

export const AgentTeachingEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  correctionId: z.string().min(1),
  resultingVersionId: z.string().min(1),
  actions: z.array(TeachingActionItemSchema),
  rationale: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AgentTeachingEvent = z.infer<typeof AgentTeachingEventSchema>;

// ─── Evaluation & Case Matrices ─────────────────────────────────────────────

export const EvaluationDeltaClassSchema = z.enum(['fixed', 'regressed', 'unchanged']);
export type EvaluationDeltaClass = z.infer<typeof EvaluationDeltaClassSchema>;

export const AgentEvaluationCaseSchema = z.object({
  id: z.string().min(1),
  evaluationId: z.string().min(1),
  workspaceId: z.string().min(1),
  benchmarkExampleId: z.string().min(1),
  productSku: z.string().min(1),
  candidateRunId: z.string().min(1),
  baselineRunId: z.string().min(1),
  candidateOutcome: z.string(),
  baselineOutcome: z.string(),
  comparison: z.record(z.string(), z.unknown()),
  deltaClass: EvaluationDeltaClassSchema,
  criticalRegression: z.boolean(),
  status: z.enum(['pending', 'completed', 'failed']),
  createdAt: z.string(),
});
export type AgentEvaluationCase = z.infer<typeof AgentEvaluationCaseSchema>;

export const AgentEvaluationSnapshotSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  candidateVersionId: z.string().min(1),
  baselineVersionId: z.string().min(1),
  datasetId: z.string().min(1),
  datasetHash: z.string().min(1),
  splitGroup: z.string().min(1),
  scorecard: z.object({
    totalCases: z.number().int().nonnegative(),
    completedCases: z.number().int().nonnegative(),
    fixedCount: z.number().int().nonnegative(),
    regressedCount: z.number().int().nonnegative(),
    unchangedCount: z.number().int().nonnegative(),
    criticalRegressions: z.number().int().nonnegative(),
    candidateExactProductHit: z.number(),
    baselineExactProductHit: z.number(),
    candidateProductTypeAccuracy: z.number().nullish(),
    baselineProductTypeAccuracy: z.number().nullish(),
    candidateAbstentionCorrect: z.number().nullish(),
    baselineAbstentionCorrect: z.number().nullish(),
    deltaExactProductHit: z.number(),
  }),
  promotionGateVerdict: z.object({
    allowed: z.boolean(),
    reasons: z.array(z.string()),
    complete: z.boolean(),
  }),
  status: z.enum(['running', 'passed', 'failed', 'cancelled']),
  createdAt: z.string(),
  completedAt: z.string().nullish(),
});
export type AgentEvaluationSnapshot = z.infer<typeof AgentEvaluationSnapshotSchema>;

// ─── Promotion Request ──────────────────────────────────────────────────────

export const AgentPromotionRequestSchema = z.object({
  candidateVersionId: z.string().min(1),
  evaluationId: z.string().min(1),
  promotedBy: z.string().min(1).default('operator'),
  notes: z.string().nullish(),
});
export type AgentPromotionRequest = z.infer<typeof AgentPromotionRequestSchema>;
