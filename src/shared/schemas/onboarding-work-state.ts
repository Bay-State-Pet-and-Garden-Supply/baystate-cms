// fallow-ignore-file unused-export

/**
 * Epic #46 — Operator work-state projection (Phases 1/7/8).
 *
 * The server owns ALL operator-facing read-model derivation. The client never
 * reverse-engineers `stage` / `stage_status` / error strings / cohort state /
 * feature flags into human meaning — it consumes the projected work state
 * below.
 *
 * This schema is the shared contract between the projection service
 * (`src/onboarding/onboarding-work-state.ts`), the batch/item APIs
 * (`src/server/routes/onboarding-routes.ts`, `onboarding-work-routes.ts`) and
 * the Batch Workspace UI.
 */
import { z } from 'zod';
import { PipelineStageEnum, StageStatusEnum, SourceTypeEnum } from './onboarding';

// ─── Categories ─────────────────────────────────────────────────────────────────

/**
 * The operator-facing bucket every onboarding item projects into. One clear
 * current work state per product.
 *
 * - processing: automation is handling the item (no human action).
 * - needs_attention: automation stopped and requires operator judgment.
 * - waiting_on_family: the item's own evidence is ready but its cohort cannot
 *   start Curation until siblings are ready/blocked (ADR 0013 barrier).
 * - ready_for_review: Curation output complete, awaiting final human review.
 * - approved: human bulk approval granted; export/release not yet performed.
 * - ready_to_export: approved AND export drafts were created (the actual
 *   ShopSite-draft side effect completed); export/release is pending.
 * - completed: the release/export operation succeeded and was verified.
 * - skipped: the item was deliberately skipped.
 */
export const WorkStateCategoryEnum = z.enum([
  'processing',
  'needs_attention',
  'waiting_on_family',
  'ready_for_review',
  'approved',
  'ready_to_export',
  'completed',
  'skipped',
]);

export type WorkStateCategory = z.infer<typeof WorkStateCategoryEnum>;

// ─── Activities ────────────────────────────────────────────────────────────────

/** The underlying automated/human activity a product is in or waiting on. */
export const WorkActivityEnum = z.enum([
  'distributor_lookup',
  'official_site_search',
  'official_url_verification',
  'extraction',
  'curation',
  'review',
  'approval',
  'export',
]);

export type WorkActivity = z.infer<typeof WorkActivityEnum>;

// ─── Attention reasons / actions ───────────────────────────────────────────────

/** Why automation stopped for a needs_attention item. */
export const AttentionReasonEnum = z.enum([
  'verify_official_url',
  'no_official_url',
  'choose_official_url',
  'extractor_profile_required',
  'extraction_profile_failed',
  'source_conflict',
  'processing_failed',
  'semantic_validation_blocked',
]);

export type AttentionReason = z.infer<typeof AttentionReasonEnum>;

/** The operator decision/action that resolves the blocker. */
export const AttentionActionEnum = z.enum([
  'verify_official_url',
  'choose_official_url',
  'setup_extractor_profile',
  'retry_extraction',
  'resolve_source_conflict',
  'retry_processing',
  'resolve_semantic_conflict',
]);

export type AttentionAction = z.infer<typeof AttentionActionEnum>;

// ─── Durable review state ──────────────────────────────────────────────────────

/**
 * Durable human-review state, independent of the pipeline stage:
 * - not_ready: Curation output does not exist yet — nothing to review.
 * - unreviewed: Curation complete, human review not yet performed (or a
 *   prior review was invalidated by a consequential edit).
 * - reviewed: human inspection recorded (durable `onboarding_review_state`).
 * - approved: bulk approval release decision recorded.
 */
export const ReviewStateEnum = z.enum(['not_ready', 'unreviewed', 'reviewed', 'approved']);

export type ReviewState = z.infer<typeof ReviewStateEnum>;

// ─── Family context ────────────────────────────────────────────────────────────

/** Canonical cohort readiness surfaced to the operator (ADR 0013 barrier). */
export const OnboardingFamilyStateSchema = z.object({
  cohortId: z.string(),
  /** Cohort label, e.g. "Blue Buffalo Life Protection Chicken". */
  label: z.string().nullable(),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
  /** Members blocked in a pre-Curation barrier stage (sourcing|discovery|extraction). */
  blockedCount: z.number().int(),
  /** Sibling item ids this product is waiting on (excludes self; never the blocked members). */
  waitingOnItemIds: z.array(z.string()),
});

export type OnboardingFamilyState = z.infer<typeof OnboardingFamilyStateSchema>;

// ─── Per-item work state ───────────────────────────────────────────────────────

export const OnboardingWorkStateSchema = z.object({
  itemId: z.string(),
  category: WorkStateCategoryEnum,
  /** The automated/human activity, when meaningful. */
  activity: WorkActivityEnum.nullable().default(null),
  /** Human-facing short label, e.g. "Verify official product page". */
  label: z.string(),
  /** Optional human-facing detail (deterministic, non-secret). */
  detail: z.string().nullable().default(null),
  /** Present ONLY for needs_attention items: why automation stopped. */
  attentionReason: AttentionReasonEnum.nullable().default(null),
  /** Present ONLY for needs_attention items: the operator action that resolves it. */
  attentionAction: AttentionActionEnum.nullable().default(null),
  /** Canonical cohort readiness when the item belongs to a candidate family. */
  family: OnboardingFamilyStateSchema.nullable().default(null),
  /** Durable review/approval state. */
  reviewState: ReviewStateEnum.nullable().default(null),
  /** Raw pipeline stage — secondary diagnostics, never the primary UI. */
  stage: PipelineStageEnum,
  /** Raw pipeline stage status — secondary diagnostics. */
  stageStatus: StageStatusEnum,
  // ── Lightweight identity for filters/search/rendering (additive) ──
  upc: z.string(),
  name: z.string(),
  brand: z.string().nullable().default(null),
  sourceType: SourceTypeEnum.nullable().default(null),
  /** Normalized source host (official page only; null for distributor records). */
  domain: z.string().nullable().default(null),
});

export type OnboardingWorkState = z.infer<typeof OnboardingWorkStateSchema>;

// ─── Batch-level projection ────────────────────────────────────────────────────

export const WorkStateCountsSchema = z.object({
  processing: z.number().int().default(0),
  needs_attention: z.number().int().default(0),
  waiting_on_family: z.number().int().default(0),
  ready_for_review: z.number().int().default(0),
  approved: z.number().int().default(0),
  ready_to_export: z.number().int().default(0),
  completed: z.number().int().default(0),
  skipped: z.number().int().default(0),
});

export type WorkStateCounts = z.infer<typeof WorkStateCountsSchema>;

export const BatchWorkStateSchema = z.object({
  batchId: z.string(),
  counts: WorkStateCountsSchema,
  items: z.array(OnboardingWorkStateSchema),
  /** Total items matching the applied filters (before limit/offset). */
  total: z.number().int(),
});

export type BatchWorkState = z.infer<typeof BatchWorkStateSchema>;

/**
 * Client-safe filter shape (mirrors the projection service's WorkStateFilters;
 * invalid enum values fail closed server-side, never 500).
 */
export interface WorkStateFilters {
  category?: WorkStateCategory;
  /** Free-text search across UPC / name / brand. */
  q?: string;
  /** Normalized source host (official page items only). */
  domain?: string;
  sourceType?: 'official_page' | 'distributor_record';
  cohortId?: string;
  reviewState?: ReviewState;
  limit?: number;
  offset?: number;
}

export const EMPTY_WORK_STATE_COUNTS: WorkStateCounts = {
  processing: 0,
  needs_attention: 0,
  waiting_on_family: 0,
  ready_for_review: 0,
  approved: 0,
  ready_to_export: 0,
  completed: 0,
  skipped: 0,
};

// ─── Approval request/response ─────────────────────────────────────────────────

export const ApproveItemsRequestSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(1000).refine(
    ids => new Set(ids).size === ids.length,
    'itemIds must not contain duplicates',
  ),
  /** Optional operator identity for the audit trail. */
  reviewerId: z.string().max(200).optional(),
});

export type ApproveItemsRequest = z.infer<typeof ApproveItemsRequestSchema>;

export const ApprovalItemOutcomeSchema = z.object({
  itemId: z.string(),
  status: z.enum(['approved', 'rejected']),
  reason: z.string().nullable().default(null),
});

export type ApprovalItemOutcome = z.infer<typeof ApprovalItemOutcomeSchema>;

export const ApproveItemsResponseSchema = z.object({
  results: z.array(ApprovalItemOutcomeSchema),
  approvedCount: z.number().int(),
  rejectedCount: z.number().int(),
  rejected: z.array(ApprovalItemOutcomeSchema),
  audited: z.boolean(),
});

export type ApproveItemsResponse = z.infer<typeof ApproveItemsResponseSchema>;

// ─── Extractor-profile domain blockers (epic #46 follow-up, phase 5) ──────────

export const ExtractorProfileBlockerSampleSchema = z.object({
  itemId: z.string(),
  upc: z.string().optional(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string(),
});

export const ExtractorProfileDomainBlockerSchema = z.object({
  domain: z.string(),
  blockedItemCount: z.number().int(),
  batchId: z.string(),
  itemIds: z.array(z.string()),
  sampleItems: z.array(ExtractorProfileBlockerSampleSchema),
  profileExists: z.boolean(),
});

export const ExtractorProfileBlockersResponseSchema = z.object({
  blockers: z.array(ExtractorProfileDomainBlockerSchema),
});

export type ExtractorProfileDomainBlocker = z.infer<typeof ExtractorProfileDomainBlockerSchema>;
export type ExtractorProfileBlockersResponse = z.infer<typeof ExtractorProfileBlockersResponseSchema>;

// ─── Brand-domain setup blockers (ADR 0017 — batch-level Resolve Brand Domains) ─

/** One sample item behind a brand-domain blocker (up to 3 per blocker). */
export const BrandDomainSetupBlockerSampleSchema = z.object({
  itemId: z.string(),
  upc: z.string().optional(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
});

/**
 * Discovery items parked because their brand has no mapped official domain
 * (`needs_review: no domain mapped for brand "X" …`), grouped by brand.
 */
export const BrandDomainSetupBlockerSchema = z.object({
  brand: z.string(),
  blockedItemCount: z.number().int(),
  batchId: z.string(),
  itemIds: z.array(z.string()),
  sampleItems: z.array(BrandDomainSetupBlockerSampleSchema),
  /** Best-known brand→domain mapping from `brand_sites` (null when unmapped). */
  existingMapping: z.string().nullable(),
  /** When the group's earliest parked item was created (ISO timestamp). */
  createdAt: z.string(),
});

export const BrandDomainSetupResponseSchema = z.object({
  blockers: z.array(BrandDomainSetupBlockerSchema),
});

export type BrandDomainSetupBlocker = z.infer<typeof BrandDomainSetupBlockerSchema>;
export type BrandDomainSetupResponse = z.infer<typeof BrandDomainSetupResponseSchema>;

// ─── Domain release response ───────────────────────────────────────────────────

export const DomainReleaseResponseSchema = z.object({
  domain: z.string(),
  releasedItemIds: z.array(z.string()),
  count: z.number().int(),
  skippedCount: z.number().int(),
});

export type DomainReleaseResponse = z.infer<typeof DomainReleaseResponseSchema>;
