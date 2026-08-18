/**
 * Resolver specialist — deterministic identity and field reconciliation for
 * Product Intelligence (epic #47, issue #53, ADR 0025).
 *
 * The resolver consumes the typed output of the Discovery specialist
 * (ADR 0022) and the deterministic extraction evidence bundles (ADR 0024) and
 * produces a versioned `ResolvedFactSet` artifact:
 *
 *   - canonical fields (title, brand, gtin, caseGtin, innerPackGtin, sku,
 *     weight, size, packCount, dimensions, caseDimensions, shippingDimensions)
 *     with per-field status, confidence, and evidence references
 *   - a resolved identity (candidate decision + GTIN) whose confidence is
 *     computed independently of field completeness and per-field confidence
 *   - preserved conflicts (never forced into a value) with both sides and
 *     their evidence
 *   - identifier scoping (consumer / case / inner / unknown) so 14-digit
 *     case identifiers are never conflated with consumer UPCs
 *   - dimension scoping (product / case / shipping) so case or shipping
 *     dimensions are never promoted to product dimensions
 *   - unit reconciliation (weight → lb, volume → fl oz, length → in) with
 *     deterministic equivalence tolerance; unparseable values stay
 *     `needs_more_evidence`, never forced
 *   - config-driven source authority (ranking policy + configId), never
 *     hardcoded in a prompt
 *
 * The resolver is a pure deterministic function over its typed input: it
 * performs no network I/O, no model calls, and never writes catalog state.
 * Its output is a proposal artifact that downstream review/promotion stages
 * consume.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import {
  DiscoveryCandidateSchema,
  type DiscoveryCandidate,
  type DiscoverySourceType,
} from './discovery';
import {
  ExtractionEvidenceBundleSchema,
  type ExtractionEvidenceBundle,
} from '../extraction/evidence';
import {
  finalizeSpecialistArtifact,
  captureSpecialistCodeCommit,
  summarizeZodIssues,
  SpecialistArtifactSchemaRegistry,
} from './artifacts';
import {
  SpecialistResultSchema,
  type SpecialistCapability,
  type SpecialistContext,
  type SpecialistResult,
} from './contracts';

// ── Constants ────────────────────────────────────────────────────────────────

export const RESOLVER_SPECIALIST_NAME = 'resolver';
export const RESOLVER_SPECIALIST_VERSION = '1.0.0';
export const RESOLVER_INPUT_SCHEMA_VERSION = '1.0.0';
export const RESOLVER_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const RESOLVER_INPUT_ARTIFACT_TYPE = 'resolver_input';
export const RESOLVER_OUTPUT_ARTIFACT_TYPE = 'resolved_factset';

// ── Source authority (config-driven, never hardcoded in a prompt) ────────────

export const SourceKindSchema = z.enum([
  'catalog',
  'manufacturer',
  'supplier',
  'distributor',
  'retailer',
  'marketplace',
  'other',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceAuthorityPolicySchema = z.object({
  configVersion: z.string().min(1),
  /**
   * Ordered source authority ranking (most authoritative first). Drives
   * display-value tie-breaking and per-field confidence weighting.
   * Config-driven: the resolver never hardcodes which source wins.
   */
  ranking: z.array(SourceKindSchema).min(1).max(16),
}).strict();
export type SourceAuthorityPolicy = z.infer<typeof SourceAuthorityPolicySchema>;

export const DEFAULT_SOURCE_AUTHORITY_POLICY: SourceAuthorityPolicy = {
  configVersion: '1.0.0',
  ranking: ['catalog', 'manufacturer', 'distributor', 'supplier', 'retailer', 'marketplace', 'other'],
};

export function sourceAuthorityConfigId(policy: SourceAuthorityPolicy): string {
  return sha256Hex(JSON.stringify({ configVersion: policy.configVersion, ranking: policy.ranking })).slice(0, 32);
}

// ── Identifier and dimension scoping ─────────────────────────────────────────

export const IdentifierScopeSchema = z.enum(['consumer_unit', 'case', 'inner', 'unknown']);
export type IdentifierScope = z.infer<typeof IdentifierScopeSchema>;

export const DimensionScopeSchema = z.enum(['product', 'case', 'shipping']);
export type DimensionScope = z.infer<typeof DimensionScopeSchema>;

// ── Evidence references ──────────────────────────────────────────────────────

export const EvidenceRefSchema = z.object({
  id: z.string().min(1).max(128),
  sourceKind: SourceKindSchema,
  candidateId: z.string().min(1).max(128).nullable(),
  url: z.string().min(1).max(2048).nullable(),
  field: z.string().min(1).max(128),
  rawValue: z.string().min(1).max(4096),
  contentHash: z.string().min(8).max(128).nullable(),
  scope: IdentifierScopeSchema.nullable(),
  method: z.string().min(1).max(64),
  sourcePath: z.string().min(1).max(512).nullable(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ── Canonical quantities ─────────────────────────────────────────────────────

export const CanonicalQuantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1).max(16),
  kind: z.enum(['weight', 'volume', 'length', 'count']),
  /** The original raw string for auditability. */
  rawValue: z.string().min(1).max(512),
}).strict();
export type CanonicalQuantity = z.infer<typeof CanonicalQuantitySchema>;

// ── Conflicts ────────────────────────────────────────────────────────────────

export const ConflictSideSchema = z.object({
  value: z.string().min(1).max(4096),
  sourceKind: SourceKindSchema,
  url: z.string().min(1).max(2048).nullable(),
  evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(32),
}).strict();
export type ConflictSide = z.infer<typeof ConflictSideSchema>;

export const FactConflictSchema = z.object({
  field: z.string().min(1).max(128),
  sides: z.array(ConflictSideSchema).min(2).max(16),
  reason: z.string().min(1).max(512),
}).strict();
export type FactConflict = z.infer<typeof FactConflictSchema>;

// ── Facts ────────────────────────────────────────────────────────────────────

export const FactStatusSchema = z.enum(['resolved', 'conflict', 'needs_more_evidence', 'abstained']);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const ResolvedFactSchema = z.object({
  field: z.string().min(1).max(128),
  status: FactStatusSchema,
  /** Canonical value when resolved; null otherwise. */
  value: z.string().min(1).max(4096).nullable(),
  /** Normalized quantity when the field is numeric; null otherwise. */
  canonicalQuantity: CanonicalQuantitySchema.nullable(),
  /** Identifier scope when the field is an identifier; null otherwise. */
  identifierScope: IdentifierScopeSchema.nullable(),
  /** Dimension scope when the field is a dimension; null otherwise. */
  dimensionScope: DimensionScopeSchema.nullable(),
  /** 0..1 per-field confidence. Independent of identity confidence. */
  confidence: z.number().min(0).max(1),
  supportingEvidence: z.array(EvidenceRefSchema).default([]),
  contradictingEvidence: z.array(EvidenceRefSchema).default([]),
  notes: z.string().max(512).nullable(),
}).strict();
export type ResolvedFact = z.infer<typeof ResolvedFactSchema>;

// ── Identity ─────────────────────────────────────────────────────────────────

export const IdentityStatusSchema = z.enum(['resolved', 'ambiguous', 'conflict', 'unresolved']);
export type IdentityStatus = z.infer<typeof IdentityStatusSchema>;

export const CandidateDecisionStatusSchema = z.enum([
  'exact_match',
  'probable_match',
  'parent_product_only',
  'wrong_variant',
  'conflict',
  'insufficient_evidence',
  'blocked',
]);
export type CandidateDecisionStatus = z.infer<typeof CandidateDecisionStatusSchema>;

export const CandidateDecisionSchema = z.object({
  candidateId: z.string().min(1).max(128),
  url: z.string().min(1).max(2048),
  sourceKind: SourceKindSchema,
  decision: CandidateDecisionStatusSchema,
  gtin: z.string().min(6).max(20).nullable(),
  reasons: z.array(z.string().min(1).max(512)).min(1).max(16),
}).strict();
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

export const ResolvedIdentitySchema = z.object({
  status: IdentityStatusSchema,
  /** 0..1 identity confidence. Computed independently of field completeness
   *  and per-field confidence. */
  confidence: z.number().min(0).max(1),
  candidateId: z.string().min(1).max(128).nullable(),
  candidateUrl: z.string().min(1).max(2048).nullable(),
  /** Resolved consumer GTIN (digits only) when identity is resolved. */
  gtin: z.string().min(6).max(20).nullable(),
  /** 12-digit consumer UPC when the resolved GTIN is 12 digits. */
  upc: z.string().min(12).max(12).nullable(),
  decisions: z.array(CandidateDecisionSchema).min(1).max(32),
  nextEvidence: z.string().min(1).max(128).nullable(),
}).strict();
export type ResolvedIdentity = z.infer<typeof ResolvedIdentitySchema>;

// ── Field completeness ───────────────────────────────────────────────────────

export const FieldCompletenessSchema = z.object({
  total: z.number().int().min(1).max(64),
  resolved: z.number().int().min(0).max(64),
  conflicts: z.number().int().min(0).max(64),
  needsMoreEvidence: z.number().int().min(0).max(64),
  abstained: z.number().int().min(0).max(64),
}).strict();
export type FieldCompleteness = z.infer<typeof FieldCompletenessSchema>;

// ── Input ────────────────────────────────────────────────────────────────────

export const ExpectedIdentitySchema = z.object({
  gtin: z.string().min(6).max(20).nullable(),
  gtinScope: IdentifierScopeSchema.default('consumer_unit'),
}).strict();
export type ExpectedIdentity = z.infer<typeof ExpectedIdentitySchema>;

export const ResolverSpecialistInputSchema = z.object({
  schemaVersion: z.literal(RESOLVER_INPUT_SCHEMA_VERSION),
  productSeed: z.any(),
  expectedIdentity: ExpectedIdentitySchema,
  discoveryCandidates: z.array(DiscoveryCandidateSchema).min(1).max(32),
  extractionBundles: z.array(ExtractionEvidenceBundleSchema).min(0).max(64),
  sourceAuthority: SourceAuthorityPolicySchema.default(DEFAULT_SOURCE_AUTHORITY_POLICY),
}).strict();
export type ResolverSpecialistInput = z.infer<typeof ResolverSpecialistInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

export const ResolvedFactSetSchema = z.object({
  schemaVersion: z.literal(RESOLVER_OUTPUT_SCHEMA_VERSION),
  specialist: z.literal(RESOLVER_SPECIALIST_NAME),
  specialistVersion: z.literal(RESOLVER_SPECIALIST_VERSION),
  productSeed: z.any(),
  expectedIdentity: ExpectedIdentitySchema,
  identity: ResolvedIdentitySchema,
  facts: z.array(ResolvedFactSchema).min(1).max(64),
  fieldCompleteness: FieldCompletenessSchema,
  conflicts: z.array(FactConflictSchema).min(0).max(64),
  /** All evidence references collected from candidates + bundles, keyed by id. */
  evidenceRegistry: z.record(z.string().min(1).max(128), EvidenceRefSchema),
  abstentions: z.array(z.object({
    field: z.string().min(1).max(128),
    reason: z.string().min(1).max(512),
  }).strict()).min(0).max(64),
  sourceAuthority: z.object({
    configVersion: z.string().min(1),
    configId: z.string().min(8).max(64),
    ranking: z.array(SourceKindSchema).min(1).max(16),
  }).strict(),
  resolvedAt: z.string().min(1),
}).strict();
export type ResolvedFactSet = z.infer<typeof ResolvedFactSetSchema>;

// ── Field vocabulary ─────────────────────────────────────────────────────────

/** Canonical fields the resolver must always produce an opinion on. */
export const RESOLVER_CORE_FIELDS = [
  'title',
  'brand',
  'gtin',
  'weight',
  'size',
  'dimensions',
] as const;

/** Optional fields — abstained when no evidence is observed. */
export const RESOLVER_OPTIONAL_FIELDS = [
  'caseGtin',
  'innerPackGtin',
  'sku',
  'packCount',
  'caseDimensions',
  'shippingDimensions',
] as const;

export const RESOLVER_CANONICAL_FIELDS: readonly string[] = [
  ...RESOLVER_CORE_FIELDS,
  ...RESOLVER_OPTIONAL_FIELDS,
];

/** Map raw observation field names to canonical resolver fields. */
const FIELD_ALIASES: Record<string, string> = {
  // title
  title: 'title',
  product_name: 'title',
  name: 'title',
  product_title: 'title',
  // brand
  brand: 'brand',
  manufacturer: 'brand',
  // gtin (consumer)
  gtin: 'gtin',
  gtin12: 'gtin',
  gtin13: 'gtin',
  upc: 'gtin',
  ean: 'gtin',
  barcode: 'gtin',
  item_code: 'gtin',
  // case gtin
  case_gtin: 'caseGtin',
  case_upc: 'caseGtin',
  case_gtin14: 'caseGtin',
  case_barcode: 'caseGtin',
  // inner pack gtin
  inner_pack_gtin: 'innerPackGtin',
  inner_gtin: 'innerPackGtin',
  inner_pack_upc: 'innerPackGtin',
  // sku
  sku: 'sku',
  mpn: 'sku',
  // weight
  weight: 'weight',
  net_weight: 'weight',
  // size / volume
  size: 'size',
  volume: 'size',
  net_content: 'size',
  // pack count
  pack_count: 'packCount',
  count: 'packCount',
  quantity: 'packCount',
  // dimensions
  dimensions: 'dimensions',
  product_dimensions: 'dimensions',
  case_dimensions: 'caseDimensions',
  case_dims: 'caseDimensions',
  shipping_dimensions: 'shippingDimensions',
  package_dimensions: 'shippingDimensions',
  shipping_dims: 'shippingDimensions',
};

export function canonicalFieldFor(rawField: string): string | null {
  const key = rawField.trim().toLowerCase();
  return FIELD_ALIASES[key] ?? null;
}

// ── Quantity parsing ─────────────────────────────────────────────────────────

const WEIGHT_UNITS: Record<string, number> = {
  lb: 1, lbs: 1, pound: 1, pounds: 1,
  kg: 2.2046226218,
  g: 0.0022046226218,
  oz: 0.0625,
};

const VOLUME_UNITS: Record<string, number> = {
  'fl oz': 1, 'fl ozs': 1, floz: 1,
  ml: 0.0338140227,
  l: 33.8140227,
  liter: 33.8140227,
  liters: 33.8140227,
};

const LENGTH_UNITS: Record<string, number> = {
  in: 1, inch: 1, inches: 1,
  cm: 0.3937007874,
  mm: 0.03937007874,
  ft: 12, foot: 12, feet: 12,
  m: 39.37007874,
};

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Parse a raw quantity string into a canonical quantity.
 * Returns null when the value is unparseable — the caller must treat this as
 * `needs_more_evidence`, never force a value.
 */
export function parseQuantity(rawValue: string, canonicalField: string): CanonicalQuantity | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const kind = quantityKindForField(canonicalField);
  if (kind === null) return null;

  if (kind === 'count') {
    const parsed = parseCount(trimmed);
    if (parsed === null) return null;
    return { value: parsed, unit: 'count', kind, rawValue: trimmed };
  }

  // Try volume first (fl oz, ml, l, bare oz in a volume field) then weight (lb, kg, g, oz).
  const volumeMatch = /^([\d.]+)\s*(fl\s*ozs?|floz|ml|l|liters?|litres?|oz)$/i.exec(trimmed);
  if (volumeMatch && kind === 'volume') {
    const value = Number(volumeMatch[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unitKey = volumeMatch[2].trim().toLowerCase().replace(/\s+/g, ' ');
    // Bare "oz" in a volume/net-content field is fluid ounces; bare "oz" in a
    // weight field is weight ounces (structured weight operator rule).
    const factor = unitKey === 'oz' ? 1 : (VOLUME_UNITS[unitKey] ?? VOLUME_UNITS[normalizeVolumeUnit(unitKey)]);
    if (factor === undefined) return null;
    return { value: round6(value * factor), unit: 'fl oz', kind, rawValue: trimmed };
  }

  const weightMatch = /^([\d.]+)\s*(lbs?|pounds?|kg|g|oz)$/i.exec(trimmed);
  if (weightMatch && kind === 'weight') {
    const value = Number(weightMatch[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unitKey = weightMatch[2].trim().toLowerCase();
    const factor = WEIGHT_UNITS[unitKey] ?? WEIGHT_UNITS[singularWeightUnit(unitKey)];
    if (factor === undefined) return null;
    return { value: round6(value * factor), unit: 'lb', kind, rawValue: trimmed };
  }

  return null;
}

function normalizeVolumeUnit(unit: string): string {
  if (unit === 'floz') return 'fl oz';
  if (unit === 'l') return 'l';
  if (unit === 'litre' || unit === 'litres') return 'liter';
  return unit;
}

function singularWeightUnit(unit: string): string {
  if (unit === 'lbs') return 'lb';
  if (unit === 'pounds') return 'pound';
  return unit;
}

function quantityKindForField(field: string): 'weight' | 'volume' | 'length' | 'count' | null {
  switch (field) {
    case 'weight': return 'weight';
    case 'size': return 'volume';
    case 'dimensions':
    case 'caseDimensions':
    case 'shippingDimensions': return 'length';
    case 'packCount': return 'count';
    default: return null;
  }
}

/**
 * Parse a dimension string like "12 x 8 x 5 in" into canonical inches.
 * Returns null when unparseable.
 */
export function parseDimensions(rawValue: string): { parts: [number, number, number]; unit: string } | null {
  const trimmed = rawValue.trim();
  const match = /^([\d.]+)\s*[x×]\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(in|inch|inches|cm|mm|ft|foot|feet|m)?$/i.exec(trimmed);
  if (!match) return null;
  const [l, w, h] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) return null;
  const unitKey = (match[4] ?? 'in').trim().toLowerCase();
  const factor = LENGTH_UNITS[unitKey] ?? LENGTH_UNITS[singularLengthUnit(unitKey)] ?? 1;
  return {
    parts: [round6(l * factor), round6(w * factor), round6(h * factor)],
    unit: 'in',
  };
}

function singularLengthUnit(unit: string): string {
  if (unit === 'inches') return 'in';
  if (unit === 'feet') return 'foot';
  return unit;
}

/** Parse a pack count like "6 count", "12", "4 ct" into an integer. */
export function parseCount(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  const match = /^(\d+)\s*(?:count|ct|pcs?|packs?|units?|each|ea)?$/i.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ── Identifier scoping ───────────────────────────────────────────────────────

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Determine the identifier scope for a GTIN-like value.
 *
 * - 12 digits → consumer_unit (UPC-A)
 * - 13 digits → consumer_unit (EAN-13)
 * - 14 digits → case (ITF-14)
 * - 8 digits  → consumer_unit (EAN-8)
 * - otherwise → unknown (never promoted)
 *
 * If the value exactly matches the expected GTIN, adopt the expected scope.
 */
export function scopeForIdentifier(value: string, expected: ExpectedIdentity): IdentifierScope {
  const d = digits(value);
  if (expected.gtin && d === digits(expected.gtin)) {
    return expected.gtinScope;
  }
  switch (d.length) {
    case 12:
    case 13:
    case 8:
      return 'consumer_unit';
    case 14:
      return 'case';
    default:
      return 'unknown';
  }
}

// ── Equivalence tolerance ────────────────────────────────────────────────────

/** Relative tolerance for numeric equivalence (1.5%). */
const EQUIVALENCE_TOLERANCE = 0.015;
/** Absolute floor for weight equivalence (lb). */
const WEIGHT_EQUIVALENCE_FLOOR = 0.02;
/** Absolute floor for volume equivalence (fl oz). */
const VOLUME_EQUIVALENCE_FLOOR = 0.05;

function quantitiesEquivalent(a: CanonicalQuantity, b: CanonicalQuantity): boolean {
  if (a.kind !== b.kind || a.unit !== b.unit) return false;
  const diff = Math.abs(a.value - b.value);
  const floor = a.kind === 'weight' ? WEIGHT_EQUIVALENCE_FLOOR : a.kind === 'volume' ? VOLUME_EQUIVALENCE_FLOOR : 0;
  const tolerance = Math.max(floor, Math.max(a.value, b.value) * EQUIVALENCE_TOLERANCE);
  return diff <= tolerance;
}

// ── Core reconciliation ──────────────────────────────────────────────────────

interface ExtractionContext {
  refs: Map<string, EvidenceRef>;
  /** candidateId → sourceKind (from discovery candidate sourceType). */
  candidateSourceKinds: Map<string, SourceKind>;
  /** normalized URL → candidate (for linking bundles to candidates). */
  candidateByUrl: Map<string, DiscoveryCandidate>;
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

function mapCandidateSourceKind(sourceType: DiscoverySourceType): SourceKind {
  switch (sourceType) {
    case 'manufacturer':
      return 'manufacturer';
    case 'supplier':
      return 'supplier';
    case 'distributor':
      return 'supplier';
    case 'retailer':
      return 'retailer';
    case 'marketplace':
      return 'marketplace';
    case 'search':
    case 'sitemap':
    case 'existing_evidence':
    case 'other':
      return 'other';
  }
}

function candidateKey(candidate: DiscoveryCandidate): string {
  return `cand:${sha256Hex(candidate.source.url).slice(0, 16)}`;
}

function addRef(ctx: ExtractionContext, ref: EvidenceRef): void {
  ctx.refs.set(ref.id, ref);
}

function extractFromCandidate(
  ctx: ExtractionContext,
  candidate: DiscoveryCandidate,
  bundleUrls: Set<string>,
): void {
  const sourceKind = mapCandidateSourceKind(candidate.source.sourceType);
  const key = candidateKey(candidate);
  ctx.candidateSourceKinds.set(key, sourceKind);

  const urlKey = normalizeUrl(candidate.source.url);
  if (!ctx.candidateByUrl.has(urlKey)) ctx.candidateByUrl.set(urlKey, candidate);
  if (candidate.finalUrl) {
    const finalKey = normalizeUrl(candidate.finalUrl);
    if (!ctx.candidateByUrl.has(finalKey)) ctx.candidateByUrl.set(finalKey, candidate);
  }

  // The extraction bundle is the richer, per-observation typed evidence source
  // for the same page. When a bundle covers this candidate's URL the
  // candidate's summary fields are duplicates and must not be double-counted.
  const coveredByBundle =
    bundleUrls.has(urlKey) ||
    (candidate.finalUrl ? bundleUrls.has(normalizeUrl(candidate.finalUrl)) : false);
  if (coveredByBundle) return;

  const extracted = candidate.extracted;
  const add = (field: string, rawValue: string, sourcePath: string): void => {
    addRef(ctx, {
      id: `resolver:cand:${sha256Hex(`${key}\n${field}\n${rawValue}`).slice(0, 24)}`,
      sourceKind,
      candidateId: key,
      url: candidate.source.url,
      field,
      rawValue,
      contentHash: null,
      scope: null,
      method: 'discovery_candidate',
      sourcePath,
    });
  };
  if (extracted.productName) add('title', extracted.productName, 'candidate.extracted.productName');
  if (extracted.brand) add('brand', extracted.brand, 'candidate.extracted.brand');
  if (extracted.sku) add('sku', extracted.sku, 'candidate.extracted.sku');
  if (extracted.size) add('size', extracted.size, 'candidate.extracted.size');
  for (const gtin of extracted.gtins) {
    if (gtin.trim()) add('gtin', gtin, 'candidate.extracted.gtins');
  }
}

function linkBundleToCandidate(
  ctx: ExtractionContext,
  bundle: ExtractionEvidenceBundle,
): DiscoveryCandidate | null {
  const requested = normalizeUrl(bundle.requestedUrl);
  const final = normalizeUrl(bundle.finalUrl);
  return ctx.candidateByUrl.get(requested) ?? ctx.candidateByUrl.get(final) ?? null;
}

function extractFromBundle(ctx: ExtractionContext, bundle: ExtractionEvidenceBundle): void {
  const candidate = linkBundleToCandidate(ctx, bundle);
  const key = candidate ? candidateKey(candidate) : null;
  const sourceKind = key ? (ctx.candidateSourceKinds.get(key) ?? 'other') : 'other';
  const finalUrl = bundle.finalUrl;

  for (const obs of bundle.observations) {
    const canonicalField = canonicalFieldFor(obs.field);
    if (!canonicalField) continue;
    const rawValue = obs.value.trim();
    if (!rawValue) continue;
    addRef(ctx, {
      id: obs.id,
      sourceKind,
      candidateId: key,
      url: obs.finalUrl ?? finalUrl,
      field: canonicalField,
      rawValue,
      contentHash: obs.contentHash,
      scope: null,
      method: obs.method,
      sourcePath: obs.sourcePath,
    });
  }
}

// ── Identity resolution ──────────────────────────────────────────────────────

function bundleDecisionStatus(status: ExtractionEvidenceBundle['identityStatus']): CandidateDecisionStatus {
  switch (status) {
    case 'exact_match':
      return 'exact_match';
    case 'probable_match':
      return 'probable_match';
    case 'parent_product_only':
      return 'parent_product_only';
    case 'wrong_variant':
      return 'wrong_variant';
    case 'conflicting_identity':
      return 'conflict';
    case 'insufficient_evidence':
      return 'insufficient_evidence';
  }
}

function decisionForCandidate(
  candidate: DiscoveryCandidate,
  bundle: ExtractionEvidenceBundle | null,
  expected: ExpectedIdentity,
): CandidateDecision {
  const sourceKind = mapCandidateSourceKind(candidate.source.sourceType);
  const key = candidateKey(candidate);
  const url = candidate.finalUrl ?? candidate.source.url;
  const reasons: string[] = [];

  if (bundle) {
    const hasObservations = bundle.observations.length > 0;
    if (!hasObservations) {
      const parentFailure = bundle.failures.find((f) => f.code === 'parent_product_only');
      if (parentFailure) {
        reasons.push('extraction failure: parent_product_only');
        return { candidateId: key, url, sourceKind, decision: 'parent_product_only', gtin: null, reasons };
      }
      const wrongFailure = bundle.failures.find((f) => f.code === 'wrong_variant');
      if (wrongFailure) {
        reasons.push('extraction failure: wrong_variant');
        return { candidateId: key, url, sourceKind, decision: 'wrong_variant', gtin: null, reasons };
      }
      if (bundle.failures.length > 0) {
        reasons.push(`extraction blocked: ${bundle.failures[0].code}`);
        return { candidateId: key, url, sourceKind, decision: 'blocked', gtin: null, reasons };
      }
      reasons.push('extraction produced no observations');
      return { candidateId: key, url, sourceKind, decision: 'insufficient_evidence', gtin: null, reasons };
    }
    reasons.push(`extraction identity: ${bundle.identityStatus}`);
    const gtinObs = bundle.observations.filter((o) => canonicalFieldFor(o.field) === 'gtin');
    const expectedGtin = expected.gtin;
    const matched = expectedGtin ? gtinObs.find((o) => digits(o.value) === digits(expectedGtin)) : undefined;
    const rawGtin = matched ? digits(matched.value) : gtinObs.length > 0 ? digits(gtinObs[0].value) : null;
    const gtin = rawGtin !== null && rawGtin.length >= 6 ? rawGtin : null;
    if (matched) reasons.push(`consumer GTIN ${gtin} matches expected`);
    else if (gtin) reasons.push(`consumer GTIN ${gtin} observed (not matched to expected)`);
    return {
      candidateId: key,
      url,
      sourceKind,
      decision: bundleDecisionStatus(bundle.identityStatus),
      gtin,
      reasons,
    };
  }

  // No extraction bundle: fall back to the candidate's own typed decision.
  if (candidate.pageKind === 'parent_family_page') {
    reasons.push('candidate page kind: parent_family_page');
    return { candidateId: key, url, sourceKind, decision: 'parent_product_only', gtin: null, reasons };
  }
  if (candidate.pageKind === 'wrong_variant') {
    reasons.push('candidate page kind: wrong_variant');
    return { candidateId: key, url, sourceKind, decision: 'wrong_variant', gtin: null, reasons };
  }
  const candidateGtin = candidate.extracted.gtins.map((g) => digits(g)).find((g) => g.length > 0) ?? null;
  if (candidateGtin && expected.gtin && candidateGtin === digits(expected.gtin)) {
    reasons.push(`candidate GTIN ${candidateGtin} matches expected (no extraction bundle)`);
    return { candidateId: key, url, sourceKind, decision: 'probable_match', gtin: candidateGtin, reasons };
  }
  reasons.push('no extraction bundle and no GTIN match');
  return { candidateId: key, url, sourceKind, decision: 'insufficient_evidence', gtin: candidateGtin, reasons };
}

function identityConfidence(decision: CandidateDecisionStatus, expectedGtinMatch: boolean): number {
  switch (decision) {
    case 'exact_match':
      return expectedGtinMatch ? 0.95 : 0.85;
    case 'probable_match':
      return expectedGtinMatch ? 0.75 : 0.55;
    case 'parent_product_only':
      return 0.1;
    case 'wrong_variant':
      return 0.1;
    case 'conflict':
      return 0.1;
    case 'insufficient_evidence':
      return 0.3;
    case 'blocked':
      return 0.0;
  }
}

function resolveIdentity(
  input: ResolverSpecialistInput,
  decisions: CandidateDecision[],
): ResolvedIdentity {
  const expected = input.expectedIdentity;

  // Prefer exact_match with expected GTIN, then probable_match with GTIN,
  // then any non-blocked candidate.
  const ranked = [...decisions].sort((a, b) => {
    const rank = (d: CandidateDecision): number => {
      const gtinMatch = d.gtin !== null && expected.gtin !== null && digits(d.gtin) === digits(expected.gtin);
      switch (d.decision) {
        case 'exact_match': return gtinMatch ? 100 : 90;
        case 'probable_match': return gtinMatch ? 80 : 60;
        case 'insufficient_evidence': return d.gtin ? 20 : 10;
        case 'parent_product_only': return 5;
        case 'wrong_variant': return 5;
        case 'conflict': return 1;
        case 'blocked': return 0;
      }
    };
    return rank(b) - rank(a);
  });

  const best = ranked[0];
  if (!best) {
    return {
      status: 'unresolved',
      confidence: 0,
      candidateId: null,
      candidateUrl: null,
      gtin: null,
      upc: null,
      decisions,
      nextEvidence: 'exact_gtin_match',
    };
  }

  const expectedGtin = expected.gtin !== null ? digits(expected.gtin) : null;
  const rawBestGtin = best.gtin !== null ? digits(best.gtin) : null;
  const gtinMatch = rawBestGtin !== null && expectedGtin !== null && rawBestGtin === expectedGtin;
  const confidence = identityConfidence(best.decision, gtinMatch);

  // A 14-digit value is a case identifier: it only resolves identity when it
  // exactly matches the expected (case-scoped) GTIN. It is never promoted to
  // a consumer identity.
  const resolvedGtin = rawBestGtin !== null && (rawBestGtin.length !== 14 || gtinMatch) ? rawBestGtin : null;
  const upc = resolvedGtin !== null && resolvedGtin.length === 12 ? resolvedGtin : null;

  let status: IdentityStatus;
  let nextEvidence: string | null;
  switch (best.decision) {
    case 'exact_match':
      if (expectedGtin !== null && resolvedGtin !== null && resolvedGtin !== expectedGtin) {
        status = 'conflict';
        nextEvidence = 'exact_gtin_match';
      } else {
        status = 'resolved';
        nextEvidence = null;
      }
      break;
    case 'probable_match':
      if (expectedGtin !== null && resolvedGtin !== null && resolvedGtin !== expectedGtin) {
        status = 'conflict';
        nextEvidence = 'exact_gtin_match';
      } else if (resolvedGtin !== null && expectedGtin !== null) {
        status = 'resolved';
        nextEvidence = null;
      } else {
        status = 'ambiguous';
        nextEvidence = 'exact_gtin_match';
      }
      break;
    case 'parent_product_only':
      status = 'unresolved';
      nextEvidence = 'exact_variant_page';
      break;
    case 'wrong_variant':
      status = 'unresolved';
      nextEvidence = 'correct_variant_page';
      break;
    case 'conflict':
      status = 'conflict';
      nextEvidence = 'exact_gtin_match';
      break;
    case 'insufficient_evidence':
      status = 'unresolved';
      nextEvidence = rawBestGtin ? 'exact_gtin_match' : 'additional_source';
      break;
    case 'blocked':
      status = 'unresolved';
      nextEvidence = 'extraction_retry';
      break;
  }

  return {
    status,
    confidence: round6(confidence),
    candidateId: best.candidateId,
    candidateUrl: best.url,
    gtin: resolvedGtin,
    upc,
    decisions,
    nextEvidence,
  };
}

// ── Field confidence ─────────────────────────────────────────────────────────

function authorityRank(sourceKind: SourceKind, policy: SourceAuthorityPolicy): number {
  const idx = policy.ranking.indexOf(sourceKind);
  return idx === -1 ? policy.ranking.length : idx;
}

/**
 * Compute per-field confidence for a resolved fact.
 * Base 0.5 for a single source, +0.2 for a second independent source,
 * +0.1 for a third, scaled by source authority (0..0.15 bonus for
 * top-ranked sources).
 */
function fieldConfidence(
  refs: EvidenceRef[],
  policy: SourceAuthorityPolicy,
): number {
  if (refs.length === 0) return 0;
  const uniqueSources = new Set(refs.map((r) => r.url ?? r.id));
  const corroboration = Math.min(0.4, 0.2 * (uniqueSources.size - 1));
  const bestAuthority = Math.min(...refs.map((r) => authorityRank(r.sourceKind, policy)));
  const authorityBonus = Math.max(0, 0.15 - bestAuthority * 0.03);
  return round6(Math.min(0.95, 0.5 + corroboration + authorityBonus));
}

// ── Reconciliation ───────────────────────────────────────────────────────────

interface FactOutcome {
  fact: ResolvedFact;
  conflicts: FactConflict[];
  abstentions: { field: string; reason: string }[];
}

function emptyFact(
  field: string,
  isCore: boolean,
  refs: EvidenceRef[],
): FactOutcome {
  const status: FactStatus = isCore ? 'needs_more_evidence' : 'abstained';
  const notes = isCore ? 'no evidence observed for this core field' : 'no evidence observed for this optional field';
  const fact: ResolvedFact = {
    field,
    status,
    value: null,
    canonicalQuantity: null,
    identifierScope: null,
    dimensionScope: null,
    confidence: 0,
    supportingEvidence: refs,
    contradictingEvidence: [],
    notes,
  };
  return {
    fact,
    conflicts: [],
    abstentions: [{ field, reason: notes }],
  };
}

function resolvedFact(
  field: string,
  value: string,
  refs: EvidenceRef[],
  policy: SourceAuthorityPolicy,
  extra?: Partial<ResolvedFact>,
): FactOutcome {
  return {
    fact: {
      field,
      status: 'resolved',
      value,
      canonicalQuantity: null,
      identifierScope: null,
      dimensionScope: null,
      confidence: fieldConfidence(refs, policy),
      supportingEvidence: refs,
      contradictingEvidence: [],
      notes: null,
      ...extra,
    },
    conflicts: [],
    abstentions: [],
  };
}

function conflictFact(
  field: string,
  sides: ConflictSide[],
  allRefs: EvidenceRef[],
  reason: string,
): FactOutcome {
  return {
    fact: {
      field,
      status: 'conflict',
      value: null,
      canonicalQuantity: null,
      identifierScope: null,
      dimensionScope: null,
      confidence: 0.1,
      supportingEvidence: [],
      contradictingEvidence: allRefs,
      notes: `conflict: ${reason}`,
    },
    conflicts: [{ field, sides, reason }],
    abstentions: [],
  };
}

/**
 * Reconcile exact-match (non-numeric) fields: title, brand, sku.
 * All refs must agree on the trimmed value; otherwise conflict.
 */
function reconcileExact(
  field: string,
  refs: EvidenceRef[],
  policy: SourceAuthorityPolicy,
  isCore: boolean,
): FactOutcome {
  if (refs.length === 0) return emptyFact(field, isCore, refs);

  const byValue = new Map<string, EvidenceRef[]>();
  for (const ref of refs) {
    const key = ref.rawValue.trim().toLowerCase();
    const list = byValue.get(key) ?? [];
    list.push(ref);
    byValue.set(key, list);
  }

  if (byValue.size === 1) {
    // All agree — pick the display value from the most authoritative source.
    const all = [...byValue.values()][0];
    const best = all.sort((a, b) => authorityRank(a.sourceKind, policy) - authorityRank(b.sourceKind, policy))[0];
    return resolvedFact(field, best.rawValue.trim(), all, policy);
  }

  // Conflict: group by value for the conflict sides.
  const sides: ConflictSide[] = [...byValue.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, valueRefs]) => {
      const best = valueRefs.sort((a, b) => authorityRank(a.sourceKind, policy) - authorityRank(b.sourceKind, policy))[0];
      return {
        value: best.rawValue.trim(),
        sourceKind: best.sourceKind,
        url: best.url,
        evidenceIds: valueRefs.map((r) => r.id),
      };
    });
  return conflictFact(field, sides, refs, `sources disagree: ${sides.map((s) => s.value).join(' vs ')}`);
}

/**
 * Reconcile numeric quantity fields: weight, size, dimensions, packCount.
 * Equivalent values (within tolerance) resolve; different values conflict.
 */
function unparseableFact(field: string, refs: EvidenceRef[], note: string): FactOutcome {
  // Unparseable values — never force.
  const fact: ResolvedFact = {
    field,
    status: 'needs_more_evidence',
    value: null,
    canonicalQuantity: null,
    identifierScope: null,
    dimensionScope: dimensionScopeForField(field),
    confidence: 0,
    supportingEvidence: refs,
    contradictingEvidence: [],
    notes: note,
  };
  return { fact, conflicts: [], abstentions: [{ field, reason: note }] };
}

function reconcileDimensions(
  field: string,
  refs: EvidenceRef[],
  policy: SourceAuthorityPolicy,
  isCore: boolean,
): FactOutcome {
  if (refs.length === 0) return emptyFact(field, isCore, refs);

  const parsed = refs
    .map((ref) => ({ ref, dims: parseDimensions(ref.rawValue) }))
    .filter((p): p is { ref: EvidenceRef; dims: { parts: [number, number, number]; unit: string } } => p.dims !== null);

  if (parsed.length === 0) {
    return unparseableFact(field, refs, 'observed values are not parseable as L x W x H dimensions');
  }

  // Group by canonical inch triple (dimension scope is fixed by the field:
  // product / case / shipping — case and shipping dimensions are never
  // promoted to product dimensions).
  const groups: { parts: [number, number, number]; refs: EvidenceRef[] }[] = [];
  for (const { ref, dims } of parsed) {
    const existing = groups.find(
      (g) => g.parts[0] === dims.parts[0] && g.parts[1] === dims.parts[1] && g.parts[2] === dims.parts[2],
    );
    if (existing) existing.refs.push(ref);
    else groups.push({ parts: dims.parts, refs: [ref] });
  }

  if (groups.length === 1) {
    const group = groups[0];
    const displayValue = `${group.parts[0]} x ${group.parts[1]} x ${group.parts[2]} in`;
    return resolvedFact(field, displayValue, group.refs, policy, {
      dimensionScope: dimensionScopeForField(field),
    });
  }

  const sides: ConflictSide[] = groups
    .map((g) => g.refs.sort((a, b) => authorityRank(a.sourceKind, policy) - authorityRank(b.sourceKind, policy))[0])
    .sort((a, b) => a.rawValue.localeCompare(b.rawValue))
    .map((ref) => {
      const group = groups.find((g) => g.refs.includes(ref))!;
      return {
        value: ref.rawValue.trim(),
        sourceKind: ref.sourceKind,
        url: ref.url,
        evidenceIds: group.refs.map((r) => r.id),
      };
    });
  return conflictFact(field, sides, refs, `sources disagree on dimensions: ${sides.map((s) => s.value).join(' vs ')}`);
}

function reconcileQuantities(
  field: string,
  refs: EvidenceRef[],
  policy: SourceAuthorityPolicy,
  isCore: boolean,
): FactOutcome {
  if (refs.length === 0) return emptyFact(field, isCore, refs);

  if (field === 'dimensions' || field === 'caseDimensions' || field === 'shippingDimensions') {
    return reconcileDimensions(field, refs, policy, isCore);
  }

  const parsed: { ref: EvidenceRef; qty: CanonicalQuantity }[] = [];
  for (const ref of refs) {
    const qty = parseQuantity(ref.rawValue, field);
    if (qty !== null) parsed.push({ ref, qty });
  }

  if (parsed.length === 0) {
    return unparseableFact(field, refs, 'observed values are not parseable as a canonical quantity');
  }

  // Group by equivalence.
  const groups: { representative: CanonicalQuantity; refs: EvidenceRef[] }[] = [];
  for (const { ref, qty } of parsed) {
    const existing = groups.find((g) => quantitiesEquivalent(g.representative, qty));
    if (existing) {
      existing.refs.push(ref);
    } else {
      groups.push({ representative: qty, refs: [ref] });
    }
  }

  if (groups.length === 1) {
    const group = groups[0];
    const best = group.refs.sort((a, b) => authorityRank(a.sourceKind, policy) - authorityRank(b.sourceKind, policy))[0];
    return resolvedFact(field, best.rawValue.trim(), group.refs, policy, {
      canonicalQuantity: group.representative,
    });
  }

  // Multiple equivalence groups → conflict.
  const sides: ConflictSide[] = groups
    .map((g) => g.refs.sort((a, b) => authorityRank(a.sourceKind, policy) - authorityRank(b.sourceKind, policy))[0])
    .sort((a, b) => a.rawValue.localeCompare(b.rawValue))
    .map((ref) => {
      const group = groups.find((g) => g.refs.includes(ref))!;
      return {
        value: ref.rawValue.trim(),
        sourceKind: ref.sourceKind,
        url: ref.url,
        evidenceIds: group.refs.map((r) => r.id),
      };
    });
  return conflictFact(field, sides, refs, `sources disagree on quantity: ${sides.map((s) => s.value).join(' vs ')}`);
}

function dimensionScopeForField(field: string): DimensionScope | null {
  switch (field) {
    case 'dimensions': return 'product';
    case 'caseDimensions': return 'case';
    case 'shippingDimensions': return 'shipping';
    default: return null;
  }
}

/**
 * Reconcile identifier fields (gtin, caseGtin, innerPackGtin, sku-as-identifier).
 * Scope is determined by digit length and expected identity.
 * A 14-digit value in the consumer GTIN slot is never promoted to consumer.
 */
function reconcileIdentifiers(
  field: string,
  refs: EvidenceRef[],
  expected: ExpectedIdentity,
  policy: SourceAuthorityPolicy,
  isCore: boolean,
): FactOutcome {
  if (refs.length === 0) return emptyFact(field, isCore, refs);

  // Assign scopes.
  const scoped = refs.map((ref) => ({
    ref,
    scope: scopeForIdentifier(ref.rawValue, expected),
  }));

  // For the consumer GTIN field, only consumer_unit scope refs count.
  // For caseGtin / innerPackGtin, use the field's own scope.
  const identityScope: IdentifierScope = field === 'gtin'
    ? expected.gtinScope
    : field === 'caseGtin'
      ? 'case'
      : field === 'innerPackGtin'
        ? 'inner'
        : 'consumer_unit';

  const inScope = scoped.filter((s) => s.scope === identityScope);
  const outOfScope = scoped.filter((s) => s.scope !== identityScope && s.scope !== 'unknown');

  if (inScope.length === 0) {
    if (!isCore) {
      return emptyFact(field, isCore, inScope.map((s) => s.ref));
    }
    // No in-scope identifier observed for core field.
    const notes = outOfScope.length > 0
      ? `observed identifiers are out of scope for ${field} (got ${[...new Set(outOfScope.map((s) => s.scope))].join(', ')})`
      : `no in-scope identifier observed for ${field}`;
    const fact: ResolvedFact = {
      field,
      status: 'needs_more_evidence',
      value: null,
      canonicalQuantity: null,
      identifierScope: identityScope,
      dimensionScope: null,
      confidence: 0,
      supportingEvidence: refs,
      contradictingEvidence: [],
      notes,
    };
    return { fact, conflicts: [], abstentions: [{ field, reason: notes }] };
  }

  // All in-scope refs must agree.
  const byValue = new Map<string, { ref: EvidenceRef; scope: IdentifierScope }[]>();
  for (const s of inScope) {
    const key = digits(s.ref.rawValue);
    const list = byValue.get(key) ?? [];
    list.push(s);
    byValue.set(key, list);
  }

  if (byValue.size === 1) {
    const all = [...byValue.values()][0];
    const best = all.sort((a, b) => authorityRank(a.ref.sourceKind, policy) - authorityRank(b.ref.sourceKind, policy))[0];
    return resolvedFact(field, digits(best.ref.rawValue), all.map((s) => s.ref), policy, {
      identifierScope: identityScope,
    });
  }

  const sides: ConflictSide[] = [...byValue.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, entries]) => {
      const best = entries.sort((a, b) => authorityRank(a.ref.sourceKind, policy) - authorityRank(b.ref.sourceKind, policy))[0];
      return {
        value,
        sourceKind: best.ref.sourceKind,
        url: best.ref.url,
        evidenceIds: entries.map((e) => e.ref.id),
      };
    });
  return conflictFact(field, sides, refs, `sources disagree on ${field}: ${sides.map((s) => s.value).join(' vs ')}`);
}

// ── Main reconciliation ──────────────────────────────────────────────────────

export interface ResolveFactSetOptions {
  /** Injectable clock for deterministic timestamps (defaults to now). */
  now?: () => string;
}

export function resolveFactSet(
  parsed: ResolverSpecialistInput,
  options: ResolveFactSetOptions = {},
): ResolvedFactSet {
  const policy = parsed.sourceAuthority;
  const expected = parsed.expectedIdentity;
  const now = options.now ?? (() => new Date().toISOString());

  // Collect evidence references.
  const ctx: ExtractionContext = {
    refs: new Map(),
    candidateSourceKinds: new Map(),
    candidateByUrl: new Map(),
  };
  const bundleUrls = new Set<string>();
  for (const bundle of parsed.extractionBundles) {
    bundleUrls.add(normalizeUrl(bundle.requestedUrl));
    bundleUrls.add(normalizeUrl(bundle.finalUrl));
  }
  for (const candidate of parsed.discoveryCandidates) {
    extractFromCandidate(ctx, candidate, bundleUrls);
  }
  const bundleByCandidate = new Map<string, ExtractionEvidenceBundle | null>();
  for (const bundle of parsed.extractionBundles) {
    extractFromBundle(ctx, bundle);
    const candidate = linkBundleToCandidate(ctx, bundle);
    if (candidate) {
      const key = candidateKey(candidate);
      if (!bundleByCandidate.has(key)) bundleByCandidate.set(key, bundle);
    }
  }
  for (const candidate of parsed.discoveryCandidates) {
    const key = candidateKey(candidate);
    if (!bundleByCandidate.has(key)) bundleByCandidate.set(key, null);
  }

  // Identity.
  const decisions = parsed.discoveryCandidates.map((candidate) =>
    decisionForCandidate(candidate, bundleByCandidate.get(candidateKey(candidate)) ?? null, expected),
  );
  const identity = resolveIdentity(parsed, decisions);

  // Facts.
  const allRefs = [...ctx.refs.values()];
  const facts: ResolvedFact[] = [];
  const conflicts: FactConflict[] = [];
  const abstentions: { field: string; reason: string }[] = [];

  // Evidence refs always store the canonical field name (raw observation
  // fields are mapped at collection time), so compare directly.
  const refsFor = (field: string): EvidenceRef[] => {
    if (field === 'gtin' || field === 'caseGtin' || field === 'innerPackGtin') {
      return allRefs.filter((r) => r.field === 'gtin' || r.field === 'caseGtin' || r.field === 'innerPackGtin');
    }
    return allRefs.filter((r) => r.field === field);
  };

  const reconcile = (field: string): void => {
    const refs = refsFor(field);
    const isCore = (RESOLVER_CORE_FIELDS as readonly string[]).includes(field);
    let outcome: FactOutcome;
    switch (field) {
      case 'gtin':
      case 'caseGtin':
      case 'innerPackGtin':
        outcome = reconcileIdentifiers(field, refs, expected, policy, isCore);
        break;
      case 'weight':
      case 'size':
      case 'dimensions':
      case 'caseDimensions':
      case 'shippingDimensions':
      case 'packCount':
        outcome = reconcileQuantities(field, refs, policy, isCore);
        break;
      default:
        outcome = reconcileExact(field, refs, policy, isCore);
        break;
    }
    facts.push(outcome.fact);
    conflicts.push(...outcome.conflicts);
    abstentions.push(...outcome.abstentions);
  };

  for (const field of RESOLVER_CANONICAL_FIELDS) {
    reconcile(field);
  }

  // Field completeness.
  const fieldCompleteness: FieldCompleteness = {
    total: facts.length,
    resolved: facts.filter((f) => f.status === 'resolved').length,
    conflicts: facts.filter((f) => f.status === 'conflict').length,
    needsMoreEvidence: facts.filter((f) => f.status === 'needs_more_evidence').length,
    abstained: facts.filter((f) => f.status === 'abstained').length,
  };

  return {
    schemaVersion: RESOLVER_OUTPUT_SCHEMA_VERSION,
    specialist: RESOLVER_SPECIALIST_NAME,
    specialistVersion: RESOLVER_SPECIALIST_VERSION,
    productSeed: parsed.productSeed,
    expectedIdentity: expected,
    identity,
    facts,
    fieldCompleteness,
    conflicts,
    evidenceRegistry: Object.fromEntries(ctx.refs),
    abstentions,
    sourceAuthority: {
      configVersion: policy.configVersion,
      configId: sourceAuthorityConfigId(policy),
      ranking: policy.ranking,
    },
    resolvedAt: now(),
  };
}

// ── ResolverSpecialist (specialist contract) ─────────────────────────────────

export interface ResolverSpecialistOptions {
  /** Deterministic build identity for artifact provenance; env/git is the fallback. */
  codeCommit?: string | null;
  /** Injectable clock for deterministic resolvedAt (defaults to now). */
  now?: () => string;
}

/**
 * ResolverSpecialist — deterministic identity and field reconciliation.
 *
 * Pure function over its typed input: no network I/O, no model calls, no
 * catalog writes. Consumes Discovery candidates + extraction evidence bundles
 * and emits a ResolvedFactSet artifact.
 */
export class ResolverSpecialist {
  readonly capability = RESOLVER_SPECIALIST_CAPABILITY;
  private readonly codeCommit: string | null;
  private readonly now: () => string;

  constructor(options: ResolverSpecialistOptions = {}) {
    this.codeCommit = options.codeCommit ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Execute through the #48 specialist boundary, returning only the bounded result. */
  async execute(rawInput: unknown, context: SpecialistContext): Promise<SpecialistResult> {
    const startedAt = Date.now();
    const parsed = ResolverSpecialistInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        specialist: RESOLVER_SPECIALIST_NAME,
        outcome: 'failed',
        failure: {
          code: 'invalid_input',
          message: summarizeZodIssues(parsed.error).join('; ').slice(0, 4096),
        },
        durationMs: Date.now() - startedAt,
      };
    }
    if (context.signal?.aborted) {
      return {
        specialist: RESOLVER_SPECIALIST_NAME,
        outcome: 'failed',
        failure: { code: 'cancelled', message: 'resolver cancelled' },
        durationMs: Date.now() - startedAt,
      };
    }
    const factSet = resolveFactSet(parsed.data, { now: this.now });
    const durationMs = Date.now() - startedAt;
    const artifact = finalizeSpecialistArtifact({
      artifactType: RESOLVER_OUTPUT_ARTIFACT_TYPE,
      payload: factSet,
      payloadSchema: ResolvedFactSetSchema,
      lineage: { runId: context.runId },
      provenance: {
        specialist: RESOLVER_SPECIALIST_NAME,
        specialistVersion: RESOLVER_SPECIALIST_VERSION,
        policyConfigId: context.policy.configId,
        codeCommit: this.codeCommit ?? captureSpecialistCodeCommit(),
        durationMs,
      },
    });
    const result: SpecialistResult = {
      specialist: RESOLVER_SPECIALIST_NAME,
      outcome: 'succeeded',
      output: artifact,
      durationMs,
    };
    return SpecialistResultSchema.parse(result);
  }
}

/** Orchestrator-facing convenience; does not route or dispatch. */
export async function runResolverSpecialist(
  input: unknown,
  context: SpecialistContext,
  options: ResolverSpecialistOptions = {},
): Promise<SpecialistResult> {
  return new ResolverSpecialist(options).execute(input, context);
}

// ── Capability + artifact schemas ────────────────────────────────────────────

export const RESOLVER_SPECIALIST_CAPABILITY: SpecialistCapability = {
  name: RESOLVER_SPECIALIST_NAME,
  version: RESOLVER_SPECIALIST_VERSION,
  kind: 'identity',
  summary:
    'Deterministic identity and field reconciliation: consumes Discovery candidates and extraction evidence bundles, emits a versioned ResolvedFactSet with per-field confidence, preserved conflicts, identifier/dimension scoping, and config-driven source authority.',
  input: { schemaName: RESOLVER_INPUT_ARTIFACT_TYPE, schemaVersion: RESOLVER_INPUT_SCHEMA_VERSION },
  output: { schemaName: RESOLVER_OUTPUT_ARTIFACT_TYPE, schemaVersion: RESOLVER_OUTPUT_SCHEMA_VERSION },
};

export const resolverSpecialistCapability = RESOLVER_SPECIALIST_CAPABILITY;

export const RESOLVER_INPUT_ARTIFACT_SCHEMA = {
  name: RESOLVER_INPUT_ARTIFACT_TYPE,
  version: RESOLVER_INPUT_SCHEMA_VERSION,
  schema: ResolverSpecialistInputSchema,
  description:
    'Typed discovery candidates + extraction evidence bundles for identity/field reconciliation',
} as const;

export const RESOLVER_OUTPUT_ARTIFACT_SCHEMA = {
  name: RESOLVER_OUTPUT_ARTIFACT_TYPE,
  version: RESOLVER_OUTPUT_SCHEMA_VERSION,
  schema: ResolvedFactSetSchema,
  description:
    'Versioned ResolvedFactSet: reconciled facts, identity, conflicts, evidence registry',
} as const;

export function registerResolverSchemas(registry: SpecialistArtifactSchemaRegistry): SpecialistArtifactSchemaRegistry {
  return registry.register(RESOLVER_INPUT_ARTIFACT_SCHEMA).register(RESOLVER_OUTPUT_ARTIFACT_SCHEMA);
}
