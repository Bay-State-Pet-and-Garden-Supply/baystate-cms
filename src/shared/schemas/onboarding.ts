import { z } from 'zod';
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
});

export type ExtractionData = z.infer<typeof ExtractionDataSchema>;

// ─── Curation Data (Refined taxonomy and packaging mapping) ─────────────────────

export const CurationDataSchema = z.object({
  curatedTitle: z.string().nullable().default(null),
  packagingOcrTitle: z.string().nullable().default(null),
  titleSource: z.enum(['web', 'ocr', 'llm', 'manual']).default('web'),
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

export const BatchStatusEnum = z.enum([
  'imported',
  'discovering',
  'extracting',
  'curating',
  'curated',
  'review',
  'promoting',
  'completed',
  'failed',
]);

export type BatchStatus = z.infer<typeof BatchStatusEnum>;

// ─── Item Statuses ──────────────────────────────────────────────────────────────

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

export const ExtractorProfileSchema = z.object({
  id: z.string(),
  domain: z.string(),
  titleSelector: z.string().nullable().default(null),
  priceSelector: z.string().nullable().default(null),
  descriptionSelector: z.string().nullable().default(null),
  brandSelector: z.string().nullable().default(null),
  imagesSelector: z.string().nullable().default(null),
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
  createdAt: z.string(),
});

export type OnboardingSource = z.infer<typeof OnboardingSourceSchema>;

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
