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
}

export interface BrowserSnapshot {
  url: string;
  finalUrl: string;
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
  gtins: Array<{ value: string; method: string }>;
  sku: string | null;
  brand: string | null;
  productName: string | null;
  size: string | null;
  variant: { name?: string; id?: string; sku?: string } | null;
  variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }>;
  selectedOptions: string[];
  finalUrl: string;
  methodsUsed: string[];
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

function addFieldOnce(fields: ExtractedFieldEvidence[], field: string, value: string | null | undefined, method: string, sourcePath?: string): void {
  if (value === null || value === undefined) return;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return;
  if (fields.some((f) => f.field === field && f.value === trimmed && f.method === method)) return;
  fields.push({ field, value: trimmed.slice(0, 2000), method, sourcePath });
}

/** Extract ladder evidence from an arbitrary product-like payload. */
export function evidenceFromProductPayload(
  product: Record<string, unknown>,
  method: string,
  sourcePath: string,
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
  },
  /** Round-5 P0-3: the expected entity identity (when known) scopes both proof
   *  and contradiction signals to linked payloads. When absent, callers
   *  without entity context keep the legacy unscoped behavior. */
  opts?: { expectedGtin?: string | null },
): void {
  const title = typeof product.title === 'string' ? product.title : typeof product.name === 'string' ? product.name : null;
  const sku = typeof product.sku === 'string' ? product.sku : null;
  const brand = typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : null;
  const size = typeof product.size === 'string' ? product.size : null;
  const gtin = gtinFromAny(product);

  if (title) addFieldOnce(out.fields, 'product_name', title, method, sourcePath);
  if (sku) addFieldOnce(out.fields, 'sku', sku, method, sourcePath);
  if (brand) addFieldOnce(out.fields, 'brand', brand, method, sourcePath);
  if (size) addFieldOnce(out.fields, 'size', size, method, sourcePath);
  if (gtin) {
    const digits = gtin.replace(/\D/g, '');
    if (!out.gtins.some((g) => g.value.replace(/\D/g, '') === digits)) out.gtins.push({ value: digits, method });
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
    if (!out.images.some((i) => i.url === image)) out.images.push({ url: image, sourcePath });
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
  const linkedToExpected = (): boolean => {
    if (!opts?.expectedGtin) return true; // no entity context: legacy behavior
    const expectedDigits = String(opts.expectedGtin).replace(/\D/g, '');
    return gtin !== null && gtin.replace(/\D/g, '') === expectedDigits;
  };
  if (Array.isArray(product.variants) && product.variants.length > 1 && linkedToExpected()) {
    if (!out.variantSignals.some((signal) => signal.kind === 'parent_page')) {
      out.variantSignals.push({ kind: 'parent_page' });
    }
  }
  const variants = Array.isArray(product.variants) ? (product.variants as Array<Record<string, unknown>>).filter((v) => v && typeof v === 'object') : [];
  const firstVariant = variants[0];
  if (firstVariant) {
    out.variant = {
      id: typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined,
      name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
      sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
    };
  }
}

/** Extract ladder evidence from a rendered snapshot (layers 5-6). */
export function evidenceFromBrowserSnapshot(
  snapshot: BrowserSnapshot,
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
    /** Round-5 P0-3: per-payload declared variant-set contributions (entity-scoped). */
    variantSetContributions?: VariantSetContribution[];
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
  for (const jsonLd of snapshot.jsonLd) {
    evidenceFromProductPayload(jsonLd, 'json_ld', 'browser JSON-LD', out, { expectedGtin: expected?.gtin ?? null });
    methodsUsed.push('json_ld');
  }
  for (const embedded of snapshot.embeddedProductData) {
    evidenceFromProductPayload(embedded, 'browser', 'browser embedded data', out, { expectedGtin: expected?.gtin ?? null });
    methodsUsed.push('embedded_data');
  }
  for (const network of snapshot.networkResponses) {
    if (network.jsonBody === null || network.jsonBody === undefined) continue;
    // Strict product finder for network bodies: cart/account payloads carry
    // title+sku too, so a network response only becomes product evidence when
    // it has real product identity (gtin/variants/handle) — review PI-11-M2.
    const product = findProductLikeStrict(network.jsonBody);
    if (product) {
      const sourcePath = `network:${network.url.split('?')[0].slice(0, 200)}`;
      evidenceFromProductPayload(product, 'network_response', sourcePath, out, { expectedGtin: expected?.gtin ?? null });
      methodsUsed.push('network_response');
    }
  }
  for (const image of snapshot.imageCandidates) {
    if (!out.images.some((i) => i.url === image)) out.images.push({ url: image, sourcePath: 'browser image candidates' });
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
  const linked = (contribution: VariantSetContribution): boolean => {
    if (expectedDigits) {
      // When the expected GTIN exists, linkage is GTIN equality — a payload
      // without it (or with a different GTIN) is NOT the entity, even if it
      // is the only product-like payload on the page.
      return contribution.identity.gtin !== null && contribution.identity.gtin === expectedDigits;
    }
    // No expected identity: the page's single product-like payload is its
    // primary/canonical product. With multiple unidentifiable payloads, none
    // may prove anything (conservative — absence never proves).
    return contributions.length === 1;
  };
  let payloadSingle = false;
  let payloadMultiple = false;
  for (const contribution of contributions) {
    if (!linked(contribution)) continue;
    if (contribution.variantCount === 1) payloadSingle = true;
    else if (contribution.variantCount > 1) payloadMultiple = true;
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
