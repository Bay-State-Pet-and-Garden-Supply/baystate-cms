import { describe, it, expect } from 'vitest';
import {
  OCR_FAILURE_REASON_MESSAGES,
  isTransientOcrFailure,
  OcrFailureReasonEnum,
} from '../../onboarding/ocr-failure-reasons';
import { OcrAttemptOutcomeSchema } from '../../shared/schemas/onboarding';

// ─── Taxonomy completeness ─────────────────────────────────────────────────────

describe('OcrFailureReasonEnum taxonomy', () => {
  const EXPECTED_CODES = [
    'not_configured',
    'policy_denied',
    'plan_incompatible',
    'no_image',
    'image_fetch_failed',
    'image_http_error',
    'image_too_small',
    'image_svg_unsupported',
    'timeout',
    'http_error',
    'transport_error',
    'empty_response',
    'unparseable_json',
    'schema_coercion_failed',
    'circuit_open',
    'audit_terminal_write_failed',
  ] as const;

  it('contains exactly the agreed failure codes', () => {
    expect(OcrFailureReasonEnum.options).toEqual(EXPECTED_CODES);
  });

  it('maps every failure class to a stable human-readable template', () => {
    for (const code of EXPECTED_CODES) {
      const message = OCR_FAILURE_REASON_MESSAGES[code];
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
      // Redaction-safe templates never interpolate raw URLs.
      expect(message).not.toContain('http://');
      expect(message).not.toContain('https://');
    }
  });

  it('rejects unknown codes', () => {
    expect(OcrFailureReasonEnum.safeParse('totally_unknown_reason').success).toBe(false);
    expect(OcrFailureReasonEnum.safeParse('timeout').success).toBe(true);
  });
});

// ─── Transient classification ──────────────────────────────────────────────────

describe('isTransientOcrFailure', () => {
  it('treats timeout and transport_error as always transient', () => {
    expect(isTransientOcrFailure('timeout')).toBe(true);
    expect(isTransientOcrFailure('timeout', 500)).toBe(true);
    expect(isTransientOcrFailure('transport_error')).toBe(true);
    expect(isTransientOcrFailure('transport_error', undefined)).toBe(true);
  });

  it('treats http_error 429 and 5xx as transient when the status is encoded separately', () => {
    expect(isTransientOcrFailure('http_error', 429)).toBe(true);
    expect(isTransientOcrFailure('http_error', 500)).toBe(true);
    expect(isTransientOcrFailure('http_error', 503)).toBe(true);
  });

  it('treats http_error 4xx and unknown status as NOT transient', () => {
    expect(isTransientOcrFailure('http_error', 400)).toBe(false);
    expect(isTransientOcrFailure('http_error', 404)).toBe(false);
    expect(isTransientOcrFailure('http_error')).toBe(false); // conservative
  });

  it('never retries deterministic failure classes', () => {
    for (const code of [
      'not_configured',
      'policy_denied',
      'plan_incompatible',
      'no_image',
      'image_fetch_failed',
      'image_http_error',
      'image_too_small',
      'image_svg_unsupported',
      'empty_response',
      'unparseable_json',
      'schema_coercion_failed',
      'circuit_open',
      'audit_terminal_write_failed',
    ] as const) {
      expect(isTransientOcrFailure(code)).toBe(false);
      expect(isTransientOcrFailure(code, 500)).toBe(false);
    }
  });
});

// ─── Additive outcome-schema extension ─────────────────────────────────────────

describe('OcrAttemptOutcomeSchema additive fields', () => {
  it('still accepts persisted rows that predate the new fields (zero breakage)', () => {
    const legacyRow = { status: 'failed', reason: 'some legacy reason', imageCount: 2 };
    const parsed = OcrAttemptOutcomeSchema.safeParse(legacyRow);
    expect(parsed.success).toBe(true);
  });

  it('accepts the new structured fields when present', () => {
    const parsed = OcrAttemptOutcomeSchema.safeParse({
      status: 'failed',
      localStatus: 'failed',
      cloudStatus: 'skipped',
      localFailureReason: 'timeout',
      cloudFailureReason: null,
      attempts: 2,
      stale: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.localFailureReason).toBe('timeout');
      expect(parsed.data.attempts).toBe(2);
      expect(parsed.data.stale).toBe(false);
    }
  });

  it('rejects unknown failure-reason codes in outcome rows', () => {
    const parsed = OcrAttemptOutcomeSchema.safeParse({
      status: 'failed',
      localFailureReason: 'made_up_code',
    });
    expect(parsed.success).toBe(false);
  });
});
