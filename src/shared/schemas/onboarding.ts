// fallow-ignore-file unused-export

import { z } from 'zod';
import { convertToLbs } from '../weight-converter';
import {
  ClassificationConfigSnapshotRefSchema,
  ClassificationEvidenceSchema,
  ClassificationProposalSchema,
  ClassificationProposalDecisionSchema,
  ClassificationHistoryEventSchema,
} from './classification';

// ─── Column Mapping ────────────────────────────────────────────────────────────

export const ColumnMappingSchema = z.object({
  upc: z.string().min(1, 'UPC column is required'),
  name: z.string().min(1, 'Name column is required'),
  /** Secondary column to concatenate with `name` (e.g. DESCRIPTION2 when name is DESCRIPTION1). */
  nameMergeWith: z.string().nullable().default(null),
  price: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  department: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
});

export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

// ─── Spreadsheet Row (post-mapping, pre-insert) ────────────────────────────────

export const SpreadsheetRowSchema = z.object({
  upc: z.string().min(1, 'UPC is required'),
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  quantity: z.number().int().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  departmentHint: z.string().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  rowNumber: z.number().int(),
});

export type SpreadsheetRow = z.infer<typeof SpreadsheetRowSchema>;

// ─── Packaging OCR Data (VLM-sourced) ───────────────────────────────────────────

/**
 * Structured attributes extracted from the product's primary packaging image
 * via local VLM OCR. Populated once before classification, then consumed by
 * both the curator (title synthesis) and the classification pipeline (evidence).
 */
export const PackagingOcrDataSchema = z.object({
  // Core identity
  productName: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  species: z.array(z.string()).default(() => []),

  // Physical / sensory attributes
  flavorVariety: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  material: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  count: z.string().nullable().default(null),

  // Pet-specific classification targets
  lifeStage: z.string().nullable().default(null),
  breedSize: z.string().nullable().default(null),
  productForm: z.string().nullable().default(null),
  healthConcernFunction: z.array(z.string()).default(() => []),

  // Label / dietary / ingredient data
  dietaryLabels: z.array(z.string()).default(() => []),
  ingredients: z.array(z.string()).default(() => []),
  ingredientKeywords: z.array(z.string()).default(() => []),
  claims: z.array(z.string()).default(() => []),

  // Raw visible text from the package (for search / fallback)
  visibleTextLines: z.array(z.string()).default(() => []),

  // Per-field confidence (0-1)
  confidenceByField: z.record(z.string(), z.number().min(0).max(1)).default(() => ({})),

  // Processing metadata
  metadata: z.object({
    imageSourceUrl: z.string().nullable().default(null),
    imageLocalPath: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    extractedAt: z.string().nullable().default(null),
    parser: z.string().nullable().default(null),
    rawResponseExcerpt: z.string().nullable().default(null),
  }).nullable().default(null),
});

export type PackagingOcrData = z.infer<typeof PackagingOcrDataSchema>;

// ─── Extraction Data (structured product output) ────────────────────────────────

export const ExtractionDataSchema = z.object({
  title: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  bulletPoints: z.array(z.string()).default(() => []),
  primaryImage: z.string().nullable().default(null),
  additionalImages: z.array(z.string()).default(() => []),
  price: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  dimensions: z.string().nullable().default(null),
  seoFileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  fieldProvenance: z.record(z.string(), z.string()).default(() => ({})),
  // Tracks where each field came from: 'json-ld', 'meta', 'html', 'ai', 'user'
  packagingTitle: z.string().nullable().default(null),
  /** Structured OCR output from the primary product image. Populated once before classification. */
  packagingOcrData: PackagingOcrDataSchema.nullable().default(null),
  customFields: z.record(z.string(), z.string()).default(() => ({})),
});

export type ExtractionData = z.infer<typeof ExtractionDataSchema>;

// ─── Curation Data (Refined taxonomy and packaging mapping) ─────────────────────

export const CurationDataSchema = z.object({
  curatedTitle: z.string().nullable().default(null),
  /** Search keywords synthesized by the curator from curated title, brand, attributes, and page names. */
  searchKeywords: z.string().nullable().default(null),
  packagingOcrTitle: z.string().nullable().default(null),
  curatedWeight: z.preprocess(val => {
    if (typeof val === 'string') {
      return convertToLbs(val);
    }
    return val;
  }, z.string().nullable().default(null)),
  titleSource: z.enum(['web', 'ocr', 'llm', 'manual', 'llm_cohort', 'cohort_fallback']).default('web'),
  suggestedPages: z.array(z.string()).default(() => []),
  suggestedProductType: z.string().nullable().default(null),
  curatedAt: z.string().nullable().default(null),
  curationMethod: z.enum(['auto', 'manual']).default('auto'),

  // Phase 1 classification containers
  classificationRunId: z.string().nullable().default(null),
  classificationConfigSnapshot: ClassificationConfigSnapshotRefSchema.nullable().default(null),
  classificationEvidence: z.array(ClassificationEvidenceSchema).default(() => []),
  classificationProposals: z.array(ClassificationProposalSchema).default(() => []),
  classificationDecisions: z.array(ClassificationProposalDecisionSchema).default(() => []),
  classificationHistory: z.array(ClassificationHistoryEventSchema).default(() => []),
});

export type CurationData = z.infer<typeof CurationDataSchema>;

// ─── Batch Statuses ─────────────────────────────────────────────────────────────

// Batches no longer control the pipeline lifecycle. Status is minimal:
// - 'active': default, items are being processed
// - 'archived': batch is done / hidden from active view
export const BatchStatusEnum = z.enum(['active', 'archived']);

export type BatchStatus = z.infer<typeof BatchStatusEnum>;

// ─── Pipeline Stages ────────────────────────────────────────────────────────────

export const PipelineStageEnum = z.enum([
  'discovery',
  'extraction',
  'curation',
  'review',
  'promotion',
]);

export type PipelineStage = z.infer<typeof PipelineStageEnum>;

// ─── Stage Statuses ─────────────────────────────────────────────────────────────

export const StageStatusEnum = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

export type StageStatus = z.infer<typeof StageStatusEnum>;

// ─── Item Statuses (DEPRECATED — use stage + stageStatus) ───────────────────────

export const ItemStatusEnum = z.enum([
  'imported',
  'discovering',
  'source_found',
  'source_confirmed',
  'extracting',
  'extracted',
  'curating',
  'curated',
  'needs_review',
  'ready',
  'promoted',
  'failed',
  'skipped',
]);

export type ItemStatus = z.infer<typeof ItemStatusEnum>;

// ─── API Key ────────────────────────────────────────────────────────────────────

export const ApiKeyServiceEnum = z.enum([
  'serper',
  'openai',
  'deepseek',
  'ollama',
  'ollama_vlm',
  'firecrawl',
]);

export type ApiKeyService = z.infer<typeof ApiKeyServiceEnum>;

export const ApiKeyConfigSchema = z.object({
  service: ApiKeyServiceEnum,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().nullable().default(null),
  model: z.string().nullable().default(null),
});

export type ApiKeyConfig = z.infer<typeof ApiKeyConfigSchema>;

export const VariantSelectionStrategySchema = z.object({
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
  optionSelector: z.string().nullable().default(null),
  optionTextAttribute: z.string().nullable().default(null),
}).nullable().default(null);

export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;

/**
 * Runtime representation of variant selection strategy (DB-serialized).
 * This matches VariantSelectionStrategySchema but allows loose JSON
 * for repo-level compatibility.
 */
export type VariantSelectionStrategyRecord = Record<string, unknown> | null;

export const ExtractorProfileSchema = z.object({
  id: z.string(),
  domain: z.string(),
  titleSelector: z.string().nullable().default(null),
  titleOptionalSelectors: z.array(z.string()).default(() => []),
  priceSelector: z.string().nullable().default(null),
  descriptionSelector: z.string().nullable().default(null),
  brandSelector: z.string().nullable().default(null),
  imagesSelector: z.string().nullable().default(null),
  customSelectors: z.record(z.string(), z.string()).default(() => ({})),
  sitemapProductUrlPattern: z.string().nullable().default(null),
  shopifyJSONPath: z.boolean().default(false),
  variantSelectionStrategy: z.record(z.string(), z.unknown()).nullable().default(null),
  customSelectorMetadata: z.record(z.string(), z.unknown()).default(() => ({})),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExtractorProfile = z.infer<typeof ExtractorProfileSchema>;

// ─── Onboarding Batch ───────────────────────────────────────────────────────────

export const OnboardingBatchSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  fileName: z.string(),
  /** Minimal batch lifecycle: 'active' (default), 'archived' (hidden from board). */
  status: BatchStatusEnum,
  totalItems: z.number().int(),
  completedItems: z.number().int(),
  failedItems: z.number().int(),
  columnMapping: ColumnMappingSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OnboardingBatch = z.infer<typeof OnboardingBatchSchema>;

// ─── Onboarding Item ────────────────────────────────────────────────────────────

export const OnboardingItemSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  upc: z.string(),
  name: z.string(),
  price: z.string().nullable(),
  quantity: z.number().int().nullable(),
  brandHint: z.string().nullable(),
  departmentHint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  expectedName: z.string().nullable().optional(),
  /** Pre-computed coordinated title from cohort LLM call. */
  coordinatedTitle: z.string().nullable().optional(),
  /** Current pipeline stage for this item. */
  stage: PipelineStageEnum,
  /** Status within the current stage. */
  stageStatus: StageStatusEnum,
  /** DEPRECATED: flat status, kept for backward compat. Use stage + stageStatus instead. */
  status: ItemStatusEnum,
  errorMessage: z.string().nullable(),
  retryCount: z.number().int(),
  isDuplicate: z.boolean(),
  existingSku: z.string().nullable(),
  extractionData: ExtractionDataSchema.nullable().default(null),
  curationData: CurationDataSchema.nullable().default(null),
  rowNumber: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OnboardingItem = z.infer<typeof OnboardingItemSchema>;

// ─── Onboarding Source ──────────────────────────────────────────────────────────

export const OnboardingSourceSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  snippet: z.string().nullable(),
  domain: z.string().nullable(),
  confidence: z.number(),
  isSelected: z.boolean(),
  sourceMethod: z.string(),
  metadataJson: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type OnboardingSource = z.infer<typeof OnboardingSourceSchema>;

// ─── Profile Governance (Phase 3) ───────────────────────────────────────────────

/** LLM tasks that can be routed through `llm_task_configs`. */
export const LlmTaskEnum = z.enum([
  'product_name_consolidation',
  'brand_inference',
  'profile_generation',
  'profile_revision',
  'product_curation',
  'category_classification',
  'classification_evidence_extraction',
  'product_type_classification',
  'category_page_assignment',
  'attribute_value_classification',
  'catalog_health_triage',
  'product_field_refactor',
  'store_manager_assistant',
]);
export type LlmTask = z.infer<typeof LlmTaskEnum>;

/** LLM providers accepted by `llm_task_configs`. */
export const LlmProviderEnum = z.enum(['deepseek', 'openai', 'ollama']);
export type LlmProvider = z.infer<typeof LlmProviderEnum>;

export const LlmTaskConfigSchema = z.object({
  id: z.string(),
  task: LlmTaskEnum,
  provider: LlmProviderEnum,
  model: z.string().min(1),
  baseUrlOverride: z.string().url().nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmTaskConfig = z.infer<typeof LlmTaskConfigSchema>;

export const LlmTaskConfigUpsertSchema = z.object({
  provider: LlmProviderEnum,
  model: z.string().min(1),
  baseUrlOverride: z.string().url().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
});

/**
 * The full set of standard selector fields.
 *
 * For runtime validation of arbitrary/custom field names, use
 * `SelectorFieldOrString` or `z.string()` directly.
 */
export const SelectorFieldEnum = z.enum([
  'titleSelector',
  'priceSelector',
  'descriptionSelector',
  'brandSelector',
  'imagesSelector',
]);
export type SelectorField = z.infer<typeof SelectorFieldEnum>;

/**
 * A selector field that is either a known standard field or an
 * arbitrary string (for custom/dynamic fields).
 */
export const SelectorFieldOrString = z.union([SelectorFieldEnum, z.string()]);
export type SelectorFieldOrString = z.infer<typeof SelectorFieldOrString>;

/**
 * Active selector fields managed in review and approval.
 *
 * This list is kept as the core subset for backward compatibility.
 * The canonical full list lives in `src/shared/profile-fields.ts`
 * as `PROMOTABLE_PROFILE_KEYS`.
 */
export const SELECTOR_FIELDS: readonly string[] = [
  'titleSelector',
  'descriptionSelector',
  'imagesSelector',
  'priceSelector',
  'brandSelector',
];

/** Profile generation audit status values. */
export const ProfileGenerationStatusEnum = z.enum([
  'proposed',
  'validated',
  'rejected',
  'promoted',
  'failed',
]);
export type ProfileGenerationStatus = z.infer<typeof ProfileGenerationStatusEnum>;

/** Profile generation revision status values. */
export const ProfileGenerationRevisionStatusEnum = z.enum([
  'draft',
  'validated',
  'rejected',
  'superseded',
]);
export type ProfileGenerationRevisionStatus = z.infer<typeof ProfileGenerationRevisionStatusEnum>;

/** Profile generation revision source values. */
export const ProfileGenerationRevisionSourceEnum = z.enum([
  'initial_generation',
  'manager_feedback',
  'manual_css',
  'system_validation',
]);
export type ProfileGenerationRevisionSource = z.infer<typeof ProfileGenerationRevisionSourceEnum>;

/** Per-field decision values. */
export const ProfileFieldDecisionTypeEnum = z.enum([
  'approved',
  'rejected',
  'rolled_back',
]);
export type ProfileFieldDecisionType = z.infer<typeof ProfileFieldDecisionTypeEnum>;

/** Per-field/per-sample validation result status. */
export const ProfileGenerationValidationStatusEnum = z.enum(['pass', 'warning', 'fail']);
export type ProfileGenerationValidationStatus = z.infer<typeof ProfileGenerationValidationStatusEnum>;

export const ProfileGenerationGenerationSchema = z.object({
  id: z.string(),
  domain: z.string(),
  sourceUrl: z.string(),
  expectedName: z.string().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  selectors: z.record(z.string(), z.unknown()).default(() => ({})),
  fieldSamples: z.record(z.string(), z.unknown()).nullable().default(null),
  validation: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ProfileGenerationStatusEnum,
  confidence: z.number(),
  llmProvider: z.string().nullable().default(null),
  llmModel: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  promotedAt: z.string().nullable().default(null),
});
export type ProfileGenerationGeneration = z.infer<typeof ProfileGenerationGenerationSchema>;

export const ProfileGenerationRevisionSchema = z.object({
  id: z.string(),
  generationId: z.string(),
  revisionNumber: z.number().int(),
  parentRevisionId: z.string().nullable().default(null),
  source: ProfileGenerationRevisionSourceEnum,
  feedback: z.record(z.string(), z.unknown()).nullable().default(null),
  selectors: z.record(z.string(), z.unknown()).default(() => ({})),
  fieldSamples: z.record(z.string(), z.unknown()).nullable().default(null),
  validationSummary: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ProfileGenerationRevisionStatusEnum,
  confidence: z.number(),
  llmTask: z.string().nullable().default(null),
  llmProvider: z.string().nullable().default(null),
  llmModel: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProfileGenerationRevision = z.infer<typeof ProfileGenerationRevisionSchema>;

export const ProfileGenerationValidationResultSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  selectorField: SelectorFieldOrString,
  sampleUrl: z.string(),
  itemId: z.string().nullable().default(null),
  expectedName: z.string().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  extractedValue: z.record(z.string(), z.unknown()).nullable().default(null),
  imagePreviews: z.array(z.string()).nullable().default(null),
  warnings: z.array(z.string()).nullable().default(null),
  status: ProfileGenerationValidationStatusEnum,
  createdAt: z.string(),
});
export type ProfileGenerationValidationResult = z.infer<typeof ProfileGenerationValidationResultSchema>;

export const ProfileGenerationFieldDecisionSchema = z.object({
  id: z.string(),
  generationId: z.string(),
  revisionId: z.string().nullable().default(null),
  domain: z.string(),
  selectorField: SelectorFieldOrString,
  decision: ProfileFieldDecisionTypeEnum,
  previousSelector: z.string().nullable().default(null),
  proposedSelector: z.string().nullable().default(null),
  approvedSelector: z.string().nullable().default(null),
  feedback: z.record(z.string(), z.unknown()).nullable().default(null),
  validationResultIds: z.array(z.string()).nullable().default(null),
  decidedAt: z.string(),
  decidedBy: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type ProfileGenerationFieldDecision = z.infer<typeof ProfileGenerationFieldDecisionSchema>;

/** Structured feedback supplied by the store manager when a revision
 *  is not correct. Designed to be UI-friendly: the operator should not
 *  have to write CSS. The AI revises the revision from this
 *  feedback. */
export const StructuredFeedbackTextSchema = z.object({
  kind: z.literal('text'),
  field: SelectorFieldOrString,
  /** Whether the operator thinks the currently-extracted value is correct. */
  currentValueCorrect: z.boolean().optional(),
  /** The expected/correct value, when not correct. */
  expectedValue: z.string().optional(),
  notes: z.string().optional(),
});

export const StructuredFeedbackImageSchema = z.object({
  kind: z.literal('images'),
  /** Per-URL verdict. URLs not in the map are ignored. */
  perImage: z.record(z.string(), z.enum(['correct', 'exclude', 'include'])).default(() => ({})),
  /** Hint that images look like recommendation/carousel content. */
  looksLikeRecommendations: z.boolean().optional(),
  /** Free-form note (advanced). */
  notes: z.string().optional(),
});

export const StructuredFeedbackPriceSchema = z.object({
  kind: z.literal('price'),
  /** Whether to ignore the price field for this domain. */
  ignoreForDomain: z.boolean().optional(),
  /** Expected price string. */
  expectedValue: z.string().optional(),
  notes: z.string().optional(),
});

export const StructuredFeedbackSchema = z.union([
  StructuredFeedbackTextSchema,
  StructuredFeedbackImageSchema,
  StructuredFeedbackPriceSchema,
]);
export type StructuredFeedback = z.infer<typeof StructuredFeedbackSchema>;

/** Per-field approval payload sent by the operator. Only `true`
 *  fields are written to `extractor_profiles`.
 *
 * Accepts both standard fields (SelectorFieldEnum) and arbitrary
 * custom field names (strings). At least one field must be `true`. */
export const ApprovedSelectorFieldsSchema = z
  .record(z.union([SelectorFieldEnum, z.string()]), z.boolean())
  .refine(
    (v) => Object.values(v).some((x) => x === true),
    { message: 'At least one selector field must be set to true' },
  );

/** Approval request body for a single revision. */
export const ApproveRevisionFieldsRequestSchema = z.object({
  approvedFields: ApprovedSelectorFieldsSchema,
  feedback: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
  /** Required when approving `imagesSelector` — operator must
   *  attest they reviewed the image previews. */
  imagePreviewsReviewed: z.boolean().optional(),
});

/** Rejection request body for a single revision. */
export const RejectRevisionFieldsRequestSchema = z.object({
  rejectedFields: z.array(z.union([SelectorFieldEnum, z.string()])).min(1),
  reason: z.string().nullable().optional(),
  feedback: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});

/** Rollback request body. */
export const RollbackFieldRequestSchema = z.object({
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});

/** Request body for creating a new revision from structured feedback. */
export const ReviseFromFeedbackRequestSchema = z.object({
  parentRevisionId: z.string().nullable().optional(),
  feedback: StructuredFeedbackSchema,
  notes: z.string().nullable().optional(),
});

/** Request body for re-validating a revision across confirmed samples. */
export const ValidateRevisionRequestSchema = z.object({
  sampleLimit: z.number().int().min(1).max(50).optional(),
  notes: z.string().nullable().optional(),
});

/** Domain profile governance summary. */
export const ValidationSampleRefSchema = z.object({
  url: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  itemId: z.string(),
  confirmed: z.boolean(),
});
export type ValidationSampleRef = z.infer<typeof ValidationSampleRefSchema>;

export const DomainProfileGovernanceSchema = z.object({
  domain: z.string(),
  activeProfile: ExtractorProfileSchema.nullable().default(null),
  generations: z.array(ProfileGenerationGenerationSchema).default(() => []),
  revisions: z.array(ProfileGenerationRevisionSchema).default(() => []),
  fieldDecisions: z.array(ProfileGenerationFieldDecisionSchema).default(() => []),
  validationSampleCount: z.number().int().default(0),
  validationSamples: z.array(ValidationSampleRefSchema).default(() => []),
});
export type DomainProfileGovernance = z.infer<typeof DomainProfileGovernanceSchema>;

// ─── Brand Site ─────────────────────────────────────────────────────────────────

export const BrandSiteSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  domain: z.string(),
  urlPattern: z.string().nullable(),
  successCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type BrandSite = z.infer<typeof BrandSiteSchema>;

// ─── Domain Diagnostics ────────────────────────────────────────────────────────

/**
 * Health values stored in `domain_status`. The diagnostics surface also
 * uses an additional `'unknown'` literal for domains that have no row
 * at all (no health probe has ever been recorded for that domain).
 */
export const DomainHealthStatusEnum = z.enum([
  'ok',
  'blocked',
  'offline',
  'mismatch',
  'unknown',
]);
export type DomainHealthStatus = z.infer<typeof DomainHealthStatusEnum>;

export const DomainDiagnosticsBrandAssociationSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  successCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
});
export type DomainDiagnosticsBrandAssociation = z.infer<
  typeof DomainDiagnosticsBrandAssociationSchema
>;

export const DomainDiagnosticsEntrySchema = z.object({
  domain: z.string(),
  hasActiveProfile: z.boolean(),
  activeProfileId: z.string().nullable(),
  profileUpdatedAt: z.string().nullable(),
  sitemapUrlsCount: z.number().int(),
  sitemapFetchedAt: z.string().nullable(),
  sitemapExpiresAt: z.string().nullable(),
  sitemapSourceUrl: z.string().nullable(),
  sitemapStale: z.boolean(),
  healthStatus: DomainHealthStatusEnum,
  healthCheckedAt: z.string().nullable(),
  healthReason: z.string().nullable(),
  healthStale: z.boolean(),
  brandAssociations: z.array(DomainDiagnosticsBrandAssociationSchema),
  generationCount: z.number().int(),
  latestGenerationStatus: ProfileGenerationStatusEnum.nullable(),
  latestGenerationAt: z.string().nullable(),
});
export type DomainDiagnosticsEntry = z.infer<typeof DomainDiagnosticsEntrySchema>;

export const DomainDiagnosticsResponseSchema = z.object({
  entries: z.array(DomainDiagnosticsEntrySchema),
  generatedAt: z.string(),
});
export type DomainDiagnosticsResponse = z.infer<typeof DomainDiagnosticsResponseSchema>;

export const ProfileBlockedItemSchema = z.object({
  itemId: z.string(),
  upc: z.string(),
  name: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  blockedAt: z.string(),
});
export type ProfileBlockedItem = z.infer<typeof ProfileBlockedItemSchema>;
