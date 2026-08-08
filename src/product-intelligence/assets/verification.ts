/**
 * Image verification pipeline (PI-6).
 *
 * The deterministic pipeline that turns a candidate image URL into a
 * `ProductAssetEvidence` record:
 *   1. gateway-fetch the asset into quarantine (content-type + size limits);
 *   2. decode via the `ImageVerificationContract` and reject corrupt content;
 *   3. record original-content and perceptual hashes;
 *   4. compare observed packaging evidence against the expected product
 *      (brand, name, variant, net content, pack count, GTIN, flavor, formula);
 *   5. resolve rights from the declared source tier + referenced basis;
 *   6. compute the deterministic commerce-approved flag.
 *
 * Identity comparison is pure and exported separately for unit tests. The
 * pipeline never throws for expected conditions — failures become structured
 * evidence (qualityStatus 'invalid', conflicts, commerceApproved false).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import { sha256Hex } from '../../shared/stable-id';
import type { ProductIntelligencePolicy } from '../contracts';
import type { PolicyGateway } from '../policy/policy-gateway';
import type { ImageVerificationContract } from './contract';
import { sharpImageVerificationAdapter } from './contract';
import { computeCommerceApproved } from './rights';
import type { IdentityObservation, NetContent, ObservationProvenance, ProductAssetEvidence } from './schema';
import type { ExtractionMethod } from './schema';

export const MAX_VERIFICATION_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Net content parsing ("12 oz", "12oz", "1.5 lb" -> { value, unit })
// ---------------------------------------------------------------------------

const UNIT_ALIASES: Record<string, string> = {
  ounce: 'oz',
  ounces: 'oz',
  'fl oz': 'fl oz',
  'fluid ounce': 'fl oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  ct: 'ct',
  count: 'ct',
};

const NET_CONTENT_RE = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z\s]+?)\s*$/;

/** Parse a "12 oz"-style string into a normalized net content, or null. */
export function parseNetContent(raw: string): NetContent | null {
  const match = NET_CONTENT_RE.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unitKey = match[2].trim().toLowerCase();
  const unit = UNIT_ALIASES[unitKey] ?? unitKey;
  if (!unit) return null;
  return { value, unit };
}

// ---------------------------------------------------------------------------
// Identity comparison (pure)
// ---------------------------------------------------------------------------

export interface AssetIdentityExpectation {
  expectedGtin: string | null;
  expectedBrand: string | null;
  expectedName: string | null;
  expectedVariant: string | null;
  expectedNetContent: NetContent | null;
  expectedPackCount: number | null;
  expectedFlavor: string | null;
  expectedFormula: string | null;
}

export interface AssetIdentityResult {
  exactProductMatch: boolean;
  exactVariantMatch: boolean | null;
  conflicts: string[];
  reasons: string[];
}

function normalizeGtin(gtin: string): string {
  return gtin.replace(/\D/g, '');
}

function sameNetContent(a: NetContent, b: NetContent): boolean {
  return Math.abs(a.value - b.value) < 0.01 && a.unit.trim().toLowerCase() === b.unit.trim().toLowerCase();
}

/** The observed text surfaces that can carry flavor/formula tokens. */
function observedText(observed: IdentityObservation): string {
  return [observed.productName, observed.variant].filter(Boolean).join(' ');
}

/**
 * Deterministic identity classification of an image asset against the
 * expected product. An exact GTIN match (observed vs expected) is the strong
 * product signal; otherwise name+net-content agreement is required. Variant
 * and packaging mismatches always produce conflicts — exact-variant is never
 * inferred from a product-level match.
 */
export function classifyAssetIdentity(observed: IdentityObservation, expected: AssetIdentityExpectation): AssetIdentityResult {
  const conflicts: string[] = [];
  const reasons: string[] = [];

  // GTIN.
  let gtinAgrees = false;
  if (expected.expectedGtin && observed.gtin) {
    if (normalizeGtin(expected.expectedGtin) === normalizeGtin(observed.gtin)) {
      gtinAgrees = true;
      reasons.push('observed GTIN matches the expected GTIN');
    } else {
      conflicts.push('gtin_mismatch: observed GTIN differs from the expected product GTIN');
    }
  } else if (expected.expectedGtin && !observed.gtin) {
    reasons.push('no observed GTIN available for comparison');
  }

  // Net content.
  if (expected.expectedNetContent && observed.netContent) {
    if (sameNetContent(expected.expectedNetContent, observed.netContent)) {
      reasons.push('observed net content matches the expected net content');
    } else {
      conflicts.push(
        `net_content_mismatch: observed ${observed.netContent.value}${observed.netContent.unit} vs expected ${expected.expectedNetContent.value}${expected.expectedNetContent.unit}`,
      );
    }
  }

  // Pack count.
  if (expected.expectedPackCount !== null && expected.expectedPackCount !== undefined && observed.packCount !== null && observed.packCount !== undefined) {
    if (expected.expectedPackCount === observed.packCount) {
      reasons.push('observed pack count matches the expected pack count');
    } else {
      conflicts.push(`pack_count_mismatch: observed pack count ${observed.packCount} vs expected ${expected.expectedPackCount}`);
    }
  }

  // Flavor and formula tokens must be visible in the observed packaging text.
  if (expected.expectedFlavor) {
    if (textHasToken(observedText(observed), expected.expectedFlavor)) {
      reasons.push('observed packaging shows the expected flavor');
    } else {
      conflicts.push(`flavor_mismatch: observed packaging does not show expected flavor '${expected.expectedFlavor}'`);
    }
  }
  if (expected.expectedFormula) {
    if (textHasToken(observedText(observed), expected.expectedFormula)) {
      reasons.push('observed packaging shows the expected formula');
    } else {
      conflicts.push(`formula_mismatch: observed packaging does not show expected formula '${expected.expectedFormula}'`);
    }
  }

  // Variant.
  let exactVariantMatch: boolean | null = null;
  if (expected.expectedVariant && observed.variant) {
    const expectedTokens = tokenSet(expected.expectedVariant);
    const observedTokens = tokenSet(observed.variant);
    const matched = [...expectedTokens].filter((token) => observedTokens.has(token)).length;
    if (expectedTokens.size > 0 && matched / expectedTokens.size >= 0.6) {
      exactVariantMatch = true;
      reasons.push('observed variant matches the expected variant');
    } else {
      exactVariantMatch = false;
      conflicts.push('variant_mismatch: observed variant does not match the expected variant');
    }
  } else if (expected.expectedVariant && !observed.variant) {
    reasons.push('no observed variant available for comparison');
  }

  // Product-level match: GTIN agreement, or strong name + net-content
  // agreement. Conflicting visible-package data (size/flavor/formula/pack
  // count/GTIN) always forces exactProductMatch false — a package showing a
  // different size or flavor is not the exact product. Variant mismatches do
  // not affect the product-level decision.
  const productConflicts = conflicts.filter((conflict) => !conflict.startsWith('variant_mismatch'));
  let exactProductMatch: boolean;
  if (expected.expectedGtin && observed.gtin) {
    exactProductMatch = gtinAgrees && productConflicts.length === 0;
  } else {
    const nameAgrees = expected.expectedName && observed.productName ? nameAlignment(expected.expectedName, observed.productName) : false;
    const contentAgrees = expected.expectedNetContent && observed.netContent ? sameNetContent(expected.expectedNetContent, observed.netContent) : false;
    exactProductMatch = Boolean(nameAgrees && (contentAgrees || expected.expectedNetContent === null)) && productConflicts.length === 0;
    if (nameAgrees) reasons.push('observed product name aligns with the expected name');
  }

  return { exactProductMatch, exactVariantMatch, conflicts, reasons };
}

const UNIT_TOKENS = new Set(['oz', 'lb', 'lbs', 'kg', 'g', 'ml', 'l', 'ct', 'pk', 'pack']);

function tokenSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d+$/.test(token) && i + 1 < tokens.length && UNIT_TOKENS.has(tokens[i + 1])) {
      merged.push(`${token}${tokens[i + 1]}`);
      i += 1;
    } else {
      merged.push(token);
    }
  }
  return new Set(merged);
}

/** Token-overlap name alignment (>=60% of the expected name's tokens appear). */
function nameAlignment(expectedName: string, productName: string): boolean {
  const expectedTokens = [...tokenSet(expectedName)];
  const productTokens = tokenSet(productName);
  if (expectedTokens.length < 2) return false;
  const matched = expectedTokens.filter((token) => {
    if (productTokens.has(token)) return true;
    return token.length > 8 && [...productTokens].some((pageToken) => pageToken.includes(token) || token.includes(pageToken));
  }).length;
  return matched / expectedTokens.length >= 0.6;
}

/** Does the observed text contain every significant token of the marker? */
function textHasToken(text: string, marker: string): boolean {
  if (!text) return false;
  const markerTokens = [...tokenSet(marker)];
  if (markerTokens.length === 0) return false;
  const observedTokens = tokenSet(text);
  return markerTokens.every((token) => observedTokens.has(token));
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export interface AssetHashRef {
  id: string;
  originalContentHash: string;
  perceptualHash: string | null;
}

export interface DuplicateResult {
  duplicate: boolean;
  referenceId: string | null;
  kind: 'exact' | 'perceptual' | null;
}

/** Maximum perceptual-hash distance (of 64 bits) treated as a duplicate. */
export const PERCEPTUAL_DUPLICATE_THRESHOLD = 10;

/**
 * Detect exact (same bytes) and perceptual (near dHash) duplicates against
 * already-recorded assets. Re-encodes and resizes of the same artwork match
 * perceptually but not exactly.
 */
export function findDuplicateAssets(existing: AssetHashRef[], candidate: AssetHashRef): DuplicateResult {
  for (const ref of existing) {
    if (ref.originalContentHash === candidate.originalContentHash) {
      return { duplicate: true, referenceId: ref.id, kind: 'exact' };
    }
  }
  if (candidate.perceptualHash) {
    for (const ref of existing) {
      if (ref.perceptualHash && ref.perceptualHash === candidate.perceptualHash) {
        return { duplicate: true, referenceId: ref.id, kind: 'perceptual' };
      }
    }
  }
  return { duplicate: false, referenceId: null, kind: null };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface VerifyImageDeps {
  runId: string;
  policy: ProductIntelligencePolicy;
  /** Policy gateway with injectable fetch (network entry point). */
  gateway: PolicyGateway;
  signal?: AbortSignal;
  contract?: ImageVerificationContract;
  now?: () => Date;
  /**
   * Resolves durable evidence rows (product_intelligence_evidence) by id.
   * The pipeline derives authoritative packaging observations from these
   * rows only. Defaults to no facts — without evidence, identity comparison
   * cannot approve.
   */
  evidenceResolver?: EvidenceResolver;
  /**
   * Server-authoritative reuse grant: (sourceTier, domain) -> the grant
   * record that authorized reuse, or null. A manufacturer/supplier domain
   * proves ORIGIN, not authorization. Defaults to NO grants — every asset
   * is restricted until a grant exists.
   */
  reuseGrantResolver?: ReuseGrantResolver;
}

export interface VerifyImageInput {
  url: string;
  sourcePageUrl?: string | null;
  sourcePath?: string | null;
  sourceArtifactId?: string | null;
  extractionMethod?: ExtractionMethod;
  expectedGtin?: string | null;
  expectedBrand?: string | null;
  expectedName?: string | null;
  expectedVariant?: string | null;
  expectedNetContent?: NetContent | null;
  expectedPackCount?: number | null;
  expectedFlavor?: string | null;
  expectedFormula?: string | null;
  declaredSourceType?: string | null;
  declaredRightsBasis?: string | null;
  declaredRightsEvidenceRef?: string | null;
  /** Durable evidence-row ids the server resolves into observations. */
  evidenceIds?: string[];
  /** Agent-asserted packaging observations — recorded, never authoritative. */
  observed?: Partial<IdentityObservation>;
}

/** A durable evidence row resolved to the facts the pipeline can consume. */
export interface ResolvedEvidenceFact {
  id: string;
  targetField: string | null;
  value: unknown;
  extractionMethod: string | null;
  snippet: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  contentHash: string | null;
  /** Which identifier namespace resolved this row: the row UUID or the
   *  agent-facing deterministic metadata.toolEvidenceId. */
  matchedNamespace?: 'row_id' | 'tool_evidence_id';
}

export type EvidenceResolver = (evidenceIds: string[]) => ResolvedEvidenceFact[];

/**
 * The durable reuse grant that authorized an asset (server-authoritative).
 * Records WHICH grant allowed reuse so the asset stores grantId instead of
 * caller-asserted rights strings.
 */
export interface ReuseGrantRecord {
  allowed: true;
  grantId: string;
  sourceTier: string;
  domainPattern: string;
  terms: string | null;
}

/**
 * (sourceTier, domain) -> the matching grant record, or null (no reuse).
 * A non-null record is the authorization itself — callers derive
 * rightsBasis/rightsEvidenceRef from it server-side.
 */
export type ReuseGrantResolver = (sourceTier: string, domain: string) => ReuseGrantRecord | null;

/**
 * Verify an image candidate end-to-end. Never throws for expected conditions:
 * decode failures and fetch failures become structured evidence records
 * (qualityStatus 'invalid', commerceApproved false). A `PolicyDeniedError`
 * from the gateway propagates so the caller can surface the exact policy
 * outcome.
 */
export async function verifyImageCandidate(input: VerifyImageInput, deps: VerifyImageDeps): Promise<ProductAssetEvidence> {
  const now = deps.now ?? (() => new Date());
  const contract = deps.contract ?? sharpImageVerificationAdapter;
  const retrievedAt = now().toISOString();
  const declaredSourceType = input.declaredSourceType ?? 'network_discovered';

  const response = await deps.gateway.gatewayFetch(
    { runId: deps.runId, policy: deps.policy },
    input.url,
    { signal: deps.signal, headers: { Accept: 'image/*' } },
    {
      allowedContentTypes: ['image/'],
      maxResponseBytes: Math.min(deps.policy.maxResponseBytes, MAX_VERIFICATION_BYTES),
    },
  );
  if (!response.ok) {
    return failRecord(input, declaredSourceType, retrievedAt, `image fetch failed: HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type');
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > MAX_VERIFICATION_BYTES) {
    return failRecord(input, declaredSourceType, retrievedAt, 'image exceeds 10 MB verification limit');
  }

  const decoded = await contract.verify({ buffer, contentType });

  // Authoritative observations come from durable evidence rows (server-
  // resolved), with deterministic pixel-decoder output filling gaps. The
  // caller-supplied `observed` (agent assertion) is recorded separately and
  // never participates in identity classification.
  const evidenceFacts = deps.evidenceResolver ? deps.evidenceResolver(input.evidenceIds ?? []) : [];
  const fromEvidence = observationFromFacts(evidenceFacts);
  const observed: IdentityObservation = {
    brand: fromEvidence.brand ?? decoded.observed.brand ?? null,
    productName: fromEvidence.productName ?? decoded.observed.productName ?? null,
    variant: fromEvidence.variant ?? decoded.observed.variant ?? null,
    netContent: fromEvidence.netContent ?? decoded.observed.netContent ?? null,
    packCount: fromEvidence.packCount ?? decoded.observed.packCount ?? null,
    gtin: fromEvidence.gtin ?? decoded.observed.gtin ?? null,
  };
  const agentAsserted: IdentityObservation | null = input.observed
    ? {
        brand: input.observed.brand ?? null,
        productName: input.observed.productName ?? null,
        variant: input.observed.variant ?? null,
        netContent: input.observed.netContent ?? null,
        packCount: input.observed.packCount ?? null,
        gtin: input.observed.gtin ?? null,
      }
    : null;
  const observationProvenance: ObservationProvenance = evidenceFacts.length > 0 ? 'evidence' : agentAsserted ? 'agent_asserted' : 'decoder';

  // Rights resolve ONLY from a durable reuse grant. Declared source tier +
  // basis strings prove where the asset came from, never authorization.
  // When a grant exists, rightsBasis/rightsEvidenceRef are derived from the
  // grant RECORD itself (grantId + tier@domainPattern) — caller-declared
  // rights strings are never authoritative.
  const grantResolver = deps.reuseGrantResolver ?? (() => null);
  const grant = grantResolver(declaredSourceType, domainOf(input.url));
  const rightsStatus = grant ? 'approved' : 'restricted';
  const rightsBasis = grant ? `grant:${grant.sourceTier}@${grant.domainPattern}` : null;
  const rightsEvidenceRef = grant ? grant.grantId : null;

  if (!decoded.verified) {
    return {
      ...baseRecord(input, declaredSourceType, retrievedAt, decoded, observed, observationProvenance, agentAsserted),
      exactProductMatch: false,
      exactVariantMatch: null,
      qualityStatus: 'invalid',
      rightsStatus,
      rightsBasis,
      rightsEvidenceRef,
      commerceApproved: false,
      conflicts: [`invalid_image: ${decoded.rejectionReason ?? 'decode failed'}`],
    };
  }

  const identity = classifyAssetIdentity(observed, {
    expectedGtin: input.expectedGtin ?? null,
    expectedBrand: input.expectedBrand ?? null,
    expectedName: input.expectedName ?? null,
    expectedVariant: input.expectedVariant ?? null,
    expectedNetContent: input.expectedNetContent ?? null,
    expectedPackCount: input.expectedPackCount ?? null,
    expectedFlavor: input.expectedFlavor ?? null,
    expectedFormula: input.expectedFormula ?? null,
  });
  const commerceApproved = computeCommerceApproved({
    rightsStatus,
    exactProductMatch: identity.exactProductMatch,
    exactVariantMatch: identity.exactVariantMatch,
    qualityStatus: decoded.qualityStatus,
    conflicts: identity.conflicts,
  });

  return {
    ...baseRecord(input, declaredSourceType, retrievedAt, decoded, observed, observationProvenance, agentAsserted),
    exactProductMatch: identity.exactProductMatch,
    exactVariantMatch: identity.exactVariantMatch,
    qualityStatus: decoded.qualityStatus,
    rightsStatus,
    rightsBasis,
    rightsEvidenceRef,
    commerceApproved,
    conflicts: identity.conflicts,
  };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const OBSERVED_FIELD_KEYS: Record<string, keyof IdentityObservation> = {
  gtin: 'gtin',
  upc: 'gtin',
  brand: 'brand',
  product_name: 'productName',
  productname: 'productName',
  name: 'productName',
  title: 'productName',
  variant: 'variant',
  net_content: 'netContent',
  netcontent: 'netContent',
  pack_count: 'packCount',
  packcount: 'packCount',
};

/** Derive an authoritative observation from durable evidence facts. Only
 *  targetField-mapped values (or direct string/number values on known
 *  fields) are trusted — evidence rows are the only durable authority. */
function observationFromFacts(facts: ResolvedEvidenceFact[]): IdentityObservation {
  const out: IdentityObservation = { brand: null, productName: null, variant: null, netContent: null, packCount: null, gtin: null };
  for (const fact of facts) {
    const key = OBSERVED_FIELD_KEYS[(fact.targetField ?? '').toLowerCase().replace(/[^a-z0-9]/g, '_')];
    if (!key) continue;
    const value = fact.value;
    if (key === 'netContent') {
      if (value && typeof value === 'object' && 'value' in value && typeof (value as { value?: unknown }).value === 'number' && typeof (value as { unit?: unknown }).unit === 'string') {
        const net = value as { value: number; unit: string };
        out.netContent = { value: net.value, unit: net.unit };
      } else if (value !== null && value !== undefined) {
        out.netContent = parseNetContent(String(value)) ?? out.netContent;
      }
      continue;
    }
    if (key === 'packCount') {
      const raw = factValue(value, key);
      const n = Number(raw ?? value);
      if (Number.isInteger(n) && n > 0) out.packCount = n;
      continue;
    }
    if (key === 'gtin') {
      const raw = factValue(value, key) ?? (value && typeof value === 'object' ? (value as Record<string, unknown>).value : null);
      const digits = String(raw ?? '').replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) out.gtin = digits;
      continue;
    }
    const stringValue = factValue(value, key);
    if (stringValue !== null && stringValue !== undefined) out[key] = String(stringValue);
  }
  return out;
}

function factValue(value: unknown, key: keyof IdentityObservation): unknown {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if ('value' in obj && obj.value !== null && obj.value !== undefined) return obj.value;
  if (key in obj) return obj[key];
  // persistToolEvidence stores { evidenceId, snippet }; fall back to snippet
  // only for name-ish fields (never GTIN — a URL would pass the digit check
  // only for true 8-14 digit identifiers).
  if (key === 'productName' && typeof obj.snippet === 'string') return obj.snippet;
  return null;
}

function baseRecord(
  input: VerifyImageInput,
  declaredSourceType: string,
  retrievedAt: string,
  decoded: Awaited<ReturnType<ImageVerificationContract['verify']>>,
  observed: IdentityObservation,
  observationProvenance: ObservationProvenance,
  agentAsserted: IdentityObservation | null,
): Omit<
  ProductAssetEvidence,
  'exactProductMatch' | 'exactVariantMatch' | 'qualityStatus' | 'rightsStatus' | 'rightsBasis' | 'rightsEvidenceRef' | 'commerceApproved' | 'conflicts'
> {
  return {
    sourceUrl: input.url,
    sourcePageUrl: input.sourcePageUrl ?? null,
    sourceType: declaredSourceType,
    sourcePath: input.sourcePath ?? null,
    sourceArtifactId: input.sourceArtifactId ?? `verify_image_candidate:${sha256Hex(input.url).slice(0, 24)}`,
    extractionMethod: input.extractionMethod ?? 'manual',
    retrievedAt,
    originalContentHash: decoded.image.contentHash,
    perceptualHash: decoded.image.perceptualHash,
    variantReference: observed.variant ?? input.expectedVariant ?? null,
    observedBrand: observed.brand,
    observedProductName: observed.productName,
    observedVariant: observed.variant,
    observedNetContent: observed.netContent,
    observedPackCount: observed.packCount,
    observedGtin: observed.gtin,
    observationProvenance,
    agentAsserted,
  };
}

function failRecord(input: VerifyImageInput, declaredSourceType: string, retrievedAt: string, reason: string): ProductAssetEvidence {
  return {
    sourceUrl: input.url,
    sourcePageUrl: input.sourcePageUrl ?? null,
    sourceType: declaredSourceType,
    sourcePath: input.sourcePath ?? null,
    sourceArtifactId: input.sourceArtifactId ?? `verify_image_candidate:${sha256Hex(input.url).slice(0, 24)}`,
    extractionMethod: input.extractionMethod ?? 'manual',
    retrievedAt,
    originalContentHash: '',
    perceptualHash: null,
    variantReference: null,
    rightsStatus: 'restricted',
    rightsBasis: null,
    rightsEvidenceRef: null,
    observedBrand: null,
    observedProductName: null,
    observedVariant: null,
    observedNetContent: null,
    observedPackCount: null,
    observedGtin: null,
    observationProvenance: 'decoder',
    agentAsserted: null,
    exactProductMatch: false,
    exactVariantMatch: null,
    qualityStatus: 'invalid',
    commerceApproved: false,
    conflicts: [reason],
  };
}

