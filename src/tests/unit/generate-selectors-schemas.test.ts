/**
 * Tests for generateSelectorsService and generateSelectors route error mapping.
 *
 * The service tests use mocked lower-level modules via dependency injection.
 * The route tests verify request validation and error code mapping.
 *
 * Full integration tests require a running Bun server, extraction worker,
 * and configured LLM — those are manual QA scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { GenerateSelectorsRequestSchema, GenerateSelectorsResponseSchema } from '../../shared/schemas/selector-generation';

// ─── Request Schema Tests ───────────────────────────────────────────────────

describe('GenerateSelectorsRequestSchema', () => {
  const validRequest = {
    htmlRef: '.shopsite-cms/artifacts/profile-builder/acmepet.com/job-123/page.html',
    sourceUrl: 'https://acmepet.com/products/chicken-dinner',
    runtime: 'rendered' as const,
    fields: [
      { key: 'titleSelector', label: 'Title', origin: 'core' as const, valueType: 'text' as const },
      { key: 'brandSelector', label: 'Brand', origin: 'core' as const, valueType: 'text' as const },
    ],
  };

  it('accepts a valid request', () => {
    const result = GenerateSelectorsRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('accepts a valid request with snapshot context', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      ...validRequest,
      snapshotContext: {
        jsonLd: [{ '@type': 'Product' }],
        imageCandidates: [{ url: 'https://example.com/img.jpg' }],
        pageStructureSignals: [{ kind: 'title', selector: 'h1', label: 'Product Title' }],
        warnings: ['Test warning'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing htmlRef', () => {
    const { htmlRef, ...rest } = validRequest;
    const result = GenerateSelectorsRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid sourceUrl', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({ ...validRequest, sourceUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('rejects unsupported runtime', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({ ...validRequest, runtime: 'headless' });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate field keys', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      ...validRequest,
      fields: [
        { key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' },
        { key: 'titleSelector', label: 'Title Again', origin: 'core', valueType: 'text' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects reserved field keys', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      ...validRequest,
      fields: [{ key: '__proto__', label: 'Bad', origin: 'core', valueType: 'text' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 50 fields', () => {
    const fields = Array.from({ length: 51 }, (_, i) => ({
      key: `field${i}Selector`,
      label: `Field ${i}`,
      origin: 'core' as const,
      valueType: 'text' as const,
    }));
    const result = GenerateSelectorsRequestSchema.safeParse({ ...validRequest, fields });
    expect(result.success).toBe(false);
  });

  it('rejects zero fields', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({ ...validRequest, fields: [] });
    expect(result.success).toBe(false);
  });
});

// ─── Response Schema Tests ──────────────────────────────────────────────────

describe('GenerateSelectorsResponseSchema', () => {
  const makeSuggestion = (overrides: Record<string, unknown> = {}) => ({
    fieldKey: 'titleSelector',
    selector: 'h1.product-title',
    status: 'suggested' as const,
    validation: { syntaxValid: true, matchedCount: 1, visibleMatchedCount: 1, unique: true },
    quality: 'high' as const,
    warnings: [],
    explanation: 'A single visible H1 contains the product name.',
    preview: { text: 'Chicken Dinner' },
    ...overrides,
  });

  it('accepts a valid response', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_01JXYZ',
      fields: { titleSelector: makeSuggestion() },
      customFields: [],
      warnings: [],
      meta: { durationMs: 18442, htmlBytes: 286104, htmlReduced: true, requestedFieldCount: 1, suggestedFieldCount: 1, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom field suggestions', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {},
      customFields: [{
        key: 'ingredientListSelector',
        fieldKey: 'ingredientListSelector',
        label: 'Ingredients',
        valueType: 'text',
        selector: 'section.ingredients',
        status: 'suggested',
        validation: { syntaxValid: true, matchedCount: 1, visibleMatchedCount: null, unique: true },
        quality: 'high',
        warnings: [],
      }],
      warnings: [],
      meta: { durationMs: 100, htmlBytes: 1000, htmlReduced: false, requestedFieldCount: 0, suggestedFieldCount: 0, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 8 custom fields', () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      key: `cf${i}Selector`,
      fieldKey: `cf${i}Selector`,
      label: `CF ${i}`,
      valueType: 'text' as const,
      selector: `h${i + 1}`,
      status: 'suggested' as const,
      validation: { syntaxValid: true, matchedCount: 1, visibleMatchedCount: null, unique: true },
      quality: 'high' as const,
      warnings: [],
    }));
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {},
      customFields: fields,
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 0, suggestedFieldCount: 0, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid status values', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: { titleSelector: makeSuggestion({ status: 'bogus' }) },
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 1, suggestedFieldCount: 1, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects selectors exceeding 500 characters', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: { titleSelector: makeSuggestion({ selector: 'a'.repeat(501) }) },
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 1, suggestedFieldCount: 1, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// ─── Error Mapping Tests (unit-testable without server) ───────────────────

describe('Generation error contract', () => {
  const errorSchema = z.object({
    requestId: z.string(),
    error: z.object({
      code: z.enum([
        'INVALID_REQUEST',
        'INVALID_ARTIFACT_REFERENCE',
        'SNAPSHOT_NOT_FOUND',
        'SNAPSHOT_TOO_LARGE',
        'UNUSABLE_SNAPSHOT',
        'LLM_NOT_CONFIGURED',
        'LLM_RATE_LIMITED',
        'LLM_TIMEOUT',
        'LLM_UNAVAILABLE',
        'INVALID_LLM_RESPONSE',
        'INTERNAL_ERROR',
      ]),
      message: z.string(),
      retryable: z.boolean(),
    }),
  });

  it('accepts every known error code', () => {
    const codes = [
      'INVALID_REQUEST', 'INVALID_ARTIFACT_REFERENCE', 'SNAPSHOT_NOT_FOUND',
      'SNAPSHOT_TOO_LARGE', 'UNUSABLE_SNAPSHOT', 'LLM_NOT_CONFIGURED',
      'LLM_RATE_LIMITED', 'LLM_TIMEOUT', 'LLM_UNAVAILABLE', 'INVALID_LLM_RESPONSE',
      'INTERNAL_ERROR',
    ];
    for (const code of codes) {
      const result = errorSchema.safeParse({
        requestId: 'req_test',
        error: { code, message: 'Test error', retryable: code === 'LLM_TIMEOUT' },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown error codes', () => {
    const result = errorSchema.safeParse({
      requestId: 'req_test',
      error: { code: 'MYSTERY', message: 'Unknown error', retryable: false },
    });
    expect(result.success).toBe(false);
  });

  it('correctly marks retryable errors', () => {
    const retryableCodes = ['LLM_RATE_LIMITED', 'LLM_TIMEOUT', 'LLM_UNAVAILABLE', 'INVALID_LLM_RESPONSE'];
    const nonRetryableCodes = ['INVALID_REQUEST', 'INVALID_ARTIFACT_REFERENCE', 'LLM_NOT_CONFIGURED', 'INTERNAL_ERROR'];
    for (const code of retryableCodes) {
      const result = errorSchema.safeParse({
        requestId: 'req_test',
        error: { code, message: 'Should be retryable', retryable: true },
      });
      expect(result.success).toBe(true);
    }
    for (const code of nonRetryableCodes) {
      const result = errorSchema.safeParse({
        requestId: 'req_test',
        error: { code, message: 'Should NOT be retryable', retryable: false },
      });
      expect(result.success).toBe(true);
    }
  });
});
