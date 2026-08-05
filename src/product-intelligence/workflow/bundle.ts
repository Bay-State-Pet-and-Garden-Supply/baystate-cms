/**
 * ProductResearchBundle terminal contract (PI-4).
 *
 * The workflow's structured result: a validated, evidence-backed research
 * bundle. The session must finish through exactly one terminal tool:
 * submit_product_research_bundle, submit_insufficient_evidence, or
 * submit_identity_conflict. Ordinary prose is never a result.
 *
 * The GTIN is the primary identity key; register name and brand hints are
 * untrusted search hints; missing facts stay null; plausibility is not
 * evidence; every factual value cites supporting evidence ids.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/21
 */
import { z } from 'zod';

export const IdentityStatusSchema = z.enum([
  'exact_match',
  'probable_match',
  'parent_product_only',
  'wrong_variant',
  'conflicting_identity',
  'insufficient_evidence',
]);
export type IdentityStatus = z.infer<typeof IdentityStatusSchema>;

export const NetContentSchema = z.object({
  value: z.number().positive(),
  unit: z.string().min(1).max(16),
});
export type NetContent = z.infer<typeof NetContentSchema>;

export const CommerceFactSchema = z.object({
  field: z.string().min(1).max(128),
  value: z.unknown(),
  /** Evidence ids from tool outputs backing this fact. */
  evidenceIds: z.array(z.string().min(1)).default([]),
  /** Deterministic extraction methods (e.g. 'json_ld', 'meta_tags', 'vlm_ocr'). */
  extractionMethods: z.array(z.string().min(1)).default([]),
  /** 0..1 self-assessed signal strength — informational only, never acceptance. */
  confidenceSignal: z.number().min(0).max(1).nullable().default(null),
});
export type CommerceFact = z.infer<typeof CommerceFactSchema>;

export const BundleClassificationProposalSchema = z.object({
  /** Stable CMS-controlled target id (Product Type, Category Page, or attribute). */
  targetId: z.string().min(1).max(128),
  /** Stable CMS-controlled option id/value selected for that target. */
  selectedOptionId: z.string().min(1).max(256),
  evidenceIds: z.array(z.string().min(1)).default([]),
  disposition: z.enum(['proposed', 'needs_review']).default('proposed'),
});
export type BundleClassificationProposal = z.infer<typeof BundleClassificationProposalSchema>;

export const ImageRoleSchema = z.enum(['primary', 'alternate', 'nutrition', 'ingredients']);
export const ImageRightsStatusSchema = z.enum(['supplier_authorized', 'manufacturer_authorized', 'licensed_dataset', 'unknown']);

export const BundleImageCandidateSchema = z.object({
  sourceId: z.string().min(1),
  sourceArtifactId: z.string().min(1),
  url: z.string().url(),
  role: ImageRoleSchema,
  /** Exact-product match is a separate decision from exact-variant match. */
  exactProductMatch: z.boolean(),
  exactVariantMatch: z.boolean().nullable().default(null),
  variantReference: z.string().max(256).nullish(),
  rightsStatus: ImageRightsStatusSchema,
});
export type BundleImageCandidate = z.infer<typeof BundleImageCandidateSchema>;

export const BundleConflictSchema = z.object({
  field: z.string().min(1).max(128),
  values: z.array(z.unknown()).min(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
  severity: z.enum(['low', 'medium', 'blocking']),
});
export type BundleConflict = z.infer<typeof BundleConflictSchema>;

export const BundleDispositionSchema = z.enum(['research_complete', 'needs_review', 'insufficient_evidence', 'identity_conflict']);
export type BundleDisposition = z.infer<typeof BundleDispositionSchema>;

export const ProductResearchBundleSchema = z.object({
  schemaVersion: z.literal(1),
  gtin: z.string().min(1).max(64),
  inputName: z.string().min(1).max(512),
  identity: z.object({
    status: IdentityStatusSchema,
    brand: z.string().max(256).nullable().default(null),
    canonicalName: z.string().max(512).nullable().default(null),
    variant: z.string().max(256).nullable().default(null),
    manufacturer: z.string().max(256).nullable().default(null),
    netContent: NetContentSchema.nullable().default(null),
    packCount: z.number().int().positive().nullable().default(null),
    evidenceIds: z.array(z.string().min(1)).default([]),
  }),
  commerceFacts: z.array(CommerceFactSchema).max(128).default([]),
  classificationProposals: z.array(BundleClassificationProposalSchema).max(64).default([]),
  imageCandidates: z.array(BundleImageCandidateSchema).max(32).default([]),
  conflicts: z.array(BundleConflictSchema).max(64).default([]),
  disposition: BundleDispositionSchema,
});
export type ProductResearchBundle = z.infer<typeof ProductResearchBundleSchema>;

/** Terminal abstention: no research outcome could be established. */
export const InsufficientEvidenceSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  gtin: z.string().min(1).max(64),
  inputName: z.string().min(1).max(512),
  reason: z.string().min(1).max(2048),
  actionableNextStep: z.string().min(1).max(2048),
  evidenceIds: z.array(z.string().min(1)).default([]),
  /** Steps attempted before abstaining (tool names). */
  attemptedSteps: z.array(z.string().min(1)).default([]),
});
export type InsufficientEvidenceSubmission = z.infer<typeof InsufficientEvidenceSubmissionSchema>;

/** Terminal conflict submission: identity or fact conflicts block completion. */
export const IdentityConflictSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  gtin: z.string().min(1).max(64),
  inputName: z.string().min(1).max(512),
  conflicts: z.array(BundleConflictSchema).min(1).max(64),
  evidenceIds: z.array(z.string().min(1)).default([]),
  recommendedDisposition: z.enum(['needs_review', 'identity_conflict']),
});
export type IdentityConflictSubmission = z.infer<typeof IdentityConflictSubmissionSchema>;

/** Any valid terminal submission. */
export const TerminalSubmissionSchema = z.union([
  ProductResearchBundleSchema,
  InsufficientEvidenceSubmissionSchema,
  IdentityConflictSubmissionSchema,
]);
export type TerminalSubmission = z.infer<typeof TerminalSubmissionSchema>;

export const TERMINAL_BUNDLE_TOOL = 'submit_product_research_bundle' as const;
export const TERMINAL_INSUFFICIENT_TOOL = 'submit_insufficient_evidence' as const;
export const TERMINAL_CONFLICT_TOOL = 'submit_identity_conflict' as const;

export const WORKFLOW_TERMINAL_TOOLS: readonly string[] = [
  TERMINAL_BUNDLE_TOOL,
  TERMINAL_INSUFFICIENT_TOOL,
  TERMINAL_CONFLICT_TOOL,
];

/** Classify a terminal submission for run disposition. */
export function terminalDisposition(submission: TerminalSubmission): 'submitted' | 'abstained' {
  if ('disposition' in submission) return 'submitted';
  return 'abstained'; // insufficient-evidence and identity-conflict are abstentions
}
