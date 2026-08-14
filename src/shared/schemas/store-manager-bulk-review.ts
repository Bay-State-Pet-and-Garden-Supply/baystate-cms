// ---------------------------------------------------------------------------
// Store Manager homogeneous bulk review schemas (operations console, Issue 8).
//
// Bulk review is a TRANSIENT server-derived selection over individually
// persisted proposals. Grouping is a read/preview operation; a preview
// persists an immutable batch header + item snapshots/digests so an approval
// binds the EXACT set the operator saw. Eligibility is fail-closed: only
// deterministic casing/whitespace (and audit-proven separator) fixes with
// uniform field/rule/evidence, no manual-review-required, no semantic/typo/
// AI-confidence, non-stale, undecided, workspace-owned items. Any stale or
// ineligible item refuses the WHOLE batch — no partial hidden approval.
//
// Every cross-boundary payload here is strict (unknown keys fail) and bounded.
// ---------------------------------------------------------------------------

import { z } from 'zod';

/** Hard cap on items in one preview/batch (bounded; large sets need splits). */
export const BULK_REVIEW_MAX_ITEMS = 200;
export const BULK_REVIEW_MAX_EXCLUSIONS = 500;
export const BULK_REVIEW_MAX_BEFORE_AFTER_SAMPLES = 50;
export const BULK_REVIEW_MAX_AFFECTED_SKUS_PER_ITEM = 5000;

/**
 * Normalization kinds eligible for homogeneous bulk review. Semantic, typo,
 * and unproven mappings are ALWAYS review-required and never eligible.
 */
export const BULK_REVIEW_ELIGIBLE_KINDS = ['casing', 'whitespace', 'separator'] as const;
export type BulkReviewEligibleKind = (typeof BULK_REVIEW_ELIGIBLE_KINDS)[number];

export const BULK_REVIEW_BATCH_STATUSES = ['pending', 'applied', 'denied'] as const;
export type BulkReviewBatchStatus = (typeof BULK_REVIEW_BATCH_STATUSES)[number];

export const BULK_REVIEW_ITEM_DECISIONS = ['pending', 'applied', 'denied'] as const;
export type BulkReviewItemDecision = (typeof BULK_REVIEW_ITEM_DECISIONS)[number];

/** Preview request: derive a homogeneous group for one ProductField. */
export const StoreManagerBulkReviewPreviewRequestSchema = z
  .object({
    field: z.string().min(1).max(128),
    /** Optional narrowing to one normalization kind (default: any eligible). */
    normalizationKind: z.enum(BULK_REVIEW_ELIGIBLE_KINDS).optional(),
    maxItems: z.number().int().min(1).max(BULK_REVIEW_MAX_ITEMS).optional(),
  })
  .strict();
export type StoreManagerBulkReviewPreviewRequest = z.infer<
  typeof StoreManagerBulkReviewPreviewRequestSchema
>;

/** One ineligible/refused item with its deterministic reason. */
export const StoreManagerBulkReviewExclusionSchema = z
  .object({
    proposalId: z.string().min(1).max(64),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type StoreManagerBulkReviewExclusion = z.infer<typeof StoreManagerBulkReviewExclusionSchema>;

const beforeAfterSampleSchema = z
  .object({
    oldValue: z.string().min(1).max(1000),
    newValue: z.string().min(1).max(1000),
    affectedCount: z.number().int().nonnegative().max(5000),
  })
  .strict();

/**
 * Transient group summary (read-only derivation). Not authoritative by
 * itself; the persisted batch binds the exact item set via digests.
 */
export const StoreManagerBulkReviewGroupSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    field: z.string().min(1).max(128),
    normalizationKind: z.enum(BULK_REVIEW_ELIGIBLE_KINDS),
    ruleVersion: z.string().min(1).max(64),
    evidenceKey: z.string().min(1).max(200),
    proposalCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
    distinctSkuCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_AFFECTED_SKUS_PER_ITEM * BULK_REVIEW_MAX_ITEMS),
    beforeAfterSamples: z.array(beforeAfterSampleSchema).max(BULK_REVIEW_MAX_BEFORE_AFTER_SAMPLES),
    exclusions: z.array(StoreManagerBulkReviewExclusionSchema).max(BULK_REVIEW_MAX_EXCLUSIONS),
    truncated: z.boolean(),
    maxItems: z.number().int().positive().max(BULK_REVIEW_MAX_ITEMS),
  })
  .strict();
export type StoreManagerBulkReviewGroup = z.infer<typeof StoreManagerBulkReviewGroupSchema>;

/** Persisted batch header (immutable preview). */
export const StoreManagerBulkReviewBatchSchema = z
  .object({
    id: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(200),
    field: z.string().min(1).max(128),
    normalizationKind: z.enum(BULK_REVIEW_ELIGIBLE_KINDS),
    ruleVersion: z.string().min(1).max(64),
    evidenceKey: z.string().min(1).max(200),
    groupKey: z.string().min(1).max(64),
    status: z.enum(BULK_REVIEW_BATCH_STATUSES),
    proposalCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
    distinctSkuCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_AFFECTED_SKUS_PER_ITEM * BULK_REVIEW_MAX_ITEMS),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    createdBy: z.string().min(1).max(64),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerBulkReviewBatch = z.infer<typeof StoreManagerBulkReviewBatchSchema>;

/** One immutable item snapshot in a batch (approval binds these digests). */
export const StoreManagerBulkReviewItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(200),
    batchId: z.string().min(1).max(64),
    proposalId: z.string().min(1).max(64),
    field: z.string().min(1).max(128),
    oldValue: z.string().min(1).max(1000),
    newValue: z.string().min(1).max(1000),
    affectedSkus: z.array(z.string().min(1).max(128)).max(BULK_REVIEW_MAX_AFFECTED_SKUS_PER_ITEM),
    itemDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(BULK_REVIEW_ITEM_DECISIONS),
    decisionActor: z.string().max(64).nullable(),
    changeSetItemRef: z.string().max(64).nullable(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerBulkReviewItem = z.infer<typeof StoreManagerBulkReviewItemSchema>;

/** Append-only per-item audit decision (batch id is correlation only). */
export const StoreManagerBulkReviewDecisionSchema = z
  .object({
    id: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(200),
    batchId: z.string().min(1).max(64),
    proposalId: z.string().min(1).max(64),
    decision: z.enum(['applied', 'denied']),
    actor: z.string().min(1).max(64),
    runId: z.string().max(64).nullable(),
    diffHash: z.string().max(64).nullable(),
    changeSetItemRef: z.string().max(64).nullable(),
    createdAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerBulkReviewDecision = z.infer<typeof StoreManagerBulkReviewDecisionSchema>;

/** Full preview result (route response): batch + items + group + stored diff. */
export const StoreManagerBulkReviewPreviewResultSchema = z
  .object({
    ok: z.literal(true),
    batch: StoreManagerBulkReviewBatchSchema,
    items: z.array(StoreManagerBulkReviewItemSchema).max(BULK_REVIEW_MAX_ITEMS),
    group: StoreManagerBulkReviewGroupSchema,
    diffHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Bounded rendered diff summary for the UI (never the raw catalog). */
    diffSummary: z
      .object({
        affectedSkuCount: z.number().int().nonnegative().max(5000),
        proposalCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
        beforeAfterSamples: z.array(beforeAfterSampleSchema).max(BULK_REVIEW_MAX_BEFORE_AFTER_SAMPLES),
        filesTouched: z.array(z.string().min(1).max(300)).max(100),
        changeSetCurrentState: z.string().max(100).nullable(),
        changeSetExpectedState: z.string().max(100),
        networkActivity: z.enum(['none', 'bounded', 'unknown']),
      })
      .strict(),
  })
  .strict();
export type StoreManagerBulkReviewPreviewResult = z.infer<typeof StoreManagerBulkReviewPreviewResultSchema>;

/** Batch detail (route response) with live staleness revalidation. */
export const StoreManagerBulkReviewBatchDetailSchema = z
  .object({
    ok: z.literal(true),
    batch: StoreManagerBulkReviewBatchSchema,
    items: z.array(StoreManagerBulkReviewItemSchema).max(BULK_REVIEW_MAX_ITEMS),
    stale: z.boolean(),
    staleReason: z.string().max(300).nullable(),
    currentProposalCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
  })
  .strict();
export type StoreManagerBulkReviewBatchDetail = z.infer<typeof StoreManagerBulkReviewBatchDetailSchema>;

/** Deny request: record per-item denied decisions with no catalog effect. */
export const StoreManagerBulkReviewDenyRequestSchema = z
  .object({
    reason: z.string().max(300).optional(),
  })
  .strict();
export type StoreManagerBulkReviewDenyRequest = z.infer<typeof StoreManagerBulkReviewDenyRequestSchema>;

const bulkApplyItemResultSchema = z
  .object({
    proposalId: z.string().min(1).max(64),
    status: z.enum(['applied', 'skipped', 'denied']),
    decisionId: z.string().max(64).nullable(),
    changeSetItemRef: z.string().max(64).nullable(),
  })
  .strict();

const perSkuVerificationSchema = z
  .object({
    sku: z.string().min(1).max(128),
    status: z.enum(['verified', 'error']),
    note: z.string().max(300).optional(),
  })
  .strict();

/**
 * Bulk apply result (tool output). Staging-only: never implies approval,
 * publish, or sync. Includes per-item audit references and an authoritative
 * per-SKU verification diff.
 */
export const StoreManagerBulkReviewApplyResultSchema = z
  .object({
    ok: z.literal(true),
    batchId: z.string().min(1).max(64),
    status: z.literal('applied'),
    appliedCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
    skippedCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
    changeSetId: z.string().min(1).max(64),
    items: z.array(bulkApplyItemResultSchema).max(BULK_REVIEW_MAX_ITEMS),
    verification: z
      .object({
        verifiedSkuCount: z.number().int().nonnegative().max(5000),
        perSku: z.array(perSkuVerificationSchema).max(200),
        perSkuTruncated: z.boolean(),
        verificationHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();
export type StoreManagerBulkReviewApplyResult = z.infer<typeof StoreManagerBulkReviewApplyResultSchema>;

/** Batch list row (bounded). */
export const StoreManagerBulkReviewBatchSummarySchema = z
  .object({
    id: z.string().min(1).max(64),
    field: z.string().min(1).max(128),
    normalizationKind: z.enum(BULK_REVIEW_ELIGIBLE_KINDS),
    status: z.enum(BULK_REVIEW_BATCH_STATUSES),
    proposalCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_ITEMS),
    distinctSkuCount: z.number().int().nonnegative().max(BULK_REVIEW_MAX_AFFECTED_SKUS_PER_ITEM * BULK_REVIEW_MAX_ITEMS),
    createdAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerBulkReviewBatchSummary = z.infer<typeof StoreManagerBulkReviewBatchSummarySchema>;
