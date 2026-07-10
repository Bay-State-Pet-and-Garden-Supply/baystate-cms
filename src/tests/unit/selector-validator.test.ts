import { describe, it, expect } from 'vitest';
import { validateAndRankSelectors } from '../../server/services/profile-builder/selectorValidator';

// ─── Helpers ────────────────────────────────────────────────────────────────────

const SIMPLE_PRODUCT_HTML = `<!DOCTYPE html>
<html>
<body>
  <main>
    <h1 class="product-title" itemprop="name">Premium Dog Food</h1>
    <span class="brand-name" itemprop="brand">Acme Pets</span>
    <div class="description" itemprop="description">A nutritious blend for active dogs.</div>
    <div class="gallery">
      <img src="https://example.com/img1.jpg" alt="Product image 1" />
      <img src="https://example.com/img2.jpg" alt="Product image 2" />
    </div>
    <div class="ingredients">
      <ul class="ingredient-list">
        <li>Chicken</li>
        <li>Rice</li>
      </ul>
    </div>
    <div class="product-weight">2.64 oz</div>
    <div hidden>Hidden promo</div>
  </main>
  <footer>Copyright 2026</footer>
</body>
</html>`;

const EMPTY_HTML = '<html><body></body></html>';

function makeFieldResult(overrides: Record<string, unknown> = {}) {
  return {
    notFound: false,
    candidates: [{ selector: 'h1.product-title', evidence: 'Single H1 contains product name.' }],
    ...overrides,
  };
}

function runValidation(
  html: string,
  fieldResults: Record<string, any>,
  fieldDefs?: Array<{ key: string; valueType: string; multiple: boolean }>,
) {
  const defs = fieldDefs ?? [
    { key: 'titleSelector', valueType: 'text', multiple: false },
    { key: 'brandSelector', valueType: 'text', multiple: false },
    { key: 'imagesSelector', valueType: 'image', multiple: true },
    { key: 'ingredientListSelector', valueType: 'text', multiple: false },
  ];
  return validateAndRankSelectors(html, fieldResults, defs);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validateAndRankSelectors', () => {
  it('validates a good unique selector', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult(),
    });

    expect(result.titleSelector.status).toBe('suggested');
    expect(result.titleSelector.selector).toBe('h1.product-title');
    expect(result.titleSelector.quality).toBe('high');
    expect(result.titleSelector.validation.matchedCount).toBe(1);
    expect(result.titleSelector.validation.unique).toBe(true);
    expect(result.titleSelector.validation.syntaxValid).toBe(true);
    expect(result.titleSelector.warnings).toHaveLength(0);
  });

  it('returns not_found when no candidates', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      brandSelector: { notFound: true, candidates: [] },
    });

    expect(result.brandSelector.status).toBe('not_found');
    expect(result.brandSelector.quality).toBe('unusable');
    expect(result.brandSelector.validation.matchedCount).toBe(0);
  });

  it('rejects XPath selectors', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: '//h1', evidence: 'XPath' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
    expect(result.titleSelector.warnings.some((w) => w.code === 'INVALID_CSS')).toBe(true);
  });

  it('rejects JavaScript expressions', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: 'document.querySelector("h1")', evidence: 'JS' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
  });

  it('rejects selectors exceeding max length', () => {
    const longSelector = 'a'.repeat(501);
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: longSelector, evidence: 'too long' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
  });

  it('handles zero matches gracefully', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: '.nonexistent-class', evidence: 'no match' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
    expect(result.titleSelector.warnings.some((w) => w.code === 'ZERO_MATCHES')).toBe(true);
  });

  it('warns on multiple matches for single-value field', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      brandSelector: makeFieldResult({ candidates: [{ selector: 'div', evidence: 'multiple divs' }] }),
    });

    expect(result.brandSelector.status).toBe('suggested');
    expect(result.brandSelector.quality).toBe('low');
    expect(result.brandSelector.warnings.some((w) => w.code === 'TOO_MANY_MATCHES')).toBe(true);
  });

  it('hard-rejects positional pseudo-classes', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: 'h1:nth-child(1)', evidence: 'first h1' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.warnings.some((w) => w.code === 'POSITIONAL_SELECTOR')).toBe(true);
    expect(result.titleSelector.quality).toBe('unusable');
  });

  it('warns on bare element selectors', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      brandSelector: makeFieldResult({ candidates: [{ selector: 'span', evidence: 'span element' }] }),
    });

    expect(result.brandSelector.status).toBe('suggested');
    expect(result.brandSelector.warnings.some((w) => w.code === 'TOO_GENERIC')).toBe(true);
  });

  it('handles image selectors with previews', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      imagesSelector: makeFieldResult({
        candidates: [{ selector: 'img', evidence: 'Image elements' }],
      }),
    }, [
      { key: 'imagesSelector', valueType: 'image', multiple: true },
    ]);

    expect(result.imagesSelector.status).toBe('suggested');
    expect(result.imagesSelector.validation.matchedCount).toBe(2);
    expect(result.imagesSelector.preview?.imageUrls).toBeDefined();
    expect(result.imagesSelector.preview!.imageUrls!.length).toBe(2);
    expect(result.imagesSelector.quality).toBe('medium');
  });

  it('starts over hidden elements', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: '[hidden]', evidence: 'hidden' }] }),
    });

    expect(result.titleSelector.status).toBe('suggested');
    expect(result.titleSelector.validation.visibleMatchedCount).toBe(null);
    expect(result.titleSelector.warnings.some((w) => w.code === 'HIDDEN_MATCH')).toBe(true);
  });

  it('prefers itemprop selectors', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({
        candidates: [
          { selector: 'footer', evidence: 'footer' },
          { selector: '[itemprop="name"]', evidence: 'itemprop' },
        ],
      }),
    });

    // Should pick the itemprop candidate
    expect(result.titleSelector.selector).toBe('[itemprop="name"]');
    expect(result.titleSelector.quality).toBe('high');
  });

  it('handles empty HTML gracefully', () => {
    const result = runValidation(EMPTY_HTML, {
      titleSelector: makeFieldResult(),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
  });

  it('warns on dynamic-looking ID', () => {
    const htmlWithGeneratedId = `<html><body><h1 id="a1b2c3d4e5f6">Title</h1></body></html>`;
    const result = runValidation(htmlWithGeneratedId, {
      titleSelector: makeFieldResult({ candidates: [{ selector: '#a1b2c3d4e5f6', evidence: 'id selector' }] }),
    });

    expect(result.titleSelector.warnings.some((w) => w.code === 'DYNAMIC_ID')).toBe(true);
  });

  it('ranks higher-quality candidate first', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({
        candidates: [
          { selector: 'footer', evidence: 'footer' },
          { selector: 'h1.product-title', evidence: 'best' },
        ],
      }),
    });

    expect(result.titleSelector.selector).toBe('h1.product-title');
  });

  it('rejects unsupported pseudo-classes', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      titleSelector: makeFieldResult({ candidates: [{ selector: ':has(h1)', evidence: 'has' }] }),
    });

    expect(result.titleSelector.status).toBe('invalid');
    expect(result.titleSelector.quality).toBe('unusable');
  });

  it('extracts text preview for text fields', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      brandSelector: makeFieldResult({ candidates: [{ selector: '.brand-name', evidence: 'Brand' }] }),
    });

    expect(result.brandSelector.preview?.text).toBe('Acme Pets');
  });

  it('handles missing field definition gracefully', () => {
    const result = runValidation(SIMPLE_PRODUCT_HTML, {
      unknownField: makeFieldResult({ candidates: [{ selector: 'h1', evidence: 'fallback' }] }),
    }, [{ key: 'titleSelector', valueType: 'text', multiple: false }]);

    // unknownField not in fieldDefinitions, but still processed with defaults
    expect(result.unknownField.status).toBe('suggested');
    expect(result.titleSelector).toBeUndefined();
  });
});
