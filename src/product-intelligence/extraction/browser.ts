/**
 * PI-11 layers 5-6: rendered-browser extraction with network capture, and
 * bounded deterministic interaction (exact constraints only — no
 * natural-language automation). The worker performs the rendering (separate
 * process, ADR-0009); this adapter parses the snapshot's structured signals
 * and captured responses into ladder evidence. It never decides taxonomy,
 * image rights, or final product identity.
 *
 * Pure module: zod only (vitest-runnable); the worker client is injected.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import type { InteractionAction } from '../../shared/schemas/extraction-worker';
import { gtinFromAny } from './platforms';
import { variantTokenOverlap } from '../tools/contract';
import type { ExtractedFieldEvidence, ExtractedImageCandidate } from '../tools/contract';

export interface CapturedNetworkResponse {
  url: string;
  status: number | null;
  responseContentType: string | null;
  jsonBody: unknown;
  /** Provenance for this exact captured response, never inferred from page HTML. */
  artifactId?: string | null;
  contentHash?: string | null;
  sourcePath?: string;
}

export interface BrowserSnapshot {
  url: string;
  finalUrl: string;
  /** Artifact/hash for the exact browser snapshot bytes. */
  artifactId?: string | null;
  contentHash?: string | null;
  jsonLd: Array<Record<string, unknown>>;
  embeddedProductData: Array<Record<string, unknown>>;
  imageCandidates: string[];
  networkResponses: CapturedNetworkResponse[];
  interaction: { performed: boolean; finalUrl: string; selectedOptions: string[] } | null;
  /** Rendered-page structure signals (e.g. 'interaction:add-to-cart') — bounded excerpt sources for layer 8. */
  pageStructureSignals: string[];
  /**
   * Round-4 P1-2: DOM variant-selector affordances observed after rendering
   * (e.g. a <select>/radio group whose options are product variant
   * dimensions). AFFIRMATIVE contradiction/proof only — optionCount >= 2 is
   * treated as a multiple-variant signal, optionCount === 1 as an
   * affirmative single-variant affordance. Absence is never proof.
   * Producer: the extraction worker's rendered-page snapshot.
   */
  domVariantSelectors?: Array<{ kind: 'select' | 'radio' | 'unknown'; optionCount: number }>;
  warnings: string[];
}

export interface BrowserSnapshotRequest {
  url: string;
  captureNetwork: boolean;
  interaction?: InteractionAction | null;
  signal?: AbortSignal | null;
}

export interface BrowserSnapshotFn {
  (request: BrowserSnapshotRequest): Promise<BrowserSnapshot>;
}

export interface BrowserExtractionEvidence {
  fields: ExtractedFieldEvidence[];
  images: ExtractedImageCandidate[];
  gtins: Array<{ value: string; method: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string | null }>;
  sku: string | null;
  brand: string | null;
  productName: string | null;
  size: string | null;
  variant: { name?: string; id?: string; sku?: string } | null;
  variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
  selectedOptions: string[];
  finalUrl: string;
  methodsUsed: string[];
  /** Round-6 P0-3: total product-like payloads processed (page context for the single-payload primary fallback). */
  stats?: { productLikeCount: number };
  /** Round-6 P0-3: identity ids of the page's PRIMARY/CURRENT product entity, established server-side from page-level markers (mainEntity, canonical-URL match, first Product in document order). */
  pagePrimaryIds?: string[];
}

/**
 * Round-5 P0-3: one product-like payload's declared variant-set contribution,
 * recorded ENTITY-SCOPED. `variantSetEvidence` is computed only from
 * contributions whose identity links to the expected entity — "some product
 * on this page has one variant" must never prove "this GTIN has one variant".
 */
export interface VariantSetContribution {
  identity: { gtin: string | null; sku: string | null; id: string | null };
  source: string;
  variantCount: number;
}

function addFieldOnce(fields: ExtractedFieldEvidence[], field: string, value: string | null | undefined, method: string, sourcePath?: string, source?: { artifactId?: string | null; contentHash?: string | null; variantRef?: string | null }): void {
  if (value === null || value === undefined) return;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return;
  if (fields.some((f) => f.field === field && f.value === trimmed && f.method === method)) return;
  fields.push({ field, value: trimmed.slice(0, 2000), method, sourcePath, sourceArtifactId: source?.artifactId, sourceContentHash: source?.contentHash, variantRef: source?.variantRef });
}

/** Extract ladder evidence from an arbitrary product-like payload. */
export function evidenceFromProductPayload(
  product: Record<string, unknown>,
  method: string,
  sourcePath: string,
  out: {
    fields: ExtractedFieldEvidence[];
    images: ExtractedImageCandidate[];
    gtins: Array<{ value: string; method: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string | null }>;
    sku: string | null;
    brand: string | null;
    productName: string | null;
    size: string | null;
    variant: { name?: string; id?: string; sku?: string } | null;
    variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    /**
     * Round-4 P1-2: affirmative variant-set evidence accumulated from payloads
     * that DECLARE their variant set (an explicit `variants` array). `single`
     * when a payload declares exactly one sellable variant; `multiple` when a
     * payload or DOM selector affordance declares >= 2. Absence never counts.
     * Round-5 P0-3: the booleans are computed from ENTITY-SCOPED
     * `variantSetContributions` (linked-to-expected only) — unlinked payloads
     * neither prove nor contradict.
     */
    variantSetEvidence?: { single: boolean; multiple: boolean };
    /** Round-5 P0-3: per-payload declared variant-set contributions (entity-scoped). */
    variantSetContributions?: VariantSetContribution[];
    /** Round-6 P0-3: total product-like payloads processed (page context). */
    stats?: { productLikeCount: number };
    /** Round-6 P0-3: identity ids of the page's PRIMARY/CURRENT product entity. */
    pagePrimaryIds?: string[];
  },
  /** Round-5 P0-3: the expected entity identity (when known) scopes both proof
   *  and contradiction signals to linked payloads. When absent, callers
   *  without entity context keep the legacy unscoped behavior. */
  opts?: { expectedGtin?: string | null; artifactId?: string | null; contentHash?: string | null; variantRef?: string | null },
): void {
  if (out.stats) out.stats.productLikeCount += 1;
  const title = typeof product.title === 'string' ? product.title : typeof product.name === 'string' ? product.name : null;
  const sku = typeof product.sku === 'string' ? product.sku : null;
  const brand = typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : null;
  const size = typeof product.size === 'string' ? product.size : null;
  const gtin = gtinFromAny(product);

  const source = { artifactId: opts?.artifactId, contentHash: opts?.contentHash, variantRef: opts?.variantRef };
  if (title) addFieldOnce(out.fields, 'product_name', title, method, sourcePath, source);
  if (sku) addFieldOnce(out.fields, 'sku', sku, method, sourcePath, source);
  if (brand) addFieldOnce(out.fields, 'brand', brand, method, sourcePath, source);
  if (size) addFieldOnce(out.fields, 'size', size, method, sourcePath, source);
  if (gtin) {
    const digits = gtin.replace(/\D/g, '');
    if (!out.gtins.some((g) => g.value.replace(/\D/g, '') === digits && g.variantRef === (opts?.variantRef ?? null))) out.gtins.push({ value: digits, method, sourcePath, sourceArtifactId: opts?.artifactId, sourceContentHash: opts?.contentHash, variantRef: opts?.variantRef ?? null });
  }
  out.sku ??= sku;
  out.brand ??= brand;
  out.productName ??= title;
  out.size ??= size;

  const images = Array.isArray(product.images)
    ? product.images
        .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown; url?: unknown })?.src ?? (img as { url?: unknown })?.url))
        .filter((src): src is string => typeof src === 'string')
    : [];
  for (const image of images) {
    if (!out.images.some((i) => i.url === image)) out.images.push({ url: image, sourcePath, sourceArtifactId: opts?.artifactId, sourceContentHash: opts?.contentHash, variantRef: opts?.variantRef ?? undefined });
  }

  // Round-5 P0-3: an explicit `variants` array is affirmative variant-set
  // evidence, recorded as an ENTITY-SCOPED contribution. The final
  // single/multiple signal is computed by evidenceFromBrowserSnapshot from
  // contributions LINKED to the expected entity only.
  if (Array.isArray(product.variants) && product.variants.length >= 1) {
    const rawId = (product as Record<string, unknown>).id ?? (product as Record<string, unknown>).productId ?? (product as Record<string, unknown>).handle;
    (out.variantSetContributions ??= []).push({
      identity: {
        gtin: gtin ? gtin.replace(/\D/g, '') : null,
        sku,
        id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null,
      },
      source: method,
      variantCount: product.variants.length,
    });
  }
  // Contradiction signal from a payload that DECLARES >= 2 variants.
  // Round-5 P0-3: when the expected identity is known, only a payload LINKED
  // to it may contradict — an unrelated recommended/product payload with
  // multiple variants neither proves nor contradicts. Page-level signals
  // (DOM variant selectors) remain the preferred contradiction source.
  // Round-8 P0-3: with an expected entity known, the contradiction is DEFERRED
  // to the final page-primary-qualified contribution pass in
  // evidenceFromBrowserSnapshot — a payload that merely carries the requested
  // GTIN (e.g. a recommendation) must not force parent_page before the
  // page-primary linkage is computed. Without an entity reference, keep the
  // legacy unscoped emission for direct callers (managed fallback).
  if (!opts?.expectedGtin && Array.isArray(product.variants) && product.variants.length > 1) {
    if (!out.variantSignals.some((signal) => signal.kind === 'parent_page')) {
      out.variantSignals.push({ kind: 'parent_page' });
    }
  }
  const variants = Array.isArray(product.variants) ? (product.variants as Array<Record<string, unknown>>).filter((v) => v && typeof v === 'object') : [];
  const firstVariant = variants[0];
  if (firstVariant) {
    const variantRef = typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined;
    out.variant = {
      id: variantRef,
      name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
      sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
    };
    if (typeof firstVariant.title === 'string') addFieldOnce(out.fields, 'variant_name', firstVariant.title, method, `${sourcePath}.variants[0].title`, { ...source, variantRef });
    if (typeof firstVariant.sku === 'string') addFieldOnce(out.fields, 'sku', firstVariant.sku, method, `${sourcePath}.variants[0].sku`, { ...source, variantRef });
    const variantGtin = gtinFromAny(firstVariant);
    if (variantGtin) {
      const digits = variantGtin.replace(/\D/g, '');
      if (!out.gtins.some((g) => g.value.replace(/\D/g, '') === digits && g.variantRef === variantRef)) out.gtins.push({ value: digits, method, sourcePath: `${sourcePath}.variants[0].gtin`, sourceArtifactId: opts?.artifactId, sourceContentHash: opts?.contentHash, variantRef: variantRef ?? null });
    }
  }
}

/** Round-6 P0-3: canonical URL form for page-context comparisons (no hash, no trailing slash, lowercase). */
function normalizeCanonicalUrl(value: string): string {
  try {
    const u = new URL(value);
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.replace(/\/$/, '').toLowerCase();
  }
}

/** Identity ids a product-like payload carries (@id/id/productId/handle/url/sku/gtin). */
function identityIdsOf(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['@id', 'id', 'productId', 'handle', 'url', 'sku']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) ids.push(value);
  }
  const gtin = gtinFromAny(payload);
  if (gtin) ids.push(gtin.replace(/\D/g, ''));
  return ids;
}

/**
 * Page-primary co-occurrence ids, EXCLUDING GTIN (round-7 P0-3): two
 * representations of the same recommendation (e.g. embedded JSON data plus
 * a /api/recommendations response) both carrying the requested GTIN must
 * never make that GTIN a page-primary identifier — GTIN equality is
 * identity evidence, not page-context evidence.
 */
function nonGtinIdentityIdsOf(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['@id', 'id', 'productId', 'handle', 'url', 'sku']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) ids.push(value);
  }
  return ids;
}

/** True for WebPage/ItemPage/ProductPage structured-data nodes. */
function isPageEntityType(payload: Record<string, unknown>): boolean {
  const t = payload['@type'] ?? payload.type;
  return typeof t === 'string' && /(WebPage|ItemPage|ProductPage)/i.test(t);
}

/** True for a leaf @type Product node (never ProductGroup). */
function isProductType(payload: Record<string, unknown>): boolean {
  const t = payload['@type'] ?? payload.type;
  return typeof t === 'string' && /(^|[^\w])Product([^\w]|$)/i.test(t);
}

/**
 * Round-6/7 P0-3: server-established identity ids of the page's PRIMARY/CURRENT
 * product entity, derived ONLY from page-level markers:
 *   - the canonical mainEntity of a WebPage/ItemPage/ProductPage node;
 *   - a product payload whose url/@id equals the canonical page URL;
 *   - identity co-occurrence: a non-GTIN stable id (sku/productId/handle)
 *     declared by two or more product-like payloads.
 *
 * Round-8 P0-3 (ANCHOR-PROPAGATION ONLY): co-occurrence may only PROPAGATE an
 * independent anchor, never create one. With no strong anchor (mainEntity /
 * canonical-URL match) AND an expected GTIN present, repeated non-GTIN
 * identifiers NEVER create page-primary status — a recommendation repeated
 * across payloads (same sku) stays corroboration, because the algorithm cannot
 * distinguish a current-product API repeating the SKU from a recommendations
 * API repeating it. Without an expected entity, the legacy co-occurrence
 * fallback remains for callers that have no identity reference.
 *
 * GTIN equality is intentionally NOT a primary marker: a recommendation
 * payload carrying the requested UPC must never become "the page's product"
 * merely because it shares the GTIN.
 */
function pagePrimaryEntityIds(snapshot: BrowserSnapshot, canonicalUrl: string, expectedGtin: string | null): string[] {
  const strongIds: string[] = [];
  const addIds = (payload: Record<string, unknown>): void => {
    strongIds.push(...identityIdsOf(payload));
  };
  const productLike: Array<Record<string, unknown>> = [];
  const collectProduct = (payload: Record<string, unknown>): void => {
    productLike.push(payload);
  };
  for (const entry of snapshot.jsonLd) {
    if (isPageEntityType(entry)) {
      const mainEntity = entry['mainEntity'];
      if (mainEntity && typeof mainEntity === 'object') {
        if (Array.isArray(mainEntity)) {
          for (const node of mainEntity) if (node && typeof node === 'object') addIds(node as Record<string, unknown>);
        } else {
          addIds(mainEntity as Record<string, unknown>);
        }
      }
      continue;
    }
    if (!isProductType(entry)) continue;
    const url = typeof entry.url === 'string' ? entry.url : typeof entry['@id'] === 'string' ? entry['@id'] : null;
    if (url && normalizeCanonicalUrl(url) === canonicalUrl) addIds(entry);
    collectProduct(entry);
  }
  for (const payload of snapshot.embeddedProductData) {
    const url = typeof payload.url === 'string' ? payload.url : null;
    if (url && normalizeCanonicalUrl(url) === canonicalUrl) addIds(payload);
    collectProduct(payload);
  }
  for (const net of snapshot.networkResponses) {
    if (net.jsonBody === null || net.jsonBody === undefined) continue;
    if (normalizeCanonicalUrl(net.url) === canonicalUrl) {
      const product = findProductLikeStrict(net.jsonBody);
      if (product) addIds(product);
    }
    const product = findProductLikeStrict(net.jsonBody);
    if (product) collectProduct(product);
  }
  if (strongIds.length > 0) {
    // Round-8: the anchor's NON-GTIN identity ids expand to other product-like
    // payloads sharing them (leaf JSON-LD product + its current-product API
    // response). GTINs never propagate page-primary status — identity evidence
    // is not page-context evidence. When the anchor carries no non-GTIN ids,
    // nothing propagates (the anchor ids themselves remain primary).
    const anchorNonGtin = new Set<string>();
    for (const id of strongIds) {
      if (!/^\d{8,14}$/.test(id)) anchorNonGtin.add(id.toLowerCase());
    }
    if (anchorNonGtin.size > 0) {
      const propagated: string[] = [...strongIds];
      for (const payload of productLike) {
        if (payloadSharesAnchor(payload, anchorNonGtin)) {
          for (const id of identityIdsOf(payload)) {
            if (!propagated.includes(id)) propagated.push(id);
          }
        }
      }
      return propagated;
    }
    return strongIds;
  }
  if (expectedGtin) {
    // Round-8 P0-3: repeated non-GTIN identifiers must never CREATE
    // page-primary status when an expected GTIN is being sought — a
    // recommendation repeated across payloads stays corroboration.
    return [];
  }
  // Legacy (no expected entity): repeated non-GTIN identity still marks the
  // page's current product for callers without an entity reference.
  const occurrences = new Map<string, number>();
  for (const payload of productLike) {
    for (const id of nonGtinIdentityIdsOf(payload)) {
      const key = id.toLowerCase();
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  }
  const repeated: string[] = [];
  for (const [key, count] of occurrences) {
    if (count >= 2) repeated.push(key);
  }
  return repeated;
}

/** True when a product-like payload shares any of the anchor's non-GTIN ids. */
function payloadSharesAnchor(payload: Record<string, unknown>, anchorNonGtin: ReadonlySet<string>): boolean {
  for (const id of nonGtinIdentityIdsOf(payload)) {
    if (anchorNonGtin.has(id.toLowerCase())) return true;
  }
  return false;
}

/** True when a contribution's identity (gtin/sku/id) matches the page-primary id set. */
function identityMatchesPrimaryIds(
  identity: { gtin: string | null; sku: string | null; id: string | null },
  primaryIds: string[],
): boolean {
  const set = new Set<string>();
  for (const raw of primaryIds) {
    set.add(raw);
    set.add(raw.toLowerCase());
    if (/^\d{8,14}$/.test(raw)) set.add(raw.replace(/\D/g, ''));
  }
  if (identity.gtin && (set.has(identity.gtin) || set.has(identity.gtin.replace(/\D/g, '')))) return true;
  for (const candidate of [identity.sku, identity.id]) {
    if (candidate && (set.has(candidate) || set.has(candidate.toLowerCase()))) return true;
  }
  return false;
}

/** Extract ladder evidence from a rendered snapshot (layers 5-6). */
export function evidenceFromBrowserSnapshot(
  snapshot: BrowserSnapshot,
  out: {
    fields: ExtractedFieldEvidence[];
    images: ExtractedImageCandidate[];
    gtins: Array<{ value: string; method: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string | null }>;
    sku: string | null;
    brand: string | null;
    productName: string | null;
    size: string | null;
    variant: { name?: string; id?: string; sku?: string } | null;
    variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    variantSetEvidence?: { single: boolean; multiple: boolean };
    /** Round-5 P0-3: per-payload declared variant-set contributions (entity-scoped). */
    variantSetContributions?: VariantSetContribution[];
    /** Round-6 P0-3: total product-like payloads processed (page context). */
    stats?: { productLikeCount: number };
    /** Round-6 P0-3: identity ids of the page's PRIMARY/CURRENT product entity. */
    pagePrimaryIds?: string[];
  },
  /**
   * Round-5 P0-3: the expected entity identity. Variant-set proof is computed
   * ONLY from contributions whose identity links to this entity — an
   * unrelated payload declaring one variant never proves this GTIN is
   * single-variant. When omitted, the single-contribution page fallback
   * applies (one product-like payload is treated as the page's primary
   * product) for callers without an entity reference.
   */
  expected?: { gtin?: string | null },
): { methodsUsed: string[]; variantSetEvidence: 'single' | 'multiple' | 'none' } {
  const methodsUsed: string[] = [];
  // Round-6 P0-3: establish the page's PRIMARY/CURRENT product entity from
  // page-level markers BEFORE iterating payloads (mainEntity, canonical-URL
  // match, first Product in document order). GTIN equality alone is identity
  // evidence, not page-context evidence — a recommendation payload carrying
  // the requested GTIN must not prove the primary product is single-variant.
  out.stats ??= { productLikeCount: 0 };
  out.pagePrimaryIds ??= pagePrimaryEntityIds(snapshot, normalizeCanonicalUrl(snapshot.finalUrl || snapshot.url), expected?.gtin ?? null);
  for (const jsonLd of snapshot.jsonLd) {
    evidenceFromProductPayload(jsonLd, 'json_ld', 'browser JSON-LD', out, { expectedGtin: expected?.gtin ?? null, artifactId: snapshot.artifactId, contentHash: snapshot.contentHash });
    methodsUsed.push('json_ld');
  }
  for (const embedded of snapshot.embeddedProductData) {
    evidenceFromProductPayload(embedded, 'browser', 'browser embedded data', out, { expectedGtin: expected?.gtin ?? null, artifactId: snapshot.artifactId, contentHash: snapshot.contentHash });
    methodsUsed.push('embedded_data');
  }
  for (const network of snapshot.networkResponses) {
    if (network.jsonBody === null || network.jsonBody === undefined) continue;
    // Strict product finder for network bodies: cart/account payloads carry
    // title+sku too, so a network response only becomes product evidence when
    // it has real product identity (gtin/variants/handle) — review PI-11-M2.
    const product = findProductLikeStrict(network.jsonBody);
    if (product) {
      const sourcePath = network.sourcePath ?? `network:${network.url.split('?')[0].slice(0, 200)}`;
      evidenceFromProductPayload(product, 'network_response', sourcePath, out, { expectedGtin: expected?.gtin ?? null, artifactId: network.artifactId, contentHash: network.contentHash });
      methodsUsed.push('network_response');
    }
  }
  for (const image of snapshot.imageCandidates) {
    if (!out.images.some((i) => i.url === image)) out.images.push({ url: image, sourcePath: 'browser image candidates', sourceArtifactId: snapshot.artifactId, sourceContentHash: snapshot.contentHash });
  }

  // ---- Round-5 P0-3: compute the ENTITY-SCOPED variant-set signal. ----
  // DOM variant-selector affordances are PAGE-LEVEL affirmative evidence and
  // are not entity-scoped (a selector belongs to the page, not a payload).
  let domSingle = false;
  let domMultiple = false;
  for (const selector of snapshot.domVariantSelectors ?? []) {
    if (selector.optionCount >= 2) {
      domMultiple = true;
      if (!out.variantSignals.some((signal) => signal.kind === 'parent_page')) {
        out.variantSignals.push({ kind: 'parent_page' });
      }
    } else if (selector.optionCount === 1) {
      domSingle = true;
    }
  }
  const contributions = out.variantSetContributions ?? [];
  const expectedDigits = expected?.gtin ? String(expected.gtin).replace(/\D/g, '') : null;
  // Round-6 P0-3: linkage requires the contribution to be the page's
  // PRIMARY/CURRENT product entity AND (when an expected GTIN exists) to
  // carry that GTIN. A payload that merely carries the requested GTIN (e.g.
  // a recommendation/cross-sell for the same UPC) is identity evidence, not
  // page-context evidence — it must not prove the page's product is
  // single-variant.
  // Round-7 P0-3: with an expected GTIN, a page with exactly ONE
  // product-like payload is NOT primary by definition — the real product may
  // render as DOM/meta while the only captured structured/network payload is
  // a cross-sell. Primary/current-page identity requires an independent
  // page-context marker (mainEntity, canonical @id/url, platform current-
  // product id, selected-child state, or repeated NON-GTIN stable identity).
  // Round-8 P0-3: the repeated non-GTIN identity path only PROPAGATES an
  // independent anchor (see pagePrimaryEntityIds); with an expected GTIN and
  // no anchor, no payload is primary and repeated recommendations stay
  // corroboration. Both the positive (single-variant proof) and the
  // CONTRADICTION (parent_page) signals are computed from this same final
  // page-primary-qualified contribution set.
  const primaryIds = out.pagePrimaryIds ?? [];
  const totalProductLike = out.stats?.productLikeCount ?? contributions.length;
  const linked = (contribution: VariantSetContribution): boolean => {
    const isPrimary =
      (expectedDigits === null && totalProductLike === 1) ||
      (primaryIds.length > 0 && identityMatchesPrimaryIds(contribution.identity, primaryIds));
    if (!isPrimary) return false;
    if (expectedDigits) {
      // When the expected GTIN exists, linkage is GTIN equality — a payload
      // without it (or with a different GTIN) is NOT the entity, even if it
      // is the only product-like payload on the page.
      return contribution.identity.gtin !== null && contribution.identity.gtin === expectedDigits;
    }
    // No expected identity: the page's primary product is the only anchor.
    return true;
  };
  let payloadSingle = false;
  let payloadMultiple = false;
  for (const contribution of contributions) {
    if (!linked(contribution)) continue;
    if (contribution.variantCount === 1) payloadSingle = true;
    else if (contribution.variantCount > 1) {
      payloadMultiple = true;
      // Round-8 P0-3: only a page-primary-qualified payload may contradict.
      if (!out.variantSignals.some((signal) => signal.kind === 'parent_page')) {
        out.variantSignals.push({ kind: 'parent_page' });
      }
    }
  }
  const single = payloadSingle || domSingle;
  const multiple = payloadMultiple || domMultiple;
  out.variantSetEvidence = { single, multiple };
  const variantSetEvidence: 'single' | 'multiple' | 'none' = multiple
    ? 'multiple'
    : single
      ? 'single'
      : 'none';
  return { methodsUsed: [...new Set(methodsUsed)], variantSetEvidence };
}

/** Product-like only with strong identity markers (gtin/variants/handle). */
function findProductLikeStrict(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductLikeStrict(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (
    (typeof obj.title === 'string' || typeof obj.name === 'string') &&
    ('gtin' in obj || 'variants' in obj || 'handle' in obj)
  ) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    const found = findProductLikeStrict(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Execute a bounded interaction and return the resulting evidence. */
export async function runBrowserInteraction(
  snapshot: BrowserSnapshotFn,
  url: string,
  interaction: InteractionAction,
  out: {
    fields: ExtractedFieldEvidence[];
    images: ExtractedImageCandidate[];
    gtins: Array<{ value: string; method: string }>;
    sku: string | null;
    brand: string | null;
    productName: string | null;
    size: string | null;
    variant: { name?: string; id?: string; sku?: string } | null;
    variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
    variantSetEvidence?: { single: boolean; multiple: boolean };
  },
  // P0-5 round 2: the EXPECTED variant (name/GTIN from the run input). A
  // successful interaction only proves an option was selected — variant_match
  // additionally requires the selected option to correspond to the expected
  // size/flavor.
  expectedVariant?: { name?: string; gtin?: string },
): Promise<{ finalUrl: string; selectedOptions: string[]; methodsUsed: string[]; warnings: string[] }> {
  const snapshotResult = await snapshot({ url, captureNetwork: true, interaction });
  const { methodsUsed } = evidenceFromBrowserSnapshot(snapshotResult, out, { gtin: expectedVariant?.gtin ?? null });
  if (interaction.type === 'select_option' && snapshotResult.interaction?.performed) {
    for (const option of snapshotResult.interaction.selectedOptions) {
      addFieldOnce(out.fields, 'variant_selection', option, 'browser', 'interaction selected option');
      // P0-5 round 2: tie the selected option to the EXPECTED variant.
      // Without expected terms no comparison is possible — emit NO signal
      // (absence of a signal must never imply a match).
      const expectedName = expectedVariant?.name;
      if (expectedName) {
        if (variantTokenOverlap(expectedName, option) >= 0.5) {
          out.variantSignals.push({ kind: 'variant_match' });
        } else {
          out.variantSignals.push({ kind: 'variant_mismatch' });
        }
      }
    }
  }
  return {
    finalUrl: snapshotResult.interaction?.finalUrl ?? snapshotResult.finalUrl,
    selectedOptions: snapshotResult.interaction?.selectedOptions ?? [],
    methodsUsed,
    warnings: snapshotResult.warnings,
  };
}
