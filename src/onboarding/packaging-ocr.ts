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

import { getVlmConfig, callVlm } from './vlm-client';
import { PackagingOcrDataSchema } from '../shared/schemas/onboarding';
import type { PackagingOcrData } from '../shared/schemas/onboarding';

// ─── Prompt ────────────────────────────────────────────────────────────────────

/**
 * Comprehensive VLM prompt for packaging image analysis.
 * Asks for structured JSON with per-field confidence.
 */
export const PACKAGING_OCR_PROMPT = `Analyze this product packaging image for a retail catalog.

Return ONLY valid JSON. Do not wrap in markdown. Do not guess. Use null or [] when not visible.
If a field does not apply to this product type (e.g. flavor for a shovel, species for a hose), return null or [].
Separate printed text from visual inference.

{
  "productName": string | null,
  "brand": string | null,
  "species": string[],
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
async function fetchRemoteImageAsBase64(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
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
    console.warn(`[PackagingOcr] Failed to fetch remote image ${url}: ${err.message}`);
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
    return fetchRemoteImageAsBase64(imageUrl);
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
): Promise<PackagingOcrData | null> {
  const { imageUrl, workspacePath, imageLocalPath, imageSourceUrl, sku } = params;

  const vlmConfig = getVlmConfig();
  if (!vlmConfig?.enabled) {
    console.log(`[PackagingOcr] VLM not enabled — skipping OCR for ${sku ?? imageUrl}`);
    return null;
  }

  // Load the image
  const base64Image = await loadProductImageAsBase64(imageUrl, workspacePath, imageLocalPath);
  if (!base64Image) {
    console.warn(`[PackagingOcr] Could not load image for OCR: ${imageUrl}`);
    return null;
  }

  // Call VLM
  console.log(`[PackagingOcr] Running OCR on ${sku ?? imageUrl} using ${vlmConfig.model}`);
  let rawResponse: string;
  try {
    rawResponse = await callVlm(PACKAGING_OCR_PROMPT, base64Image, vlmConfig);
  } catch (err: any) {
    console.warn(`[PackagingOcr] VLM call failed for ${sku ?? imageUrl}: ${err.message}`);
    return null;
  }

  if (!rawResponse || rawResponse.length < 3) {
    console.warn(`[PackagingOcr] Empty or too-short response from VLM for ${sku ?? imageUrl}`);
    return null;
  }

  // Parse
  const responseExcerpt = rawResponse.slice(0, 200);
  const parsed = parseJsonFromVlmResponse(rawResponse);
  if (!parsed) {
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
  };

  const result = coercePackagingOcrData(parsed, metadata);
  if (!result) {
    console.warn(`[PackagingOcr] Schema coercion failed for ${sku ?? imageUrl}`);
    return null;
  }

  const fieldCount = Object.entries(result).filter(
    ([k, v]) => k !== 'metadata' && k !== 'confidenceByField' && v !== null && !(Array.isArray(v) && v.length === 0),
  ).length;

  console.log(
    `[PackagingOcr] ✓ OCR complete for ${sku ?? imageUrl}: ${fieldCount} fields populated ` +
    `(productName="${result.productName ?? 'N/A'}", species=[${result.species.join(', ')}], ` +
    `form="${result.productForm ?? 'N/A'}", labels=[${result.dietaryLabels.join(', ')}])`,
  );

  return result;
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

  // metadata — keep the primary image's (first result)
  merged.metadata = results[0].metadata;

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
