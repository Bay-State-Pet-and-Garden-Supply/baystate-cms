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
import { defaultPolicyGateway } from '../policy';
import { extractPackagingOcr } from '../../onboarding/packaging-ocr';
import { sha256Hex } from '../../shared/stable-id';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import {
  classifyPageIdentity,
  errorResult,
  evidenceId,
  noResult,
  okResult,
  policyDenied,
  type ExtractedFieldEvidence,
  type PageExtractionContract,
  type PageExtractionResult,
} from './contract';
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
  }): Promise<PageExtractionResult> {
    const expected = request.expected ?? {};
    const raw = await extractViaHttpDetailed(request.url, null, {
      name: expected.name,
      brandHint: expected.brandHint ?? null,
    });

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
    if (variantText && expected.gtin && !gtins.some((g) => g.value === expected.gtin)) {
      variantSignals.push({ kind: 'variant_mismatch' });
    } else if (variantText) {
      variantSignals.push({ kind: 'variant_match' });
    }

    const identity = classifyPageIdentity({
      requestedGtin: expected.gtin ?? '',
      extractedGtins: gtins.map((g) => g.value),
      sku,
      productName: title,
      expectedName: expected.name,
      variantSignals,
      hasAnyField: fields.length > 0 || gtins.length > 0,
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

export const defaultPageExtractionContract: PageExtractionContract = new HttpPageExtractionAdapter();

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
        const result = await contract.extract({
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
              domain: (() => { try { return new URL(result.finalUrl).hostname; } catch { return undefined; } })(),
              method: contract.name,
              contentHash: result.contentHash ?? undefined,
            },
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
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const url = String(params.url ?? '');
    try {
      const raw = await extractViaHttpDetailed(url, null, { name: params.expectedName ? String(params.expectedName) : undefined });
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
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const imageUrl = String(params.imageUrl ?? '');
    try {
      const ocr = await extractPackagingOcr({
        imageUrl,
        sku: params.gtin ? String(params.gtin) : null,
        imageSourceUrl: params.imageSourceUrl ? String(params.imageSourceUrl) : null,
      });
      if (!ocr) {
        return noResult('Packaging OCR produced no result (VLM may be unconfigured or the image could not be loaded)');
      }
      return okResult(
        {
          productName: ocr.productName ?? null,
          brand: ocr.brand ?? null,
          size: ocr.size ?? null,
          weight: ocr.weight ?? null,
          flavorVariety: ocr.flavorVariety ?? null,
          rawFields: Object.keys(ocr).filter((k) => !['productName', 'brand', 'size', 'weight', 'flavorVariety'].includes(k)),
        },
        [{ id: evidenceId('extract_packaging_evidence', imageUrl), kind: 'gtin_evidence', url: imageUrl, method: 'vlm_packaging_ocr' }],
      );
    } catch (error) {
      return errorResult('ocr_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

const inspectCandidateImage: PiToolAdapter = {
  name: 'inspect_candidate_image',
  version: '1.0.0',
  description:
    'Inspect a candidate product image: fetch it and return safe metadata (dimensions, MIME type, byte size) and a content hash. Never returns image binaries to the agent.',
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
      return okResult(
        {
          url,
          contentType,
          bytes: buffer.length,
          contentHash: sha256Hex(Buffer.from(buffer).toString('latin1')),
          note: 'identity and rights status are NOT determined by this tool',
        },
        [{ id: evidenceId('inspect_candidate_image', url), kind: 'image_evidence', url, method: 'image_metadata_inspection' }],
      );
    } catch (error) {
      return errorResult('image_fetch_failed', error instanceof Error ? error.message.slice(0, 500) : String(error));
    }
  },
};

export function buildExtractionTools(contract: PageExtractionContract = defaultPageExtractionContract): PiToolAdapter[] {
  return [buildExtractProductPage(contract), extractStructuredPageData, extractPackagingEvidence, inspectCandidateImage];
}
