/**
 * Single-source vision-model defaults for local VLM (packaging OCR) routing.
 *
 * The canonical constants moved to the SHARED layer
 * (`src/shared/vision-model-defaults.ts`) so client code and shared schemas
 * can consume them without crossing layer boundaries (`src/shared/*` may
 * only import zod/sibling-shared; client may import shared). This module is
 * now a thin re-export keeping existing `src/ai/...` imports working.
 */
export {
  DEFAULT_LOCAL_VISION_MODEL,
  LEGACY_ROUTE_FALLBACK_VISION_MODEL,
  FALLBACK_MODEL_SUGGESTIONS,
  OLLAMA_VLM_SERVICE_NAME,
} from '../shared/vision-model-defaults';
