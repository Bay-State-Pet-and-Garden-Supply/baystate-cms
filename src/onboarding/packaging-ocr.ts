/**
 * Shared packaging OCR module.
 *
 * Runs VLM OCR on a product's primary packaging image once, before
 * classification. Extracts structured attributes into PackagingOcrData
 * and persists them on ExtractionData so both the curator (title synthesis)
 * and the classification pipeline (evidence extraction) consume the same
 * data without duplicate VLM calls.
 *
 * Images are expected to be remote URLs at this point (extraction stores
 * them as URLs). We fetch them in-memory — no local download required.
 */

import { getVlmConfig, callVlm, type VlmConfig } from './vlm-client';
import { isLoopbackBaseUrl, redactImageUrl, redactTransportText } from '../classification/model-policy-gateway';
import {
  computePromptHashes,
  MODEL_CALL_STATUS,
  COST_BASIS,
  type ModelCallContext,
} from '../classification/model-operation-registry';
import {
  assertModelPlanCompatible,
  getModelExecutionPlanEntry,
} from '../classification/runtime-snapshot';
import {
  insertModelCallStart,
  completeModelCall,
  recordTerminalPreflight,
} from '../db/repositories/classification-model-call-repo';
import { PackagingOcrDataSchema } from '../shared/schemas/onboarding';
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import { sha256Hex } from '../shared/stable-id';

// ─── Prompt ────────────────────────────────────────────────────────────────────

/**
 * Comprehensive VLM prompt for packaging image analysis.
 * Asks for structured JSON with per-field confidence.
 */
export const PACKAGING_OCR_PROMPT = `Analyze this product packaging image for a retail catalog.

Return ONLY valid JSON. Do not wrap in markdown. Do not guess. Use null or [] when not visible.
If a field does not apply to this product type (e.g. flavor for a shovel, species for a hose), return null or [].
Separate printed text from visual inference.
"upc": transcribe the exact UPC/GTIN barcode digits printed on the package (EAN-13/UPC-A, 8-14 digits, digits only after stripping check-spacing). Use null when no barcode is visible or legible.

{
  "productName": string | null,
  "brand": string | null,
  "species": string[],
  "upc": string | null,
  "flavorVariety": string | null,
  "color": string | null,
  "material": string | null,
  "size": string | null,
  "weight": string | null,
  "count": string | null,
  "lifeStage": string | null,
  "breedSize": string | null,
  "productForm": string | null,
  "healthConcernFunction": string[],
  "dietaryLabels": string[],
  "ingredients": string[],
  "ingredientKeywords": string[],
  "claims": string[],
  "visibleTextLines": string[],
  "confidenceByField": { [fieldName: string]: number }
}`;

// ─── Image loading ─────────────────────────────────────────────────────────────

/**
 * Determine whether a string is an HTTP(S) URL.
 */
function isRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch a remote image and return its base64-encoded contents.
 * `fetchFn` defaults to the global fetch (onboarding pipeline unchanged);
 * PI callers may pass a policy-gateway-bound fetch (P0-1).
 */
async function fetchRemoteImageAsBase64(url: string, fetchFn: NetworkFetch = fetch): Promise<string | null> {
  try {
    const response = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BaystateCMS/1.0)',
        Accept: 'image/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`[PackagingOcr] HTTP ${response.status} fetching remote image: ${url}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('svg')) {
      console.warn(`[PackagingOcr] Skipping SVG image: ${url}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Skip tiny files (likely icons/spacers)
    if (buffer.length < 1024) {
      console.warn(`[PackagingOcr] Image too small (${buffer.length}b), skipping: ${url}`);
      return null;
    }

    return buffer.toString('base64');
  } catch (err: any) {
    console.warn(`[PackagingOcr] Failed to fetch remote image ${redactImageUrl(url)}: ${redactTransportText(err.message)}`);
    return null;
  }
}

/**
 * Load a product image as base64, supporting both local paths and remote URLs.
 *
 * Priority:
 * 1. If `imageLocalPath` is provided and the file exists on disk, read it.
 * 2. If `imageUrl` is an HTTP(S) URL, fetch it in-memory.
 * 3. Otherwise return null.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function loadProductImageAsBase64(
  imageUrl: string,
  workspacePath?: string,
  imageLocalPath?: string | null,
  fetchFn: NetworkFetch = fetch,
): Promise<string | null> {
  // Try local path first (for items where images were downloaded)
  if (imageLocalPath && workspacePath) {
    const resolved = pathResolve(workspacePath, imageLocalPath);
    try {
      const fs = await import('fs');
      if (fs.existsSync(resolved)) {
        const buffer = fs.readFileSync(resolved);
        if (buffer.length >= 1024) {
          return buffer.toString('base64');
        }
        console.warn(`[PackagingOcr] Local image too small (${buffer.length}b): ${resolved}`);
      }
    } catch {
      // Fall through to remote fetch
    }
  }

  // Try resolving the image URL as a local path if it's not a remote URL
  if (!isRemoteUrl(imageUrl) && workspacePath) {
    const resolved = pathResolve(workspacePath, imageUrl);
    try {
      const fs = await import('fs');
      if (fs.existsSync(resolved)) {
        const buffer = fs.readFileSync(resolved);
        if (buffer.length >= 1024) {
          return buffer.toString('base64');
        }
      }
    } catch {
      // Fall through to remote fetch
    }
  }

  // Remote URL — fetch in-memory
  if (isRemoteUrl(imageUrl)) {
    return fetchRemoteImageAsBase64(imageUrl, fetchFn);
  }

  return null;
}

// ─── Parser ─────────────────────────────────────────────────────────────────────

/**
 * Attempt to extract a JSON object from the VLM response text.
 * Tries, in order:
 * 1. Raw JSON.parse
 * 2. Strip markdown code fences
 * 3. Find the first { ... } block surrounded by prose
 */
export function parseJsonFromVlmResponse(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null;

  const trimmed = raw.trim();

  // 1. Raw parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to next strategy
  }

  // 2. Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue
    }
  }

  // 3. Find the first { ... } object
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const candidate = trimmed.slice(braceStart, braceEnd + 1);
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Give up
    }
  }

  return null;
}

/**
 * Coerce a raw parsed object into a valid PackagingOcrData.
 * Normalizes arrays, clamps confidence values, and defaults unknown fields.
 */
export function coercePackagingOcrData(
  raw: Record<string, unknown>,
  metadata?: {
    imageSourceUrl?: string | null;
    imageLocalPath?: string | null;
    model?: string | null;
    parser?: string | null;
    rawResponseExcerpt?: string | null;
  } | null,
): PackagingOcrData | null {
  // Normalize scalar values that should be arrays
  const normalizeArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return [val.trim()];
    return [];
  };

  const normalizeString = (val: unknown): string | null => {
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    return null;
  };

  // Round-5: barcode digits only; a valid UPC/GTIN is 8-14 digits after
  // stripping spaces/hyphens (EAN-13/UPC-A check-spacing). Anything else
  // is not a trustworthy barcode transcription and stays null.
  const normalizeBarcode = (val: unknown): string | null => {
    const raw = normalizeString(val);
    if (raw === null) return null;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  };

  // Clamp confidence values
  const normalizeConfidence = (val: unknown): number | null => {
    const n = typeof val === 'number' ? val : Number(val);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(1, n));
  };

  const confidenceByField: Record<string, number> = {};
  if (raw.confidenceByField && typeof raw.confidenceByField === 'object') {
    for (const [key, val] of Object.entries(raw.confidenceByField)) {
      const clamped = normalizeConfidence(val);
      if (clamped !== null) confidenceByField[key] = clamped;
    }
  }

  const candidate = {
    productName: normalizeString(raw.productName),
    brand: normalizeString(raw.brand),
    species: normalizeArray(raw.species),
    upc: normalizeBarcode(raw.upc),
    flavorVariety: normalizeString(raw.flavorVariety),
    color: normalizeString(raw.color),
    material: normalizeString(raw.material),
    size: normalizeString(raw.size),
    weight: normalizeString(raw.weight),
    count: normalizeString(raw.count),
    lifeStage: normalizeString(raw.lifeStage),
    breedSize: normalizeString(raw.breedSize),
    productForm: normalizeString(raw.productForm),
    healthConcernFunction: normalizeArray(raw.healthConcernFunction),
    dietaryLabels: normalizeArray(raw.dietaryLabels),
    ingredients: normalizeArray(raw.ingredients),
    ingredientKeywords: normalizeArray(raw.ingredientKeywords),
    claims: normalizeArray(raw.claims),
    visibleTextLines: normalizeArray(raw.visibleTextLines),
    confidenceByField,
    metadata: metadata ?? null,
  };

  const result = PackagingOcrDataSchema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }

  console.warn(`[PackagingOcr] Schema validation failed: ${result.error.message}`);
  return null;
}

// ─── Main entry point ──────────────────────────────────────────────────────────


/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ExtractPackagingOcrParams {
  /** The primary image URL or relative path from extraction data. */
  imageUrl: string;
  /** Workspace path for resolving local image paths. */
  workspacePath?: string;
  /** Optional local path override (if image was downloaded). */
  imageLocalPath?: string | null;
  /** Original source URL for metadata. */
  imageSourceUrl?: string | null;
  /** SKU / UPC for logging. */
  sku?: string | null;
  /**
   * P0-1 (round 2): injected fetch for the remote image loader. Product
   * Intelligence binds this to the policy gateway's gatewayFetch; the
   * onboarding pipeline keeps the default global fetch.
   */
  fetchFn?: NetworkFetch;
  /**
   * Round-4: injected transport for the VLM MODEL call, separately gated
   * from the image download. Product Intelligence binds this to the
   * gateway's buildModelFetch (checkModelEndpoint authority — local
   * loopback models allowed under any data-sharing policy; remote models
   * must match the modelRoute). Defaults to fetchFn for the onboarding
   * pipeline, which historically passed one transport for both.
   */
  modelFetchFn?: NetworkFetch;
  /** Durable model-call audit context (issue #17 E): when present, the local
   *  VLM transport is audited with a classification_model_calls row
   *  (started → terminal on every path) so run-bound local VLM output is
   *  fully observable and its callId flows into the OCR evidence metadata. */
  modelCall?: ModelCallContext | null;
  /** Runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: import('../classification/runtime-snapshot').RuntimeClassificationSnapshot | null;
  /**
   * Frozen local VLM route from the run snapshot plan entry. When provided
   * (run-bound), the transport uses ONLY this base URL/model — never mutable
   * `ollama_vlm` settings — and locality is resolved from the ACTUAL URL used
   * (loopback ⇒ local; non-loopback ⇒ deny before transport).
   */
  frozenVlmRoute?: { baseUrl: string; model: string } | null;
  /** Frozen model-policy digest bound to the snapshot (for the audit row). */
  modelPolicyDigest?: string | null;
}

/**
 * Run VLM OCR on a product packaging image and return structured data.
 *
 * This is the single entry point for all packaging OCR. It:
 * 1. Loads the image (local path or remote URL)
 * 2. Calls the local VLM with a comprehensive JSON prompt
 * 3. Parses and validates the response
 * 4. Returns structured PackagingOcrData or null
 *
 * Returns null (does not throw) when:
 * - VLM is not configured
 * - Image cannot be loaded
 * - Parsing fails after recovery attempts
 */
export async function extractPackagingOcr(
  params: ExtractPackagingOcrParams,
): Promise<(PackagingOcrData & { contentHash: string | null }) | null> {
  const { imageUrl, workspacePath, imageLocalPath, imageSourceUrl, sku, fetchFn, modelFetchFn } = params;

  const auditCtx = params.modelCall ?? null;
  const runBound = Boolean(params.snapshot);

  // Boundary-level parity with the cloud VLM transport: a supplied audit
  // context WITHOUT a runtime snapshot cannot be validated against a frozen
  // plan — fail closed before any config resolution or transport. Correctness
  // of the exported single transport entry point cannot depend on every
  // caller passing both arguments.
  if (!runBound && auditCtx) {
    throw new Error(
      'Local VLM call supplied a model-call audit context without a runtime snapshot.',
    );
  }

  // Resolve the local VLM route. Run-bound calls MUST use the frozen route
  // captured in the snapshot plan (never mutable `ollama_vlm` settings) and
  // MUST pass plan compatibility. A run-bound call without a frozen route or
  // with a non-loopback frozen URL is denied BEFORE any transport (image
  // fetch or model call) and recorded as `policy_denied` — never a false
  // 'local' success row.
  let vlmConfig: VlmConfig | null;
  let routeLocality: 'local' | null = null;
  if (runBound) {
    if (!auditCtx) {
      throw new Error(
        'Run-bound local VLM call without a model-call audit context (no compatible frozen plan).',
      );
    }
    // The single transport entry point must bind to the snapshot itself:
    // assert plan compatibility (schema-v2, digests, entry, versions,
    // context) BEFORE any transport, then derive the route and the audit
    // digest from the frozen plan entry — caller-supplied route/digest
    // values are never trusted for run-bound calls.
    assertModelPlanCompatible(params.snapshot, 'evidence_extraction', auditCtx);
    const planEntry = getModelExecutionPlanEntry(params.snapshot, 'evidence_extraction');
    const planDigest = params.snapshot?.modelExecutionPlan?.digest ?? '';
    const frozen = planEntry?.localVlmBaseUrl
      ? { baseUrl: planEntry.localVlmBaseUrl, model: planEntry.localVlmModel ?? '' }
      : null;
    if (!frozen || !frozen.model) {
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        'Local VLM route denied: no frozen local VLM route in the run snapshot plan.',
      );
      return null;
    }
    // A caller-supplied route that disagrees with the frozen plan entry is a
    // tampering signal — deny rather than trust the caller.
    const supplied = params.frozenVlmRoute ?? null;
    if (supplied && (supplied.baseUrl !== frozen.baseUrl || supplied.model !== frozen.model)) {
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        'Local VLM route denied: supplied route does not match the frozen plan entry.',
      );
      return null;
    }
    if (!isLoopbackBaseUrl(frozen.baseUrl)) {
      recordTerminalPreflight(
        auditCtx,
        planDigest,
        MODEL_CALL_STATUS.policyDenied,
        `Local VLM route denied: frozen base URL ${redactImageUrl(frozen.baseUrl)} is not loopback.`,
      );
      return null;
    }
    vlmConfig = { baseUrl: frozen.baseUrl, model: frozen.model, enabled: true };
    routeLocality = 'local';
  } else {
    vlmConfig = getVlmConfig();
    if (!vlmConfig?.enabled) {
      console.log(`[PackagingOcr] VLM not enabled — skipping OCR for ${sku ?? imageUrl}`);
      return null;
    }
  }

  // Durable audit for run-bound local VLM calls (issue #17 E): insert the
  // `started` row BEFORE any transport (image fetch + model call) so the
  // model is never invoked without provenance. Without a durable start row
  // the model is never invoked.
  let callId: string | null = null;
  if (auditCtx) {
    const hashes = computePromptHashes(PACKAGING_OCR_PROMPT, '');
    callId = insertModelCallStart({
      runId: auditCtx.runId,
      stageName: auditCtx.stage,
      operation: auditCtx.operation,
      attempt: auditCtx.attempt,
      provider: 'ollama',
      model: vlmConfig?.model ?? 'unknown',
      locality: routeLocality ?? null,
      snapshotHash: auditCtx.snapshotHash,
      modelPolicyDigest: params.snapshot?.modelExecutionPlan?.digest ?? params.modelPolicyDigest ?? '',
      promptTemplateVersion: auditCtx.promptTemplateVersion,
      ruleVersion: auditCtx.ruleVersion,
      systemPromptHash: hashes.systemPromptHash,
      userPromptHash: hashes.userPromptHash,
    });
  }

  // Load the image
  const base64Image = await loadProductImageAsBase64(imageUrl, workspacePath, imageLocalPath, fetchFn);
  if (!base64Image) {
    console.warn(`[PackagingOcr] Could not load image for OCR: ${imageUrl}`);
    if (callId) {
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        durationMs: 0,
        errorMessage: 'Could not load image for OCR.',
        estimatedCostUsd: routeLocality === 'local' ? 0 : null,
        costBasis: routeLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
    }
    return null;
  }

  // Round-4: byte-hash binding — the SHA-256 of the EXACT downloaded bytes.
  // OCR facts are bound to this hash so image A's facts can never authorize
  // identity while image B is being inspected.
  const contentHash = sha256Hex(Buffer.from(base64Image, 'base64'));

  const startedAt = Date.now();
  let terminalWritten = false;
  const markTerminal = (
    status: typeof MODEL_CALL_STATUS[keyof typeof MODEL_CALL_STATUS],
    errorMessage?: string,
  ): boolean => {
    if (!callId) return true;
    terminalWritten = true;
    return completeModelCall(callId, {
      status,
      durationMs: Date.now() - startedAt,
      errorMessage,
      estimatedCostUsd: routeLocality === 'local' ? 0 : null,
      costBasis: routeLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
    });
  };

  // Call VLM
  console.log(`[PackagingOcr] Running OCR on ${sku ?? imageUrl} using ${vlmConfig.model}`);
  let rawResponse: string;
  try {
    rawResponse = await callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig, modelFetchFn ?? fetchFn);
  } catch (err: any) {
    if (!terminalWritten && callId) {
      try {
        markTerminal(MODEL_CALL_STATUS.failed, redactTransportText(err.message));
      } catch {
        // best-effort; the primary warning still uses the redacted reason
      }
    }
    console.warn(`[PackagingOcr] VLM call failed for ${sku ?? redactImageUrl(imageUrl ?? '')}: ${redactTransportText(err.message)}`);
    return null;
  }

  if (!rawResponse || rawResponse.length < 3) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Empty or too-short response from local VLM.');
    console.warn(`[PackagingOcr] Empty or too-short response from VLM for ${sku ?? imageUrl}`);
    return null;
  }

  // Parse
  const responseExcerpt = rawResponse.slice(0, 200);
  const parsed = parseJsonFromVlmResponse(rawResponse);
  if (!parsed) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Could not parse JSON from local VLM response.');
    console.warn(`[PackagingOcr] Could not parse JSON from VLM response for ${sku ?? imageUrl}`);
    return null;
  }

  // Coerce and validate
  const metadata = {
    imageSourceUrl: imageSourceUrl ?? imageUrl,
    imageLocalPath: imageLocalPath ?? null,
    model: vlmConfig.model,
    extractedAt: new Date().toISOString(),
    parser: 'packaging-ocr.ts',
    rawResponseExcerpt: responseExcerpt,
    ...(callId ? { modelCallIds: [callId] } : {}),
  };

  const result = coercePackagingOcrData(parsed, metadata);
  if (!result) {
    if (callId) markTerminal(MODEL_CALL_STATUS.failed, 'Schema coercion failed for local VLM response.');
    console.warn(`[PackagingOcr] Schema coercion failed for ${sku ?? imageUrl}`);
    return null;
  }

  // Success: the terminal row must be durable before the result is returned.
  if (callId) {
    const terminalDurable = markTerminal(MODEL_CALL_STATUS.success);
    if (!terminalDurable) {
      console.error(`[PackagingOcr] Local VLM call ${callId} terminal update failed; discarding OCR output.`);
      return null;
    }
  }

  const fieldCount = Object.entries(result).filter(
    ([k, v]) => k !== 'metadata' && k !== 'confidenceByField' && v !== null && !(Array.isArray(v) && v.length === 0),
  ).length;

  console.log(
    `[PackagingOcr] ✓ OCR complete for ${sku ?? imageUrl}: ${fieldCount} fields populated ` +
    `(productName="${result.productName ?? 'N/A'}", species=[${result.species.join(', ')}], ` +
    `form="${result.productForm ?? 'N/A'}", labels=[${result.dietaryLabels.join(', ')}])`,
  );

  return { ...result, contentHash };
}

// ─── OCR result merging (multi-image support) ────────────────────────────────

/**
 * Merge multiple PackagingOcrData results from different images of the same
 * product into a single combined result.
 *
 * Strategy:
 * - **Scalar fields** (productName, brand, flavorVariety, etc.): Highest-confidence
 *   wins (uses confidenceByField; falls back to first non-null when no confidence data).
 * - **Array fields** (ingredients, claims, dietaryLabels, species, etc.):
 *   Unioned across all results, deduplicated, preserving order.
 * - **confidenceByField**: Per-field, the maximum confidence wins.
 * - **metadata**: Keeps the primary image's metadata.
 */
export function mergeOcrResults(results: PackagingOcrData[]): PackagingOcrData {
  if (results.length === 0) throw new Error('Cannot merge empty OCR results');
  if (results.length === 1) return results[0];

  const merged: Record<string, any> = {};

  // Scalar fields — highest-confidence wins
  // For each scalar field, check all results' confidenceByField,
  // pick the value from the result with the highest confidence.
  // Falls back to first-non-null when no confidence data exists.
  const scalarFields: Array<keyof PackagingOcrData> = [
    'productName', 'brand', 'flavorVariety', 'color', 'material',
    'size', 'weight', 'count', 'lifeStage', 'breedSize', 'productForm',
  ];
  for (const field of scalarFields) {
    let bestVal: unknown = null;
    let bestConf = -1;
    for (const r of results) {
      const val = r[field];
      if (val === null || val === undefined) continue;
      const conf = r.confidenceByField?.[field] ?? -1;
      if (conf > bestConf || (conf === -1 && bestVal === null)) {
        bestVal = val;
        bestConf = conf;
      }
    }
    merged[field] = bestVal ?? null;
  }

  // Array fields — union, deduplicated
  const arrayFields: Array<keyof PackagingOcrData> = [
    'species', 'healthConcernFunction', 'dietaryLabels',
    'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
  ];
  for (const field of arrayFields) {
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const r of results) {
      const arr = r[field];
      if (Array.isArray(arr)) {
        for (const val of arr) {
          if (val && !seen.has(val.toLowerCase())) {
            seen.add(val.toLowerCase());
            combined.push(val);
          }
        }
      }
    }
    merged[field] = combined;
  }

  // confidenceByField — take max per field
  const mergedConfidence: Record<string, number> = {};
  for (const r of results) {
    if (r.confidenceByField) {
      for (const [field, conf] of Object.entries(r.confidenceByField)) {
        if (conf !== null && conf !== undefined) {
          mergedConfidence[field] = Math.max(mergedConfidence[field] ?? 0, conf);
        }
      }
    }
  }
  merged.confidenceByField = mergedConfidence;

  // metadata — keep the primary image's metadata, but UNION the durable
  // model-call IDs across ALL images' results so every influencing call is
  // traceable from the merged OCR evidence (issue #17 pass 4c). A call that
  // supplied a value selected by the merge must never be dropped.
  const callIdUnion = new Set<string>();
  for (const r of results) {
    const ids = (r.metadata as { modelCallIds?: string[] } | null)?.modelCallIds ?? [];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (id && typeof id === 'string') callIdUnion.add(id);
      }
    }
  }
  const mergedMetadata = results[0].metadata
    ? { ...results[0].metadata }
    : (callIdUnion.size > 0 ? {} : null);
  if (callIdUnion.size > 0 && mergedMetadata) {
    (mergedMetadata as { modelCallIds?: string[] }).modelCallIds = [...callIdUnion];
  }
  merged.metadata = mergedMetadata;

  return merged as PackagingOcrData;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal path.resolve that doesn't require importing 'path' at module level.
 */
function pathResolve(base: string, relative: string): string {
  // Simple implementation that handles the common cases
  if (relative.startsWith('/')) return relative;
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}
