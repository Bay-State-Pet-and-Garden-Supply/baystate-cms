/**
 * Provider-neutral page-extraction result shape + deterministic identity
 * classification (ADR-0030 Phase 1 salvage from PI tools/contract.ts).
 *
 * This is the per-field provenance result contract the onboarding extraction
 * ladder reports: every field observation carries method, source path,
 * artifact id, content hash, and optional variant reference, and the page
 * carries an identity status that ALWAYS distinguishes retrieval success
 * (fields found) from correct product extraction (exact_match). Layers 5-8
 * machinery (browser/managed/LLM) was deliberately NOT relocated.
 */

/** Identity status of an extracted page against the requested product. */
export const PAGE_IDENTITY_STATUSES = [
  'exact_match',
  'probable_match',
  'parent_product_only',
  'wrong_variant',
  'conflicting_identity',
  'insufficient_evidence',
] as const;

export type PageIdentityStatus = (typeof PAGE_IDENTITY_STATUSES)[number];

export interface ExtractedFieldEvidence {
  field: string;
  value: string | null;
  /** Deterministic extraction method (e.g. 'json_ld', 'meta_tags', 'selectors'). */
  method: string;
  /** Where in the page the value came from (CSS path / meta name / JSON-LD type). */
  sourcePath?: string;
  /** Artifact containing this field observation, when retained. */
  sourceArtifactId?: string | null;
  /** SHA-256 of the exact source artifact containing this observation. */
  sourceContentHash?: string | null;
  /** Executed profile provenance, only for profile-path observations. */
  sourceProfileId?: string | null;
  sourceProfileVersion?: string | number | null;
  /** Variant identity attached to this observation when source-specific. */
  variantRef?: string | null;
  /** Field-specific durable evidence ids for this observation. */
  evidenceIds?: string[];
}

/**
 * Identifier evidence is deliberately separate from page-level evidence. A
 * GTIN or SKU can be present on a page without being the identifier for the
 * selected product, so consumers must retain the exact source path, artifact,
 * and evidence ids for each observed value.
 */
export interface ExtractedIdentifierEvidence {
  value: string;
  /** Deterministic extraction method (e.g. 'json_ld', 'selectors'). */
  method: string;
  /** Exact source path for this identifier observation. */
  sourcePath?: string;
  /** Artifact containing this identifier observation. */
  sourceArtifactId?: string | null;
  /** SHA-256 of the exact source artifact containing this observation. */
  sourceContentHash?: string | null;
  /** Variant identity attached to this observation when source-specific. */
  variantRef?: string | null;
  /** Durable evidence ids for this identifier observation. */
  evidenceIds?: string[];
}

export interface ExtractedImageCandidate {
  url: string;
  /** Variant mapping when the page declares one (e.g. Shopify variant id). */
  variantRef?: string;
  /** Artifact containing this image observation. */
  sourceArtifactId?: string | null;
  /** SHA-256 of the exact source artifact containing this image observation. */
  sourceContentHash?: string | null;
  sourcePath?: string;
}

export interface PageExtractionResult {
  requestedUrl: string;
  finalUrl: string;
  /** Fetch modes used (e.g. ['http_detailed']). Browser modes arrive with PI-11. */
  fetchModes: string[];
  /** SHA-256 of the fetched page content, when retained. */
  contentHash: string | null;
  /** Artifact reference (worker artifact id) when the page was archived. */
  artifactRef: string | null;
  fields: ExtractedFieldEvidence[];
  /** GTINs found on the page, with identifier-specific provenance. */
  gtins: ExtractedIdentifierEvidence[];
  sku: string | null;
  /** Identifier-specific provenance for the extracted SKU. */
  skuEvidence?: ExtractedIdentifierEvidence | null;
  brand: string | null;
  productName: string | null;
  variant: { name?: string; id?: string; sku?: string } | null;
  size: string | null;
  packCount: number | null;
  images: ExtractedImageCandidate[];
  conflicts: Array<{ field: string; summary: string }>;
  identityStatus: PageIdentityStatus;
  identityReasons: string[];
  /** False when LLM-assisted extraction was involved (never overrides deterministic conflicts). */
  deterministicOnly: boolean;
}

export interface PageExtractionContract {
  readonly name: string;
  readonly version: string;
  extract(request: {
    url: string;
    expected?: { gtin?: string; name?: string; brandHint?: string | null };
    signal: AbortSignal;
    timeoutMs: number;
    /** Optional approved profile to apply. Implementations that omit profile
     * support must not be used to validate an active profile. */
    profile?: {
      selectors: Record<string, string | null>;
      runtime: 'static' | 'rendered';
    };
  }): Promise<PageExtractionResult>;
  /** Explicit profile-runner seam. This is intentionally separate from the
   * fallback ladder so a compatibility probe cannot silently pass on JSON-LD,
   * heuristics, browser, or LLM extraction. */
  extractWithProfile?(request: {
    url: string;
    expected?: { gtin?: string; name?: string; brandHint?: string | null };
    signal: AbortSignal;
    timeoutMs: number;
    profile: {
      selectors: Record<string, string | null>;
      runtime: 'static' | 'rendered';
    };
  }): Promise<PageExtractionResult>;
}

// ---------------------------------------------------------------------------
// Shared outcome helpers
// ---------------------------------------------------------------------------

export function classifyPageIdentity(input: {
  requestedGtin: string;
  extractedGtins: string[];
  sku: string | null;
  productName: string | null;
  expectedName: string | undefined;
  variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
  hasAnyField: boolean;
  /** POSITIVE single-variant evidence (P0-5): the page affirmatively reports exactly one variant. */
  singleVariantProof: boolean;
  /** POSITIVE selected-child linkage (P0-5): the requested child variant is the selected/default one. */
  selectedVariantLinkage: boolean;
}): { status: PageIdentityStatus; reasons: string[] } {
  const reasons: string[] = [];
  const exactGtin = input.extractedGtins.some((g) => g.replace(/\D/g, '') === input.requestedGtin);
  // P0-5 (review hardening): exact GTIN establishes that the requested entity
  // is REPRESENTED on the page — never automatically that the page currently
  // displays that variant. exact_match additionally requires POSITIVE
  // single-variant evidence (a platform/structured claim of exactly one
  // variant) or POSITIVE selected-child linkage (a variant_match signal).
  // Absence of detected variant UI is deliberately not proof.
  if (exactGtin && (input.singleVariantProof || input.selectedVariantLinkage)) {
    reasons.push(
      input.singleVariantProof
        ? 'exact GTIN present on a page affirmatively proven single-variant'
        : 'exact GTIN present with positive selected-variant linkage',
    );
    return { status: 'exact_match', reasons };
  }
  if (input.variantSignals.some((s) => s.kind === 'variant_mismatch')) {
    reasons.push('variant mismatch signal present');
    return { status: 'wrong_variant', reasons };
  }
  if (input.variantSignals.some((s) => s.kind === 'parent_page')) {
    reasons.push('page is a parent product page (variant selector without exact variant)');
    return { status: 'parent_product_only', reasons };
  }
  if (!input.hasAnyField) {
    return { status: 'insufficient_evidence', reasons: ['no extractable product fields'] };
  }
  const nameMatches = nameAlignment(input.expectedName, input.productName);
  if (exactGtin) {
    // The exact entity is represented, but variant status is unproven —
    // settle conservatively below exact_match (review P0-5).
    reasons.push('exact GTIN present but variant status unproven');
    if (nameMatches || input.sku) {
      reasons.push(nameMatches ? 'product name aligns with the expected name' : 'SKU present');
    }
    return { status: 'probable_match', reasons };
  }
  if (nameMatches || input.sku) {
    reasons.push(nameMatches ? 'product name aligns with the expected name' : 'SKU present');
    return { status: 'probable_match', reasons };
  }
  return { status: 'insufficient_evidence', reasons: ['no GTIN, no SKU, and no name alignment'] };
}

/**
 * Derive the P0-5 proof booleans from variant signals and an optional
 * platform-reported variant count. `singleVariantProof` requires POSITIVE
 * evidence (a platform affirmatively reporting exactly one variant) — the
 * absence of signals is never treated as proof.
 */
export function variantProofFromSignals(
  signals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>,
  platformVariantCount?: number,
): { singleVariantProof: boolean; selectedVariantLinkage: boolean } {
  return {
    singleVariantProof: platformVariantCount === 1,
    selectedVariantLinkage: signals.some((s) => s.kind === 'variant_match'),
  };
}

/**
 * Positive single-variant proof from an HTML page's structured data (P0-5,
 * round 2): proof requires an AFFIRMATIVE single-sellable-variant declaration
 * parsed from embedded JSON-LD — a leaf Product node carrying a single offers
 * object and no variant affordance keys (hasVariant / isVariantOf / variants /
 * ProductGroup). Raw-HTML absence heuristics are never proof: a multi-variant
 * storefront can render leaf JSON-LD for the displayed child only, so callers
 * must additionally let platform/browser layers run before settling on this
 * proof (see the ladder's early-exit gating).
 */
export function structuredSingleVariantProof(html: string): boolean {
  return jsonLdEntriesFromHtml(html).some(jsonLdLeafProductProof);
}

/**
 * Extract raw JSON-LD nodes (@type-bearing) from embedded
 * `<script type="application/ld+json">` blocks, recursing into @graph,
 * mainEntity and itemListElement containers. Malformed blocks are ignored.
 */
function jsonLdEntriesFromHtml(html: string): unknown[] {
  const entries: unknown[] = [];
  const scriptRe = /<script[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON-LD block is never proof
    }
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj['@graph'] !== undefined) collect(obj['@graph']);
      if (obj['@type'] !== undefined) entries.push(obj);
      for (const key of ['mainEntity', 'itemListElement']) {
        if (obj[key] !== undefined) collect(obj[key]);
      }
    };
    collect(parsed);
  }
  return entries;
}

/**
 * Positive single-variant proof from a parsed JSON-LD entry (P0-5 round 2):
 * @type Product (not ProductGroup) with NO variant affordance keys
 * (hasVariant / isVariantOf / variants) AND an AFFIRMATIVE single-offer
 * declaration (offers present as a single object, not an array). Absence of
 * variant markers without an offer declaration is never proof.
 */
export function jsonLdLeafProductProof(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  if (obj['hasVariant'] !== undefined) return false;
  if (obj['isVariantOf'] !== undefined) return false;
  if (obj['variants'] !== undefined) return false;
  const type = obj['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('ProductGroup')) return false;
  if (!types.includes('Product')) return false;
  const offers = obj['offers'];
  if (offers === undefined || Array.isArray(offers)) return false;
  if (typeof offers !== 'object' || offers === null) return false;
  return true;
}

/**
 * P0-5 round 2: variant_match must be tied to the EXPECTED variant, not to a
 * successful interaction. Token overlap between the expected product name and
 * the selected option / declared variant, with digit+unit merging so "16 oz"
 * aligns with "16oz". Generic selector tokens (size/option/select/variant/
 * flavor/color) are ignored. Returns the fraction of candidate tokens present
 * in the expected name (0..1); 0 when either side is empty.
 */
export function variantTokenOverlap(expectedName: string | undefined, candidate: string): number {
  if (!expectedName || !candidate) return 0;
  const tokens = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/(\d+)\s*(oz|ml|lb|lbs|g|kg|ct|count|pack|fl|floz|count)/g, '$1$2')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !/^(size|option|select|variant|flavou?r|color|colour|default)$/.test(t));
  const expectedTokens = new Set(tokens(expectedName));
  const candidateTokens = tokens(candidate);
  if (candidateTokens.length === 0) return 0;
  const hits = candidateTokens.filter((t) => expectedTokens.has(t)).length;
  return hits / candidateTokens.length;
}

/**
 * Forgiving name alignment: token-overlap ratio (>=60% of the expected
 * name's significant tokens appear on the page), with digit+unit merging so
 * "16 oz" matches "16oz". Text similarity is corroboration only — identity
 * requires the exact GTIN.
 */
function nameAlignment(expectedName: string | undefined, productName: string | null): boolean {
  if (!expectedName || !productName) return false;
  const expectedTokens = nameTokens(expectedName);
  const pageTokens = nameTokens(productName);
  if (expectedTokens.length < 2) return false;
  const pageSet = new Set(pageTokens);
  const matched = expectedTokens.filter((token) => {
    if (pageSet.has(token)) return true;
    // Partial containment for longer tokens: "chicken" ~ "chkn" families
    // are not matched this way, but compound splits like "chickenbroth" are.
    return token.length > 8 && [...pageSet].some((pageToken) => pageToken.includes(token) || token.includes(pageToken));
  }).length;
  return matched / expectedTokens.length >= 0.6;
}

const UNIT_TOKENS = new Set(['oz', 'lb', 'lbs', 'kg', 'g', 'ml', 'l', 'ct', 'pk', 'pack']);

function nameTokens(name: string): string[] {
  const tokens = name
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
  return merged;
}

/** Compute the simple check-digit for a 12-digit UPC (returns null when invalid). */
export function upcCheckDigit(upc12: string): number | null {
  if (!/^\d{11}$/.test(upc12)) return null;
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    sum += Number(upc12[i]) * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return check;
}
