// fallow-ignore-file unused-export

/**
 * Shared contracts for the one-shot LLM selector generation feature.
 *
 * This file defines the Zod schemas and inferred TypeScript types for
 * the `POST /api/onboarding/settings/profile-tooling/generate-selectors`
 * endpoint.
 *
 * No Bun-only imports — safe for both client (Vite/React) and
 * server (Bun) contexts.
 */

import { z } from 'zod';

// ─── Runtime ─────────────────────────────────────────────────────────────────

export const SelectorGenerationRuntimeSchema = z.enum(['static', 'rendered']);
export type SelectorGenerationRuntime = z.infer<typeof SelectorGenerationRuntimeSchema>;

// ─── Field Value Type ─────────────────────────────────────────────────────────

export const FieldValueTypeSchema = z.enum([
  'text',
  'html',
  'url',
  'image',
  'list',
]);
export type FieldValueType = z.infer<typeof FieldValueTypeSchema>;

// ─── Field Origin ─────────────────────────────────────────────────────────────

export const FieldOriginSchema = z.enum([
  'core',
  'standard_custom',
  'draft_custom',
]);
export type FieldOrigin = z.infer<typeof FieldOriginSchema>;

// ─── Requested Field ──────────────────────────────────────────────────────────

export const GenerateSelectorFieldSchema = z.object({
  /** Existing ProfileDraft selector key (e.g. titleSelector, weightSelector). */
  key: z.string().min(1).max(128),
  /** Human-readable label. */
  label: z.string().min(1).max(256),
  /** Where this field originated in the catalog or draft. */
  origin: FieldOriginSchema,
  /** Expected value type for the extracted content. */
  valueType: FieldValueTypeSchema,
  /** Whether this field can match multiple elements. */
  multiple: z.boolean().default(false),
  /** Optional field-description hint for the model. */
  description: z.string().max(1024).nullable().default(null),
});
export type GenerateSelectorField = z.infer<typeof GenerateSelectorFieldSchema>;

// ─── Snapshot Context (inline signals) ────────────────────────────────────────

export const ImageCandidateSchema = z.object({
  url: z.string(),
  sourceElement: z.string().nullable().default(null),
  dimensions: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .nullable()
    .default(null),
  role: z.enum(['primary', 'alternate', 'thumbnail', 'unknown']).default('unknown'),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

export const PageStructureSignalSchema = z.object({
  kind: z.string(),
  selector: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type PageStructureSignal = z.infer<typeof PageStructureSignalSchema>;

export const SnapshotContextSchema = z.object({
  jsonLd: z.array(z.record(z.string(), z.unknown())).default(() => []),
  embeddedProductData: z.array(z.record(z.string(), z.unknown())).default(() => []),
  imageCandidates: z.array(ImageCandidateSchema).default(() => []),
  pageStructureSignals: z.array(PageStructureSignalSchema).default(() => []),
  warnings: z.array(z.string()).default(() => []),
});
export type SnapshotContext = z.infer<typeof SnapshotContextSchema>;

// ─── Request ──────────────────────────────────────────────────────────────────

export const GenerateSelectorsRequestSchema = z.object({
  /** Snapshot HTML artifact reference (relative to project root). */
  htmlRef: z.string().min(1),
  /** Source URL for context (not used for filesystem resolution). */
  sourceUrl: z.string().url(),
  /** Extraction runtime used for the snapshot. */
  runtime: SelectorGenerationRuntimeSchema,
  /** Field catalog entries to generate selectors for. */
  fields: z
    .array(GenerateSelectorFieldSchema)
    .min(1, 'At least one field is required')
    .max(50, 'Maximum 50 fields'),
  /** Inline snapshot signals (small enough to send with the request). */
  snapshotContext: SnapshotContextSchema.optional(),
}).refine(
  (req) => {
    const keys = req.fields.map((f) => f.key);
    return new Set(keys).size === keys.length;
  },
  { message: 'Field keys must be unique' },
).refine(
  (req) => {
    const reserved = ['__proto__', 'constructor', 'prototype'];
    return req.fields.every((f) => !reserved.includes(f.key));
  },
  { message: 'Reserved field key detected' },
);
export type GenerateSelectorsRequest = z.infer<typeof GenerateSelectorsRequestSchema>;

// ─── Warning Codes ────────────────────────────────────────────────────────────

export const SelectorWarningCodeSchema = z.enum([
  'ZERO_MATCHES',
  'MULTIPLE_PRIMARY_MATCHES',
  'TOO_MANY_MATCHES',
  'TOO_GENERIC',
  'DYNAMIC_ID',
  'POSITIONAL_SELECTOR',
  'EXCESSIVE_SELECTOR_DEPTH',
  'HIDDEN_MATCH',
  'DUPLICATE_SELECTOR',
  'INVALID_CSS',
  'TRUNCATED_HTML',
  'SNAPSHOT_WARNING',
]);
export type SelectorWarningCode = z.infer<typeof SelectorWarningCodeSchema>;

export const SelectorWarningSeveritySchema = z.enum(['info', 'warning', 'error']);
export type SelectorWarningSeverity = z.infer<typeof SelectorWarningSeveritySchema>;

export const SelectorWarningSchema = z.object({
  code: SelectorWarningCodeSchema,
  severity: SelectorWarningSeveritySchema,
  message: z.string(),
  fieldKey: z.string().nullable().default(null),
});
export type SelectorWarning = z.infer<typeof SelectorWarningSchema>;

// ─── Field Suggestion Status ──────────────────────────────────────────────────

export const SuggestionStatusSchema = z.enum([
  'suggested',
  'not_found',
  'invalid',
]);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const SelectorQualitySchema = z.enum([
  'high',
  'medium',
  'low',
  'unusable',
]);
export type SelectorQuality = z.infer<typeof SelectorQualitySchema>;

// ─── Field Suggestion ─────────────────────────────────────────────────────────

export const SelectorValidationSchema = z.object({
  syntaxValid: z.boolean(),
  matchedCount: z.number().int().min(0),
  visibleMatchedCount: z.number().int().min(0).nullable().default(null),
  unique: z.boolean(),
});
export type SelectorValidation = z.infer<typeof SelectorValidationSchema>;

export const FieldPreviewSchema = z.object({
  text: z.string().max(500).nullable().default(null),
  values: z.array(z.string().max(500)).max(10).nullable().default(null),
  imageUrls: z.array(z.string()).max(10).nullable().default(null),
});
export type FieldPreview = z.infer<typeof FieldPreviewSchema>;

export const SelectorSuggestionSchema = z.object({
  fieldKey: z.string(),
  selector: z.string().max(500).nullable(),
  status: SuggestionStatusSchema,
  validation: SelectorValidationSchema,
  quality: SelectorQualitySchema,
  warnings: z.array(SelectorWarningSchema).default(() => []),
  explanation: z.string().max(300).nullable().default(null),
  preview: FieldPreviewSchema.nullable().default(null),
});
export type SelectorSuggestion = z.infer<typeof SelectorSuggestionSchema>;

// ─── Custom Field Suggestion ─────────────────────────────────────────────────

export const CustomFieldSuggestionSchema = SelectorSuggestionSchema.extend({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  valueType: FieldValueTypeSchema,
});
export type CustomFieldSuggestion = z.infer<typeof CustomFieldSuggestionSchema>;

// ─── Response ─────────────────────────────────────────────────────────────────

export const GenerateSelectorsResponseMetaSchema = z.object({
  durationMs: z.number().int().min(0),
  htmlBytes: z.number().int().min(0),
  htmlReduced: z.boolean(),
  requestedFieldCount: z.number().int().min(0),
  suggestedFieldCount: z.number().int().min(0),
  notFoundFieldCount: z.number().int().min(0),
  invalidFieldCount: z.number().int().min(0),
});
export type GenerateSelectorsResponseMeta = z.infer<typeof GenerateSelectorsResponseMetaSchema>;

export const GenerateSelectorsResponseSchema = z.object({
  requestId: z.string(),
  /**
   * Dynamic field-key → suggestion map.
   *
   * SECURITY: The server must construct this object with
   * Object.create(null) to prevent prototype-pollution via keys
   * like __proto__ or constructor. Zod's z.record() cannot
   * enforce this at the schema level, so it is a runtime
   * requirement in the response builder.
   */
  fields: z.record(
    z.string(),
    SelectorSuggestionSchema,
  ),
  customFields: z.array(CustomFieldSuggestionSchema).max(8).default(() => []),
  warnings: z.array(SelectorWarningSchema).default(() => []),
  meta: GenerateSelectorsResponseMetaSchema,
});
export type GenerateSelectorsResponse = z.infer<typeof GenerateSelectorsResponseSchema>;

// ─── Error Response ───────────────────────────────────────────────────────────

export const GenerationErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'INVALID_ARTIFACT_REFERENCE',
  'SNAPSHOT_NOT_FOUND',
  'SNAPSHOT_TOO_LARGE',
  'UNUSABLE_SNAPSHOT',
  'LLM_NOT_CONFIGURED',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_UNAVAILABLE',
  'INVALID_LLM_RESPONSE',
  'INTERNAL_ERROR',
]);
export type GenerationErrorCode = z.infer<typeof GenerationErrorCodeSchema>;

export const GenerateSelectorsErrorResponseSchema = z.object({
  requestId: z.string(),
  error: z.object({
    code: GenerationErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).nullable().default(null),
  }),
});
export type GenerateSelectorsErrorResponse = z.infer<typeof GenerateSelectorsErrorResponseSchema>;

// ─── Limits (runtime constants, not in the wire schema) ──────────────────────

export const SELECTOR_GENERATION_LIMITS = {
  /** Maximum fields in a single generation request. */
  maxRequestedFields: 50,
  /** Maximum custom-field suggestions returned by the server. */
  maxCustomFields: 8,
  /** Maximum artifact file size in bytes. */
  maxArtifactBytes: 2_000_000,
  /** Maximum character length of a CSS selector. */
  maxSelectorCharacters: 500,
  /** Maximum comma-separated selector groups. */
  maxSelectorGroups: 5,
  /** Maximum combinator depth for a selector. */
  maxCombinators: 16,
  /** Maximum preview text characters. */
  maxPreviewTextCharacters: 500,
  /** Maximum preview values. */
  maxPreviewValues: 10,
  /** Maximum preview image URLs. */
  maxPreviewImageUrls: 10,
  /** Maximum explanation characters. */
  maxExplanationCharacters: 300,
  /** Maximum sanitized HTML characters (before truncation). */
  maxReducedHtmlCharacters: 350_000,
} as const;
