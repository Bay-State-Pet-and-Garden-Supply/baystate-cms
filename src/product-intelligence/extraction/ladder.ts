/**
 * Deterministic PI-11 extraction ladder (layers 1-4). Executes the cheapest
 * reliable layer first and escalates only when evidence is insufficient:
 *
 *   1. Direct HTTP retrieval.
 *   2. JSON-LD / microdata / Open Graph / canonical / meta structured data.
 *   3. Platform-specific public product representations (Shopify product
 *      JSON, WooCommerce Store API payloads, Next.js app state, Nuxt
 *      hydration state).
 *   4. Existing domain-specific extraction profiles (declared seam; none
 *      registered into Pi yet — they live in the extraction worker).
 *
 * Rendered-browser capture, bounded interaction, managed fallbacks, and
 * narrow LLM extraction are layers 5-8 (this module). The engine
 * returns ONE normalized evidence-backed result regardless of layers used;
 * retrieval success is always distinguished from correct product extraction
 * via the identity status.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import type { PageExtractionResult, ExtractedFieldEvidence, ExtractedIdentifierEvidence, ExtractedImageCandidate } from '../tools/contract';
import {
  classifyPageIdentity,
  jsonLdLeafProductProof,
  structuredSingleVariantProof,
  type PageExtractionContract,
} from '../tools/contract';
import { fetchPageHtml, parseStructuredSignals, detectPlatform, parseNextJsData, parseNuxtData, shopifyProductUrl, fetchShopifyProductJson, parseWooCommerceStoreApi, gtinFromAny, type FetchedPage } from './platforms';
import { evidenceFromBrowserSnapshot, evidenceFromProductPayload, runBrowserInteraction, type BrowserSnapshotFn } from './browser';
import type { ManagedFallbackRegistry, ManagedPage } from './managed-fallback';
import { isLlmAvailable, type LlmExtractionAdapter } from './llm';
import type { InteractionAction } from '../../shared/schemas/extraction-worker';

export interface LadderOptions {
  /** Policy authorization checked before every arbitrary HTTP(S) destination. */
  networkGate?: (url: string, signal: AbortSignal) => Promise<{ allowed: boolean; code?: string; detail?: string }>;
  fetchPage?: typeof fetchPageHtml;
  fetchShopify?: typeof fetchShopifyProductJson;
  /**
   * Layer-4 seam: registered domain profiles (CSS-selector extractors).
   * Empty by default — the extraction worker's profiles are not wired into
   * Pi; a future slice registers approved profiles per domain.
   */
  profiles?: Array<{
    name: string;
    /** Optional durable identity/version for provenance bundles. */
    id?: string;
    version?: string | number;
    runtime?: 'static' | 'rendered';
    matches(url: string): boolean;
    extract(
      url: string,
      signal: AbortSignal,
      timeoutMs: number,
      expected?: { gtin?: string; name?: string; brandHint?: string | null },
    ): Promise<{
      fields: ExtractedFieldEvidence[];
      images: Array<{ url: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string }>;
      profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered'; artifactId?: string | null; contentHash?: string | null };
    } | null>;
  }>;
  /** Layer 5: rendered browser with network capture (injected worker client). */
  browser?: { snapshot: BrowserSnapshotFn } | null;
  /** Layer 6: exact bounded interaction constraints (caller-supplied only). */
  interaction?: InteractionAction | null;
  /** Layer 7: benchmark-selected managed browser / unlocking fallback. */
  managedFallback?: ManagedFallbackRegistry | null;
  /** Layer 8: narrow schema-constrained LLM extraction (env-configured model). */
  llm?: { adapter: LlmExtractionAdapter } | null;
}

export interface LadderRun {
  result: PageExtractionResult;
  layersUsed: string[];
  /** Approved profile selected by the ladder, when one matched. */
  profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered'; artifactId?: string | null; contentHash?: string | null } | null;
}

/** Digits-only comparison of expected vs extracted GTINs. */
export function exactGtinMatch(expected: string | undefined, extractedGtins: Array<{ value: string }>): boolean {
  if (!expected) return false;
  const normalized = expected.replace(/\D/g, '');
  if (normalized.length === 0) return false;
  return extractedGtins.some((g) => g.value.replace(/\D/g, '') === normalized);
}

export async function runExtractionLadder(
  url: string,
  expected: { gtin?: string; name?: string; brandHint?: string | null },
  signal: AbortSignal,
  timeoutMs: number,
  options: LadderOptions = {},
): Promise<LadderRun> {
  const layersUsed: string[] = [];
  const fields: ExtractedFieldEvidence[] = [];
  const images: ExtractedImageCandidate[] = [];
  const gtins: ExtractedIdentifierEvidence[] = [];
  type SourceMetadata = {
    artifactId?: string | null;
    contentHash?: string | null;
    variantRef?: string | null;
    profileId?: string | null;
    profileVersion?: string | number | null;
  };
  let pageArtifactId: string | null = null;
  const conflicts: Array<{ field: string; summary: string }> = [];
  const fetchModes: string[] = [];
  const variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }> = [];
  let sku: string | null = null;
  let brand: string | null = null;
  let productName: string | null = null;
  let size: string | null = null;
  const packCount: number | null = null;
  let variant: { name?: string; id?: string; sku?: string } | null = null;
  let finalUrl = url;
  let contentHash: string | null = null;
  // P0-5 proof accumulator (round 3): proof strength is tracked by SOURCE.
  // A JSON-LD single-offer claim is CORROBORATION (structured) — it records
  // the page's self-declared single-variant state but NEVER settles exact
  // identity on its own. Only a platform payload or a rendered-browser
  // snapshot that affirmatively sees the variant set (platform/browser)
  // provides sufficient single-variant proof. Absence of variant UI or
  // signals is never treated as proof.
  type VariantProofSource = 'platform' | 'browser' | 'structured' | 'none';
  const PROOF_STRENGTH: Record<Exclude<VariantProofSource, 'none'>, number> = {
    platform: 3,
    browser: 2,
    structured: 1,
  };
  let variantProofSource: VariantProofSource = 'none';
  const noteProof = (source: Exclude<VariantProofSource, 'none'>): void => {
    if (PROOF_STRENGTH[source] > (PROOF_STRENGTH[variantProofSource as Exclude<VariantProofSource, 'none'>] ?? 0)) {
      variantProofSource = source;
    }
  };
  const selectedVariantLinkage = (): boolean => variantSignals.some((s) => s.kind === 'variant_match');
  const authorizeNetwork = async (destination: string): Promise<void> => {
    if (!options.networkGate) return;
    const decision = await options.networkGate(destination, signal);
    if (!decision.allowed) throw new Error(`network denied${decision.code ? `: ${decision.code}` : ''}${decision.detail ? ` (${decision.detail})` : ''}`);
  };
  // P0-5 round 2: an affirmative contradiction — platform/browser revealing
  // multiple variants (parent_page) or a variant mismatch — invalidates any
  // proof claim. Structured corroboration never survives a layer that
  // actually sees the variant set.
  const contradictoryVariant = (): boolean =>
    variantSignals.some((s) => s.kind === 'parent_page' || s.kind === 'variant_mismatch');
  // Only platform/browser sources are sufficient; structured corroboration
  // never produces exact identity on its own (P0-5 round 3).
  const effectiveSingleVariantProof = (): boolean =>
    (variantProofSource === 'platform' || variantProofSource === 'browser') && !contradictoryVariant();

  const pageSource = (): SourceMetadata => ({ artifactId: pageArtifactId, contentHash });
  const addField = (field: string, value: string | null | undefined, method: string, sourcePath?: string, source: SourceMetadata = pageSource()): void => {
    if (value === null || value === undefined) return;
    const trimmed = String(value).trim();
    if (trimmed.length === 0) return;
    if (fields.some((f) => f.field === field && f.value === trimmed && f.method === method && f.variantRef === (source.variantRef ?? undefined))) return;
    fields.push({ field, value: trimmed.slice(0, 2000), method, sourcePath, sourceArtifactId: source.artifactId, sourceContentHash: source.contentHash, sourceProfileId: source.profileId, sourceProfileVersion: source.profileVersion, variantRef: source.variantRef });
  };

  const addGtin = (value: string, method: string, sourcePath?: string, source: SourceMetadata = pageSource()): void => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 6) return;
    if (gtins.some((g) => g.value.replace(/\D/g, '') === digits && g.method === method && g.variantRef === (source.variantRef ?? undefined))) return;
    const existing = gtins.find((g) => g.value.replace(/\D/g, '') !== digits);
    if (existing) {
      conflicts.push({ field: 'gtin', summary: `conflicting GTIN evidence: ${existing.value} vs ${digits}` });
    }
    gtins.push({ value: digits, method, sourcePath, sourceArtifactId: source.artifactId, sourceContentHash: source.contentHash, variantRef: source.variantRef });
  };

  // Nuxt hydration state (window.__NUXT__ / __NUXT_DATA__) can carry a full
  // variant list. Emit provenance + variantRef for EVERY variant entry — not
  // only variants[0] — including per-variant SKU/GTIN and field observations,
  // so downstream identity work never flattens the variant set.
  const emitNuxtProduct = (product: Record<string, unknown>): void => {
    addField('product_name', product.title as string | undefined, 'platform_api', '__NUXT__ product');
    if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NUXT__ product.sku');
    const productGtin = gtinFromAny(product);
    if (productGtin) addGtin(productGtin, 'platform_api', '__NUXT__ product.gtin');
    productName ??= typeof product.title === 'string' ? product.title : null;
    sku ??= typeof product.sku === 'string' ? product.sku : null;
    brand ??= typeof product.brand === 'string' ? product.brand : null;
    if (typeof product.brand === 'string') addField('brand', product.brand, 'platform_api', '__NUXT__ product.brand');
    const productImages = Array.isArray(product.images)
      ? product.images
          .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown; url?: unknown })?.src ?? (img as { url?: unknown })?.url))
          .filter((src): src is string => typeof src === 'string')
      : [];
    for (const image of productImages) {
      if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: '__NUXT__ product.images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
    if (Array.isArray(product.variants)) {
      const variantList = product.variants.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      const first = variantList[0];
      if (first) {
        variant = {
          id: typeof first.id === 'string' || typeof first.id === 'number' ? String(first.id) : undefined,
          name: typeof first.title === 'string' ? first.title : typeof first.name === 'string' ? first.name : undefined,
          sku: typeof first.sku === 'string' ? first.sku : undefined,
        };
        if (variantList.length > 1) {
          variantSignals.push({ kind: 'parent_page' });
        } else if (variantList.length === 1) {
          // Platform API affirmatively reports exactly one variant.
          noteProof('platform');
        }
      }
      variantList.forEach((v, index) => {
        const variantRef = typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id) : `nuxt-variant-${index}`;
        const variantSource: SourceMetadata = { ...pageSource(), variantRef };
        const variantPath = `__NUXT__ product.variants[${index}]`;
        const variantTitle = typeof v.title === 'string' ? v.title : typeof v.name === 'string' ? v.name : undefined;
        if (variantTitle) addField('variant_name', variantTitle, 'platform_api', `${variantPath}.title`, variantSource);
        if (typeof v.sku === 'string') {
          addField(index === 0 ? 'sku' : 'variant_sku', v.sku, 'platform_api', `${variantPath}.sku`, variantSource);
        }
        if (index === 0 && typeof v.option1 === 'string') addField('size', v.option1, 'platform_api', `${variantPath}.option1`, variantSource);
        const variantGtin = gtinFromAny(v);
        if (variantGtin) addGtin(variantGtin, 'platform_api', `${variantPath}.barcode`, variantSource);
      });
    }
  };

  // Layer 1 + 2: one HTTP fetch, then parse every embedded structured signal.
  let page: FetchedPage;
  try {
    // A raw default transport is never permitted without an explicit policy
    // gate. Injected transports are the provider-neutral seam and are expected
    // to be gateway-bound by their caller.
    if (!options.fetchPage && !options.networkGate) throw new Error('network policy gate required for default transport');
    await authorizeNetwork(url);
    page = await (options.fetchPage ?? fetchPageHtml)(url, signal, timeoutMs);
    if (options.networkGate && page.finalUrl !== url) await authorizeNetwork(page.finalUrl);
  } catch (error) {
    return {
      result: {
        requestedUrl: url,
        finalUrl: url,
        fetchModes: ['http'],
        contentHash: null,
        artifactRef: null,
        fields: [],
        gtins: [],
        sku: null,
        brand: null,
        productName: null,
        variant: null,
        size: null,
        packCount: null,
        images: [],
        conflicts: [
          { field: '_retrieval', summary: error instanceof Error ? error.message.slice(0, 300) : 'fetch failed' },
        ],
        identityStatus: 'insufficient_evidence',
        identityReasons: ['page could not be retrieved'],
        deterministicOnly: true,
      },
      layersUsed: ['http'],
      profile: null,
    };
  }
  layersUsed.push('http', 'structured_data');
  fetchModes.push('http', 'structured_data');
  finalUrl = page.finalUrl;
  contentHash = page.contentHash;
  pageArtifactId = page.artifactId ?? null;

  const signals = parseStructuredSignals(page.html);
  // JSON-LD single-offer = corroboration only (never sufficient on its own).
  if (structuredSingleVariantProof(page.html)) noteProof('structured');
  for (const product of signals.jsonLdProducts) {
    if (product.name) addField('product_name', product.name, 'json_ld', 'JSON-LD Product.name');
    if (product.sku) addField('sku', product.sku, 'json_ld', 'JSON-LD Product.sku');
    if (product.brand) addField('brand', product.brand, 'json_ld', 'JSON-LD Product.brand');
    if (product.gtin) addGtin(product.gtin, 'json_ld', 'JSON-LD Product.gtin');
    if (product.size) addField('size', product.size, 'json_ld', 'JSON-LD Product.size');
    for (const image of product.images) {
      if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: 'JSON-LD Product.image', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
    productName ??= product.name;
    sku ??= product.sku;
    brand ??= product.brand;
    size ??= product.size;
  }
  if (signals.metaTitle) addField('product_name', signals.metaTitle, 'meta', 'og:title');
  if (signals.metaDescription) addField('description', signals.metaDescription, 'meta', 'meta[name=description]');
  if (signals.ogImage) {
    if (!images.some((i) => i.url === signals.ogImage)) {
      images.push({ url: signals.ogImage, sourcePath: 'og:image', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
  }
  productName ??= signals.ogTitle ?? signals.metaTitle;

  // Layer 3: platform-specific public product representations.
  layersUsed.push('platform_api');
  fetchModes.push('platform_api');
  const platform = detectPlatform(page.html, page.finalUrl);
  switch (platform) {
    case 'shopify': {
      const jsonUrl = shopifyProductUrl(page.finalUrl);
      if (jsonUrl) {
        try {
          await authorizeNetwork(jsonUrl);
          const productJson = await (options.fetchShopify ?? fetchShopifyProductJson)(jsonUrl, signal, timeoutMs);
          if (productJson.sourceUrl && options.networkGate) await authorizeNetwork(productJson.sourceUrl);
          layersUsed.push('shopify');
          const platformSource: SourceMetadata = {
            artifactId: productJson.sourceArtifactId,
            contentHash: productJson.sourceContentHash,
          };
          addField('product_name', productJson.title, 'platform_api', productJson.sourcePath ?? 'Shopify product JSON', platformSource);
          addField('brand', productJson.vendor ?? undefined, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.vendor`, platformSource);
          const gtin = gtinFromAny(productJson as unknown as Record<string, unknown>);
          if (gtin) addGtin(gtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.gtin`, platformSource);
          productName ??= productJson.title;
          brand ??= productJson.vendor ?? null;
          if (productJson.variants.length > 1) {
            variantSignals.push({ kind: 'parent_page' });
          } else if (productJson.variants.length === 1) {
            // Platform API affirmatively reports exactly one variant.
            noteProof('platform');
          }
          const first = productJson.variants[0];
          if (first) {
            variant = {
              id: String(first.id ?? ''),
              name: typeof first.title === 'string' ? first.title : undefined,
              sku: typeof first.sku === 'string' ? first.sku : undefined,
            };
            if (first.title) addField('variant_name', first.title, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].title`, { ...platformSource, variantRef: String(first.id) });
            if (first.option1) addField('size', first.option1, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].option1`, { ...platformSource, variantRef: String(first.id) });
            if (first.sku) addField('sku', first.sku, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].sku`, { ...platformSource, variantRef: String(first.id) });
            const firstGtin = gtinFromAny(first as unknown as Record<string, unknown>);
            if (firstGtin) addGtin(firstGtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].barcode`, { ...platformSource, variantRef: String(first.id) });
          }
          for (const v of productJson.variants) {
            const variantRef = String(v.id);
            if (v.sku && v.sku !== first?.sku) addField('variant_sku', v.sku, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[].sku`, { ...platformSource, variantRef });
            const variantGtin = gtinFromAny(v as unknown as Record<string, unknown>);
            if (variantGtin) addGtin(variantGtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[].barcode`, { ...platformSource, variantRef });
          }
          for (const image of productJson.images) {
            if (!images.some((i) => i.url === image.src)) {
              images.push({ url: image.src, sourcePath: `${productJson.sourcePath ?? 'Shopify product JSON'}.images`, sourceArtifactId: platformSource.artifactId, sourceContentHash: platformSource.contentHash, variantRef: image.variant_ids[0] !== undefined ? String(image.variant_ids[0]) : undefined });
            }
          }
        } catch {
          layersUsed.push('shopify_failed');
          // Shopify-Hydrogen headless stores pair Shopify markers with
          // Next.js/Nuxt app state; the .js endpoint 404s but the embedded
          // state still carries the product (review PI-11-MAJOR-4).
          const nextFallback = parseNextJsData(page.html);
          if (nextFallback.product) {
            layersUsed.push('nextjs');
            const product = nextFallback.product;
            addField('product_name', product.title as string | undefined, 'platform_api', '__NEXT_DATA__ product');
            if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NEXT_DATA__ product.sku');
            const fallbackGtin = gtinFromAny(product);
            if (fallbackGtin) addGtin(fallbackGtin, 'platform_api', '__NEXT_DATA__ product.gtin');
            productName ??= typeof product.title === 'string' ? product.title : null;
            sku ??= typeof product.sku === 'string' ? product.sku : null;
            if (Array.isArray(product.variants)) {
              const firstVariant = product.variants.find((v) => !!v && typeof v === 'object') as Record<string, unknown> | undefined;
              if (firstVariant) {
                variant = {
                  id: typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined,
                  name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
                  sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
                };
                if (product.variants.length > 1) {
                  variantSignals.push({ kind: 'parent_page' });
                } else if (product.variants.length === 1) {
                  // Platform API affirmatively reports exactly one variant.
                  noteProof('platform');
                }
              }
            }
          } else {
            const nuxtFallback = parseNuxtData(page.html);
            if (nuxtFallback.product) {
              layersUsed.push('nuxt');
              emitNuxtProduct(nuxtFallback.product);
            }
          }
        }
      }
      break;
    }
    case 'woocommerce': {
      const wc = parseWooCommerceStoreApi(page.html, page.finalUrl);
      if (wc.product) {
        layersUsed.push('woocommerce');
        addField('product_name', wc.product.name ?? undefined, 'platform_api', 'WooCommerce Store API payload');
        addField('sku', wc.product.sku ?? undefined, 'platform_api', 'WooCommerce Store API payload');
        if (wc.product.price) addField('price', wc.product.price, 'platform_api', 'WooCommerce Store API payload');
        productName ??= wc.product.name;
        sku ??= wc.product.sku;
        for (const image of wc.product.images) {
          if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: 'WooCommerce Store API images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
        }
        for (const attr of wc.product.attributes) {
          addField(`attribute_${attr.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, attr.value, 'platform_api', 'WooCommerce Store API attributes');
        }
      } else {
        layersUsed.push('woocommerce_embedded_none');
      }
      break;
    }
    case 'nextjs': {
      const nextData = parseNextJsData(page.html);
      if (nextData.product) {
        layersUsed.push('nextjs');
        const product = nextData.product;
        addField('product_name', product.title as string | undefined, 'platform_api', '__NEXT_DATA__ product');
        if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NEXT_DATA__ product.sku');
        const gtin = gtinFromAny(product);
        if (gtin) addGtin(gtin, 'platform_api', '__NEXT_DATA__ product.gtin');
        productName ??= typeof product.title === 'string' ? product.title : null;
        sku ??= typeof product.sku === 'string' ? product.sku : null;
        brand ??= typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : null;
        if (typeof product.brand === 'string') addField('brand', product.brand, 'platform_api', '__NEXT_DATA__ product.brand');
        const productImages = Array.isArray(product.images)
          ? product.images
              .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown; url?: unknown })?.src ?? (img as { url?: unknown })?.url))
              .filter((src): src is string => typeof src === 'string')
          : [];
        for (const image of productImages) {
          if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: '__NEXT_DATA__ product.images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
        }
        if (Array.isArray(product.variants)) {
          const firstVariant = product.variants.find((v) => !!v && typeof v === 'object') as Record<string, unknown> | undefined;
          if (firstVariant) {
            variant = {
              id: typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined,
              name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
              sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
            };
            if (product.variants.length > 1) {
              variantSignals.push({ kind: 'parent_page' });
            } else if (product.variants.length === 1) {
              // Platform API affirmatively reports exactly one variant.
              noteProof('platform');
            }
          }
        }
      } else {
        layersUsed.push('nextjs_no_product');
      }
      break;
    }
    case 'nuxt': {
      const nuxtData = parseNuxtData(page.html);
      if (nuxtData.product) {
        layersUsed.push('nuxt');
        emitNuxtProduct(nuxtData.product);
      } else {
        layersUsed.push('nuxt_no_product');
      }
      break;
    }
    default:
      layersUsed.push('platform_none');
  }

  // Layer 4: registered domain profiles (CSS selector extractors).
  let profileMatched = false;
  let selectedProfile: LadderRun['profile'] = null;
  for (const profile of options.profiles ?? []) {
    if (!profile.matches(finalUrl)) continue;
    profileMatched = true;
    layersUsed.push('profile_selector');
    fetchModes.push('profile_selector');
    try {
      const out = await profile.extract(finalUrl, signal, timeoutMs, expected);
      if (out) {
        selectedProfile = out.profile ?? (profile.id && profile.version !== undefined ? { id: profile.id, version: profile.version, runtime: profile.runtime } : null);
        const profileSource: SourceMetadata = {
          artifactId: out.profile?.artifactId ?? null,
          contentHash: out.profile?.contentHash ?? null,
          profileId: selectedProfile?.id ?? null,
          profileVersion: selectedProfile?.version ?? null,
        };
        for (const f of out.fields) {
          // Preserve the resolver-provided method/sourcePath/artifact/hash/
          // variantRef verbatim — never overwrite f.method with
          // profile_selector. Only tag profile_selector when the resolver
          // explicitly reports selector provenance (an explicit method or a
          // `profile:`-prefixed source path); structured/meta fallbacks keep
          // their true method and unknown origins stay 'profile_fallback'.
          const method = f.method && f.method.trim().length > 0
            ? f.method
            : (typeof f.sourcePath === 'string' && f.sourcePath.startsWith('profile:') ? 'profile_selector' : 'profile_fallback');
          addField(f.field, f.value, method, f.sourcePath, {
            ...profileSource,
            artifactId: f.sourceArtifactId ?? profileSource.artifactId,
            contentHash: f.sourceContentHash ?? profileSource.contentHash,
            variantRef: f.variantRef,
          });
        }
        for (const image of out.images) {
          if (!images.some((i) => i.url === image.url)) {
            images.push({ url: image.url, sourcePath: image.sourcePath, sourceArtifactId: image.sourceArtifactId ?? profileSource.artifactId, sourceContentHash: image.sourceContentHash ?? profileSource.contentHash, variantRef: image.variantRef });
          }
        }
      }
    } catch {
      layersUsed.push('profile_failed');
    }
  }
  if (!profileMatched) {
    layersUsed.push('profile_miss');
  }

  // Promote recorded field evidence into the identity accumulators: layers
  // record fields with methods/source paths, but identity classification
  // consumes the canonical sku/productName/brand values. (This runs after
  // every layer, not just the profile layer.)
  sku ??= fields.find((f) => f.field === 'sku')?.value ?? null;
  productName ??= fields.find((f) => f.field === 'product_name')?.value ?? null;
  brand ??= fields.find((f) => f.field === 'brand')?.value ?? null;
  size ??= fields.find((f) => f.field === 'size')?.value ?? null;

  // Early exit (P0-5 round 3): settle only on AFFIRMATIVE proof — a platform
  // payload reporting exactly one variant, a rendered-browser snapshot's own
  // single-variant data, or positive selected-variant linkage. Structured
  // JSON-LD single-offer claims are CORROBORATION ONLY and never settle the
  // identity here; the ladder falls through so an available browser layer
  // gets the chance to reveal client-state variants before exact_match. An
  // affirmative contradiction (parent_page/variant_mismatch) invalidates the
  // proof via effectiveSingleVariantProof().
  if (exactGtinMatch(expected.gtin, gtins) && fields.length >= 3 && (effectiveSingleVariantProof() || selectedVariantLinkage())) {
    return {
      result: assembleResult(false),
      layersUsed: [...new Set(layersUsed)],
      profile: selectedProfile,
    };
  }

  // ---------------------------------------------------------------------
  // Layers 5-8: escalate only when deterministic layers did not settle the
  // identity. Settling requires exact GTIN + healthy field count + AFFIRMATIVE
  // single-variant proof (platform/browser) or selected-variant linkage.
  // ---------------------------------------------------------------------
  let llmContributed = false;
  let browserSignals: string[] = [];
  const settled = (): boolean =>
    exactGtinMatch(expected.gtin, gtins) && fields.length >= 3 && (effectiveSingleVariantProof() || selectedVariantLinkage());

  // Layer 5: rendered browser with network capture (XHR/fetch/GraphQL).
  if (!settled() && options.browser) {
    layersUsed.push('browser');
    try {
      const snapshot = await options.browser.snapshot({ url: finalUrl, captureNetwork: true, signal });
      fetchModes.push('browser');
      const browserOut = { fields, images, gtins, sku, brand, productName, size, variant, variantSignals, variantSetEvidence: { single: false, multiple: false }, variantSetContributions: [] };
      const browserEvidence = evidenceFromBrowserSnapshot(snapshot, browserOut, { gtin: expected.gtin });
      // Round-4 P1-2 + round-5 P0-3 + round-6 P0-3: browser single-variant
      // proof requires AFFIRMATIVE browser-derived variant-set evidence (a
      // payload declaring exactly one variant, or a DOM selector with a single
      // option) that is ENTITY-SCOPED — only payloads LINKED to the expected
      // GTIN AND established as the page's PRIMARY/CURRENT product entity
      // (mainEntity/canonical-URL/first-Product markers) may prove; an
      // unrelated recommendation payload that happens to carry the requested
      // GTIN proves nothing about the page's product (GTIN equality is
      // identity evidence, not page-context evidence). Rendered JSON-LD is
      // only corroboration (structured) — the same leaf claim re-observed
      // after rendering never upgrades to browser proof.
      if (browserEvidence.variantSetEvidence === 'single') {
        noteProof('browser');
      } else if (snapshot.jsonLd.some(jsonLdLeafProductProof)) {
        noteProof('structured');
      }
      if (browserEvidence.methodsUsed.length > 0) {
        layersUsed.push('browser_parsed');
        layersUsed.push('browser_success');
      }
      if (snapshot.warnings.length > 0) layersUsed.push('browser_warnings');
      browserSignals = snapshot.pageStructureSignals ?? [];
      finalUrl = snapshot.finalUrl || finalUrl;
      // The out object copies scalar bindings by value; re-sync everything
      // (variant included) so browser-layer evidence reaches the result.
      sku ??= fields.find((f) => f.field === 'sku')?.value ?? null;
      productName ??= fields.find((f) => f.field === 'product_name')?.value ?? null;
      brand ??= fields.find((f) => f.field === 'brand')?.value ?? null;
      size ??= fields.find((f) => f.field === 'size')?.value ?? null;
      if (browserOut.variant) variant = browserOut.variant;

      // Phase 3: Trigger background domain profile proposal on profile_miss + browser_success
      if (layersUsed.includes('profile_miss') && layersUsed.includes('browser_success')) {
        try {
          const pageDomain = new URL(finalUrl).hostname.replace(/^www\./, '').trim();
          if (pageDomain) {
            const lazyReq = createRequire(import.meta.url);
            const gov = lazyReq('../../onboarding/profile-governance-service') as {
              requestDomainProfileProposal?: (d: string, opts: { sourceUrl: string; expectedName?: string; brandHint?: string | null }) => unknown;
            };
            gov.requestDomainProfileProposal?.(pageDomain, {
              sourceUrl: finalUrl,
              expectedName: expected.name,
              brandHint: expected.brandHint,
            });
          }
        } catch {
          // background proposal trigger is strictly non-blocking
        }
      }
    } catch {
      layersUsed.push('browser_failed');
    }
  }

  // Layer 6: exact bounded interaction (variant selectors / collapsed
  // content) — only when the caller supplied precise constraints. Returns
  // the resulting variant state; never decides taxonomy, rights, or identity.
  if (!settled() && options.browser && options.interaction) {
    layersUsed.push('interaction');
    try {
      const interactionOut = { fields, images, gtins, sku, brand, productName, size, variant, variantSignals, variantSetEvidence: { single: false, multiple: false }, variantSetContributions: [] };
      const result = await runBrowserInteraction(
        options.browser.snapshot,
        finalUrl,
        options.interaction,
        interactionOut,
        { name: expected.name, gtin: expected.gtin },
      );
      fetchModes.push('browser');
      finalUrl = result.finalUrl || finalUrl;
      // The interaction's snapshot is the freshest evidence of the selected
      // variant — prefer it over an earlier layer's first-variant (m7).
      if (interactionOut.variant) variant = interactionOut.variant;
      if (result.methodsUsed.length > 0) layersUsed.push('interaction_parsed');
      layersUsed.push('interaction_done');
    } catch {
      layersUsed.push('interaction_failed');
    }
  }

  // Layer 7: benchmark-selected managed browser / unlocking fallback.
  if (!settled() && options.managedFallback) {
    layersUsed.push('managed_browser');
    try {
      const managed: ManagedPage = await options.managedFallback.fetch(finalUrl, signal, timeoutMs);
      fetchModes.push('managed_browser');
      const managedSignals = parseStructuredSignals(managed.html);
      // Managed-fallback HTML is corroboration only — the managed provider is
      // a rendered browser, but its HTML may be JS-stripped, so it never
      // settles identity on its own (P0-5 round 3).
      if (structuredSingleVariantProof(managed.html)) noteProof('structured');
      const managedOut = { fields, images, gtins, sku, brand, productName, size, variant, variantSignals };
      for (const product of managedSignals.jsonLdProducts) {
        evidenceFromProductPayload(
          {
            title: product.name ?? undefined,
            sku: product.sku ?? undefined,
            brand: product.brand ?? undefined,
            size: product.size ?? undefined,
            gtin: product.gtin ?? undefined,
            images: product.images,
          } as Record<string, unknown>,
          'managed_browser',
          'managed fallback JSON-LD',
          managedOut,
        );
      }
      if (managedSignals.jsonLdProducts.length > 0) layersUsed.push('managed_parsed');
      finalUrl = managed.finalUrl || finalUrl;
      if (managedOut.variant) variant = managedOut.variant;
    } catch {
      layersUsed.push('managed_failed');
    }
  }

  // Layer 8: narrow schema-constrained LLM extraction — unresolved fields
  // ONLY, bounded excerpts, never contradicting deterministic values. Any
  // contribution makes the whole result non-deterministic, so it only runs
  // when the deterministic layers did NOT settle the identity (review M3)
  // and only when there is prose to resolve from (M4: no excerpt source ->
  // no hallucinated fill-ins).
  if (options.llm) {
    if (!isLlmAvailable()) {
      layersUsed.push('llm_unavailable');
    } else if (!settled()) {
      const canonical = ['sku', 'brand', 'product_name', 'size'];
      const resolved = new Set(fields.map((f) => f.field));
      const unresolved = canonical.filter((field) => !resolved.has(field));
      if (unresolved.length > 0) {
        // Excerpt sources: static meta first, then rendered page-structure
        // signals (JS-rendered pages have empty static meta).
        const excerptCandidates = [
          ...(signals.metaDescription ? [{ text: signals.metaDescription, path: 'meta description' }] : []),
          ...(signals.metaTitle ? [{ text: signals.metaTitle, path: 'meta title' }] : []),
          ...browserSignals.slice(0, 4).map((text, index) => ({ text, path: `browser page structure signal ${index}` })),
        ];
        const excerpts = unresolved.map((field) => {
          const first = excerptCandidates[0];
          return { field, text: (first?.text ?? '').slice(0, 300), sourcePath: first?.path ?? 'no excerpt source' };
        });
        if (excerptCandidates.length === 0 || excerpts.every((e) => e.text.length === 0)) {
          layersUsed.push('llm_skipped_no_excerpts');
        } else {
          layersUsed.push('llm_extraction');
          fetchModes.push('llm_extraction');
          try {
            const response = await options.llm.adapter.extract({
              unresolvedFields: unresolved,
              excerpts,
              deterministicValues: Object.fromEntries(
                fields.filter((f) => f.value !== null).map((f) => [f.field, f.value as string]),
              ),
            });
            for (const value of response.values) {
              if (unresolved.includes(value.field)) {
                addField(value.field, value.value, 'llm_extraction', value.sourcePath ?? 'llm extraction');
                llmContributed = true;
              }
            }
            if (llmContributed) {
              layersUsed.push('llm_contributed');
              sku ??= fields.find((f) => f.field === 'sku')?.value ?? null;
              productName ??= fields.find((f) => f.field === 'product_name')?.value ?? null;
              brand ??= fields.find((f) => f.field === 'brand')?.value ?? null;
              size ??= fields.find((f) => f.field === 'size')?.value ?? null;
            }
          } catch {
            layersUsed.push('llm_failed');
          }
        }
      } else {
        layersUsed.push('llm_unneeded');
      }
    }
  }

  return {
    result: assembleResult(llmContributed),
    layersUsed: [...new Set(layersUsed)],
    profile: selectedProfile,
  };

  function assembleResult(llmContributed = false): PageExtractionResult {
    const hasAnyField = fields.length > 0;
    const identity = classifyPageIdentity({
      requestedGtin: expected.gtin ?? '',
      extractedGtins: gtins.map((g) => g.value),
      sku,
      productName,
      expectedName: expected.name,
      variantSignals,
      hasAnyField,
      singleVariantProof: effectiveSingleVariantProof(),
      selectedVariantLinkage: selectedVariantLinkage(),
    });
    return {
      requestedUrl: url,
      finalUrl,
      fetchModes: [...new Set(fetchModes)],
      contentHash,
      // The page artifact is the source only for fields explicitly attached
      // to page bytes. Platform/profile observations carry their own metadata.
      artifactRef: pageArtifactId,
      fields,
      gtins,
      sku,
      brand,
      productName,
      variant,
      size,
      packCount,
      images: images.slice(0, 16),
      conflicts,
      identityStatus: identity.status,
      identityReasons: identity.reasons,
      // Layer 8 (LLM extraction) makes the whole result non-deterministic.
      deterministicOnly: !llmContributed,
    };
  }
}

/** PageExtractionContract adapter over the ladder (drop-in for the tool). */
export function createLadderExtractionContract(options: LadderOptions = {}): PageExtractionContract {
  return {
    name: 'extraction_ladder',
    version: '1.0.0',
    async extract(request: {
      url: string;
      expected?: { gtin?: string; name?: string; brandHint?: string | null };
      signal: AbortSignal;
      timeoutMs: number;
      profile?: { selectors: Record<string, string | null>; runtime: 'static' | 'rendered' };
    }): Promise<PageExtractionResult> {
      const { result } = await runExtractionLadder(request.url, request.expected ?? {}, request.signal, request.timeoutMs, options);
      return result;
    },
    async extractWithProfile(request: {
      url: string;
      expected?: { gtin?: string; name?: string; brandHint?: string | null };
      signal: AbortSignal;
      timeoutMs: number;
      profile: { selectors: Record<string, string | null>; runtime: 'static' | 'rendered' };
    }): Promise<PageExtractionResult> {
      // This is the deterministic profile-runner seam: unlike `extract`, it
      // never invokes the ladder's fallback layers and only reports values
      // selected by the supplied profile. A profile fetch is a privileged
      // network operation: callers must provide both an authorized gate and
      // an explicitly injected transport. Never fall back to global fetch.
      if (request.profile.runtime !== 'rendered' && (!options.networkGate || !options.fetchPage)) {
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          fetchModes: ['profile_unsupported'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'profile extraction requires an authorized network gate and transport' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['profile extraction transport is not policy-authorized'],
          deterministicOnly: true,
        };
      }
      if (request.profile.runtime === 'rendered') {
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          fetchModes: ['profile_unsupported'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'rendered profile requires the browser profile runner; unsupported by this ladder seam' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['rendered profile runtime is unsupported by this static ladder seam'],
          deterministicOnly: true,
        };
      }
      const profileFetchPage = options.fetchPage;
      const authorizeProfileNetwork = async (destination: string): Promise<void> => {
        const decision = await options.networkGate!(destination, request.signal);
        if (!decision.allowed) throw new Error(`network denied${decision.code ? `: ${decision.code}` : ''}${decision.detail ? ` (${decision.detail})` : ''}`);
      };
      await authorizeProfileNetwork(request.url);
      const page = await profileFetchPage!(request.url, request.signal, request.timeoutMs);
      // A gateway-bound transport validates redirects itself. For arbitrary
      // injected transports, still authorize the observed final hop before
      // accepting or exposing any selector value.
      if (page.finalUrl !== request.url) await authorizeProfileNetwork(page.finalUrl);
      if (!page.contentHash || !/^[0-9a-f]{64}$/u.test(page.contentHash) || !page.artifactId && !page.contentHash) {
        return {
          requestedUrl: request.url,
          finalUrl: page.finalUrl,
          fetchModes: ['profile_failed'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'profile source bytes were not retained with a valid content hash' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['profile source provenance unavailable'],
          deterministicOnly: true,
        };
      }
      const source = { sourceArtifactId: page.artifactId ?? null, sourceContentHash: page.contentHash };
      const $ = cheerio.load(page.html);
      const selector = (key: string): string | null => request.profile.selectors[key] ?? null;
      const text = (key: string): string | null => {
        const sel = selector(key);
        if (!sel) return null;
        try { return $(sel).first().text().trim() || null; } catch { return null; }
      };
      const productName = text('titleSelector');
      const fields: ExtractedFieldEvidence[] = productName
        ? [{ field: 'product_name', value: productName, method: 'profile_selector', sourcePath: selector('titleSelector') ?? undefined, ...source }]
        : [];
      const description = text('descriptionSelector');
      if (description) fields.push({ field: 'description', value: description, method: 'profile_selector', sourcePath: selector('descriptionSelector') ?? undefined, ...source });
      const brand = text('brandSelector');
      if (brand) fields.push({ field: 'brand', value: brand, method: 'profile_selector', sourcePath: selector('brandSelector') ?? undefined, ...source });
      const images: ExtractedImageCandidate[] = [];
      const imageSelector = selector('imagesSelector');
      if (imageSelector) {
        try {
          $(imageSelector).find('img').each((_index, element) => {
            const src = $(element).attr('src') ?? $(element).attr('data-src');
            if (src) images.push({ url: new URL(src, page.finalUrl).toString(), sourcePath: imageSelector, ...source });
          });
        } catch { /* invalid selectors are an incompatible profile */ }
      }
      const expectedName = request.expected?.name?.trim().toLowerCase();
      const identityStatus = productName && expectedName && productName.toLowerCase().includes(expectedName)
        ? 'exact_match' as const
        : productName ? 'probable_match' as const : 'insufficient_evidence' as const;
      return {
        requestedUrl: request.url,
        finalUrl: page.finalUrl,
        fetchModes: ['profile_selector'],
        contentHash: page.contentHash,
        artifactRef: page.artifactId ?? null,
        fields,
        gtins: [],
        sku: null,
        brand,
        productName,
        variant: null,
        size: null,
        packCount: null,
        images,
        conflicts: [],
        identityStatus,
        identityReasons: productName ? [] : ['active profile title selector produced no value'],
        deterministicOnly: true,
      };
    },
  };
}

/** Re-exported for consumers that classify product-like payloads directly. */
