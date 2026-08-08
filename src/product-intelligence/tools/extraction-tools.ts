/**
 * Extraction research tools (PI-3).
 *
 * extract_product_page delegates through a provider-neutral
 * `PageExtractionContract` (PI-11 replaces the default HTTP adapter with the
 * deterministic extraction ladder later; the contract is the seam). Raw HTML
 * and unrestricted network payloads never reach Pi — only normalized fields
 * with method, source path, and identity status.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type } from 'typebox';
import { extractViaHttpDetailed } from '../../onboarding/page-extractor';
import { defaultPolicyGateway, PolicyDeniedError } from '../policy';
import { extractPackagingOcr } from '../../onboarding/packaging-ocr';
import { getVlmConfig } from '../../onboarding/vlm-client';
import { sha256Hex } from '../../shared/stable-id';
import { sharpImageVerificationAdapter } from '../assets/contract';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import {
  classifyPageIdentity,
  errorResult,
  evidenceId,
  fieldEvidenceId,
  noResult,
  okResult,
  policyDenied,
  structuredSingleVariantProof,
  variantProofFromSignals,
  variantTokenOverlap,
  type ExtractedFieldEvidence,
  type FieldEvidenceEntry,
  type PageExtractionContract,
  type PageExtractionResult,
} from './contract';
import { createLadderExtractionContract } from '../extraction/ladder';
import { defaultLadderOptions } from '../extraction/wiring';
import { HTTP_EXTRACTION_HEADERS, type FetchedPage, type ShopifyProductJson } from '../extraction/platforms';
import type { LadderOptions } from '../extraction/ladder';
import type { PolicyGateway } from '../policy/policy-gateway';
import { boundedString } from './registry';

// ---------------------------------------------------------------------------
// Default HTTP extraction adapter (deterministic; PI-11 replaces later)
// ---------------------------------------------------------------------------

function normalizeFieldValue(raw: string | string[] | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 2000) : null;
}

export class HttpPageExtractionAdapter implements PageExtractionContract {
  readonly name = 'http_detailed';
  readonly version = '1.0.0';

  async extract(request: {
    url: string;
    expected?: { gtin?: string; name?: string; brandHint?: string | null };
    signal: AbortSignal;
    timeoutMs: number;
    fetchFn?: typeof fetch;
  }): Promise<PageExtractionResult> {
    const expected = request.expected ?? {};
    const raw = await extractViaHttpDetailed(
      request.url,
      null,
      {
        name: expected.name,
        brandHint: expected.brandHint ?? null,
      },
      // P0-1 (round 2): bind the legacy transport to the injected
      // (gateway-bound) fetch when the caller provides one.
      (request as { fetchFn?: typeof fetch }).fetchFn,
    );

    // Final URL: extraction follows redirects internally; when it does not
    // report one, the requested URL stands.
    const finalUrl = (raw as { finalUrl?: string }).finalUrl ?? request.url;
    const fields: ExtractedFieldEvidence[] = [];

    const jsonLd = (raw as { jsonLd?: Record<string, unknown> }).jsonLd ?? null;
    const meta = (raw as { metaTags?: Record<string, string | null> }).metaTags ?? null;
    const microdata = (raw as { microdata?: Array<Record<string, unknown>> }).microdata ?? null;
    const heuristics = (raw as { htmlHeuristics?: Record<string, string | string[] | null> }).htmlHeuristics ?? null;
    const pushField = (field: string, value: string | null, method: string, sourcePath?: string): void => {
      if (value === null) return;
      fields.push({ field, value, method, sourcePath });
    };

    // GTINs from all deterministic layers.
    const gtins: Array<{ value: string; method: string }> = [];
    const collectGtin = (value: unknown, method: string): void => {
      if (typeof value !== 'string') return;
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14 && !gtins.some((g) => g.value === digits)) {
        gtins.push({ value: digits, method });
      }
    };
    for (const [key, value] of Object.entries(jsonLd ?? {})) {
      if (typeof value === 'string' && /gtin|upc|sku/i.test(key)) collectGtin(value, `json_ld.${key}`);
    }
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (/gtin|upc|sku/i.test(key)) collectGtin(value ?? '', `meta.${key}`);
    }
    for (const block of microdata ?? []) {
      for (const [key, value] of Object.entries(block)) {
        if (typeof value === 'string' && /gtin|upc|sku/i.test(key)) collectGtin(value, `microdata.${key}`);
      }
    }

    const title = normalizeFieldValue((heuristics?.title as string) ?? (meta?.title as string) ?? (jsonLd?.name as string));
    const brand = normalizeFieldValue((heuristics?.brand as string) ?? (meta?.brand as string) ?? (jsonLd?.brand as string));
    const description = normalizeFieldValue((heuristics?.description as string) ?? (meta?.description as string) ?? (jsonLd?.description as string));
    const sku = normalizeFieldValue((heuristics?.sku as string) ?? (meta?.sku as string));
    const size = normalizeFieldValue((heuristics?.size as string) ?? (meta?.size as string));

    pushField('title', title, 'deterministic', 'html_heuristics/meta/json_ld');
    pushField('brand', brand, 'deterministic', 'html_heuristics/meta/json_ld');
    pushField('description', description, 'deterministic', 'html_heuristics/meta/json_ld');
    pushField('sku', sku, 'deterministic', 'html_heuristics/meta');
    pushField('size', size, 'deterministic', 'html_heuristics/meta');

    const images = ((raw as { images?: string[] }).images ?? []).slice(0, 12).map((url) => ({ url }));

    const rawHtml = (raw as { html?: string }).html ?? '';
    const contentHash = rawHtml ? sha256Hex(rawHtml) : null;

    const variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }> = [];
    const variantText = normalizeFieldValue((heuristics?.variant as string) ?? null);
    if (variantText) {
      // P0-5 round 2: a declared variant only yields variant_match when it is
      // tied to the EXPECTED variant (token overlap with the expected name);
      // a bare variant declaration or a successful interaction is never a
      // match by itself.
      if (expected.gtin && !gtins.some((g) => g.value === expected.gtin)) {
        variantSignals.push({ kind: 'variant_mismatch' });
      } else if (expected.name && variantTokenOverlap(expected.name, variantText) >= 0.5) {
        variantSignals.push({ kind: 'variant_match' });
      } else if (expected.name) {
        variantSignals.push({ kind: 'variant_mismatch' });
      }
      // No expected name -> no comparison possible -> no signal.
    }

    const proof = variantProofFromSignals(variantSignals);
    const identity = classifyPageIdentity({
      requestedGtin: expected.gtin ?? '',
      extractedGtins: gtins.map((g) => g.value),
      sku,
      productName: title,
      expectedName: expected.name,
      variantSignals,
      hasAnyField: fields.length > 0 || gtins.length > 0,
      singleVariantProof: proof.singleVariantProof || structuredSingleVariantProof(rawHtml),
      selectedVariantLinkage: proof.selectedVariantLinkage,
    });

    const conflicts: Array<{ field: string; summary: string }> = [];
    if (gtins.length > 1 && new Set(gtins.map((g) => g.value)).size > 1) {
      conflicts.push({ field: 'gtin', summary: `multiple GTINs on page: ${gtins.map((g) => g.value).join(', ')}` });
    }

    return {
      requestedUrl: request.url,
      finalUrl,
      fetchModes: ['http_detailed'],
      contentHash,
      artifactRef: null,
      fields,
      gtins,
      sku,
      brand,
      productName: title,
      variant: variantText ? { name: variantText } : null,
      size,
      packCount: null,
      images,
      conflicts,
      identityStatus: identity.status,
      identityReasons: identity.reasons,
      deterministicOnly: true,
    };
  }
}

export const defaultPageExtractionContract: PageExtractionContract = createLadderExtractionContract(defaultLadderOptions());

/**
 * P0-1: ladder options whose HTTP layer rides the policy gateway. The ladder
 * already accepts `fetchPage`/`fetchShopify` seams (no ladder change needed);
 * here they are bound to gatewayFetch so destination policy, per-hop redirect
 * revalidation, size/type limits, and audit attribution apply to every
 * PI-initiated page fetch.
 */
function gatewayBoundLadderOptions(ctx: PiToolContext): LadderOptions {
  const gateway: PolicyGateway = ctx.gateway ?? defaultPolicyGateway;
  const netCtx = { runId: ctx.runId, policy: ctx.policy };
  // Round-3 finding 3: the run's allowed-source-domains are captured in the
  // per-run snapshot closure (no module-global policy state), so concurrent
  // runs never execute under each other's browser allowlist.
  const sourcesAllowlist =
    ctx.policy.allowedSourceDomains && ctx.policy.allowedSourceDomains.length > 0
      ? ctx.policy.allowedSourceDomains
      : undefined;
  const options = defaultLadderOptions(sourcesAllowlist);
  options.fetchPage = async (url: string, signal: AbortSignal, timeoutMs: number): Promise<FetchedPage> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await gateway.gatewayFetch(
      netCtx,
      url,
      { headers: HTTP_EXTRACTION_HEADERS, signal: combined },
      {
        dataClassification: 'fetched_content',
        maxResponseBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['text/html', 'application/xhtml+xml', 'application/json'],
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error(`Response too large (${html.length} chars) for ${url}`);
    return { html, finalUrl: response.url || url, status: response.status, contentHash: sha256Hex(html) };
  };
  options.fetchShopify = async (url: string, signal: AbortSignal, timeoutMs: number): Promise<ShopifyProductJson> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await gateway.gatewayFetch(
      netCtx,
      url,
      { headers: HTTP_EXTRACTION_HEADERS, signal: combined },
      { dataClassification: 'fetched_content', maxResponseBytes: 2 * 1024 * 1024, allowedContentTypes: ['application/json'] },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return (await response.json()) as ShopifyProductJson;
  };
  return options;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildExtractProductPage(contract: PageExtractionContract): PiToolAdapter {
  return {
    name: 'extract_product_page',
    version: contract.version,
    description:
      'Extract a product page through the deterministic extraction engine. Returns normalized fields with extraction method and source path, GTINs found, image candidates, conflicts, and the identity status ' +
      '(exact_match, probable_match, parent_product_only, wrong_variant, conflicting_identity, insufficient_evidence). Raw HTML is never returned.',
    parameters: Type.Object({
      url: boundedString(512, 'Product page URL'),
      gtin: Type.Optional(boundedString(64, 'Expected GTIN')),
      expectedName: Type.Optional(boundedString(256, 'Expected product name')),
      brandHint: Type.Optional(boundedString(128, 'Brand hint')),
    }),
    promptGuidelines: [
      'extract_product_page is the ONLY page-reading tool; never attempt to read HTML yourself.',
      'The identityStatus field is authoritative for whether this page is the exact product.',
    ],
    async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
      const url = String(params.url ?? '');
      const netCheck = await (ctx.gateway ?? defaultPolicyGateway).checkNetworkRequest({ runId: ctx.runId, policy: ctx.policy }, url);
      if (!netCheck.allowed) return policyDenied(`network denied: ${netCheck.reasonCode}${netCheck.detail ? ` (${netCheck.detail})` : ''}`);
      try {
        // P0-1: when running the default ladder, bind its HTTP layer to the
        // policy gateway (per-run context) so the fetch itself is enforced,
        // not only pre-checked.
        const runContract = contract === defaultPageExtractionContract ? createLadderExtractionContract(gatewayBoundLadderOptions(ctx)) : contract;
        const result = await runContract.extract({
          url,
          expected: {
            gtin: params.gtin ? String(params.gtin) : undefined,
            name: params.expectedName ? String(params.expectedName) : undefined,
            brandHint: params.brandHint ? String(params.brandHint) : null,
          },
          signal: ctx.signal,
          timeoutMs: ctx.remainingMs,
        });
        if (result.fields.length === 0 && result.gtins.length === 0 && result.images.length === 0) {
          return noResult(`No extractable product data at ${url.slice(0, 80)}`);
        }
        const domainOf = (pageUrl: string): string | undefined => {
          try { return new URL(pageUrl).hostname; } catch { return undefined; }
        };
        const pageDomain = domainOf(result.finalUrl);
        // P1-4: one FieldEvidenceEntry per extracted field (field-specific
        // durable id) so persistence stores value + method + source path per
        // row. The page-level aggregate entry is kept for consumers that cite
        // the coarse id (bundle identity evidenceIds).
        const fieldEvidence: FieldEvidenceEntry[] = result.fields.map((f) => ({
          id: fieldEvidenceId('extract_product_page', result.finalUrl, f.field, f.sourcePath ?? f.value ?? ''),
          field: f.field,
          value: f.value,
          method: f.method,
          path: f.sourcePath,
          snippet: f.value ? String(f.value).slice(0, 200) : undefined,
          url: result.finalUrl,
          domain: pageDomain,
          contentHash: result.contentHash ?? undefined,
        }));
        for (const g of result.gtins) {
          fieldEvidence.push({
            id: fieldEvidenceId('extract_product_page', result.finalUrl, 'gtin', `${g.method}:${g.value}`),
            field: 'gtin',
            value: g.value,
            method: g.method,
            path: g.method,
            snippet: g.value.slice(0, 40),
            url: result.finalUrl,
            domain: pageDomain,
            contentHash: result.contentHash ?? undefined,
          });
        }
        return okResult(
          {
            requestedUrl: result.requestedUrl,
            finalUrl: result.finalUrl,
            fetchModes: result.fetchModes,
            contentHash: result.contentHash,
            artifactRef: result.artifactRef,
            identityStatus: result.identityStatus,
            identityReasons: result.identityReasons,
            fields: result.fields,
            gtins: result.gtins,
            sku: result.sku,
            brand: result.brand,
            productName: result.productName,
            variant: result.variant,
            size: result.size,
            packCount: result.packCount,
            images: result.images.slice(0, 8),
            conflicts: result.conflicts,
            deterministicOnly: result.deterministicOnly,
          },
          [
            {
              id: evidenceId('extract_product_page', url),
              kind: result.identityStatus === 'exact_match' ? 'gtin_evidence' : 'search_lead',
              url: result.finalUrl,
              domain: pageDomain,
              method: contract.name,
              contentHash: result.contentHash ?? undefined,
            },
            ...fieldEvidence,
          ],
        );
      } catch (error) {
        return errorResult('extraction_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
      }
    },
  };
}

const extractStructuredPageData: PiToolAdapter = {
  name: 'extract_structured_page_data',
  version: '1.0.0',
  description:
    'Extract structured data layers from a page (JSON-LD, meta tags, microdata, HTML heuristics) as normalized fields. Returns only deterministic extractions with their source layer — no raw HTML.',
  parameters: Type.Object({
    url: boundedString(512, 'Product page URL'),
    expectedName: Type.Optional(boundedString(256, 'Expected product name')),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    const gateway = ctx.gateway ?? defaultPolicyGateway;
    const netCtx = { runId: ctx.runId, policy: ctx.policy };
    const policyDecision = await gateway.checkNetworkRequest(ctx, url, 'fetched_content');
    if (!policyDecision.allowed) {
      return policyDenied(policyDecision.detail ?? policyDecision.reasonCode);
    }
    try {
      // P0-1 (round 2): the legacy transport owns the real fetch — inject the
      // gateway-bound fetch so the actual HTTP is enforced (SSRF, redirects,
      // size/type limits, audit), not only pre-checked.
      const raw = await extractViaHttpDetailed(
        url,
        null,
        { name: params.expectedName ? String(params.expectedName) : undefined },
        gateway.buildPiNetworkFetch(netCtx, { dataClassification: 'fetched_content' }),
      );
      const projection = {
        finalUrl: (raw as { finalUrl?: string }).finalUrl ?? url,
        jsonLd: (raw as { jsonLd?: unknown }).jsonLd ?? null,
        metaTags: (raw as { metaTags?: unknown }).metaTags ?? null,
        microdata: (raw as { microdata?: unknown }).microdata ?? null,
        htmlHeuristics: (raw as { htmlHeuristics?: unknown }).htmlHeuristics ?? null,
        images: ((raw as { images?: string[] }).images ?? []).slice(0, 8),
      };
      const hasAny =
        projection.jsonLd || projection.metaTags || projection.microdata || projection.htmlHeuristics || (projection.images?.length ?? 0) > 0;
      if (!hasAny) return noResult(`No structured data at ${url.slice(0, 80)}`);
      return okResult(projection, [
        {
          id: evidenceId('extract_structured_page_data', url),
          kind: 'search_lead',
          url: projection.finalUrl,
          method: 'structured_layers',
        },
      ]);
    } catch (error) {
      return errorResult('extraction_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

const extractPackagingEvidence: PiToolAdapter = {
  name: 'extract_packaging_evidence',
  version: '1.0.0',
  description:
    'Run local VLM OCR on a product packaging image to extract name, brand, size, and UPC evidence from the label. Returns structured OCR data or no_result when VLM OCR is not configured.',
  parameters: Type.Object({
    imageUrl: boundedString(512, 'Packaging image URL'),
    gtin: Type.Optional(boundedString(64, 'SKU/UPC for logging')),
    imageSourceUrl: Type.Optional(boundedString(512, 'Original page URL for provenance')),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const imageUrl = String(params.imageUrl ?? '');
    const gateway = ctx.gateway ?? defaultPolicyGateway;
    const netCtx = { runId: ctx.runId, policy: ctx.policy };
    // P0-1: the OCR path hands this URL to the legacy image loader (raw
    // fetch). Validate the destination through the policy gateway first —
    // private/link-local, allowlist, and data-sharing restrictions deny the
    // call before any bytes are fetched.
    const netCheck = await gateway.checkNetworkRequest(netCtx, imageUrl);
    if (!netCheck.allowed) return policyDenied(`image fetch denied: ${netCheck.reasonCode}${netCheck.detail ? ` (${netCheck.detail})` : ''}`);

    // Round-4 (P0): the VLM call is MODEL-POLICY-owned, not just
    // gateway-owned. Resolve the configured VLM endpoint and gate it via
    // checkModelEndpoint — a local loopback model is allowed under any
    // data-sharing policy (nothing leaves the machine); a REMOTE VLM carries
    // the prompt + image to a third party and is denied under local_only or
    // when it is not the policy modelRoute.
    let vlmConfig: { baseUrl: string; model: string } | null = null;
    try {
      vlmConfig = getVlmConfig();
    } catch {
      // unconfigured/unavailable — treated as no VLM
    }
    if (!vlmConfig) {
      return noResult('Packaging OCR produced no result (VLM may be unconfigured or the image could not be loaded)');
    }
    const modelDecision = await gateway.checkModelEndpoint(netCtx, {
      provider: 'ollama_vlm',
      model: vlmConfig.model,
      endpointUrl: vlmConfig.baseUrl,
    });
    if (!modelDecision.allowed) {
      return policyDenied(`VLM model call denied: ${modelDecision.reasonCode}${modelDecision.detail ? ` (${modelDecision.detail})` : ''}`);
    }
    try {
      // P0-1 (round 2): the OCR image loader performs the real fetch — inject
      // the gateway-bound fetch so the actual download is enforced end-to-end
      // (the pre-check above denies obvious violations before any bytes move).
      // Round-4: the VLM model call rides a SEPARATE model-gated transport
      // (buildModelFetch) so the two authorities never share a transport.
      const ocr = await extractPackagingOcr({
        imageUrl,
        sku: params.gtin ? String(params.gtin) : null,
        imageSourceUrl: params.imageSourceUrl ? String(params.imageSourceUrl) : null,
        fetchFn: gateway.buildPiNetworkFetch(netCtx, { dataClassification: 'fetched_content' }),
        modelFetchFn: gateway.buildModelFetch(netCtx, {
          provider: 'ollama_vlm',
          model: vlmConfig.model,
          endpointUrl: vlmConfig.baseUrl,
        }),
      });
      if (!ocr) {
        return noResult('Packaging OCR produced no result (VLM may be unconfigured or the image could not be loaded)');
      }
      // Round-4 (P1): one durable FIELD-LEVEL evidence entry per observed OCR
      // fact, each bound to the SHA-256 of the exact downloaded image bytes
      // (contentHash). verify_image_candidate later drops facts whose hash
      // does not match the bytes it is inspecting.
      const facts: Array<[string, string]> = (
        [
          ['productName', ocr.productName],
          ['brand', ocr.brand],
          ['size', ocr.size],
          ['weight', ocr.weight],
          ['flavorVariety', ocr.flavorVariety],
        ] as Array<[string, unknown]>
      ).filter(
        (entry): entry is [string, string] =>
          entry[1] !== null && entry[1] !== undefined && String(entry[1]).trim() !== '',
      );
      let domain: string | null = null;
      try {
        domain = new URL(imageUrl).hostname;
      } catch {
        domain = null;
      }
      const evidence = facts.map(([field, value]) => ({
        id: fieldEvidenceId('extract_packaging_evidence', imageUrl, field, String(value)),
        field,
        value,
        method: 'image_ocr' as const,
        url: imageUrl,
        ...(domain ? { domain } : {}),
        contentHash: ocr.contentHash ?? undefined,
        snippet: String(value).slice(0, 300),
      }));
      return okResult(
        {
          productName: ocr.productName ?? null,
          brand: ocr.brand ?? null,
          size: ocr.size ?? null,
          weight: ocr.weight ?? null,
          flavorVariety: ocr.flavorVariety ?? null,
          contentHash: ocr.contentHash ?? null,
          rawFields: Object.keys(ocr).filter((k) => !['productName', 'brand', 'size', 'weight', 'flavorVariety'].includes(k)),
        },
        evidence,
      );
    } catch (error) {
      return errorResult('ocr_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

const inspectCandidateImage: PiToolAdapter = {
  name: 'inspect_candidate_image',
  version: '1.1.0',
  description:
    'Inspect a candidate product image: fetch it through the policy gateway and return safe metadata (dimensions, aspect ratio, MIME type, byte size, content hash, perceptual hash) and the quality verdict. Identity and rights status are NOT determined by this tool — use verify_image_candidate. Never returns image binaries to the agent.',
  parameters: Type.Object({ url: boundedString(512, 'Image URL') }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    try {
      const response = await (ctx.gateway ?? defaultPolicyGateway).gatewayFetch(
        { runId: ctx.runId, policy: ctx.policy },
        url,
        { signal: ctx.signal, headers: { Accept: 'image/*' } },
        {
          allowedContentTypes: ['image/'],
          maxResponseBytes: Math.min(ctx.policy.maxResponseBytes, 10 * 1024 * 1024),
        },
      );
      if (!response.ok) return noResult(`Image fetch failed: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type');
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length > 10 * 1024 * 1024) return noResult('Image exceeds 10 MB inspection limit');
      const inspected = await sharpImageVerificationAdapter.verify({ buffer, contentType });
      if (!inspected.verified) {
        return noResult(inspected.rejectionReason ?? 'corrupt or non-image content', [
          { id: evidenceId('inspect_candidate_image', url), kind: 'image_evidence', url, method: 'image_metadata_inspection' },
        ]);
      }
      return okResult(
        {
          url,
          contentType,
          bytes: buffer.length,
          contentHash: inspected.image.contentHash,
          perceptualHash: inspected.image.perceptualHash,
          width: inspected.image.width,
          height: inspected.image.height,
          aspectRatio: inspected.image.aspectRatio,
          qualityStatus: inspected.qualityStatus,
          note: 'identity and rights status are NOT determined by this tool; use verify_image_candidate',
        },
        [
          {
            id: evidenceId('inspect_candidate_image', url),
            kind: 'image_evidence',
            url,
            method: 'image_metadata_inspection',
            contentHash: inspected.image.contentHash,
          },
        ],
      );
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        return policyDenied(`network denied: ${error.decision.reasonCode}${error.decision.detail ? ` (${error.decision.detail})` : ''}`);
      }
      return errorResult('image_fetch_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

export function buildExtractionTools(contract: PageExtractionContract = defaultPageExtractionContract): PiToolAdapter[] {
  return [buildExtractProductPage(contract), extractStructuredPageData, extractPackagingEvidence, inspectCandidateImage];
}
