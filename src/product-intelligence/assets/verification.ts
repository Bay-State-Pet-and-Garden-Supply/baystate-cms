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
import { sha256Hex, canonicalJsonStringify } from '../../shared/stable-id';
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

/**
 * Round-5: extract a net-content reading from free text such as a register
 * name ("STELLA CHKN BROTH 16OZ" -> { value: 16, unit: 'oz' }). Unanchored
 * scan so a trailing size token inside a longer name is found; false
 * positives are acceptable because a mismatch only blocks exact identity
 * (the GTIN rule below is the primary gate).
 */
const NET_CONTENT_SCAN_RE = /(\d+(?:\.\d+)?)\s*(fl\s?oz|oz|ounce|ounces|lb|lbs|pound|pounds|kg|kilogram|kilograms|g|gram|grams|ml|milliliter|milliliters|l|liter|liters|ct|pk|pack)\b/i;
export function extractNetContentFromText(raw: string): NetContent | null {
  const match = NET_CONTENT_SCAN_RE.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unitKey = match[2].trim().toLowerCase();
  const unit = UNIT_ALIASES[unitKey] ?? unitKey;
  if (!unit) return null;
  return { value, unit };
}

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
  } else if (expected.expectedGtin) {
    // Round-5: a run whose identity carries a GTIN demands an OBSERVED exact
    // GTIN (or a server-authoritative asset-to-GTIN linkage) for exact
    // identity — fuzzy name alignment alone can only support probable_match,
    // never exact. This closes "expected 16 oz" vs a 32 oz package whose OCR
    // captured no barcode (and whose size evidence becomes a conflict).
    const nameAgrees = expected.expectedName && observed.productName ? nameAlignment(expected.expectedName, observed.productName) : false;
    if (nameAgrees) reasons.push('observed product name aligns with the expected name');
    reasons.push('name alignment only — exact identity requires an observed GTIN');
    exactProductMatch = false;
  } else {
    const nameAgrees = expected.expectedName && observed.productName ? nameAlignment(expected.expectedName, observed.productName) : false;
    const contentAgrees = expected.expectedNetContent && observed.netContent ? sameNetContent(expected.expectedNetContent, observed.netContent) : false;
    exactProductMatch = Boolean(nameAgrees && (contentAgrees || expected.expectedNetContent === null)) && productConflicts.length === 0;
    if (nameAgrees) reasons.push('observed product name aligns with the expected name');
  }

  // Round-5: size/weight net-content (and flavor/formula) conflicts are
  // VARIANT discriminators — a 32 oz package is not the 16 oz variant even
  // when the variant field itself was never observed. Detected conflicts
  // must also block commerce approval regardless of a null exactVariantMatch.
  if (
    exactVariantMatch === null &&
    conflicts.some(
      (c) => c.startsWith('net_content_mismatch') || c.startsWith('flavor_mismatch') || c.startsWith('formula_mismatch'),
    )
  ) {
    exactVariantMatch = false;
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
  /** Server-derived source-kind: resolves the durable source row for the
   *  asset URL AND its durable provenance (the discovering page + the
   *  field-level evidence rows) and returns the source_type of the first
   *  resolvable record. Authority never comes from the agent's
   *  declaredSourceType string. When no durable source resolves,
   *  verification proceeds with sourceType 'unknown' (rights stay
   *  restricted unless a reuse grant matches). */
  sourceTypeResolver?: (url: string, provenance: SourceTypeProvenance) => string | null;
  /**
   * Server-authoritative reuse grant: (sourceTier, domain) -> the grant
   * record that authorized reuse, or null. A manufacturer/supplier domain
   * proves ORIGIN, not authorization. Defaults to NO grants — every asset
   * is restricted until a grant exists.
   */
  reuseGrantResolver?: ReuseGrantResolver;
}

/**
 * Round-4 (review P0): the immutable product identity a verification is
 * performed against, derived SERVER-SIDE from the run input. The terminal
 * validator recomputes the canonical hash from the current run's input and
 * refuses assets verified against any other run/identity.
 */
export interface VerifiedAgainstSnapshot {
  runId?: string | null;
  gtin?: string | null;
  name?: string | null;
  variant?: string | null;
  netContent?: { value: number; unit: string } | null;
  packCount?: number | null;
  flavor?: string | null;
  formula?: string | null;
}

/** Canonical, order-stable hash of the identity snapshot. Both the verifier
 *  (at tool time) and the terminal validator (at submission time) compute
 *  this from run-derived data, so hash equality proves the asset was verified
 *  against the same immutable product identity. */
/** Durable provenance a source-kind resolver can chain through. Round-7:
 *  the candidateId is the SERVER-CREATED discovery record — sourcePageUrl
 *  (display only) and evidenceIds (observation only) never select the tier. */
export type SourceTypeProvenance = {
  sourcePageUrl?: string | null;
  evidenceIds?: string[];
  candidateId?: string | null;
};

export function canonicalVerifiedAgainstHash(snapshot: VerifiedAgainstSnapshot): string {
  return sha256Hex(canonicalJsonStringify(snapshot));
}

export interface VerifyImageInput {
  url: string;
  sourcePageUrl?: string | null;
  sourcePath?: string | null;
  sourceArtifactId?: string | null;
  extractionMethod?: ExtractionMethod;
  /** Round-7: the durable server-created discovery record this image came
   *  from (discover_image_candidates). Provenance authority — the source
   *  tier/rights resolve from its discovering source, never from
   *  agent-supplied strings. */
  candidateId?: string | null;
  /** Round-4: authoritative comparison target, server-derived from the run
   *  input. Agent-supplied expected* fields below are recorded for review
   *  but are NEVER used as comparison targets (non-authoritative hints). */
  runIdentity?: VerifiedAgainstSnapshot | null;
  expectedGtin?: string | null;
  expectedBrand?: string | null;
  expectedName?: string | null;
  expectedVariant?: string | null;
  expectedNetContent?: NetContent | null;
  expectedPackCount?: number | null;
  expectedFlavor?: string | null;
  expectedFormula?: string | null;
  /** @deprecated Round-4: source kind is derived from the durable source row
   *  via VerifyImageDeps.sourceTypeResolver, never from this agent string. */
  declaredSourceType?: string | null;
  declaredRightsBasis?: string | null;
  declaredRightsEvidenceRef?: string | null;
  /** Durable evidence-row ids the server resolves into observations. */
  evidenceIds?: string[];
  /** Round-6/8: server-authoritative asset-to-GTIN linkage. ONLY a caller that
   *  resolved a durable asset record for THIS image (same run/URL) may supply
   *  this — it is the alternative to hash-bound OCR/decoder evidence for
   *  establishing the image's observed GTIN. The agent cannot supply it; the
   *  tool adapter builds it server-side from durable asset rows. Round-8: the
   *  linkage is CONTENT-ADDRESSED — it authorizes only the exact bytes
   *  (originalContentHash === currentImageHash) that the prior asset was
   *  verified against; a mutable URL whose bytes changed can never re-qualify
   *  the old GTIN. */
  assetGtinLinkages?: Array<{ gtin: string; assetId?: string; originalContentHash: string | null }>;
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
  // Round-4: source kind derives from the durable source row (provenance),
  // never from the agent's declared string. Unresolvable -> 'unknown' (fail
  // closed: no grant tier, rights stay restricted unless one matches).
  const declaredSourceType = deps.sourceTypeResolver?.(input.url, {
    sourcePageUrl: input.sourcePageUrl ?? null,
    evidenceIds: input.evidenceIds ?? [],
    candidateId: input.candidateId ?? null,
  }) ?? 'unknown';
  // Round-4: the comparison target is the server-derived run identity. When
  // the run input lacks a dimension, that dimension is NOT compared — it is
  // never taken from the agent.
  const runIdentity = input.runIdentity ?? null;
  const verifiedAgainstHash = runIdentity ? canonicalVerifiedAgainstHash(runIdentity) : null;

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
    return failRecord(input, declaredSourceType, retrievedAt, `image fetch failed: HTTP ${response.status}`, verifiedAgainstHash);
  }
  const contentType = response.headers.get('content-type');
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > MAX_VERIFICATION_BYTES) {
    return failRecord(input, declaredSourceType, retrievedAt, 'image exceeds 10 MB verification limit', verifiedAgainstHash);
  }

  const decoded = await contract.verify({ buffer, contentType });

  // Authoritative observations come from durable evidence rows (server-
  // resolved), with deterministic pixel-decoder output filling gaps. The
  // caller-supplied `observed` (agent assertion) is recorded separately and
  // never participates in identity classification.
  // Round-3 (review finding 5): byte-hash binding — OCR/decoder evidence is
  // authoritative for THIS image only when its recorded content hash matches
  // the bytes being inspected. Evidence with a mismatching hash (image A's
  // facts used to authorize image B) is dropped. Facts without a hash (e.g.
  // page extraction) remain usable.
  const evidenceFacts = deps.evidenceResolver ? deps.evidenceResolver(input.evidenceIds ?? []) : [];
  const currentImageHash = decoded.image?.contentHash ?? '';
  const usableFacts = currentImageHash
    ? evidenceFacts.filter((fact) => !fact.contentHash || fact.contentHash === currentImageHash)
    : evidenceFacts;
  const fromEvidence = observationFromFacts(usableFacts);
  // Round-6 byte-bound GTIN qualification: 'this run has durable evidence
  // that GTIN X exists' is NOT the same as 'this image is durably linked to
  // GTIN X'. A generic field-evidence GTIN (any method, null content hash)
  // can never establish the image's identity. Only (a) image-derived
  // evidence (image_ocr/decoder) whose content hash equals the EXACT bytes
  // being inspected, or (b) a server-authoritative asset-to-GTIN linkage
  // (resolved by the tool from durable asset rows for THIS image) qualify.
  const normalizeGtinDigits = (value: unknown): string => String(value ?? '').replace(/\D/g, '');
  const isGtinObservationFact = (fact: ResolvedEvidenceFact): boolean => {
    const key = OBSERVED_FIELD_KEYS[(fact.targetField ?? '').toLowerCase().replace(/[^a-z0-9]/g, '_')];
    return key === 'gtin' && fact.value !== null && fact.value !== undefined;
  };
  // Round-7 (review P0): qualify EACH GTIN fact independently. A fact's hash
  // may only authorize ITS OWN value — one fact's byte binding can never make
  // another fact's value the image's observed GTIN. Qualified values are the
  // union of (a) byte-bound image_ocr/decoder facts whose content hash equals
  // the exact bytes being inspected and (b) values covered by a
  // server-authoritative asset-to-GTIN linkage. Differing qualified values are
  // a GTIN conflict (never silently picks one).
  // Round-8 (review P0): linkages are CONTENT-ADDRESSED — a linkage covers a
  // value ONLY when its recorded originalContentHash equals the exact bytes
  // being inspected. A prior exact asset authorizes the same BYTES, never
  // whatever happens to live at the same URL later. One fact's hash can never
  // authorize another fact's value.
  const linkageCovers = (digits: string): boolean =>
    (input.assetGtinLinkages ?? []).some(
      (linkage) =>
        normalizeGtinDigits(linkage.gtin) === digits &&
        linkage.originalContentHash !== null &&
        linkage.originalContentHash !== undefined &&
        linkage.originalContentHash !== '' &&
        linkage.originalContentHash === currentImageHash,
    );
  const qualifiedGtinValues = new Set<string>();
  for (const fact of usableFacts.filter(isGtinObservationFact)) {
    const raw = fact.value && typeof fact.value === 'object' ? (fact.value as Record<string, unknown>).value : fact.value;
    const digits = normalizeGtinDigits(raw);
    if (digits.length < 8 || digits.length > 14) continue;
    const method = (fact.extractionMethod ?? '').toLowerCase();
    const isImageDerived = method === 'image_ocr' || method === 'decoder';
    const byteBound =
      isImageDerived && !!fact.contentHash && currentImageHash !== '' && fact.contentHash === currentImageHash;
    if (byteBound || linkageCovers(digits)) {
      qualifiedGtinValues.add(digits);
    }
  }
  const gtinConflictValues =
    qualifiedGtinValues.size > 1 ? Array.from(qualifiedGtinValues) : null;
  const observedGtinFromEvidence = qualifiedGtinValues.size === 1 ? Array.from(qualifiedGtinValues)[0] : null;
  // Round-12 (review P0-3): the BRAND observation is QUALIFIED like the GTIN.
  // A hash-less brand fact from anywhere can never become the observed brand
  // for authority purposes. Only (a) byte-bound image_ocr/decoder brand facts
  // whose content hash equals the exact bytes being inspected, or (b)
  // structured evidence (json_ld/platform/etc.) explicitly entity-linked to
  // the exact-GTIN product (same source URL as a QUALIFIED exact-GTIN fact)
  // establish the brand. The QUALIFYING evidence row id + hash are persisted
  // on the asset — brand provenance is never reconstructed from
  // observedBrand + image hash later.
  const isBrandObservationFact = (fact: ResolvedEvidenceFact): boolean => {
    const key = OBSERVED_FIELD_KEYS[(fact.targetField ?? '').toLowerCase().replace(/[^a-z0-9]/g, '_')];
    return key === 'brand' && fact.value !== null && fact.value !== undefined;
  };
  const qualifiedGtinSourceUrls = new Set<string>();
  for (const fact of usableFacts.filter(isGtinObservationFact)) {
    const raw = fact.value && typeof fact.value === 'object' ? (fact.value as Record<string, unknown>).value : fact.value;
    const digits = normalizeGtinDigits(raw);
    const method = (fact.extractionMethod ?? '').toLowerCase();
    const isImageDerived = method === 'image_ocr' || method === 'decoder';
    const byteBound =
      isImageDerived && !!fact.contentHash && currentImageHash !== '' && fact.contentHash === currentImageHash;
    if ((byteBound || linkageCovers(digits)) && fact.sourceUrl) {
      qualifiedGtinSourceUrls.add(fact.sourceUrl);
    }
  }
  const qualifiedBrandCandidates: Array<{ brand: string; factId: string | null; hash: string | null }> = [];
  let unqualifiedBrandRejected = false;
  for (const fact of usableFacts.filter(isBrandObservationFact)) {
    const method = (fact.extractionMethod ?? '').toLowerCase();
    const isImageDerived = method === 'image_ocr' || method === 'decoder';
    const byteBound =
      isImageDerived && !!fact.contentHash && currentImageHash !== '' && fact.contentHash === currentImageHash;
    const structuredEntityLinked = !isImageDerived && !!fact.sourceUrl && qualifiedGtinSourceUrls.has(fact.sourceUrl);
    if (byteBound || structuredEntityLinked) {
      const raw = factValue(fact.value, 'brand') ?? (typeof fact.value === 'string' ? fact.value : null);
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        qualifiedBrandCandidates.push({
          brand: String(raw).trim(),
          factId: fact.id ?? null,
          hash: fact.contentHash ?? currentImageHash,
        });
      }
    } else if (!fact.contentHash) {
      unqualifiedBrandRejected = true;
    }
  }
  const distinctQualifiedBrands = new Set(qualifiedBrandCandidates.map((c) => c.brand.toLowerCase()));
  const qualifiedBrand: string | null =
    distinctQualifiedBrands.size === 1 ? qualifiedBrandCandidates.find((c) => c.brand.toLowerCase() === [...distinctQualifiedBrands][0])!.brand : null;
  // The qualifying binding: prefer the byte-bound/structured evidence row;
  // a deterministic decoder brand is bytes-bound by construction.
  const brandEvidence = qualifiedBrand
    ? {
        evidenceId:
          qualifiedBrandCandidates.find(
            (c) => c.brand.toLowerCase() === qualifiedBrand.toLowerCase() && c.factId !== null,
          )?.factId ?? null,
        hash: qualifiedBrandCandidates.find((c) => c.brand.toLowerCase() === qualifiedBrand.toLowerCase())?.hash ?? currentImageHash,
      }
    : { evidenceId: null, hash: null };
  const observed: IdentityObservation = {
    brand: qualifiedBrand ?? fromEvidence.brand ?? decoded.observed.brand ?? null,
    productName: fromEvidence.productName ?? decoded.observed.productName ?? null,
    variant: fromEvidence.variant ?? decoded.observed.variant ?? null,
    netContent: fromEvidence.netContent ?? decoded.observed.netContent ?? null,
    packCount: fromEvidence.packCount ?? decoded.observed.packCount ?? null,
    gtin: observedGtinFromEvidence ?? decoded.observed.gtin ?? null,
  };
  // Reviewer-facing note when evidence contained a GTIN that failed the
  // byte-bound/linkage qualification (kept out of `observed` but surfaced).
  const gtinEvidenceRejected =
    fromEvidence.gtin && !observed.gtin && usableFacts.some(isGtinObservationFact);
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
  const observationProvenance: ObservationProvenance = usableFacts.length > 0 ? 'evidence' : agentAsserted ? 'agent_asserted' : 'decoder';

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
      ...baseRecord(input, declaredSourceType, retrievedAt, decoded, observed, observationProvenance, agentAsserted, verifiedAgainstHash, runIdentity, brandEvidence),
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

  // Round-4: the comparison target is the server-derived run identity. The
  // agent's expected* fields are never used as comparison targets — when the
  // run input lacks a dimension, that dimension is simply not compared.
  const identity = classifyAssetIdentity(observed, {
    expectedGtin: runIdentity?.gtin ?? null,
    expectedBrand: null,
    expectedName: runIdentity?.name ?? null,
    expectedVariant: runIdentity?.variant ?? null,
    // Round-5: the run schema carries no net content field, so the register
    // name's trailing size token ("STELLA CHKN BROTH 16OZ" -> 16 oz) is the
    // server-derived expectation — a 32 oz package OCR then conflicts instead
    // of silently passing on name alignment.
    expectedNetContent: runIdentity?.netContent ?? (runIdentity?.name ? extractNetContentFromText(runIdentity.name) : null),
    expectedPackCount: runIdentity?.packCount ?? null,
    expectedFlavor: runIdentity?.flavor ?? null,
    expectedFormula: runIdentity?.formula ?? null,
  });
  // Round-6: surface WHY an evidence GTIN was rejected (byte-bound or
  // linkage qualification) so the reviewer sees the distinction instead of
  // a bare 'no observed GTIN'.
  if (gtinEvidenceRejected) {
    identity.reasons.push('observed GTIN evidence is not byte-bound to this image (evidence GTIN without a matching content hash or server-authoritative linkage)');
  }
  // Round-7: differing QUALIFIED GTIN values (each byte-bound or linkage
  // covered in its own right) are a conflicting-GTIN identity failure — the
  // image is not exact, and the reviewer sees both values. A generic fact's
  // value is never authorized by another fact's hash.
  if (gtinConflictValues) {
    identity.exactProductMatch = false;
    identity.conflicts.push(`conflicting GTIN evidence: ${gtinConflictValues.join(' vs ')}`);
    identity.reasons.push(`conflicting qualified GTINs: ${gtinConflictValues.join(' vs ')}`);
  }
  // Round-12 (review P0-3): surface when evidence brand facts were dropped
  // for lack of qualification — the reviewer sees the distinction instead of
  // a bare 'no observed brand'.
  if (unqualifiedBrandRejected && !qualifiedBrand) {
    identity.reasons.push('observed brand evidence is not qualified (a hash-less or unlinked brand fact cannot establish the brand)');
  }
  if (qualifiedBrand === null && distinctQualifiedBrands.size > 1) {
    identity.reasons.push('conflicting qualified brand evidence — brand unresolved (fail closed)');
  }
  const commerceApproved = computeCommerceApproved({
    rightsStatus,
    exactProductMatch: identity.exactProductMatch,
    exactVariantMatch: identity.exactVariantMatch,
    qualityStatus: decoded.qualityStatus,
    conflicts: identity.conflicts,
  });

  return {
    ...baseRecord(input, declaredSourceType, retrievedAt, decoded, observed, observationProvenance, agentAsserted, verifiedAgainstHash, runIdentity, brandEvidence),
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
  // Round-5: packaging-OCR size/weight fields become net-content readings
  // ("32 oz" is a variant discriminator, not a name token); count maps to
  // pack count; flavor maps to the variant field so flavor evidence can
  // surface in the observed text and variant comparison.
  size: 'netContent',
  weight: 'netContent',
  count: 'packCount',
  flavor: 'variant',
  flavor_variety: 'variant',
  flavorvariety: 'variant',
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
  decoded: Awaited<ReturnType<ImageVerificationContract['verify']>> | null,
  observed: IdentityObservation,
  observationProvenance: ObservationProvenance,
  agentAsserted: IdentityObservation | null,
  verifiedAgainstHash: string | null,
  verifiedAgainst: VerifiedAgainstSnapshot | null,
  brandEvidence?: { evidenceId: string | null; hash: string | null } | null,
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
    verificationMethod: 'image_verification_pipeline',
    retrievedAt,
    originalContentHash: decoded?.image?.contentHash ?? '',
    perceptualHash: decoded?.image?.perceptualHash ?? null,
    variantReference: observed.variant ?? input.runIdentity?.variant ?? null,
    observedBrand: observed.brand,
    observedProductName: observed.productName,
    observedVariant: observed.variant,
    observedNetContent: observed.netContent,
    observedPackCount: observed.packCount,
    observedGtin: observed.gtin,
    observationProvenance,
    agentAsserted,
    verifiedAgainstHash,
    verifiedAgainst: (verifiedAgainst ?? null) as Record<string, unknown> | null,
    declaredSourceType,
    brandEvidenceId: brandEvidence?.evidenceId ?? null,
    brandEvidenceHash: brandEvidence?.hash ?? null,
  };
}

function failRecord(input: VerifyImageInput, declaredSourceType: string, retrievedAt: string, reason: string, verifiedAgainstHash: string | null): ProductAssetEvidence {
  return {
    sourceUrl: input.url,
    sourcePageUrl: input.sourcePageUrl ?? null,
    sourceType: declaredSourceType,
    sourcePath: input.sourcePath ?? null,
    sourceArtifactId: input.sourceArtifactId ?? `verify_image_candidate:${sha256Hex(input.url).slice(0, 24)}`,
    extractionMethod: input.extractionMethod ?? 'manual',
    verificationMethod: 'image_verification_pipeline',
    retrievedAt,
    originalContentHash: '',
    perceptualHash: null,
    variantReference: null,
    brandEvidenceId: null,
    brandEvidenceHash: null,
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
    verifiedAgainstHash,
    verifiedAgainst: null,
    declaredSourceType,
    exactProductMatch: false,
    exactVariantMatch: null,
    qualityStatus: 'invalid',
    commerceApproved: false,
    conflicts: [reason],
  };
}

