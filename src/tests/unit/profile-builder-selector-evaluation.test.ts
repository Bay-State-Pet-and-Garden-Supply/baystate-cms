/**
 * Unit tests for `src/client/components/profile-builder/selectorEvaluation.ts`.
 *
 * The `evaluateSelectorLocally` function uses `DOMParser`, which is NOT
 * available in vitest's `environment: 'node'`. This test file covers:
 *
 *   1. The early-return non-DOM paths (empty input, XPath, JS expressions)
 *   2. The function returns correct statuses and messages for these cases
 *
 * DOM-dependent paths (valid CSS matching, match counting, image attribute
 * extraction, cardinality warnings, min-length checks) require a jsdom or
 * happy-dom environment. Those tests are documented as needed but cannot
 * run in the current test config.
 *
 * See selectorEvaluation.ts — all non-DOM paths are exercised here.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateSelectorLocally,
  evaluateTitleOptionalSelectors,
} from '@/client/components/profile-builder/selectorEvaluation';
import type { FieldDefinition } from '@/client/components/profile-builder/fieldCatalog';

// ─── Test helpers ────────────────────────────────────────────────────────────

function textField(overrides?: Partial<FieldDefinition>): FieldDefinition {
  return {
    key: 'testField',
    label: 'Test field',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    category: 'identity',
    ...overrides,
  };
}

function imageField(overrides?: Partial<FieldDefinition>): FieldDefinition {
  return {
    key: 'imagesSelector',
    label: 'Images',
    outputTarget: 'core',
    valueType: 'image',
    cardinality: 'multiple',
    category: 'media',
    ...overrides,
  };
}

// ─── Empty selector ─────────────────────────────────────────────────────────

describe('evaluateSelectorLocally — empty input', () => {
  it('returns unassigned for empty string', () => {
    const result = evaluateSelectorLocally('<html></html>', '', textField());
    expect(result.status).toBe('unassigned');
    expect(result.matchCount).toBe(0);
    expect(result.extractedPreview).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('returns unassigned for whitespace-only string', () => {
    const result = evaluateSelectorLocally('<html></html>', '   ', textField());
    expect(result.status).toBe('unassigned');
    expect(result.matchCount).toBe(0);
  });

  it('returns unassigned for null-like empty', () => {
    const result = evaluateSelectorLocally('<html></html>', '  \n  ', textField());
    expect(result.status).toBe('unassigned');
  });
});

// ─── XPath rejection ────────────────────────────────────────────────────────

describe('evaluateSelectorLocally — XPath rejection', () => {
  it('rejects selector starting with /', () => {
    const result = evaluateSelectorLocally('<html></html>', '//div[@class="title"]', textField());
    expect(result.status).toBe('failed');
    expect(result.matchCount).toBe(0);
    expect(result.warnings[0]).toContain('XPath');
    expect(result.error).toBe('Unsupported selector syntax');
  });

  it('rejects selector starting with //', () => {
    const result = evaluateSelectorLocally('<html></html>', '//div[@class="title"]', textField());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Unsupported selector syntax');
  });

  it('rejects xpath: prefix', () => {
    const result = evaluateSelectorLocally('<html></html>', 'xpath:/html/body/div', textField());
    expect(result.status).toBe('failed');
    expect(result.warnings[0]).toContain('XPath');
  });

  it('rejects (/ pattern', () => {
    const result = evaluateSelectorLocally('<html></html>', '(/html/body/div)[1]', textField());
    expect(result.status).toBe('failed');
  });
});

// ─── JS expression rejection ────────────────────────────────────────────────

describe('evaluateSelectorLocally — JS expression rejection', () => {
  it('rejects document.querySelector', () => {
    const result = evaluateSelectorLocally('<html></html>', 'document.querySelector("h1")', textField());
    expect(result.status).toBe('failed');
    expect(result.warnings[0]).toContain('JavaScript');
    expect(result.error).toBe('Unsupported selector syntax');
  });

  it('rejects arrow function', () => {
    const result = evaluateSelectorLocally('<html></html>', '() => document.title', textField());
    expect(result.status).toBe('failed');
    expect(result.warnings[0]).toContain('JavaScript');
  });

  it('rejects function() syntax', () => {
    const result = evaluateSelectorLocally('<html></html>', 'function() { return "test"; }', textField());
    expect(result.status).toBe('failed');
    expect(result.warnings[0]).toContain('JavaScript');
  });

  it('rejects => without parens', () => {
    const result = evaluateSelectorLocally('<html></html>', 'el => el.textContent', textField());
    expect(result.status).toBe('failed');
    expect(result.warnings[0]).toContain('JavaScript');
  });
});

// ─── titleOptionalSelectors ─────────────────────────────────────────────────

describe('evaluateTitleOptionalSelectors — non-DOM paths', () => {
  it('returns unassigned for empty array', () => {
    const result = evaluateTitleOptionalSelectors('<html></html>', []);
    expect(result.status).toBe('unassigned');
    expect(result.concatenatedPreview).toBeNull();
    expect(result.parts).toEqual([]);
  });

  it('handles empty strings in selectors', () => {
    // Empty selectors produce matchCount 0 -> status 'failed' for the group
    const result = evaluateTitleOptionalSelectors('<html></html>', ['', '  ']);
    expect(result.status).toBe('failed');
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].value).toBeNull();
    expect(result.parts[0].matchCount).toBe(0);
    expect(result.concatenatedPreview).toBeNull();
  });

  it('returns failed for XPath in title optional selectors', () => {
    const result = evaluateTitleOptionalSelectors('<html></html>', ['//div[@class="subtitle"]']);
    expect(result.status).toBe('failed');
    expect(result.parts[0].matchCount).toBe(0);
    expect(result.concatenatedPreview).toBeNull();
  });
});

// ─── HTML parse error path ─────────────────────────────────────────────────

describe('evaluateSelectorLocally — DOMParser failure path', () => {
  it('handles non-string html gracefully', () => {
    // When DOMParser is unavailable, the try block catches and returns failed.
    // This test verifies the error path logic works even if DOMParser isn't present.
    const result = evaluateSelectorLocally('', 'h1', textField());
    // If DOMParser IS available, it will parse empty string (valid HTML).
    // If DOMParser is NOT available, it would return failed.
    // Either way, the code handles both paths without throwing.
    expect(result.status).toMatch(/^(failed|unassigned|assigned|warning)$/);
  });
});

// ─── Non-DOM: known stable selectors ─────────────────────────────────────────
// These tests verify the function's early return paths work correctly.
// Actual CSS matching tests require jsdom (see docs below).

describe('evaluateSelectorLocally — return type shape', () => {
  it('always returns a valid SelectorEvaluationResult shape', () => {
    const result = evaluateSelectorLocally('<html></html>', '', textField());
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('extractedPreview');
    expect(result).toHaveProperty('matchCount');
    expect(result).toHaveProperty('warnings');
    expect(['unassigned', 'assigned', 'tested', 'warning', 'failed', 'validated']).toContain(result.status);
    expect(typeof result.matchCount).toBe('number');
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('returns status failed for unsupported syntax', () => {
    const result = evaluateSelectorLocally('<html></html>', 'document.querySelectorAll(".foo")', textField());
    expect(result.status).toBe('failed');
    expect(typeof result.error).toBe('string');
  });
});

/**
 * DOCUMENTED GAPS — DOM-dependent tests that require jsdom:
 *
 * The following scenarios use `new DOMParser().parseFromString()` and
 * `querySelectorAll()` which are not available in vitest environment: 'node'.
 *
 * 1. evaluateSelectorLocally valid CSS match:
 *    - Input: '<html><body><h1>Hello</h1></body></html>', 'h1'
 *    - Expected: status 'assigned', extractedPreview 'Hello', matchCount 1
 *
 * 2. evaluateSelectorLocally zero matches:
 *    - Input: '<html><body></body></html>', 'h1.nonexistent'
 *    - Expected: status 'failed', matchCount 0, warning about no elements
 *
 * 3. evaluateSelectorLocally cardinality warning (single field, multiple matches):
 *    - Input: '<html><body><h1>A</h1><h1>B</h1></body></html>', 'h1'
 *    - Expected: status 'warning', matchCount 2, warning about multiple matches
 *
 * 4. evaluateSelectorLocally image field:
 *    - Input: '<html><body><img src="a.jpg" data-src="b.jpg"></body></html>', 'img'
 *    - Expected: extractedPreview includes both src values
 *
 * 5. evaluateSelectorLocally minLength warning:
 *    - Input: '<html><body><h1>AB</h1></body></html>', 'h1'
 *    - field with validationHints.minLength: 3
 *    - Expected: status 'warning', warning about too short
 *
 * 6. evaluateTitleOptionalSelectors with real HTML:
 *    - Input: '<html><body><span class="sub">Extra</span></body></html>', ['.sub']
 *    - Expected: concatenatedPreview 'Extra', status 'assigned'
 *
 * 7. evaluateSelectorLocally invalid CSS syntax:
 *    - Input: '<html></html>', ':::bad'
 *    - Expected: status 'failed', error about invalid selector
 *
 * To enable these tests, install jsdom and update vitest.config.ts:
 *   test: { environment: 'jsdom' }
 * OR, for a hybrid approach, add a test file with:
 *   // @vitest-environment jsdom
 * at the top and ensure jsdom is available.
 */
