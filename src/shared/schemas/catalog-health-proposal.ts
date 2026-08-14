// ---------------------------------------------------------------------------
// Catalog health proposal schemas (epic #42, #39)
//
// Single contract shared by the server (persistence + validation) and the
// client (wire types). The persisted proposal type, the AI model response
// envelope, and each candidate proposal are strictly validated server-side
// before any DB mutation. Model confidence is informational only — it never
// participates in approval or staging predicates.
// ---------------------------------------------------------------------------

import { z } from 'zod';

export const PROPOSAL_SOURCES = ['deterministic', 'ai'] as const;
export const PROPOSAL_STATUSES = ['proposed', 'applied', 'dismissed'] as const;

/**
 * Deterministic classification of an AI-suggested normalization. `casing`,
 * `whitespace` and (audit-proven) `separator` mappings are mechanical;
 * `typo` requires review; `semantic` (taxonomy consolidation) is ALWAYS
 * review-required and never mechanically safe.
 */
export const NORMALIZATION_KINDS = [
  'casing',
  'whitespace',
  'separator',
  'typo',
  'semantic',
] as const;

export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type NormalizationKind = (typeof NORMALIZATION_KINDS)[number];

/** Bounds for persisted and AI-suggested values. */
export const MAX_PROPOSAL_VALUE_LENGTH = 200;
export const MAX_PROPOSAL_REASON_LENGTH = 500;
export const MAX_AFFECTED_SKUS = 5000;
export const MAX_AI_PROPOSAL_COUNT = 50;
export const MAX_AI_PROPOSAL_RESPONSE_BYTES = 60_000;

const catalogProposalCore = {
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  // Field is a bounded string; the ProductField\d+ pattern is enforced by the
  // AI-proposal field-scope validation (resolveProposalFieldScope), not by the
  // persisted row schema (catalog_health_proposals also serves non-ProductField
  // health flows).
  field: z.string().min(1).max(128),
  // Values keep their exact casing/whitespace: AI oldValue must match an
  // observed catalog value byte-for-byte, so no trim transform here.
  oldValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
  newValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
  affectedSkus: z.array(z.string().min(1)).max(MAX_AFFECTED_SKUS),
  reason: z.string().min(1).max(MAX_PROPOSAL_REASON_LENGTH),
  /** Informational only — never an approval or staging predicate. */
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(PROPOSAL_SOURCES),
  status: z.enum(PROPOSAL_STATUSES),
  changeSetId: z.string().nullable(),
  // ── Bulk-review eligibility metadata (operations console, Issue 8) ──
  // Only NEW records carry these explicitly; legacy/unknown rows default
  // `manualReviewRequired = true` (ineligible) and are NEVER reclassified as
  // safe by inference or confidence.
  normalizationKind: z.enum(NORMALIZATION_KINDS).nullable(),
  /** Deterministic rule that produced the mapping (stable, server-owned). */
  ruleVersion: z.string().max(64).nullable(),
  /** Evidence class the mapping belongs to (uniform within a bulk group). */
  evidenceKey: z.string().max(200).nullable(),
  /** True => never eligible for homogeneous bulk review. */
  manualReviewRequired: z.boolean(),
  /** Content digest captured at insert; bulk previews bind this exact row. */
  currentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

/**
 * Persisted catalog health proposal. This is the single type shared by the
 * repository, services, routes, and client — no duplicate server/client
 * interfaces.
 */
export const CatalogProposalSchema = z.object(catalogProposalCore).strict();

export type CatalogProposal = z.infer<typeof CatalogProposalSchema>;

/** Input shape accepted by the repository insert path (subset of persisted). */
export const InsertCatalogProposalSchema = z
  .object({
    workspaceId: z.string().min(1),
    field: z.string().min(1).max(128),
    oldValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
    newValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
    affectedSkus: z.array(z.string().min(1)).max(MAX_AFFECTED_SKUS),
    reason: z.string().min(1).max(MAX_PROPOSAL_REASON_LENGTH),
    confidence: z.number().finite().min(0).max(1),
    source: z.enum(PROPOSAL_SOURCES),
    status: z.enum(PROPOSAL_STATUSES).optional().default('proposed'),
    // Optional bulk-review metadata (Issue 8). Omitted values default to
    // `manualReviewRequired = true` so ANY caller that does not prove the
    // mapping deterministic-safe produces an ineligible row.
    normalizationKind: z.enum(NORMALIZATION_KINDS).optional(),
    ruleVersion: z.string().max(64).optional(),
    evidenceKey: z.string().max(200).optional(),
    manualReviewRequired: z.boolean().optional(),
  })
  .strict();

export type InsertCatalogProposal = z.infer<typeof InsertCatalogProposalSchema>;

/**
 * One candidate proposal in the AI model response. Unknown keys are rejected;
 * values and counts are bounded; confidence is finite in `[0, 1]`.
 */
export const AiProposalCandidateSchema = z
  .object({
    // Exact values as observed in the catalog (casing/whitespace preserved).
    oldValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
    newValue: z.string().min(1).max(MAX_PROPOSAL_VALUE_LENGTH),
    reason: z.string().min(1).max(MAX_PROPOSAL_REASON_LENGTH).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export type AiProposalCandidate = z.infer<typeof AiProposalCandidateSchema>;

/**
 * Complete AI model response envelope. Strict: unknown top-level keys and
 * unknown candidate keys are rejected; the proposal array is bounded.
 */
export const AiProposalsEnvelopeSchema = z
  .object({
    // Count is bounded by the validator (distinct too_many_proposals code);
    // keep the schema permissive so the code-specific check runs first.
    proposals: z.array(AiProposalCandidateSchema).min(1),
  })
  .strict();

export type AiProposalsEnvelope = z.infer<typeof AiProposalsEnvelopeSchema>;
