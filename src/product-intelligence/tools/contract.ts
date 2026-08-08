/**
 * Bounded Product Intelligence tool contract (PI-3).
 *
 * Every agent-facing research tool is a `PiToolAdapter`: strict TypeBox
 * parameter schema, stable version, bounded inputs, structured outcomes, and
 * explicit no-result / policy-denied results. Adapters wrap deterministic CMS
 * capabilities (discovery, verification, extraction, OCR, catalog lookup);
 * the agent orchestrates them instead of improvising browser behavior.
 *
 * Hard rules enforced by the registry (never by the agent):
 * - workspace + run ownership validation before dispatch;
 * - timeout and cancellation (caller AbortSignal + remaining deadline);
 * - request budget (policy.maxToolCalls);
 * - credential/path/raw-artifact redaction — raw HTML and unrestricted
 *   network payloads never reach Pi;
 * - no writes to approved catalog or ShopSite state;
 * - evidence ids / artifact references on every factual result.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import type { TSchema } from 'typebox';
import { sha256Hex } from '../../shared/stable-id';
import type { ProductIntelligencePolicy } from '../contracts';
import type { PolicyGateway } from '../policy/policy-gateway';

// ---------------------------------------------------------------------------
// Execution context passed to every adapter
// ---------------------------------------------------------------------------

export interface PiToolContext {
  runId: string;
  workspaceId: string;
  workspacePath: string;
  /** Immutable policy snapshot the run executes under (PI-5). */
  policy: ProductIntelligencePolicy;
  /** Policy gateway for network enforcement (injectable for tests). */
  gateway?: PolicyGateway;
  /** Caller cancellation signal (run abort). */
  signal: AbortSignal;
  /** Milliseconds of run deadline remaining when the call starts. */
  remainingMs: number;
  /** Round-10 (review P1): absolute epoch-ms run deadline; when present the
   *  registry recomputes remaining time PER INVOCATION from this instead of
   *  trusting a value frozen at session creation. */
  deadlineAt?: number | null;
}

// ---------------------------------------------------------------------------
// Evidence and outcomes
// ---------------------------------------------------------------------------

/** A factual result with durable provenance the agent can cite. */
export interface PiToolEvidence {
  /** Stable evidence id (deterministic per tool + input where possible). */
  id: string;
  kind: 'search_lead' | 'gtin_evidence' | 'variant_evidence' | 'parent_product_evidence' | 'official_evidence' | 'supplier_evidence' | 'retailer_corroboration' | 'community_evidence' | 'catalog_evidence' | 'taxonomy_evidence' | 'image_evidence';
  url?: string;
  domain?: string;
  /** Deterministic extraction method or capability name. */
  method: string;
  /** Short safe snippet (never raw page content). */
  snippet?: string;
  /** Content hash when an artifact was read. */
  contentHash?: string;
  /** Timestamp when the source was retrieved. */
  retrievedAt?: string;
}

/**
 * Field-level durable evidence (P1-4): ONE entry per extracted field with a
 * field-specific id so a reviewer can reconstruct exactly which source path
 * supported which value ('size = 16 oz supported by path X') from persisted
 * rows alone. Persistence writes one row per entry: targetField = field,
 * value = the ACTUAL extracted value, extractionMethod = method,
 * metadata.path = the source path.
 */
export interface FieldEvidenceEntry {
  /** Field-specific durable evidence id (see fieldEvidenceId). */
  id: string;
  /** Extracted field name (title, gtin, size, ...). */
  field: string;
  /** The actual extracted value. */
  value: string | null;
  /** Deterministic extraction method (e.g. 'json_ld', 'html_heuristics'). */
  method: string;
  /** Where in the page the value came from (JSON-LD path / selector / meta name). */
  path?: string;
  /** Short safe snippet of the source text (never raw page content). */
  snippet?: string;
  url?: string;
  domain?: string;
  /** Content hash of the artifact the field was extracted from. */
  contentHash?: string;
  /** Legacy compatibility fields (serializers read them; field entries leave them unset). */
  kind?: string;
  retrievedAt?: string;
}

/** Field-level evidence may appear alongside page-level evidence entries. */
export type ToolEvidence = PiToolEvidence | FieldEvidenceEntry;

export type PiToolResult =
  | { status: 'ok'; data: unknown; evidence: ToolEvidence[] }
  | { status: 'no_result'; reason: string; evidence: ToolEvidence[] }
  | { status: 'policy_denied'; reason: string; evidence: ToolEvidence[] }
  | { status: 'error'; code: string; message: string; evidence: ToolEvidence[] };

export function okResult(data: unknown, evidence: ToolEvidence[] = []): PiToolResult {
  return { status: 'ok', data, evidence };
}

export function noResult(reason: string, evidence: ToolEvidence[] = []): PiToolResult {
  return { status: 'no_result', reason, evidence };
}

export function policyDenied(reason: string): PiToolResult {
  return { status: 'policy_denied', reason, evidence: [] };
}

export function errorResult(code: string, message: string): PiToolResult {
  return { status: 'error', code, message, evidence: [] };
}

/** Deterministic evidence id: tool name + sha of the identifying input. */
export function evidenceId(toolName: string, identifyingInput: string): string {
  return `${toolName}:${sha256Hex(identifyingInput).slice(0, 24)}`;
}

/**
 * Field-specific durable evidence id (P1-4): tool + source url + field +
 * path/value hash. Unique per field on a page so one extraction produces one
 * resolvable id per extracted field — never the same id on N rows.
 */
export function fieldEvidenceId(toolName: string, url: string, field: string, pathOrValue: string): string {
  return `${toolName}:${sha256Hex(url).slice(0, 24)}:${field}:${sha256Hex(pathOrValue).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Adapter shape
// ---------------------------------------------------------------------------

export interface PiToolAdapter {
  /** Stable tool name the agent calls. */
  name: string;
  /** Adapter implementation version (bumped on behavior change). */
  version: string;
  /** LLM-facing description. */
  description: string;
  /** Optional system-prompt guideline bullets. */
  promptGuidelines?: string[];
  /** TypeBox parameter schema — rejects oversized/malformed inputs. */
  parameters: TSchema;
  /**
   * Execute the tool. Must never throw for expected conditions — return an
   * explicit outcome instead. Must honor ctx.signal and ctx.remainingMs.
   */
  execute(params: Record<string, unknown>, ctx: PiToolContext): Promise<PiToolResult>;
}

// ---------------------------------------------------------------------------
// Provider-neutral page-extraction contract (PI-11 seam)
// ---------------------------------------------------------------------------

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
}

export interface ExtractedImageCandidate {
  url: string;
  /** Variant mapping when the page declares one (e.g. Shopify variant id). */
  variantRef?: string;
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
  /** GTINs found on the page, with their extraction method. */
  gtins: Array<{ value: string; method: string }>;
  sku: string | null;
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
