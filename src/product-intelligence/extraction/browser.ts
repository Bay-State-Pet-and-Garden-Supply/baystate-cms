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
  },
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

  if (Array.isArray(product.variants) && product.variants.length > 1) {
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
  },
): string[] {
  const methodsUsed: string[] = [];
  for (const jsonLd of snapshot.jsonLd) {
    evidenceFromProductPayload(jsonLd, 'json_ld', 'browser JSON-LD', out);
    methodsUsed.push('json_ld');
  }
  for (const embedded of snapshot.embeddedProductData) {
    evidenceFromProductPayload(embedded, 'browser', 'browser embedded data', out);
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
      evidenceFromProductPayload(product, 'network_response', sourcePath, out);
      methodsUsed.push('network_response');
    }
  }
  for (const image of snapshot.imageCandidates) {
    if (!out.images.some((i) => i.url === image)) out.images.push({ url: image, sourcePath: 'browser image candidates' });
  }
  return [...new Set(methodsUsed)];
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
  },
): Promise<{ finalUrl: string; selectedOptions: string[]; methodsUsed: string[]; warnings: string[] }> {
  const snapshotResult = await snapshot({ url, captureNetwork: true, interaction });
  const methodsUsed = evidenceFromBrowserSnapshot(snapshotResult, out);
  if (interaction.type === 'select_option' && snapshotResult.interaction?.performed) {
    for (const option of snapshotResult.interaction.selectedOptions) {
      out.variantSignals.push({ kind: 'variant_match' });
      addFieldOnce(out.fields, 'variant_selection', option, 'browser', 'interaction selected option');
    }
  }
  return {
    finalUrl: snapshotResult.interaction?.finalUrl ?? snapshotResult.finalUrl,
    selectedOptions: snapshotResult.interaction?.selectedOptions ?? [],
    methodsUsed,
    warnings: snapshotResult.warnings,
  };
}
