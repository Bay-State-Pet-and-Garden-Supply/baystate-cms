import { z } from 'zod';
import { ExtractionDataSchema } from './onboarding';

// ─── Capabilities ──────────────────────────────────────────────────────────────

export const WorkerCapabilitiesSchema = z.object({
  playwright: z.boolean().default(true),
  crawlee: z.boolean().default(false),
  stagehand: z.boolean().default(false),
});

export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;

// ─── Health ────────────────────────────────────────────────────────────────────

export const WorkerHealthResponseSchema = z.object({
  ok: z.boolean(),
  capabilities: WorkerCapabilitiesSchema,
  version: z.string().default('0.1.0'),
});

export type WorkerHealthResponse = z.infer<typeof WorkerHealthResponseSchema>;

// ─── Artifact Reference ────────────────────────────────────────────────────────

export const ArtifactRefSchema = z.object({
  type: z.enum(['html', 'html_min', 'screenshot', 'network', 'image_candidates', 'validation_results']),
  path: z.string(),
  sizeBytes: z.number().int().optional(),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ─── Snapshot ──────────────────────────────────────────────────────────────────

export const SnapshotRequestSchema = z.object({
  url: z.string().url(),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
  captureScreenshot: z.boolean().default(true),
  captureNetwork: z.boolean().default(true),
});

export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;

export const SnapshotResponseSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  htmlRef: z.string().nullable().default(null),
  screenshotRef: z.string().nullable().default(null),
  networkRef: z.string().nullable().default(null),
  jsonLd: z.array(z.record(z.string(), z.unknown())).default(() => []),
  embeddedProductData: z.array(z.record(z.string(), z.unknown())).default(() => []),
  imageCandidates: z.array(z.string()).default(() => []),
  pageStructureSignals: z.array(z.string()).default(() => []),
  warnings: z.array(z.string()).default(() => []),
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

// ─── Generate Selector (Paste-Element) ───────────────────────────────────────

export const GenerateSelectorRequestSchema = z.object({
  /** Full page HTML (used to check selector uniqueness across the page). */
  html: z.string().min(1),
  /** The outerHTML of the element the user selected/copied from DevTools. */
  outerHTML: z.string().min(1),
});
export type GenerateSelectorRequest = z.infer<typeof GenerateSelectorRequestSchema>;

export const GenerateSelectorResponseSchema = z.object({
  selector: z.string(),
  stability: z.enum(['high', 'medium', 'low']),
  extractedText: z.string().nullable().default(null),
  extractedImages: z.array(z.string()).default(() => []),
  matchCount: z.number().int(),
  warnings: z.array(z.string()).default(() => []),
});
export type GenerateSelectorResponse = z.infer<typeof GenerateSelectorResponseSchema>;

// ─── Pick Element (Visual Picker) ────────────────────────────────────────────

export const PickElementRequestSchema = z.object({
  /** The URL of the product page to open in the headful browser. */
  url: z.string().url(),
  /** Which field the user is selecting: title, description, or images. */
  field: z.enum(['title', 'description', 'images']),
  /** Whether to allow selecting a parent container (for image galleries). */
  allowParentContainer: z.boolean().default(true),
});
export type PickElementRequest = z.infer<typeof PickElementRequestSchema>;

export const PickElementResponseSchema = z.object({
  /** The generated CSS selector. */
  selector: z.string(),
  /** Stability of the generated selector. */
  stability: z.enum(['high', 'medium', 'low']),
  /** Text content extracted by the selector (for title/description). */
  extractedText: z.string().nullable().default(null),
  /** Image URLs extracted by the selector (for images). */
  extractedImages: z.array(z.string()).default(() => []),
  /** How many elements the selector matches (uniqueness check). */
  matchCount: z.number().int(),
  /** The outerHTML of the element the user clicked (for confirmation). */
  outerHTML: z.string().nullable().default(null),
  /** Reference path to a confirmation screenshot. */
  screenshotRef: z.string().nullable().default(null),
  /** Warnings (e.g., element not unique, headful browser unavailable). */
  warnings: z.array(z.string()).default(() => []),
});
export type PickElementResponse = z.infer<typeof PickElementResponseSchema>;

// ─── Profile Proposal ──────────────────────────────────────────────────────────

export const SpreadsheetHintSchema = z.record(z.string(), z.string());

export type SpreadsheetHint = z.infer<typeof SpreadsheetHintSchema>;

export const VariantSelectionStrategySchema = z.object({
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
});
export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;

export const ProposalSeedSampleSchema = z.object({
  url: z.string().url(),
  expectedName: z.string().optional(),
  upc: z.string().optional(),
  spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
});

export type ProposalSeedSample = z.infer<typeof ProposalSeedSampleSchema>;

export const ProfileProposalRequestSchema = z.object({
  domain: z.string().min(1),
  seedSamples: z.array(ProposalSeedSampleSchema).min(1),
  allowLlm: z.boolean().default(false),
});

export type ProfileProposalRequest = z.infer<typeof ProfileProposalRequestSchema>;

export const ProfileProposalDraftSchema = z.object({
  domain: z.string(),
  urlPatterns: z.array(z.string()).default(() => []),
  pageStructureSignals: z.array(z.string()).default(() => []),
  runtime: z.enum(['static', 'rendered']).default('static'),
  selectors: z.record(z.string(), z.string().nullable()).default(() => ({})),
  imageRules: z.record(z.string(), z.unknown()).default(() => ({})),
  variantSelectionStrategy: VariantSelectionStrategySchema.nullable().default(null),
  warnings: z.array(z.string()).default(() => []),
});

export type ProfileProposalDraft = z.infer<typeof ProfileProposalDraftSchema>;

export const ProfileProposalResponseSchema = z.object({
  proposal: ProfileProposalDraftSchema,
  sampleArtifacts: z.array(z.string()).default(() => []),
});

export type ProfileProposalResponse = z.infer<typeof ProfileProposalResponseSchema>;

// ─── Validation ────────────────────────────────────────────────────────────────

export const ValidationSampleSchema = z.object({
  url: z.string().url(),
  confirmed: z.boolean().default(false),
  expectedName: z.string().optional(),
  upc: z.string().optional(),
  spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
});

export type ValidationSample = z.infer<typeof ValidationSampleSchema>;

export const ValidateRequestSchema = z.object({
  profileDraft: ProfileProposalDraftSchema,
  samples: z.array(ValidationSampleSchema).min(1),
});

export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ValidationSampleResultSchema = z.object({
  sampleUrl: z.string(),
  confirmed: z.boolean(),
  fieldResults: z.record(z.string(), z.object({
    status: z.enum(['pass', 'warning', 'fail']),
    extractedValue: z.string().nullable().default(null),
    warnings: z.array(z.string()).default(() => []),
  })),
  imageResults: z.object({
    primaryImageMatch: z.boolean(),
    candidateCount: z.number().int(),
    warnings: z.array(z.string()).default(() => []),
  }),
  variantResult: z.object({
    selected: z.boolean(),
    variantTitle: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    containerSelector: z.string().nullable().default(null),
    optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).nullable().default(null),
    detectedOptions: z.array(z.string()).default(() => []),
    optionFields: z.array(z.string()).default(() => []),
    strategyValid: z.boolean().default(false),
  }).nullable().default(null),
});

export type ValidationSampleResult = z.infer<typeof ValidationSampleResultSchema>;

export const ValidateResponseSchema = z.object({
  summary: z.object({
    sampleCount: z.number().int(),
    confirmedSampleCount: z.number().int(),
    passingSamples: z.number().int(),
    failingSamples: z.number().int(),
    variantSamplesPassing: z.number().int().default(0),
  }),
  results: z.array(ValidationSampleResultSchema).default(() => []),
});

export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

// ─── Trusted Profile Runner Extract ────────────────────────────────────────────

export const ExtractRequestSchema = z.object({
  profileId: z.string(),
  profileVersion: z.number().int(),
  sourceUrl: z.string().url(),
  expected: z.object({
    name: z.string(),
    brandHint: z.string().nullable().default(null),
    upc: z.string().optional(),
    spreadsheetHints: SpreadsheetHintSchema.default(() => ({})),
    price: z.string().nullable().default(null),
  }),
  profile: z.object({
    runtime: z.enum(['static', 'rendered']).default('rendered'),
    selectors: z.record(z.string(), z.string().nullable()).default(() => ({})),
    imageRules: z.record(z.string(), z.unknown()).default(() => ({})),
    variantSelectionStrategy: VariantSelectionStrategySchema.nullable().default(null),
  }),
});

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const ExtractResponseSchema = z.object({
  ok: z.boolean(),
  extractionData: ExtractionDataSchema.optional(),
  fieldProvenance: z.record(z.string(), z.string()).default(() => ({})),
  profileRuntime: z.enum(['static', 'rendered']),
  profileId: z.string(),
  profileVersion: z.number().int(),
  warnings: z.array(z.string()).default(() => []),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ─── Job Queue Payloads ────────────────────────────────────────────────────────

export const WorkerJobTypeEnum = z.enum([
  'profile_tooling_propose',
  'profile_tooling_validate',
]);

export type WorkerJobType = z.infer<typeof WorkerJobTypeEnum>;

export const WorkerJobStatusEnum = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
]);

export type WorkerJobStatus = z.infer<typeof WorkerJobStatusEnum>;

export const WorkerJobPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('profile_tooling_propose'),
    payload: ProfileProposalRequestSchema,
  }),
  z.object({
    type: z.literal('profile_tooling_validate'),
    payload: ValidateRequestSchema,
  }),
]);

export type WorkerJobPayload = z.infer<typeof WorkerJobPayloadSchema>;

export const WorkerJobResultSchema = z.object({
  jobId: z.string(),
  status: WorkerJobStatusEnum,
  progress: z.number().min(0).max(1).default(0),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  artifactRefs: z.array(z.string()).default(() => []),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export type WorkerJobResult = z.infer<typeof WorkerJobResultSchema>;
