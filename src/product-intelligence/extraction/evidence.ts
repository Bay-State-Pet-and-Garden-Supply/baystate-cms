/**
 * Versioned deterministic extraction evidence and provenance contracts (PI-12 /
 * issue #52).
 *
 * This module deliberately contains no transport, database, browser, or model
 * code.  An observation is accepted only when it has field-level provenance;
 * page-level hashes and URLs are not a substitute for the exact source path.
 */
import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import type { ExtractedImageCandidate, ExtractedIdentifierEvidence, ExtractedFieldEvidence, PageExtractionResult } from '../tools/contract';
export type { PageExtractionResult };

export const EXTRACTION_EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const EXTRACTION_EVIDENCE_RUNNER_VERSION = '1.0.0';

export const ExtractionProfileBindingSchema = z.object({
  id: z.string().min(1).max(256),
  /** Profile versions are timestamps in the current profile repository, but
   * the contract permits an explicitly versioned profile implementation too. */
  version: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
  runtime: z.enum(['static', 'rendered']).optional(),
}).strict();
export type ExtractionProfileBinding = z.infer<typeof ExtractionProfileBindingSchema>;

export const ExtractionObservationSchema = z.object({
  /** Stable within this bundle; derived from source URL/field/path/value. */
  id: z.string().min(1).max(256),
  field: z.string().min(1).max(128),
  value: z.string().max(4096),
  method: z.string().min(1).max(128),
  /** Exact JSON path, CSS selector, network path, or profile selector. */
  sourcePath: z.string().min(1).max(512),
  sourceUrl: z.string().url().max(2048),
  finalUrl: z.string().url().max(2048),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  artifactId: z.string().min(1).max(512).nullable(),
  profileId: z.string().min(1).max(256).nullable(),
  profileVersion: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).nullable(),
  variantRef: z.string().max(256).nullable(),
  /** A method-only fallback is explicit rather than silently pretending to be
   * an exact path.  Accepted observations always retain the path string. */
  provenanceQuality: z.enum(['exact_path', 'method_only']),
}).strict();
export type ExtractionObservation = z.infer<typeof ExtractionObservationSchema>;

export const ExtractionFailureSchema = z.object({
  code: z.enum([
    'invalid_url',
    'cancelled',
    'policy_denied',
    'blocked',
    'http_error',
    'response_too_large',
    'retrieval_failed',
    'profile_missing',
    'profile_failed',
    'profile_changed',
    'missing_fields',
    'parent_product_only',
    'wrong_variant',
    'conflicting_identity',
    'artifact_unavailable',
    'extraction_failed',
  ]),
  stage: z.enum(['request', 'policy', 'retrieval', 'structured_data', 'platform_api', 'profile_selector', 'identity', 'replay']),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
}).strict();
export type ExtractionFailure = z.infer<typeof ExtractionFailureSchema>;

export const ExtractionPathStepSchema = z.object({
  layer: z.string().min(1).max(128),
  method: z.string().min(1).max(128),
  sourcePath: z.string().max(512).nullable(),
  artifactId: z.string().max(512).nullable(),
}).strict();
export type ExtractionPathStep = z.infer<typeof ExtractionPathStepSchema>;

export const ExtractionImageEvidenceSchema = z.object({
  url: z.string().url().max(2048),
  variantRef: z.string().max(256).nullable(),
  variantRefKind: z.enum(['shopify_variant_id', 'sku', 'gtin', 'catalog_id', 'generic']).nullable().optional(),
  sourcePath: z.string().min(1).max(512),
  method: z.string().min(1).max(128),
  artifactId: z.string().max(512).nullable(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  rightsStatus: z.enum(['approved', 'commercial', 'licensed', 'public_domain', 'unverified', 'unknown', 'denied']).nullable().optional(),
  commerceApproved: z.boolean().nullable().optional(),
  rightsBasis: z.string().max(256).nullable().optional(),
  sourceTier: z.enum(['manufacturer', 'brand', 'official', 'distributor', 'supplier', 'retailer', 'marketplace', 'other']).nullable().optional(),
  identityMatch: z.enum(['exact', 'verified', 'exact_match', 'probable', 'unverified', 'wrong_variant', 'parent_only']).nullable().optional(),
}).strict();
export type ExtractionImageEvidence = z.infer<typeof ExtractionImageEvidenceSchema>;

export const ExtractionEvidenceBundleSchema = z.object({
  schemaVersion: z.literal(EXTRACTION_EVIDENCE_BUNDLE_SCHEMA_VERSION),
  runnerVersion: z.string().min(1).max(64),
  requestedUrl: z.string().url().max(2048),
  finalUrl: z.string().url().max(2048),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  artifactRefs: z.array(z.string().min(1).max(512)).max(32),
  profile: ExtractionProfileBindingSchema.nullable(),
  extractionPath: z.array(ExtractionPathStepSchema).max(128),
  observations: z.array(ExtractionObservationSchema).max(256),
  images: z.array(ExtractionImageEvidenceSchema).max(16),
  variant: z.object({
    id: z.string().max(256).nullable(),
    name: z.string().max(512).nullable(),
    sku: z.string().max(256).nullable(),
    references: z.array(z.string().max(256)).max(32),
  }).strict().nullable(),
  identityStatus: z.enum(['exact_match', 'probable_match', 'parent_product_only', 'wrong_variant', 'conflicting_identity', 'insufficient_evidence']),
  identityReasons: z.array(z.string().max(512)).max(32),
  failures: z.array(ExtractionFailureSchema).max(32),
  deterministicOnly: z.literal(true),
}).strict();
export type ExtractionEvidenceBundle = z.infer<typeof ExtractionEvidenceBundleSchema>;

export interface ProvenanceAdapterContext {
  profile?: ExtractionProfileBinding | null;
  artifactId?: string | null;
  retrievedAt?: string;
}

function observationId(url: string, field: string, method: string, path: string, value: string): string {
  return `extraction:${sha256Hex(`${url}\n${field}\n${method}\n${path}\n${value}`).slice(0, 32)}`;
}

function validContentHash(value: string | null): string | null {
  return value && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

function sourcePathFor(field: ExtractedFieldEvidence | ExtractedIdentifierEvidence, method: string): { path: string; quality: 'exact_path' | 'method_only' } {
  const sourcePath = field.sourcePath?.trim();
  return sourcePath ? { path: sourcePath.slice(0, 512), quality: 'exact_path' } : { path: method.slice(0, 512), quality: 'method_only' };
}

function toObservation(
  result: PageExtractionResult,
  field: ExtractedFieldEvidence | ExtractedIdentifierEvidence,
  context: ProvenanceAdapterContext,
  variantRef: string | null = null,
): ExtractionObservation | null {
  const value = String(field.value ?? '').slice(0, 4096);
  const source = sourcePathFor(field, field.method);
  const contentHash = validContentHash(field.sourceContentHash ?? null);
  const pageHash = validContentHash(result.contentHash);
  // The run context may identify the retained page, but it must not be
  // attached to a different source payload (Shopify/browser/profile).
  const artifactId = field.sourceArtifactId ?? (contentHash && contentHash === pageHash ? context.artifactId ?? null : null);
  // A page hash is valid only when the ladder explicitly attached it to this
  // observation. Never borrow result.contentHash for platform/browser/profile
  // observations; missing source metadata is unavailable, not page evidence.
  if (!contentHash && !artifactId) return null;
  return {
    id: observationId(result.finalUrl, 'field' in field ? field.field : 'gtin', field.method, source.path, value),
    field: 'field' in field ? field.field : 'gtin',
    value,
    method: field.method,
    sourcePath: source.path,
    sourceUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    contentHash,
    artifactId,
    profileId: 'field' in field ? field.sourceProfileId ?? null : null,
    profileVersion: 'field' in field ? field.sourceProfileVersion ?? null : null,
    variantRef: field.variantRef ?? variantRef,
    provenanceQuality: source.quality,
  };
}

function failureForResult(result: PageExtractionResult): ExtractionFailure[] {
  const failures: ExtractionFailure[] = [];
  for (const conflict of result.conflicts) {
    const message = conflict.summary.slice(0, 512);
    let code: ExtractionFailure['code'] = 'extraction_failed';
    let stage: ExtractionFailure['stage'] = 'identity';
    if (conflict.field === '_retrieval') {
      stage = 'retrieval';
      code = /403|401|429|blocked|cloudflare|captcha|just a moment/i.test(message) ? 'blocked' : /too large|size/i.test(message) ? 'response_too_large' : 'retrieval_failed';
    } else if (conflict.field === '_profile') {
      stage = 'profile_selector';
      code = 'profile_failed';
    } else if (conflict.field === 'gtin') {
      code = 'conflicting_identity';
    }
    failures.push({ code, stage, message, retryable: code === 'retrieval_failed' || code === 'blocked' });
  }
  if (result.identityStatus === 'wrong_variant') failures.push({ code: 'wrong_variant', stage: 'identity', message: result.identityReasons.join('; ').slice(0, 512) || 'variant mismatch', retryable: false });
  if (result.identityStatus === 'parent_product_only') failures.push({ code: 'parent_product_only', stage: 'identity', message: result.identityReasons.join('; ').slice(0, 512) || 'parent product page', retryable: false });
  if (result.identityStatus === 'conflicting_identity') failures.push({ code: 'conflicting_identity', stage: 'identity', message: result.identityReasons.join('; ').slice(0, 512) || 'conflicting identity', retryable: false });
  if (result.identityStatus === 'insufficient_evidence' && result.fields.length === 0 && result.gtins.length === 0 && result.images.length === 0) {
    failures.push({ code: 'missing_fields', stage: 'identity', message: 'no accepted product observations', retryable: false });
  }
  return failures;
}

/** Convert an existing ladder/contract result into durable field-level evidence. */
export function createExtractionProvenanceAdapter(context: ProvenanceAdapterContext = {}) {
  return {
    adapt(result: PageExtractionResult): ExtractionEvidenceBundle {
      const observations = result.fields.flatMap((field) => {
        const observation = toObservation(result, field, context);
        return observation ? [observation] : [];
      });
      const identifierObservations = result.gtins.flatMap((gtin) => {
        const observation = toObservation(result, gtin, context);
        return observation ? [observation] : [];
      });
      const allObservations = [...observations, ...identifierObservations];
      const images = result.images.slice(0, 16).map((image) => {
        const variantRef = image.variantRef ?? null;
        let variantRefKind = (image as any).variantRefKind ?? null;
        if (!variantRefKind && variantRef) {
          if (result.variant?.id && variantRef === result.variant.id) {
            variantRefKind = 'shopify_variant_id';
          } else if (result.sku && variantRef === result.sku) {
            variantRefKind = 'sku';
          }
        }
        return {
          url: image.url,
          variantRef,
          variantRefKind,
          sourcePath: image.sourcePath?.trim() || 'image_candidates',
          method: image.sourcePath?.startsWith('profile:') ? 'profile_selector' : 'image_candidate',
          artifactId: image.sourceArtifactId ?? (image.sourceContentHash && validContentHash(image.sourceContentHash) === validContentHash(result.contentHash) ? context.artifactId ?? null : null),
          contentHash: validContentHash(image.sourceContentHash ?? null),
          rightsStatus: (image as any).rightsStatus ?? 'unverified',
          commerceApproved: (image as any).commerceApproved ?? false,
          rightsBasis: (image as any).rightsBasis ?? null,
          sourceTier: (image as any).sourceTier ?? null,
          identityMatch: (image as any).identityMatch ?? 'unverified',
        };
      }).filter((image) => !!image.contentHash || !!image.artifactId);
      const imageObservations = images.map((image) => ({
        id: observationId(result.finalUrl, 'image', image.method, image.sourcePath, image.url),
        field: 'image',
        value: image.url,
        method: image.method,
        sourcePath: image.sourcePath,
        sourceUrl: result.requestedUrl,
        finalUrl: result.finalUrl,
        contentHash: image.contentHash,
        artifactId: image.artifactId,
        profileId: null,
        profileVersion: null,
        variantRef: image.variantRef,
        provenanceQuality: image.sourcePath === 'image_candidates' ? 'method_only' as const : 'exact_path' as const,
      }));
      const path = [...new Map(
        [...result.fields, ...result.gtins].map((entry) => {
          const source = sourcePathFor(entry, entry.method);
          return [source.path, {
            layer: entry.method,
            method: entry.method,
            sourcePath: source.quality === 'exact_path' ? source.path : null,
            // Do not borrow the retained page artifact for a platform,
            // browser, or profile observation. The source metadata on the
            // observation is the only authority.
            artifactId: entry.sourceArtifactId ?? null,
          }];
        }),
      ).values()];
      const variantReference = result.variant?.id ?? result.variant?.sku ?? null;
      return ExtractionEvidenceBundleSchema.parse({
        schemaVersion: EXTRACTION_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        runnerVersion: EXTRACTION_EVIDENCE_RUNNER_VERSION,
        requestedUrl: result.requestedUrl,
        finalUrl: result.finalUrl,
        retrievedAt: context.retrievedAt ?? new Date().toISOString(),
        contentHash: validContentHash(result.contentHash),
        artifactRefs: [...new Set([
          context.artifactId,
          result.artifactRef,
          ...allObservations.map((observation) => observation.artifactId),
        ].filter((ref): ref is string => !!ref))].slice(0, 32),
        profile: context.profile ?? null,
        extractionPath: path.slice(0, 128),
        observations: [...allObservations, ...imageObservations].slice(0, 256),
        images,
        variant: result.variant
          ? { id: result.variant.id ?? null, name: result.variant.name ?? null, sku: result.variant.sku ?? null, references: variantReference ? [variantReference] : [] }
          : null,
        identityStatus: result.identityStatus,
        identityReasons: result.identityReasons.slice(0, 32),
        failures: failureForResult(result),
        deterministicOnly: true,
      });
    },
  };
}

export function toExtractionEvidenceBundle(result: PageExtractionResult, context: ProvenanceAdapterContext = {}): ExtractionEvidenceBundle {
  return createExtractionProvenanceAdapter(context).adapt(result);
}

/** Class form for callers that keep one adapter per extraction run. */
export class ExtractionProvenanceAdapter {
  private readonly adapter: ReturnType<typeof createExtractionProvenanceAdapter>;
  constructor(context: ProvenanceAdapterContext = {}) {
    this.adapter = createExtractionProvenanceAdapter(context);
  }
  adapt(result: PageExtractionResult): ExtractionEvidenceBundle {
    return this.adapter.adapt(result);
  }
}

/** Stable, review-safe materialization projection. It never invents absent fields. */
export function materializeExtractionEvidenceBundle(bundle: ExtractionEvidenceBundle): {
  sourceUrl: string;
  finalUrl: string;
  fields: Record<string, string>;
  fieldProvenance: Record<string, string>;
  images: ExtractionImageEvidence[];
  variant: ExtractionEvidenceBundle['variant'];
} {
  const parsed = ExtractionEvidenceBundleSchema.parse(bundle);
  const fields: Record<string, string> = {};
  const fieldProvenance: Record<string, string> = {};
  for (const observation of parsed.observations) {
    if (observation.field === 'image' || fields[observation.field] !== undefined) continue;
    fields[observation.field] = observation.value;
    fieldProvenance[observation.field] = observation.sourcePath;
  }
  return { sourceUrl: parsed.requestedUrl, finalUrl: parsed.finalUrl, fields, fieldProvenance, images: parsed.images, variant: parsed.variant };
}

/**
 * Onboarding-compatible read-only projection. This is deliberately a plain
 * value map rather than an onboarding repository write; promotion remains the
 * caller's reviewed responsibility.
 */
export function materializeExtractionDataFromEvidence(bundle: ExtractionEvidenceBundle): {
  title: string | null;
  brand: string | null;
  description: string | null;
  price: string | null;
  weight: string | null;
  primaryImage: string | null;
  additionalImages: string[];
  sourceUrl: string;
  fieldProvenance: Record<string, string>;
  variant: ExtractionEvidenceBundle['variant'];
} {
  const projection = materializeExtractionEvidenceBundle(bundle);
  const field = (name: string): string | null => projection.fields[name] ?? null;
  return {
    title: field('product_name') ?? field('title'),
    brand: field('brand'),
    description: field('description'),
    price: field('price'),
    weight: field('size') ?? field('weight'),
    primaryImage: projection.images[0]?.url ?? null,
    additionalImages: projection.images.slice(1).map((image) => image.url),
    sourceUrl: projection.sourceUrl,
    fieldProvenance: projection.fieldProvenance,
    variant: projection.variant,
  };
}

export type { ExtractedImageCandidate };
