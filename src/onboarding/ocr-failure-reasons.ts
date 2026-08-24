/**
 * OCR failure-reason taxonomy — messages and classification helpers (P1-T1).
 *
 * The reason codes themselves are defined in the SHARED layer
 * (`OcrFailureReasonEnum` in src/shared/schemas/onboarding.ts) because they
 * are persisted inside `OcrAttemptOutcomeSchema`; src/shared must never
 * import from src/onboarding, so this module derives from the schema instead.
 *
 * Redaction safety: the message templates below NEVER interpolate raw URLs,
 * hosts, or transport payloads. Callers pass a PRE-REDACTED detail string
 * (already run through redactImageUrl/redactTransportText by packaging-ocr).
 */

import {
  OcrFailureReasonEnum,
  type OcrFailureReason,
} from '../shared/schemas/onboarding';

// Re-exported so onboarding consumers can import the taxonomy + type from a
// single module without reaching into the shared schema file directly.
export { OcrFailureReasonEnum };
export type { OcrFailureReason };

/** Stable human-readable template per failure code (redaction-safe). */
export const OCR_FAILURE_REASON_MESSAGES: Record<OcrFailureReason, string> = {
  not_configured: 'Local VLM is not configured or enabled.',
  policy_denied: 'VLM call denied by model policy.',
  plan_incompatible: 'Run snapshot plan does not permit this VLM call.',
  no_image: 'Product image could not be loaded for OCR.',
  image_fetch_failed: 'Image fetch failed before an HTTP response.',
  image_http_error: 'Image fetch returned a non-OK HTTP status.',
  image_too_small: 'Image too small (< 1KB) to run OCR.',
  image_svg_unsupported: 'SVG images are unsupported for OCR.',
  timeout: 'VLM request timed out.',
  http_error: 'VLM request failed with a non-OK HTTP status.',
  transport_error: 'VLM transport failed (network/connection error).',
  empty_response: 'VLM returned an empty response.',
  unparseable_json: 'Could not parse JSON from the VLM response.',
  schema_coercion_failed: 'Schema coercion failed for the VLM response.',
  circuit_open: 'Circuit breaker is open for this VLM route.',
  audit_terminal_write_failed: 'Durable terminal audit update failed; OCR output discarded.',
};

/**
 * Whether a failure is transient and eligible for a bounded retry.
 *
 * - `timeout` and `transport_error` are always transient.
 * - `http_error` is transient only for retryable statuses (429, 5xx); the
 *   HTTP status is encoded SEPARATELY from the reason code, so an
 *   `http_error` with an unknown status is conservatively NOT transient.
 */
export function isTransientOcrFailure(code: OcrFailureReason, httpStatus?: number): boolean {
  if (code === 'timeout' || code === 'transport_error') return true;
  if (code === 'http_error') {
    if (httpStatus === undefined) return false;
    return httpStatus === 429 || httpStatus >= 500;
  }
  return false;
}
