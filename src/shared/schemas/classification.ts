import { z } from 'zod';

// ─── Helper Schemas ────────────────────────────────────────────────────────────

/**
 * Stable human-readable slug used for classification configuration IDs.
 * Must start with a lowercase letter and contain only lowercase letters,
 * numbers, hyphens, and underscores.
 */
export const ClassificationSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Slug must start with a letter and contain only a-z, 0-9, hyphens, and underscores');

export type ClassificationSlug = z.infer<typeof ClassificationSlugSchema>;

/**
 * ISO 8601 datetime string.  Stored as TEXT in SQLite.
 */
export const IsoDateTimeStringSchema = z.string();

export type IsoDateTimeString = z.infer<typeof IsoDateTimeStringSchema>;

// ─── Configuration Payload Schemas ─────────────────────────────────────────────

/**
 * Schema for manifest.json in store/classification/.
 */
export const ClassificationManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  compatibilityVersion: z.number().int().positive(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
  fileVersions: z.record(z.string(), z.string()).optional().default({}),
});

export type ClassificationManifest = z.infer<typeof ClassificationManifestSchema>;

/**
 * One product-type entry in product-types.json.
 */
export const ProductTypeConfigSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  attributeProfileId: ClassificationSlugSchema.nullable().default(null),
  oldIdAliases: z.array(z.string()).default(() => []),
});

export type ProductTypeConfig = z.infer<typeof ProductTypeConfigSchema>;

// ─── Attribute value mode ───────────────────────────────────────────────────────

export const ValueModeEnum = z.enum(['controlled', 'freeText', 'measured']);
export type ValueMode = z.infer<typeof ValueModeEnum>;

export const VisualEvidenceEligibilityEnum = z.enum(['eligible', 'ineligible']);
export type VisualEvidenceEligibility = z.infer<typeof VisualEvidenceEligibilityEnum>;

/**
 * One attribute entry in attributes.json.
 */
export const ProductAttributeConfigSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  valueMode: ValueModeEnum,
  canonicalUnit: z.string().nullable().default(null),
  allowedValues: z.array(z.string()).default(() => []),
  valueAliases: z
    .array(
      z.object({
        alias: z.string(),
        mapsTo: z.string(),
      }),
    )
    .default(() => []),
  visualEvidenceEligibility: VisualEvidenceEligibilityEnum.default('eligible'),
  isClaim: z.boolean().default(false),
  isCompositionAttribute: z.boolean().default(false),
  group: z.string().nullable().default(null),
});

export type ProductAttributeConfig = z.infer<typeof ProductAttributeConfigSchema>;

// ─── Attribute cardinality ─────────────────────────────────────────────────────

export const CardinalityEnum = z.enum(['single', 'multiple']);
export type Cardinality = z.infer<typeof CardinalityEnum>;

/**
 * One attribute entry within an attribute profile.
 */
export const AttributeProfileAttributeSchema = z.object({
  attributeId: ClassificationSlugSchema,
  required: z.boolean().default(false),
  cardinality: CardinalityEnum.default('single'),
  applicabilityConditions: z.array(z.unknown()).default(() => []),
  constraints: z.record(z.string(), z.unknown()).default(() => ({})),
  confidenceThresholds: z.record(z.string(), z.number().min(0).max(1)).default(() => ({})),
  valueAliases: z
    .array(
      z.object({
        alias: z.string(),
        mapsTo: z.string(),
      }),
    )
    .default(() => []),
});

export type AttributeProfileAttribute = z.infer<typeof AttributeProfileAttributeSchema>;

/**
 * One profile entry in attribute-profiles.json.
 */
export const AttributeProfileConfigSchema = z.object({
  id: ClassificationSlugSchema,
  productTypeId: ClassificationSlugSchema,
  name: z.string().min(1),
  attributes: z.array(AttributeProfileAttributeSchema).default(() => []),
});

export type AttributeProfileConfig = z.infer<typeof AttributeProfileConfigSchema>;

/**
 * Serialization configuration for how attribute values are formatted
 * into a catalog field string.
 */
export const SerializationConfigSchema = z.object({
  format: z.string(),
  separator: z.string().optional().default(', '),
  prefix: z.string().optional().default(''),
  suffix: z.string().optional().default(''),
});

export type SerializationConfig = z.infer<typeof SerializationConfigSchema>;

/**
 * One mapping entry in mappings.json.
 */
export const AttributeMappingConfigSchema = z.object({
  id: ClassificationSlugSchema,
  attributeId: ClassificationSlugSchema,
  catalogField: z.string().min(1),
  serialization: SerializationConfigSchema.default(() => ({ format: 'direct', separator: ', ', prefix: '', suffix: '' })),
  isStale: z.boolean().default(false),
});

export type AttributeMappingConfig = z.infer<typeof AttributeMappingConfigSchema>;

// ─── Guidance scope ────────────────────────────────────────────────────────────

export const GuidanceScopeEnum = z.enum([
  'workspace',
  'productType',
  'attribute',
  'categoryPage',
  'attributeMapping',
]);

export type GuidanceScope = z.infer<typeof GuidanceScopeEnum>;

/**
 * One guidance entry in guidance.json.
 */
export const GuidanceConfigSchema = z.object({
  id: ClassificationSlugSchema,
  scope: GuidanceScopeEnum,
  scopeId: z.string().nullable().default(null),
  structured: z.record(z.string(), z.unknown()).default(() => ({})),
  freeForm: z.string().nullable().default(null),
  manualReviewRequirement: z.boolean().default(false),
});

export type GuidanceConfig = z.infer<typeof GuidanceConfigSchema>;

/**
 * Model policy configuration for model-policies.json.
 * Defines default provider/model and stage-specific overrides.
 * Image data sharing defaults to local-only.
 */
export const ModelPolicyConfigSchema = z.object({
  defaultProvider: z.string().default('ollama'),
  defaultModel: z.string().default('qwen2.5vl:latest'),
  stageOverrides: z
    .record(
      z.string(),
      z.object({
        provider: z.string().optional(),
        model: z.string().optional(),
        fallbackProvider: z.string().nullable().default(null),
        fallbackModel: z.string().nullable().default(null),
      }),
    )
    .default(() => ({})),
  imageDataSharing: z.enum(['local_only', 'cloud_allowed']).default('local_only'),
  textDataSharing: z.enum(['local_only', 'cloud_allowed']).default('local_only'),
});

export type ModelPolicyConfig = z.infer<typeof ModelPolicyConfigSchema>;

/**
 * Data-sharing policy configuration for data-sharing.json.
 * Image policy defaults to local-only for privacy.
 */
export const DataSharingConfigSchema = z.object({
  imagePolicy: z.enum(['local_only', 'cloud_allowed']).default('local_only'),
  textPolicy: z.enum(['local_only', 'cloud_allowed']).default('local_only'),
  sensitiveDataFiltering: z.boolean().default(true),
  retentionDays: z.number().int().positive().default(90),
});

export type DataSharingConfig = z.infer<typeof DataSharingConfigSchema>;

/**
 * Aggregate classification configuration for snapshot validation.
 */
export const ClassificationConfigSchema = z.object({
  manifest: ClassificationManifestSchema,
  productTypes: z.array(ProductTypeConfigSchema).default(() => []),
  attributes: z.array(ProductAttributeConfigSchema).default(() => []),
  attributeProfiles: z.array(AttributeProfileConfigSchema).default(() => []),
  attributeMappings: z.array(AttributeMappingConfigSchema).default(() => []),
  guidance: z.array(GuidanceConfigSchema).default(() => []),
  modelPolicy: ModelPolicyConfigSchema.default(() => ({
    defaultProvider: 'ollama' as const,
    defaultModel: 'qwen2.5vl:latest' as const,
    stageOverrides: {} as Record<string, { fallbackProvider: string | null; fallbackModel: string | null; provider?: string; model?: string }>,
    imageDataSharing: 'local_only' as const,
    textDataSharing: 'local_only' as const,
  })),
  dataSharing: DataSharingConfigSchema.default(() => ({
    imagePolicy: 'local_only' as const,
    textPolicy: 'local_only' as const,
    sensitiveDataFiltering: true as const,
    retentionDays: 90 as const,
  })),
});

export type ClassificationConfig = z.infer<typeof ClassificationConfigSchema>;

// ─── Runtime / Review Enums ────────────────────────────────────────────────────

export const ClassificationStageNameEnum = z.enum([
  'evidence_extraction',
  'primary_product_type_proposal',
  'attribute_applicability',
  'product_attribute_proposals',
  'category_page_proposals',
  'product_draft_projection',
]);

export type ClassificationStageName = z.infer<typeof ClassificationStageNameEnum>;

export const ClassificationRunStatusEnum = z.enum([
  'queued',
  'running',
  'completed',
  'completed_with_abstentions',
  'failed',
  'cancelled',
]);

export type ClassificationRunStatus = z.infer<typeof ClassificationRunStatusEnum>;

export const ClassificationStageStatusEnum = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'abstained',
]);

export type ClassificationStageStatus = z.infer<typeof ClassificationStageStatusEnum>;

export const EvidenceSourceEnum = z.enum([
  'spreadsheet',
  'official_product_page',
  'third_party_page',
  'visual_product_evidence',
  'page_context',
  'approved_product_example',
  'catalog_manager_guidance',
]);

export type EvidenceSource = z.infer<typeof EvidenceSourceEnum>;

export const EvidenceReliabilityEnum = z.enum([
  'high',
  'medium',
  'low',
  'conflicting',
  'unknown',
]);

export type EvidenceReliability = z.infer<typeof EvidenceReliabilityEnum>;

export const ProposalTypeEnum = z.enum([
  'primary_product_type',
  'category_page',
  'field_assignment',
  'configuration_gap',
  'reviewable_abstention',
]);

export type ProposalType = z.infer<typeof ProposalTypeEnum>;

export const ProposalStatusEnum = z.enum(['pending', 'accepted', 'rejected', 'deferred', 'stale']);
export type ProposalStatus = z.infer<typeof ProposalStatusEnum>;

export const DecisionEnum = z.enum(['accepted', 'rejected', 'deferred']);
export type Decision = z.infer<typeof DecisionEnum>;

// ─── Runtime / Review Schemas ──────────────────────────────────────────────────

/**
 * Reference to a classification config snapshot.
 */
export const ClassificationConfigSnapshotRefSchema = z.object({
  id: z.string(),
  hash: z.string(),
  sourceCommit: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationConfigSnapshotRef = z.infer<typeof ClassificationConfigSnapshotRefSchema>;

/**
 * A piece of classification evidence: a product fact supporting a proposal.
 */
export const ClassificationEvidenceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stageName: ClassificationStageNameEnum,
  productSku: z.string().min(1),
  attributeId: z.string().nullable().default(null),
  source: EvidenceSourceEnum,
  reliability: EvidenceReliabilityEnum,
  sourceUrl: z.string().nullable().default(null),
  sourceField: z.string().nullable().default(null),
  snippet: z.string().nullable().default(null),
  value: z.unknown().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
  capturedAt: IsoDateTimeStringSchema,
});

export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>;

/**
 * A reviewable suggestion produced by a classification run.
 */
export const ClassificationProposalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  productSku: z.string().min(1),
  proposalType: ProposalTypeEnum,
  targetId: z.string().nullable().default(null),
  proposedValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).default(() => []),
  status: ProposalStatusEnum.default('pending'),
  isBulkAcceptable: z.boolean().default(false),
  isStale: z.boolean().default(false),
  stalenessReason: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationProposal = z.infer<typeof ClassificationProposalSchema>;

/**
 * A reviewer's decision on a classification proposal.
 */
export const ClassificationProposalDecisionSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  decision: DecisionEnum,
  revisedFromId: z.string().nullable().default(null),
  reviewerId: z.string().nullable().default(null),
  reviewerNote: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationProposalDecision = z.infer<typeof ClassificationProposalDecisionSchema>;

/**
 * An audit/history event for a classification run.
 */
export const ClassificationHistoryEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  proposalId: z.string().nullable().default(null),
  decisionId: z.string().nullable().default(null),
  eventType: z.string(),
  eventJson: z.record(z.string(), z.unknown()).default(() => ({})),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationHistoryEvent = z.infer<typeof ClassificationHistoryEventSchema>;
