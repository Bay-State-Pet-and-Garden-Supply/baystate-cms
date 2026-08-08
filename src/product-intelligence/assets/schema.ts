/**
 * Image asset contracts (PI-6).
 *
 * The durable `ProductAssetEvidence` record the issue requires: source and
 * retrieval provenance, content and perceptual hashes, rights status with
 * basis and evidence reference, observed packaging fields, exact-product and
 * exact-variant decisions, quality, and the deterministic commerce-approval
 * flag. Also the discovery-candidate and verification-input shapes.
 *
 * Pure module: zod only (vitest-runnable).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import { z } from 'zod';

export const ExtractionMethodSchema = z.enum([
  'json_ld',
  'platform_api',
  'network_response',
  'profile_selector',
  'media_api',
  'manual',
  // PI-6 review hardening: OCR/pixel-derived facts are their own extraction
  // methods (server-resolved, bound to the inspected image content hash).
  'image_ocr',
  'decoder',
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const AssetRightsStatusSchema = z.enum(['approved', 'restricted', 'unknown']);
export type AssetRightsStatus = z.infer<typeof AssetRightsStatusSchema>;

export const AssetQualityStatusSchema = z.enum(['usable', 'low_quality', 'invalid']);
export type AssetQualityStatus = z.infer<typeof AssetQualityStatusSchema>;

/** Structural twin of the workflow NetContent shape (avoids a module cycle). */
export const NetContentSchema = z.object({
  value: z.number().positive(),
  unit: z.string().min(1).max(16),
});
export type NetContent = z.infer<typeof NetContentSchema>;

/**
 * Packaging observations, as established by the verification pipeline.
 * `identity` fields may come from durable evidence rows (provenance
 * 'evidence'), from the deterministic pixel decoder ('decoder'), or be
 * caller-supplied agent assertions ('agent_asserted') — the latter are
 * recorded for review but are never authoritative for exact matching or
 * commerce approval.
 */
export const IdentityObservationSchema = z.object({
  brand: z.string().max(256).nullable().default(null),
  productName: z.string().max(512).nullable().default(null),
  variant: z.string().max(256).nullable().default(null),
  netContent: NetContentSchema.nullable().default(null),
  packCount: z.number().int().positive().nullable().default(null),
  gtin: z.string().max(64).nullable().default(null),
});
export type IdentityObservation = z.infer<typeof IdentityObservationSchema>;

export const ObservationProvenanceSchema = z.enum(['evidence', 'decoder', 'agent_asserted']);
export type ObservationProvenance = z.infer<typeof ObservationProvenanceSchema>;

/**
 * The required asset record from the PI-6 issue. `conflicts` is an addition
 * carrying the deterministic visible-package conflict reasons that block
 * primary-image use.
 */
export const ProductAssetEvidenceSchema = z.object({
  /** Direct asset URL. */
  sourceUrl: z.string().url(),
  /** Page the asset was discovered on. */
  sourcePageUrl: z.string().url().nullable(),
  /** Declared source kind (supplier/manufacturer/retailer/network_discovered/...). */
  sourceType: z.string().min(1).max(128),
  /** Where in the source the asset came from (selector/JSON path/API response). */
  sourcePath: z.string().max(1024).nullable(),
  /** Stable artifact id of the source/network response the asset came from. */
  sourceArtifactId: z.string().min(1).max(256),
  extractionMethod: ExtractionMethodSchema,
  /** Retrieval timestamp (ISO-8601). */
  retrievedAt: z.string(),
  /** SHA-256 of the original fetched bytes (never mutated by transforms). */
  originalContentHash: z.string().min(1),
  /** dHash of the decoded pixels (resize/re-encode stable). */
  perceptualHash: z.string().nullable(),
  /** Variant mapping when the source declares one. */
  variantReference: z.string().max(256).nullable(),
  rightsStatus: AssetRightsStatusSchema,
  /** Approved reuse basis; null means none established. */
  rightsBasis: z.string().max(512).nullable(),
  /** Evidence reference backing the rights basis. */
  rightsEvidenceRef: z.string().max(512).nullable(),
  observedBrand: z.string().max(256).nullable(),
  observedProductName: z.string().max(512).nullable(),
  observedVariant: z.string().max(256).nullable(),
  observedNetContent: NetContentSchema.nullable(),
  observedPackCount: z.number().int().positive().nullable(),
  observedGtin: z.string().max(64).nullable(),
  /** Exact-product match is separate from exact-variant match. */
  exactProductMatch: z.boolean(),
  exactVariantMatch: z.boolean().nullable(),
  qualityStatus: AssetQualityStatusSchema,
  /** Deterministic flag: rights approved + exact product + usable + no conflicts. */
  commerceApproved: z.boolean(),
  /** Visible-package conflict reasons (net content, pack count, flavor, ...). */
  conflicts: z.array(z.string()).default([]),
  /** How the observed packaging fields were established (durable evidence,
   *  deterministic pixel decoder, or non-authoritative agent assertion). */
  observationProvenance: ObservationProvenanceSchema.optional(),
  /** Caller-supplied (agent-asserted) observations, recorded for review but
   *  never fed into exact matching or commerce approval. */
  agentAsserted: IdentityObservationSchema.nullish(),
  // Durable-record fields (DB identity + payload), optional on the record the
  // pipeline returns; filled when persisted/loaded from product_intelligence_assets.
  id: z.string().nullish(),
  runId: z.string().nullish(),
  sourceId: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
  createdAt: z.string().nullish(),
  /** Round-4: canonical identity snapshot the asset was verified against
   *  (server-derived from the run input: runId + gtin + name). */
  verifiedAgainst: z.record(z.string(), z.unknown()).nullish(),
  /** Round-4: SHA-256 of canonicalVerifiedAgainstHash(snapshot) — the
   *  terminal validator recomputes it from the current run's input and
   *  refuses cross-run / cross-identity borrowing. */
  verifiedAgainstHash: z.string().nullish(),
  /** Round-4: durable source-kind derived from the source row at
   *  verification time (never the agent's declared string). */
  declaredSourceType: z.string().nullish(),
});
export type ProductAssetEvidence = z.infer<typeof ProductAssetEvidenceSchema>;

/** Verification input: the asset URL, expected product fields, and observed packaging evidence. */
export const ImageVerificationInputSchema = z.object({
  url: z.string().url(),
  /** Where the candidate was discovered (page). */
  sourcePageUrl: z.string().url().nullish(),
  sourcePath: z.string().max(1024).nullish(),
  sourceArtifactId: z.string().min(1).max(256).nullish(),
  extractionMethod: ExtractionMethodSchema.nullish(),
  expectedGtin: z.string().max(64).nullish(),
  expectedBrand: z.string().max(256).nullish(),
  expectedName: z.string().max(512).nullish(),
  expectedVariant: z.string().max(256).nullish(),
  expectedNetContent: NetContentSchema.nullish(),
  expectedPackCount: z.number().int().positive().nullish(),
  expectedFlavor: z.string().max(256).nullish(),
  expectedFormula: z.string().max(256).nullish(),
  /** Declared source kind (origin only — never by itself a reuse grant). */
  declaredSourceType: z.string().max(128).nullish(),
  declaredRightsBasis: z.string().max(512).nullish(),
  declaredRightsEvidenceRef: z.string().max(512).nullish(),
  /** Durable evidence-row ids (product_intelligence_evidence) the server
   *  resolves into authoritative observations. Agent-supplied `observed`
   *  below is recorded but never authoritative. */
  evidenceIds: z.array(z.string().min(1)).optional(),
  /** Packaging evidence gathered separately (OCR/structured) — recorded as
   *  agent-asserted, never fed into exact matching or commerce approval. */
  observed: IdentityObservationSchema.optional(),
});
export type ImageVerificationInput = z.infer<typeof ImageVerificationInputSchema>;

// ---------------------------------------------------------------------------
// Image discovery artifacts (consumes #29-style structured captures)
// ---------------------------------------------------------------------------

/** Normalized candidate from a discovery parser, with full provenance. */
export const DiscoveredImageCandidateSchema = z.object({
  url: z.string().url(),
  sourcePageUrl: z.string().url(),
  /** Exact source path (JSON-LD key, embedded-state path, API response id). */
  sourcePath: z.string().max(1024),
  /** Stable artifact id of the source (content hash of the parsed artifact). */
  sourceArtifactId: z.string().min(1).max(256),
  extractionMethod: ExtractionMethodSchema,
  variantReference: z.string().max(256).nullable().default(null),
  variantName: z.string().max(256).nullable().default(null),
  retrievedAt: z.string(),
});
export type DiscoveredImageCandidate = z.infer<typeof DiscoveredImageCandidateSchema>;

/** A #29-style captured network response (JSON body only, no raw payloads). */
export const NetworkCaptureArtifactSchema = z.object({
  url: z.string().url(),
  status: z.number().int().nullish(),
  responseContentType: z.string().nullish(),
  jsonBody: z.unknown().nullish(),
});
export type NetworkCaptureArtifact = z.infer<typeof NetworkCaptureArtifactSchema>;
