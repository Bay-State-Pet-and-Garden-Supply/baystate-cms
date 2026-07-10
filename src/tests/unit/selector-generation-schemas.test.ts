import { describe, it, expect } from 'vitest';
import {
  GenerateSelectorsRequestSchema,
  GenerateSelectorsResponseSchema,
  GenerateSelectorsErrorResponseSchema,
  GenerateSelectorFieldSchema,
  SelectorSuggestionSchema,
  CustomFieldSuggestionSchema,
  SELECTOR_GENERATION_LIMITS,
} from '../../shared/schemas/selector-generation';

// ─── Request Validation ─────────────────────────────────────────────────────

describe('GenerateSelectorsRequestSchema', () => {
  it('accepts a valid minimal request', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: '.shopsite-cms/artifacts/profile-builder/acmepet.com/job-123/page.html',
      sourceUrl: 'https://acmepet.com/products/chicken-dinner',
      runtime: 'rendered',
      fields: [
        { key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' },
        { key: 'brandSelector', label: 'Brand', origin: 'core', valueType: 'text' },
        { key: 'descriptionSelector', label: 'Description', origin: 'core', valueType: 'text' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a request with snapshot context', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: '.shopsite-cms/artifacts/profile-builder/acmepet.com/job-123/page.html',
      sourceUrl: 'https://acmepet.com/products/chicken-dinner',
      runtime: 'static',
      fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' }],
      snapshotContext: {
        jsonLd: [{ '@type': 'Product', name: 'Test' }],
        embeddedProductData: [],
        imageCandidates: [{ url: 'https://acmepet.com/img.jpg' }],
        pageStructureSignals: [{ kind: 'title', selector: 'h1', label: 'Product Title' }],
        warnings: ['Some warning'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing htmlRef', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsupported runtime', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'browser',
      fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate field keys', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [
        { key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text' },
        { key: 'titleSelector', label: 'Title Again', origin: 'core', valueType: 'text' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('unique');
    }
  });

  it('rejects reserved field keys', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [{ key: '__proto__', label: 'Proto', origin: 'core', valueType: 'text' }],
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
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields,
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero fields', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsupported field value types', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'number' as any }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects fields with empty keys', () => {
    const result = GenerateSelectorsRequestSchema.safeParse({
      htmlRef: 'artifacts/test.html',
      sourceUrl: 'https://acmepet.com/products/test',
      runtime: 'rendered',
      fields: [{ key: '', label: 'Empty', origin: 'core', valueType: 'text' }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Response Validation ────────────────────────────────────────────────────

describe('GenerateSelectorsResponseSchema', () => {
  const makeSuggestion = (overrides: Record<string, unknown> = {}) => ({
    fieldKey: 'titleSelector',
    selector: 'h1.product-title',
    status: 'suggested' as const,
    validation: { syntaxValid: true, matchedCount: 1, visibleMatchedCount: 1, unique: true },
    quality: 'high' as const,
    explanation: 'A single visible H1 contains the product name.',
    preview: { text: 'Chicken Dinner' },
    ...overrides,
  });

  it('accepts a valid response with suggested fields', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_01JXYZ',
      fields: {
        titleSelector: makeSuggestion(),
        brandSelector: makeSuggestion({ fieldKey: 'brandSelector', selector: null, status: 'not_found', quality: 'unusable', matchedCount: 0, preview: null, explanation: null }),
      },
      customFields: [],
      warnings: [],
      meta: {
        durationMs: 18442,
        htmlBytes: 286104,
        htmlReduced: true,
        requestedFieldCount: 2,
        suggestedFieldCount: 1,
        notFoundFieldCount: 1,
        invalidFieldCount: 0,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a response with custom field suggestions', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {},
      customFields: [
        {
          key: 'ingredientListSelector',
          fieldKey: 'ingredientListSelector',
          label: 'Ingredients',
          valueType: 'text',
          selector: 'section.ingredients .ingredient-list',
          status: 'suggested',
          validation: { syntaxValid: true, matchedCount: 1, unique: true },
          quality: 'high',
          explanation: 'Found ingredient list.',
          preview: { text: 'Chicken, rice...' },
        },
      ],
      warnings: [],
      meta: {
        durationMs: 5000,
        htmlBytes: 100000,
        htmlReduced: false,
        requestedFieldCount: 0,
        suggestedFieldCount: 0,
        notFoundFieldCount: 0,
        invalidFieldCount: 0,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts up to 8 custom fields', () => {
    const fields = Array.from({ length: 8 }, (_, i) => ({
      key: `field${i}Selector`,
      fieldKey: `field${i}Selector`,
      label: `Field ${i}`,
      valueType: 'text' as const,
      selector: `h${i + 1}`,
      status: 'suggested' as const,
      validation: { syntaxValid: true, matchedCount: 1, unique: true },
      quality: 'high' as const,
    }));
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {},
      customFields: fields,
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 0, suggestedFieldCount: 0, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 8 custom fields', () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      key: `field${i}Selector`,
      fieldKey: `field${i}Selector`,
      label: `Field ${i}`,
      valueType: 'text' as const,
      selector: `h${i + 1}`,
      status: 'suggested' as const,
      validation: { syntaxValid: true, matchedCount: 1, unique: true },
      quality: 'high' as const,
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

  it('rejects invalid selector status', () => {
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {
        titleSelector: { ...makeSuggestion(), status: 'magic' },
      },
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 1, suggestedFieldCount: 0, notFoundFieldCount: 1, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty fields map (server uses Object.create(null) for safety)', () => {
    // Zod's z.record() cannot reject __proto__ at the schema level.
    // Protection is enforced by the server using Object.create(null)
    // when constructing the fields map.
    const safeFields = Object.create(null) as Record<string, unknown>;
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: safeFields,
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 0, suggestedFieldCount: 0, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects selectors exceeding max length', () => {
    const longSelector = 'a'.repeat(501);
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {
        titleSelector: makeSuggestion({ selector: longSelector }),
      },
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 1, suggestedFieldCount: 1, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects preview text exceeding max characters', () => {
    const longText = 'x'.repeat(501);
    const result = GenerateSelectorsResponseSchema.safeParse({
      requestId: 'req_test',
      fields: {
        titleSelector: makeSuggestion({ preview: { text: longText } }),
      },
      warnings: [],
      meta: { durationMs: 1, htmlBytes: 1, htmlReduced: false, requestedFieldCount: 1, suggestedFieldCount: 1, notFoundFieldCount: 0, invalidFieldCount: 0 },
    });
    expect(result.success).toBe(false);
  });
});

// ─── Error Response ─────────────────────────────────────────────────────────

describe('GenerateSelectorsErrorResponseSchema', () => {
  it('accepts a valid error response', () => {
    const result = GenerateSelectorsErrorResponseSchema.safeParse({
      requestId: 'req_err',
      error: {
        code: 'LLM_NOT_CONFIGURED',
        message: 'LLM not configured for selector generation.',
        retryable: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown error codes', () => {
    const result = GenerateSelectorsErrorResponseSchema.safeParse({
      requestId: 'req_err',
      error: {
        code: 'MYSTERY_ERROR',
        message: 'Something happened.',
        retryable: true,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ─── Limits ─────────────────────────────────────────────────────────────────

describe('SELECTOR_GENERATION_LIMITS', () => {
  it('defines sensible defaults', () => {
    expect(SELECTOR_GENERATION_LIMITS.maxRequestedFields).toBe(50);
    expect(SELECTOR_GENERATION_LIMITS.maxCustomFields).toBe(8);
    expect(SELECTOR_GENERATION_LIMITS.maxArtifactBytes).toBe(2_000_000);
    expect(SELECTOR_GENERATION_LIMITS.maxSelectorCharacters).toBe(500);
    expect(SELECTOR_GENERATION_LIMITS.maxReducedHtmlCharacters).toBe(350_000);
  });
});
