/**
 * Cloud-based VLM OCR client for packaging images.
 *
 * Provides a cloud fallback for packaging OCR when the local VLM is
 * unavailable or produces low-confidence results. Uses an OpenAI-compatible
 * /chat/completions endpoint with image content support.
 *
 * This is gated by data-sharing policy — only fires when
 * `dataSharing.imagePolicy === 'cloud_allowed'`.
 */
import { getLlmConfigForTask, type LlmConfig } from './llm-client';
import { PACKAGING_OCR_PROMPT, parseJsonFromVlmResponse, coercePackagingOcrData } from './packaging-ocr';
import type { PackagingOcrData } from '../shared/schemas/onboarding';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CloudVlmParams {
  /** The primary product image URL */
  imageUrl: string;
  /** Provider/model override (defaults to llm_task_configs or fallback) */
  task?: string;
}

// ─── Image Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch a remote image, validate size, and return base64 + MIME type.
 */
async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShopSiteCMS/1.0)',
        Accept: 'image/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.warn(`[CloudVlm] HTTP ${response.status} fetching image: ${url}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';

    // Skip SVGs and other non-raster formats
    if (contentType.includes('svg')) {
      console.warn(`[CloudVlm] Skipping SVG image: ${url}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Skip tiny files (likely icons/spacers)
    if (buffer.length < 1024) {
      console.warn(`[CloudVlm] Image too small (${buffer.length}b), skipping: ${url}`);
      return null;
    }

    return { base64: buffer.toString('base64'), mimeType: contentType };
  } catch (err: any) {
    console.warn(`[CloudVlm] Failed to fetch image ${url}: ${err.message}`);
    return null;
  }
}

// ─── Cloud VLM Call ───────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible vision API to extract packaging text from an image.
 *
 * Sends the PACKAGING_OCR_PROMPT with the image inline (image_url content type).
 * Uses the standard /chat/completions endpoint with a model that supports vision.
 *
 * Provider resolution:
 * 1. If `task` is provided, uses `getLlmConfigForTask(task)` (e.g. 'classification_evidence_extraction')
 * 2. Falls back to generic `getLlmConfig()` (default LLM provider)
 *
 * Returns parsed PackagingOcrData or null on failure.
 */
export async function extractPackagingOcrFromCloud(
  params: CloudVlmParams,
): Promise<PackagingOcrData | null> {
  const { imageUrl, task } = params;

  if (!imageUrl) {
    console.warn('[CloudVlm] No image URL provided.');
    return null;
  }

  // 1. Get the image as base64
  const imageData = await fetchImageAsBase64(imageUrl);
  if (!imageData) {
    console.warn(`[CloudVlm] Could not load image: ${imageUrl}`);
    return null;
  }

  // 2. Resolve LLM config for the vision task
  let config: LlmConfig | null = null;
  try {
    config = getLlmConfigForTask((task ?? 'classification_evidence_extraction') as LlmTask, { allowFallback: true });
  } catch {
    // Fallback to generic config
    const { getLlmConfig } = await import('./llm-client');
    config = getLlmConfig();
  }

  if (!config) {
    console.warn('[CloudVlm] No LLM config available for cloud VLM call.');
    return null;
  }

  // 3. Build the OpenAI-compatible vision request
  //    The image is sent as an image_url content part alongside the text prompt.
  const dataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;

  const body = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PACKAGING_OCR_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
  };

  // 4. Call the API
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;

  console.log(`[CloudVlm] Calling ${config.provider}:${config.model} for packaging OCR`);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[CloudVlm] API request failed (${config.provider}): ${response.status} - ${errorText.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = data?.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.warn('[CloudVlm] API returned empty response.');
      return null;
    }

    const responseExcerpt = rawContent.slice(0, 200);

    // 5. Parse the response using the same utilities as local OCR
    const parsed = parseJsonFromVlmResponse(rawContent);
    if (!parsed) {
      console.warn('[CloudVlm] Could not parse JSON from response.');
      return null;
    }

    // 6. Coerce to the standard PackagingOcrData shape
    const metadata = {
      imageSourceUrl: imageUrl,
      imageLocalPath: null,
      model: `${config.provider}:${config.model}`,
      extractedAt: new Date().toISOString(),
      parser: 'cloud-vlm-client.ts',
      rawResponseExcerpt: responseExcerpt,
    };

    const result = coercePackagingOcrData(parsed, metadata);
    if (!result) {
      console.warn('[CloudVlm] Schema coercion failed for cloud OCR response.');
      return null;
    }

    const fieldCount = Object.entries(result).filter(
      ([k, v]) => k !== 'metadata' && k !== 'confidenceByField' && v !== null && !(Array.isArray(v) && v.length === 0),
    ).length;

    console.log(
      `[CloudVlm] ✓ OCR complete: ${fieldCount} fields populated ` +
      `(productName="${result.productName ?? 'N/A'}", species=[${result.species.join(', ')}])`,
    );

    return result;
  } catch (err: any) {
    console.warn(`[CloudVlm] Cloud VLM call failed: ${err.message}`);
    return null;
  }
}
