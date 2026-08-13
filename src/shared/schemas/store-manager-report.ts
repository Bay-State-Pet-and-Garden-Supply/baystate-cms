// ---------------------------------------------------------------------------
// Store Manager cleanup report schemas (epic #42, #38)
//
// The report is evidence-grounded: every catalog-specific finding must trace
// to a field in the bounded evidence bundle. This module is the single
// contract shared by the server (collection + deterministic builder) and the
// client (request + response types).
// ---------------------------------------------------------------------------

import { z } from 'zod';

/** Maximum number of ProductFields a caller may request to audit. */
export const MAX_REPORT_FIELDS = 10;
/** Maximum number of issue samples carried in the evidence bundle. */
export const MAX_ISSUE_SAMPLES = 20;
/** Per-string truncation bound for sample messages / statements. */
export const MAX_REPORT_STRING_LENGTH = 200;
/** Maximum narrative bullets accepted from an optional model narrative. */
export const MAX_NARRATIVE_BULLETS = 20;

/**
 * POST /store-manager/report request body. Both options are optional: the
 * deterministic report is the default and needs no model.
 */
export const StoreManagerReportRequestSchema = z.object({
  /** Registered, editable ProductFields to audit. Capped and validated server-side. */
  fields: z.array(z.string().trim().min(1).max(128)).max(MAX_REPORT_FIELDS).optional(),
  /** Opt-in model narrative over the bounded bundle. Defaults to false. */
  narrative: z.boolean().optional(),
});

export const CatalogHealthIssueSampleSchema = z.object({
  sku: z.string(),
  severity: z.string(),
  code: z.string(),
  message: z.string(),
  fieldPath: z.string().nullable(),
});

/** Catalog health evidence derived from the authoritative health report. */
export const CatalogHealthEvidenceSchema = z.object({
  totalProducts: z.number().int().nonnegative(),
  healthyProducts: z.number().int().nonnegative(),
  unhealthyProducts: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  totalWarnings: z.number().int().nonnegative(),
  /** Count of validation issues by exact severity label. */
  issueCountsBySeverity: z.record(z.string(), z.number().int().nonnegative()),
  /** Count of validation issues by exact issue code. */
  issueCountsByCode: z.record(z.string(), z.number().int().nonnegative()),
  /** Bounded issue samples with SKU/evidence identifiers. */
  issueSamples: z.array(CatalogHealthIssueSampleSchema).max(MAX_ISSUE_SAMPLES),
  /** True when the full issue list exceeded the sample cap. */
  issueSamplesTruncated: z.boolean(),
});

/** Per-field summary derived from the authoritative ProductField audit. */
export const ProductFieldAuditEvidenceSchema = z.object({
  field: z.string(),
  label: z.string(),
  totalActiveProducts: z.number().int().nonnegative(),
  emptyCount: z.number().int().nonnegative(),
  emptyRate: z.number().min(0).max(1),
  uniqueValueCount: z.number().int().nonnegative(),
  casingDuplicateCount: z.number().int().nonnegative(),
  nearDuplicateCount: z.number().int().nonnegative(),
  separatorInconsistent: z.boolean(),
  suspiciousCount: z.number().int().nonnegative(),
});

/**
 * Strict, bounded evidence bundle. The deterministic report builder and the
 * optional narrative validator both consume exactly this shape.
 */
export const StoreManagerEvidenceBundleSchema = z.object({
  generatedAt: z.string(),
  workspaceId: z.string(),
  catalogHealth: CatalogHealthEvidenceSchema,
  fieldAudits: z.array(ProductFieldAuditEvidenceSchema).max(MAX_REPORT_FIELDS),
  proposals: z.object({
    /** Stored proposals with status 'proposed' (pending review). */
    proposedCount: z.number().int().nonnegative(),
    byField: z.record(z.string(), z.number().int().nonnegative()),
  }),
  changeSets: z.object({
    /** Counts by exact ChangeSetSchema state (draft/reviewing/approved/pushed/discarded). */
    byState: z.record(z.string(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
  }),
});

/** Response: structured evidence plus rendered Markdown so findings are traceable. */
export const StoreManagerReportResponseSchema = z.object({
  evidence: StoreManagerEvidenceBundleSchema,
  summary: z.string(),
  reportMarkdown: z.string(),
});

export type StoreManagerReportRequest = z.infer<typeof StoreManagerReportRequestSchema>;
export type StoreManagerEvidenceBundle = z.infer<typeof StoreManagerEvidenceBundleSchema>;
export type CatalogHealthIssueSample = z.infer<typeof CatalogHealthIssueSampleSchema>;
export type ProductFieldAuditEvidence = z.infer<typeof ProductFieldAuditEvidenceSchema>;
export type StoreManagerReportResponse = z.infer<typeof StoreManagerReportResponseSchema>;
