/**
 * Single-source vision-model defaults for local VLM (packaging OCR) routing.
 *
 * Pure constants module with NO imports (sibling-shared layering rule:
 * `src/shared/*` may only import zod/sibling-shared) — it is safe to pull
 * into any layer (server routes, PI tools, shared schemas, client) without
 * creating an import cycle. `src/ai/vision-model-defaults.ts` re-exports
 * these constants so existing server-layer imports keep working.
 */

/** Default local vision model used for packaging OCR (`api_keys.ollama_vlm`). */
export const DEFAULT_LOCAL_VISION_MODEL = 'qwen2.5vl:latest';

/**
 * Fallback model id used when a resolved AI Compute `visionOcr` workload
 * route carries no explicit modelId.
 *
 * BEHAVIOR FIX: this previously hardcoded the stale `'gemma-4-26b-a4b-qat'`
 * literal, which silently routed model-less visionOcr primaries to a model
 * that may no longer exist locally. It now falls back to the same default
 * local vision model as the legacy `ollama_vlm` row.
 */
export const LEGACY_ROUTE_FALLBACK_VISION_MODEL = 'qwen2.5vl:latest';

/** Suggested local vision models surfaced in UI/failure guidance. */
export const FALLBACK_MODEL_SUGGESTIONS = ['qwen2.5vl:latest', 'qwen3-vl:4b', 'qwen3-vl:8b'] as const;

/** `api_keys` service row name backing the legacy local VLM configuration. */
export const OLLAMA_VLM_SERVICE_NAME = 'ollama_vlm';
