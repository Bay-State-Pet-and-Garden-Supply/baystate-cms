import { createHash } from 'node:crypto';
import type { EvidenceAttempt, ProductIdentityEvidence } from '../../shared/schemas/distributor-evidence';
import { ProductIdentityEvidenceSchema } from '../../shared/schemas/distributor-evidence';
import type { ConnectorVariantAxisDeclaration } from './contracts';
import {
  normalizeGtin,
  isIdentityCriticalField,
  normalizeVariantAxis,
  normalizeDeclaredVariantAxis,
  isUnknownVariantAxis,
} from './contracts';
import { normalizeIdentityValueForComparison } from '../normalization/identity';

/**
 * Deterministic distributor-record projection (Amendment A).
 *
 * One pure authority for the Discovery-skipping `distributor_record_to_extraction`
 * qualification and evidence hash. Reused by reconciliation, automatic/manual
 * routing, final conflict resolution, and materialization:
 *
 * - Identity-only: exact normalized UPC/GTIN, distributor SKU, MPN, name,
 *   noncanonical brand, weight, whitelisted variant attributes, provenance.
 *   NO description/bullets/claims, price/inventory, images, arbitrary raw
 *   fields, secrets, or confidence authority.
 * - Qualification floor: exact normalized identifier equality, current-generation
 *   accepted evidence, ≥1 nonblank name, complete provenance, no open hard
 *   conflict. Confidence never affects the result.
 * - Deterministic and order-insensitive: providers, attempts, keys, and
 *   multi-values are sorted before hashing.
 * - Operator conflict resolutions are explicit inputs: `candidate_selected`
 *   adopts that candidate, `custom_override` adopts the reviewed value,
 *   `dismiss` removes the field (remaining evidence must still qualify).
 */

export const PROJECTION_VERSION = 'distributor-record-projection-v1';

/** Amendment B (M5): the v2 merchandising-depth projection version. */
export const PROJECTION_VERSION_V2 = 'distributor-record-projection-v2';

export const SOURCING_PROJECTION_REASON_CODES = [
  'no_accepted_evidence',
  'incomplete_provenance',
  'identifier_mismatch',
  'stale_generation',
  'empty_identity',
  'unknown_variant_axis',
  'open_hard_conflict',
  'missing_name',
  'cross_item_attempt',
] as const;
export type SourcingProjectionReasonCode = (typeof SOURCING_PROJECTION_REASON_CODES)[number];

/** Operator conflict resolution inputs applied before qualification. */
export interface ProjectionResolutionInput {
  field: string;
  kind: 'candidate_selected' | 'custom_override' | 'dismissed';
  /** Value for `custom_override`; the resolved value for `candidate_selected` (taken from the named attempt). */
  value?: string | null;
  /** Attempt whose candidate is adopted when kind === 'candidate_selected'. */
  attemptId?: string | null;
}

export interface DistributorRecordProjectionInput {
  itemId: string;
  /** The item's raw UPC as imported; normalized inside. */
  itemUpc: string;
  /** The current sourcing generation (stale attempts are rejected). */
  sourcingGenerationId: string;
  /** Current-generation evidence attempts (immutable rows). */
  attempts: EvidenceAttempt[];
  /** Accepted attempt ids (post-reconciliation or post-resolution state). */
  acceptedAttemptIds: string[];
  /**
   * Connector-declared variant axes for the generation (Amendment A).
   * Loose normalized names; use `variantAxisDeclarations` for the durable
   * raw-field → normalized-axis registry.
   */
  declaredVariantAxes?: string[];
  /**
   * Amendment A durable registry: raw-field → normalized-axis declarations.
   * When present, raw attribute keys are matched exactly against
   * `rawField`, and each declaration's `normalizedAxis` joins the hard
   * identity-field set for this generation.
   */
  variantAxisDeclarations?: ConnectorVariantAxisDeclaration[];
  /** Operator conflict resolutions (explicit projection inputs). */
  resolutions?: ProjectionResolutionInput[];
}

/**
 * Amendment B (M5): one merchandising provenance entry — the values ONE
 * accepted attempt supplied for ONE merchandising field, with the attempt's
 * provider/catalog/connection identity.
 */
export interface MerchandisingProvenanceEntry {
  attemptId: string;
  providerId: string;
  catalogVersion: string;
  connectionId: string;
  /** Bounded values that THIS attempt supplied for the field (sorted). */
  values: string[];
}

/**
 * Amendment B (M5): the v2 merchandising-depth projection. Extends the v1
 * identity authority with explicit bounded merchandising fields and their
 * dedicated per-field provenance. The v2 evidence hash covers all selected
 * and merged fields PLUS all provenance (order-insensitive canonical JSON).
 */
export interface DistributorRecordProjectionV2 extends Omit<DistributorRecordProjection, 'version'> {
  version: typeof PROJECTION_VERSION_V2;
  description: string | null;
  /** Case-insensitive sorted-unique union, deterministic display spelling. */
  features: string[];
  category: string | null;
  dimensions: string | null;
  casePack: string | null;
  unitOfMeasure: string | null;
  ingredients: string | null;
  /** Sorted-unique HTTPS image candidate URLs (display-only). */
  imageUrls: string[];
  /** Per-field merchandising provenance grouped by attempt. */
  merchandisingProvenance: Record<string, MerchandisingProvenanceEntry[]>;
}

export interface DistributorRecordProjection {
  version: typeof PROJECTION_VERSION;
  upc: string;
  gtin: string | null;
  distributorSku: string | null;
  manufacturerPartNumber: string | null;
  name: string;
  brand: string | null;
  weight: string | null;
  size: string | null;
  count: string | null;
  packCount: string | null;
  flavor: string | null;
  formula: string | null;
  /** Connector-declared variant axes and their qualified values (Amendment A). */
  customVariantAxes: Record<string, string>;
  provenance: {
    /** Sorted-unique provider ids whose accepted attempts contributed. */
    providerIds: string[];
    /** Sorted-unique accepted evidence attempt ids. */
    acceptedAttemptIds: string[];
    sourcingGenerationId: string;
    /** Sorted-unique catalog versions observed on contributing attempts. */
    catalogVersions: string[];
    /** Sorted-unique observation timestamps of contributing attempts. */
    observedAt: string[];
    /** Sorted-unique distributor connection ids of contributing attempts. */
    connectionIds: string[];
    /** Per-field provenance: which attempt/provider/catalogVersion/connection supplied each projected field. */
    fieldProvenance: Record<
      string,
      Array<{ attemptId: string; providerId: string; catalogVersion: string; connectionId: string }>
    >;
  };
}

/** Shared failure branch for both result unions (structurally identical). */
export interface SourcingProjectionFailure {
  qualified: false;
  reasonCodes: SourcingProjectionReasonCode[];
  acceptedAttemptIds: string[];
  providerIds: string[];
  warnings: string[];
}

export type SourcingProjectionResult =
  | {
      qualified: true;
      projection: DistributorRecordProjection;
      evidenceHash: string;
      acceptedAttemptIds: string[];
      providerIds: string[];
      warnings: string[];
    }
  | SourcingProjectionFailure;

/** Amendment B (M5): the v2 default-authority result shape. */
export type SourcingProjectionResultV2 =
  | {
      qualified: true;
      projection: DistributorRecordProjectionV2;
      evidenceHash: string;
      acceptedAttemptIds: string[];
      providerIds: string[];
      warnings: string[];
    }
  | SourcingProjectionFailure;

// ─── Canonical JSON (deterministic hashing) ────────────────────────────────────

/**
 * Order-insensitive canonical JSON: object keys are sorted recursively;
 * arrays preserve their (pre-sorted) order. Undefined values are omitted.
 * Primitives are serialized with JSON.stringify, which is deterministic.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 hex of the canonical JSON of a projection (excluding the hash
 * itself). The decision, extraction row, extraction payload, and frozen
 * cohort projection must all carry the SAME value.
 */
export function computeEvidenceHash(projection: DistributorRecordProjection | DistributorRecordProjectionV2): string {
  return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

// ─── Projection build ──────────────────────────────────────────────────────────

/**
 * Amendment B (M5): merchandising scalar fields the v2 projection may carry.
 * Never identity-critical: disagreements warn, never block qualification.
 */
const MERCHANDISING_SCALAR_FIELDS = ['description', 'category', 'dimensions', 'casePack', 'unitOfMeasure', 'ingredients'] as const;

/** Identity fields the projection v1 may carry (identity-only allowlist). */
const PROJECTION_FIELDS = [
  'upc',
  'gtin',
  'distributorSku',
  'manufacturerPartNumber',
  'name',
  'brand',
  'weight',
  'size',
  'count',
  'packCount',
  'flavor',
  'formula',
] as const;
const EMPTY_RESULT = {
  acceptedAttemptIds: [] as string[],
  providerIds: [] as string[],
  warnings: [] as string[],
};

function fail(reasonCodes: SourcingProjectionReasonCode[], warnings: string[]): SourcingProjectionFailure {
  return { qualified: false, reasonCodes, ...EMPTY_RESULT, warnings };
}

/** Extract the per-field value from a parsed identity (attributes normalized). */
function identityFieldValue(
  identity: ProductIdentityEvidence,
  field: string,
  declaredAxes: ReadonlySet<string> = new Set(),
  rawToAxis: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (field === 'size' || field === 'count' || field === 'packCount' || field === 'flavor' || field === 'formula') {
    const attrs = identity.attributes ?? {};
    for (const [rawKey, rawVal] of Object.entries(attrs)) {
      if (normalizeVariantAxis(rawKey) === field) {
        return rawVal.trim() || null;
      }
    }
    return null;
  }
  if (declaredAxes.has(field)) {
    const attrs = identity.attributes ?? {};
    for (const [rawKey, rawVal] of Object.entries(attrs)) {
      // Durable registry first: exact rawField → normalizedAxis.
      if (rawToAxis.get(rawKey) === field) {
        return rawVal.trim() || null;
      }
      // Fallback: normalization-based matching for loose declarations.
      if (normalizeDeclaredVariantAxis(rawKey) === field) {
        return rawVal.trim() || null;
      }
    }
    return null;
  }
  const value = (identity as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Build the deterministic projection (shared v1/v2 core). `merchandising:
 * true` produces the Amendment B v2 authority (identity + merchandising
 * fields + dedicated provenance); `false` reproduces the v1 identity-only
 * authority BYTE-FOR-BYTE (same fields, same version, same hash) for
 * historical verification. Returns `qualified: true` with the projection and
 * evidence hash, or `qualified: false` with stable reason codes. Never
 * throws; never writes; never reads env/DB.
 */
function buildProjectionCore(
  input: DistributorRecordProjectionInput,
  merchandising: boolean,
): SourcingProjectionResultV2 {
  const warnings: string[] = [];
  const reasons = new Set<SourcingProjectionReasonCode>();

  if (!input.acceptedAttemptIds || input.acceptedAttemptIds.length === 0) {
    return fail(['no_accepted_evidence'], warnings);
  }

  const itemIdentifier = normalizeGtin(input.itemUpc);
  if (!itemIdentifier) {
    return fail(['empty_identity'], warnings);
  }

  const attemptsById = new Map(input.attempts.map((a) => [a.id, a]));

  // Every requested accepted id must resolve; a missing attempt fails closed.
  const missingIds = input.acceptedAttemptIds.filter((id) => !attemptsById.has(id));
  if (missingIds.length > 0) {
    warnings.push(`Accepted attempt(s) missing from evidence: ${missingIds.join(', ')}`);
    return fail(['incomplete_provenance'], warnings);
  }
  const accepted = input.acceptedAttemptIds.map((id) => attemptsById.get(id)!) as EvidenceAttempt[];

  // Cross-item ownership: a same-UPC attempt belonging to ANOTHER item can
  // never qualify this one (BLOCKER fix — authority must be item-exact).
  const foreign = accepted.find((a) => a.itemId !== input.itemId);
  if (foreign) {
    warnings.push(
      `Attempt ${foreign.id} belongs to item ${foreign.itemId}, not ${input.itemId} — cross-item evidence cannot qualify`,
    );
    return fail(['cross_item_attempt'], warnings);
  }

  // Provider-ordered iteration (deterministic across input orderings).
  accepted.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const resolutions = new Map<string, ProjectionResolutionInput>();
  for (const r of input.resolutions ?? []) {
    resolutions.set(r.field, r);
  }

  const declaredAxes = new Set<string>();
  for (const axis of input.declaredVariantAxes ?? []) {
    const normalized = normalizeDeclaredVariantAxis(axis);
    if (normalized) declaredAxes.add(normalized);
  }
  // Durable registry: rawField → normalizedAxis exact mapping; every
  // declaration's normalized axis joins the hard identity-field set.
  const rawToAxis = new Map<string, string>();
  for (const declaration of input.variantAxisDeclarations ?? []) {
    const normalized = normalizeDeclaredVariantAxis(declaration.normalizedAxis);
    if (!normalized) continue;
    declaredAxes.add(normalized);
    if (declaration.rawField && !rawToAxis.has(declaration.rawField)) {
      rawToAxis.set(declaration.rawField, normalized);
    }
  }
  const isHardField = (field: string) => isIdentityCriticalField(field) || declaredAxes.has(field);

  const parsedIdentities: Array<{ attempt: EvidenceAttempt; identity: ProductIdentityEvidence }> = [];

  for (const attempt of accepted) {
    // Generation provenance: accepted attempts must belong to the current generation.
    if (attempt.sourcingGenerationId !== input.sourcingGenerationId) {
      reasons.add('stale_generation');
      continue;
    }
    // Observation provenance floor: qualification requires a real observation
    // timestamp and catalog version (complete provenance is non-negotiable).
    if (!attempt.observedAt || !attempt.catalogVersion) {
      reasons.add('incomplete_provenance');
      warnings.push(
        `Attempt ${attempt.id} lacks observation provenance (observedAt/catalogVersion required for qualification)`,
      );
      continue;
    }
    // Connection authority (BLOCKER fix): an attempt must be bound to a real
    // distributor connection to qualify; connection provenance is part of the
    // hash so the projection pins exactly which connection supplied the record.
    if (!attempt.distributorConnectionId) {
      reasons.add('incomplete_provenance');
      warnings.push(`Attempt ${attempt.id} lacks distributorConnectionId — connection-bound provenance required for qualification`);
      continue;
    }
    if (attempt.outcome !== 'found') {
      reasons.add('incomplete_provenance');
      continue;
    }
    // Exact normalized lookup identifier equality (item ↔ attempt).
    if (normalizeGtin(attempt.lookupUpc) !== itemIdentifier) {
      reasons.add('identifier_mismatch');
      continue;
    }
    const raw = attempt.identityJson;
    if (!raw) {
      reasons.add('incomplete_provenance');
      continue;
    }
    let identity: ProductIdentityEvidence;
    try {
      const parsed = ProductIdentityEvidenceSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        reasons.add('incomplete_provenance');
        continue;
      }
      identity = parsed.data;
    } catch {
      reasons.add('incomplete_provenance');
      continue;
    }
    // Record identifier equality (identity upc/gtin must match the item).
    const recordIdentifier = normalizeGtin(identity.upc ?? null) ?? normalizeGtin(identity.gtin ?? null);
    if (!recordIdentifier) {
      reasons.add('empty_identity');
      continue;
    }
    if (recordIdentifier !== itemIdentifier) {
      reasons.add('identifier_mismatch');
      continue;
    }
    parsedIdentities.push({ attempt, identity });
  }

  if (parsedIdentities.length === 0) {
    return fail([...reasons] as SourcingProjectionReasonCode[], warnings);
  }

  // Unknown variant axes (Amendment A): never silently soft, never copy.
  // A raw key is KNOWN when it is a built-in axis, normalizes to a declared
  // axis, or is declared exactly via the durable rawField registry.
  for (const { identity } of parsedIdentities) {
    for (const [attrKey] of Object.entries(identity.attributes ?? {})) {
      if (normalizeVariantAxis(attrKey) !== null) continue;
      if (rawToAxis.has(attrKey)) continue;
      if (isUnknownVariantAxis(attrKey, input.declaredVariantAxes ?? [])) {
        // Resolution lookup agrees with the collection loop: try the raw
        // key first, then the normalized form of the key.
        const resolution =
          resolutions.get(attrKey) ?? resolutions.get(normalizeDeclaredVariantAxis(attrKey) ?? '');
        if (resolution?.kind !== 'dismissed') {
          reasons.add('unknown_variant_axis');
          warnings.push(`Unknown variant attribute '${attrKey}' — record insufficient for Discovery-skip qualification`);
        }
      }
    }
  }

  // Collect per-field values across accepted attempts (dismissed fields excluded),
  // tracking per-field attempt/provider/catalogVersion provenance.
  const declaredFields = Array.from(declaredAxes).sort();
  const allFields = [...PROJECTION_FIELDS, ...declaredFields];
  const fieldProvenance = new Map<
    string,
    Array<{ attemptId: string; providerId: string; catalogVersion: string; connectionId: string }>
  >();
  const fieldValues = new Map<string, string[]>();
  for (const { attempt, identity } of parsedIdentities) {
    for (const field of allFields) {
      const resolution = resolutions.get(field);
      if (resolution?.kind === 'dismissed') continue;
      const value = identityFieldValue(identity, field, declaredAxes, rawToAxis);
      if (value !== null) {
        if (!fieldValues.has(field)) fieldValues.set(field, []);
        const list = fieldValues.get(field)!;
        if (!list.includes(value)) list.push(value);
        const prov = fieldProvenance.get(field) ?? [];
        const entry = {
          attemptId: attempt.id,
          providerId: attempt.providerId,
          catalogVersion: attempt.catalogVersion ?? '',
          connectionId: attempt.distributorConnectionId ?? '',
        };
        if (!prov.some((p) => p.attemptId === entry.attemptId && p.providerId === entry.providerId)) {
          prov.push(entry);
        }
        fieldProvenance.set(field, prov);
      }
    }
  }

  // Apply resolutions (candidate_selected / custom_override) as canonical values.
  for (const [field, resolution] of resolutions) {
    if (resolution.kind === 'dismissed') continue;
    if (!allFields.includes(field)) continue;
    let resolvedValue: string | null = null;
    let resolvedProvenance: {
      attemptId: string;
      providerId: string;
      catalogVersion: string;
      connectionId: string;
    } | null = null;
    if (resolution.kind === 'custom_override') {
      resolvedValue = typeof resolution.value === 'string' && resolution.value.trim() ? resolution.value.trim() : null;
      if (resolvedValue !== null) {
        resolvedProvenance = {
          attemptId: `operator:${field}`,
          providerId: 'operator',
          catalogVersion: '',
          connectionId: '',
        };
      }
    } else if (resolution.kind === 'candidate_selected') {
      const target = parsedIdentities.find((p) => p.attempt.id === resolution.attemptId);
      if (target) {
        resolvedValue = identityFieldValue(target.identity, field, declaredAxes, rawToAxis);
        // Real attempt provenance (BLOCKER fix): never an operator placeholder
        // when the value genuinely came from a candidate attempt.
        resolvedProvenance = {
          attemptId: target.attempt.id,
          providerId: target.attempt.providerId,
          catalogVersion: target.attempt.catalogVersion ?? '',
          connectionId: target.attempt.distributorConnectionId ?? '',
        };
      }
    }
    if (resolvedValue !== null && resolvedProvenance !== null) {
      fieldValues.set(field, [resolvedValue]);
      fieldProvenance.set(field, [resolvedProvenance]);
    }
  }

  // ── Amendment B (M5): merchandising-depth collection (v2 only) ───────────
  // Explicit bounded fields; NEVER identity-critical. Disagreements on
  // merchandising scalars become bounded warnings, never conflict rows or
  // qualification reasons. Missing merchandising fields never block
  // qualification. `casePack` may seed the built-in identity `packCount`
  // (numeric only) — disagreement on THAT identity axis stays hard.
  const merchandisingProvenance: Record<string, MerchandisingProvenanceEntry[]> = {};
  if (merchandising) {
    const pushMerchEntry = (field: string, attempt: EvidenceAttempt, values: string[]) => {
      const sorted = [...new Set(values)].sort();
      const list = merchandisingProvenance[field] ?? [];
      if (!list.some((e) => e.attemptId === attempt.id && e.providerId === attempt.providerId)) {
        list.push({
          attemptId: attempt.id,
          providerId: attempt.providerId,
          catalogVersion: attempt.catalogVersion ?? '',
          connectionId: attempt.distributorConnectionId ?? '',
          values: sorted,
        });
        merchandisingProvenance[field] = list;
      }
    };
    const addProv = (field: string, attempt: EvidenceAttempt) => {
      const prov = fieldProvenance.get(field) ?? [];
      const entry = {
        attemptId: attempt.id,
        providerId: attempt.providerId,
        catalogVersion: attempt.catalogVersion ?? '',
        connectionId: attempt.distributorConnectionId ?? '',
      };
      if (!prov.some((p) => p.attemptId === entry.attemptId && p.providerId === entry.providerId)) {
        prov.push(entry);
        fieldProvenance.set(field, prov);
      }
    };
    for (const field of MERCHANDISING_SCALAR_FIELDS) {
      for (const { attempt, identity } of parsedIdentities) {
        const value = identityFieldValue(identity, field);
        if (value === null) continue;
        if (!fieldValues.has(field)) fieldValues.set(field, []);
        const list = fieldValues.get(field)!;
        if (!list.includes(value)) list.push(value);
        pushMerchEntry(field, attempt, [value]);
        addProv(field, attempt);
      }
    }
    // features: case-insensitive sorted-unique union, first-seen display
    // spelling preserved (attempt order is provider-sorted → deterministic).
    const featureOrder: string[] = [];
    for (const { attempt, identity } of parsedIdentities) {
      const feats = (identity.features ?? []).map((f) => (typeof f === 'string' ? f.trim() : '')).filter((f) => f.length > 0);
      if (feats.length > 0) pushMerchEntry('features', attempt, feats);
      for (const f of feats) {
        if (!featureOrder.some((existing) => existing.toLowerCase() === f.toLowerCase())) featureOrder.push(f);
      }
    }
    if (featureOrder.length > 0) {
      fieldValues.set(
        'features',
        [...featureOrder].sort((a, b) => {
          const la = a.toLowerCase();
          const lb = b.toLowerCase();
          return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
        }),
      );
    }
    // imageUrls: HTTPS-only sorted-unique union (display-only candidates).
    for (const { attempt, identity } of parsedIdentities) {
      const urls = (identity.images ?? [])
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => /^https:\/\//i.test(u));
      if (urls.length > 0) {
        pushMerchEntry('imageUrls', attempt, urls);
        for (const u of urls) {
          if (!fieldValues.has('imageUrls')) fieldValues.set('imageUrls', []);
          const list = fieldValues.get('imageUrls')!;
          if (!list.includes(u)) list.push(u);
          addProv('imageUrls', attempt);
        }
      }
    }
    const imageUrls = (fieldValues.get('imageUrls') ?? []).sort();
    if (imageUrls.length > 0) {
      fieldValues.set('imageUrls', imageUrls);
    }
    // Numeric casePack seeds the built-in identity packCount when no direct
    // packCount evidence exists (identity disagreement stays hard).
    if (!fieldValues.has('packCount')) {
      const numericCasePacks = (fieldValues.get('casePack') ?? []).filter((v) => /^\d+$/.test(v.trim()));
      if (numericCasePacks.length > 0) {
        fieldValues.set('packCount', [...new Set(numericCasePacks)]);
        const cpProv = fieldProvenance.get('casePack');
        if (cpProv) fieldProvenance.set('packCount', [...cpProv]);
      }
    }
    // Merchandising scalar disagreement → bounded warning only.
    for (const field of MERCHANDISING_SCALAR_FIELDS) {
      const values = (fieldValues.get(field) ?? []).filter((v) => v.trim().length > 0);
      if (values.length > 1) {
        const distinct = new Set(values.map((v) => v.toLowerCase()));
        if (distinct.size > 1) warnings.push(`merchandising_disagreement:${field}`);
      }
    }
  }

  // Multi-distributor values on identity-critical fields are auto-resolved to the winning candidate.
  for (const field of allFields) {
    const values = fieldValues.get(field) ?? [];
    if (values.length <= 1) continue;
    const comparisonValues = new Set(
      values.map((v) => {
        const normalized = normalizeIdentityValueForComparison(field, v);
        return normalized.status === 'normalized' ? normalized.comparisonValue : v.toLowerCase();
      }),
    );
    if (comparisonValues.size > 1 && isHardField(field)) {
      warnings.push(`Identity field '${field}' has multiple distributor values; auto-resolved to winning candidate`);
    }
  }

  // Nonblank product name is part of the qualification floor.
  const names = (fieldValues.get('name') ?? []).filter((n) => n.trim().length > 0);
  if (names.length === 0) {
    reasons.add('missing_name');
  }

  if (reasons.size > 0) {
    return {
      qualified: false,
      reasonCodes: [...reasons] as SourcingProjectionReasonCode[],
      acceptedAttemptIds: input.acceptedAttemptIds,
      providerIds: Array.from(new Set(parsedIdentities.map((p) => p.attempt.providerId))),
      warnings,
    };
  }

  const pick = (field: string): string | null => {
    const values = (fieldValues.get(field) ?? []).filter((v) => v.trim().length > 0);
    if (values.length === 0) return null;
    if (values.length === 1) return values[0];

    const counts = new Map<string, number>();
    for (const { identity } of parsedIdentities) {
      const v = identityFieldValue(identity, field, declaredAxes, rawToAxis);
      if (v && v.trim()) {
        const norm = normalizeIdentityValueForComparison(field, v.trim());
        const key = norm.status === 'normalized' ? norm.comparisonValue : norm.comparisonValue.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let maxCount = 0;
    for (const count of counts.values()) {
      if (count > maxCount) maxCount = count;
    }
    const topValues = values.filter((v) => {
      const norm = normalizeIdentityValueForComparison(field, v);
      const key = norm.status === 'normalized' ? norm.comparisonValue : norm.comparisonValue.toLowerCase();
      return (counts.get(key) ?? 0) === maxCount;
    });
    for (const { identity } of parsedIdentities) {
      const v = identityFieldValue(identity, field, declaredAxes, rawToAxis);
      if (v && topValues.includes(v)) {
        return v;
      }
    }
    return topValues[0] ?? values[0];
  };

  const builtInNames = new Set<string>(PROJECTION_FIELDS);
  const customAxes: Record<string, string> = {};
  for (const field of declaredFields) {
    if (builtInNames.has(field)) continue;
    const value = pick(field);
    if (value !== null) customAxes[field] = value;
  }

  const sortedFieldProvenance: Record<
    string,
    Array<{ attemptId: string; providerId: string; catalogVersion: string; connectionId: string }>
  > = {};
  for (const field of Array.from(fieldProvenance.keys()).sort()) {
    sortedFieldProvenance[field] = (fieldProvenance.get(field) ?? []).sort((a, b) =>
      a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0,
    );
  }

  const contributing = parsedIdentities.map((p) => p.attempt);

  // Amendment B (M5): v2 projection — identity + merchandising + dedicated
  // provenance. The evidence hash covers every selected/merged field and all
  // provenance; canonical JSON is key-sorted, so input order cannot change it.
  if (merchandising) {
    const pickMerch = (field: string): string | null => {
      const values = (fieldValues.get(field) ?? []).filter((v) => v.trim().length > 0);
      if (values.length === 0) return null;
      return [...values].sort()[0];
    };
    const sortedMerchProvenance: Record<string, MerchandisingProvenanceEntry[]> = {};
    for (const field of Object.keys(merchandisingProvenance).sort()) {
      sortedMerchProvenance[field] = (merchandisingProvenance[field] ?? []).sort((a, b) =>
        a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0,
      );
    }
    const projectionV2: DistributorRecordProjectionV2 = {
      version: PROJECTION_VERSION_V2,
      upc: itemIdentifier,
      gtin: pick('gtin'),
      distributorSku: pick('distributorSku'),
      manufacturerPartNumber: pick('manufacturerPartNumber'),
      name: pick('name') ?? names[0],
      brand: pick('brand'),
      weight: pick('weight'),
      size: pick('size'),
      count: pick('count'),
      packCount: pick('packCount'),
      flavor: pick('flavor'),
      formula: pick('formula'),
      customVariantAxes: customAxes,
      description: pickMerch('description'),
      features: fieldValues.get('features') ?? [],
      category: pickMerch('category'),
      dimensions: pickMerch('dimensions'),
      casePack: pickMerch('casePack'),
      unitOfMeasure: pickMerch('unitOfMeasure'),
      ingredients: pickMerch('ingredients'),
      imageUrls: fieldValues.get('imageUrls') ?? [],
      merchandisingProvenance: sortedMerchProvenance,
      provenance: {
        providerIds: Array.from(new Set(contributing.map((a) => a.providerId))).sort(),
        acceptedAttemptIds: Array.from(new Set(input.acceptedAttemptIds)).sort(),
        sourcingGenerationId: input.sourcingGenerationId,
        catalogVersions: Array.from(new Set(contributing.map((a) => a.catalogVersion ?? ''))).filter((v) => v).sort(),
        observedAt: Array.from(new Set(contributing.map((a) => a.observedAt ?? ''))).filter((v) => v).sort(),
        connectionIds: Array.from(new Set(contributing.map((a) => a.distributorConnectionId ?? '')))
          .filter((v) => v)
          .sort(),
        fieldProvenance: sortedFieldProvenance,
      },
    };
    return {
      qualified: true,
      projection: projectionV2,
      evidenceHash: computeEvidenceHash(projectionV2),
      acceptedAttemptIds: projectionV2.provenance.acceptedAttemptIds,
      providerIds: projectionV2.provenance.providerIds,
      warnings,
    };
  }

  const projection: DistributorRecordProjection = {
    version: PROJECTION_VERSION,
    upc: itemIdentifier,
    gtin: pick('gtin'),
    distributorSku: pick('distributorSku'),
    manufacturerPartNumber: pick('manufacturerPartNumber'),
    name: pick('name') ?? names[0],
    brand: pick('brand'),
    weight: pick('weight'),
    size: pick('size'),
    count: pick('count'),
    packCount: pick('packCount'),
    flavor: pick('flavor'),
    formula: pick('formula'),
    customVariantAxes: customAxes,
    provenance: {
      providerIds: Array.from(new Set(contributing.map((a) => a.providerId))).sort(),
      // Sorted-unique: an input with duplicate accepted ids must not leak
      // duplicates into provenance (hash stability across duplicate inputs).
      acceptedAttemptIds: Array.from(new Set(input.acceptedAttemptIds)).sort(),
      sourcingGenerationId: input.sourcingGenerationId,
      catalogVersions: Array.from(new Set(contributing.map((a) => a.catalogVersion ?? ''))).filter((v) => v).sort(),
      observedAt: Array.from(new Set(contributing.map((a) => a.observedAt ?? ''))).filter((v) => v).sort(),
      connectionIds: Array.from(new Set(contributing.map((a) => a.distributorConnectionId ?? '')))
        .filter((v) => v)
        .sort(),
      fieldProvenance: sortedFieldProvenance,
    },
  };

  return {
    qualified: true,
    projection,
    evidenceHash: computeEvidenceHash(projection),
    acceptedAttemptIds: projection.provenance.acceptedAttemptIds,
    providerIds: projection.provenance.providerIds,
    warnings,
  } as unknown as SourcingProjectionResultV2;
}

/**
 * Amendment A v1 projection authority — identity-only, byte-for-byte
 * unchanged. Use ONLY for verifying existing v1 extraction rows at
 * promotion/readiness. New decisions use `buildDistributorRecordProjection`
 * (v2, Amendment B).
 */
export function buildDistributorRecordProjectionV1(input: DistributorRecordProjectionInput): SourcingProjectionResult {
  // merchandising=false produces exactly the v1 identity-only projection
  // (version v1, identical fields/hash); the cast is structural-only.
  return buildProjectionCore(input, false) as SourcingProjectionResult;
}

/**
 * Amendment B (M5) DEFAULT authority: v2 merchandising-depth projection for
 * every newly computed decision (reconciliation, manual/automatic routing,
 * final conflict resolution, materialization).
 */
export function buildDistributorRecordProjection(input: DistributorRecordProjectionInput): SourcingProjectionResultV2 {
  return buildProjectionCore(input, true);
}
