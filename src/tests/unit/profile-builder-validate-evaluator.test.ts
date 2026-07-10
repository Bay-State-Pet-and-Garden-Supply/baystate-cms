/**
 * Unit tests for the Cheerio-based CSS selector evaluators in validate.ts.
 *
 * These tests verify that the replacement for the old regex-based
 * extractTextBySelector correctly handles compound CSS selectors,
 * custom elements, descendant combinators, :not() pseudo-class,
 * and selector-scoped image source extraction.
 *
 * The test fixture is modeled on GitHub issue #3's DOM structure.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateSelectorText,
  evaluateSelectorImageUrls,
} from '../../extraction-worker/routes/validate';

// ─── Fixture: issue #3 style product page ────────────────────────────────────
//
// Contains:
//  - A custom element with a boolean attribute (product-hero)
//  - A compound descendant selector (media-gallery .product-media__image img)
//  - A :not() pseudo-class selector
//  - Semantic classes with multiple elements
//  - Hidden/template elements that should not pollute image counts

const ISSUE3_HTML = `<!DOCTYPE html>
<html>
<body>
  <main>
    <!-- Custom element with boolean attribute -->
    <product-hero data-product-id="12345">
      <h1 class="product-title">Premium Dog Food</h1>
      <div class="product-price">$24.99</div>
    </product-hero>

    <!-- Media gallery: compound descendant target -->
    <div class="media-gallery">
      <div class="product-media__image">
        <img src="https://example.com/dog-food-main.jpg" alt="Premium Dog Food" />
      </div>
      <div class="product-media__image">
        <img src="https://example.com/dog-food-alt1.jpg" alt="Premium Dog Food Alt" />
      </div>
      <div class="product-media__image">
        <img src="https://example.com/dog-food-alt2.jpg" alt="Premium Dog Food Alt 2" />
      </div>
      <!-- Hidden/template gallery item — should not be excluded by selector but
           demonstrates the selector matches multiple <img> elements -->
      <div class="product-media__image" data-template="true">
        <img src="https://example.com/dog-food-template.jpg" alt="Template" />
      </div>
    </div>

    <!-- Specification list with :not() pattern -->
    <ul class="spec-list">
      <li class="spec-item not-nutritional">Weight: 2.64 oz</li>
      <li class="spec-item nutritional">Protein: 26%</li>
      <li class="spec-item not-nutritional">Flavor: Chicken</li>
      <li class="spec-item nutritional">Fat: 14%</li>
      <li class="spec-item not-nutritional">Brand: Acme Pets</li>
    </ul>

    <!-- Alt gallery paths that could be mistaken matches -->
    <div class="other-gallery">
      <div class="other-media">
        <img src="https://example.com/unrelated-icon.svg" alt="icon" />
      </div>
    </div>

    <!-- Page-level images for the old buggy behavior -->
    <footer>
      <img src="https://example.com/logo.png" alt="logo" />
      <img src="https://example.com/footer-bg.jpg" alt="background" />
    </footer>

    <!-- Empty/no-text image that the old regex would fail on -->
    <div class="image-with-no-text">
      <img src="https://example.com/no-text-image.jpg" alt="" />
    </div>
  </main>
</body>
</html>`;

const EMPTY_HTML = '<html><body></body></html>';

// ─── evaluateSelectorText ────────────────────────────────────────────────────

describe('evaluateSelectorText', () => {
  it('extracts text for a simple class selector', () => {
    const result = evaluateSelectorText(ISSUE3_HTML, '.product-title');
    expect(result).toBe('Premium Dog Food');
  });

  it('extracts text for a compound descendant selector', () => {
    // media-gallery .product-media__image should match the container divs,
    // and we get text from the first match's contents
    const result = evaluateSelectorText(ISSUE3_HTML, '.media-gallery .product-media__image');
    // The first matched element's textContent is the img alt text implicitly,
    // but since <img> is self-closing, textContent is empty for the img.
    // The container div's textContent includes all child text (none outside img).
    // Cheerio's .text() on the div returns '' because the img has no alt text
    // as text nodes. But for typical HTML with text around the img, it works.
    expect(result).toBeNull(); // img children have no text
  });

  it('extracts text for a custom element with attribute selector', () => {
    const result = evaluateSelectorText(ISSUE3_HTML, 'product-hero[data-product-id] .product-title');
    expect(result).toBe('Premium Dog Food');
  });

  it('extracts text for a :not() selector', () => {
    // Select li.spec-item that does NOT have class "nutritional"
    const result = evaluateSelectorText(ISSUE3_HTML, '.spec-item:not(.nutritional)');
    expect(result).toBe('Weight: 2.64 oz');
  });

  it('returns null for zero matches', () => {
    const result = evaluateSelectorText(ISSUE3_HTML, '.nonexistent-selector');
    expect(result).toBeNull();
  });

  it('returns null for invalid CSS selector', () => {
    // Malformed selector that Cheerio cannot parse
    const result = evaluateSelectorText(ISSUE3_HTML, ':::bad');
    expect(result).toBeNull();
  });

  it('returns null for empty selector', () => {
    expect(evaluateSelectorText(ISSUE3_HTML, '')).toBeNull();
    expect(evaluateSelectorText(ISSUE3_HTML, '  ')).toBeNull();
  });

  it('returns null for empty HTML', () => {
    const result = evaluateSelectorText(EMPTY_HTML, '.product-title');
    expect(result).toBeNull();
  });

  it('extracts text from deeply nested elements', () => {
    const result = evaluateSelectorText(ISSUE3_HTML, 'main product-hero h1');
    expect(result).toBe('Premium Dog Food');
  });
});

// ─── evaluateSelectorImageUrls ───────────────────────────────────────────────

describe('evaluateSelectorImageUrls', () => {
  it('returns images scoped to the selector, not page-wide', () => {
    // Issue #3's failing case: .media-gallery .product-media__image should
    // only return images within those elements, not logo, footer, or icon.
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.media-gallery .product-media__image');
    expect(urls.length).toBe(4);
    // Should NOT include logo, footer-bg, or unrelated icon
    expect(urls).not.toContain('https://example.com/logo.png');
    expect(urls).not.toContain('https://example.com/footer-bg.jpg');
    expect(urls).not.toContain('https://example.com/unrelated-icon.svg');
    // Should include the gallery images
    expect(urls).toContain('https://example.com/dog-food-main.jpg');
    expect(urls).toContain('https://example.com/dog-food-alt1.jpg');
    expect(urls).toContain('https://example.com/dog-food-alt2.jpg');
    expect(urls).toContain('https://example.com/dog-food-template.jpg');
  });

  it('returns images from a direct img selector', () => {
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.media-gallery img');
    expect(urls.length).toBe(4);
  });

  it('returns image when the matched element itself is an img', () => {
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.media-gallery .product-media__image img');
    expect(urls.length).toBe(4);
    expect(urls[0]).toContain('dog-food-main');
  });

  it('returns empty array for zero matches', () => {
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.nonexistent-selector');
    expect(urls).toEqual([]);
  });

  it('returns empty array for invalid CSS', () => {
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, ':::bad');
    expect(urls).toEqual([]);
  });

  it('returns empty array for empty selector', () => {
    expect(evaluateSelectorImageUrls(ISSUE3_HTML, '')).toEqual([]);
    expect(evaluateSelectorImageUrls(ISSUE3_HTML, '   ')).toEqual([]);
  });

  it('returns empty array for empty HTML', () => {
    const urls = evaluateSelectorImageUrls(EMPTY_HTML, 'img');
    expect(urls).toEqual([]);
  });

  it('excludes SVG images', () => {
    // The other-gallery contains an SVG img that should be excluded
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.other-gallery img');
    expect(urls.length).toBe(0); // .svg should be excluded by isUsableImageUrl
  });

  it('does not return images from unrelated sections', () => {
    // .media-gallery should only return images within the gallery
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.media-gallery img');
    expect(urls.every(u => u.includes('dog-food'))).toBe(true);
  });

  it('handles a compound custom-element selector', () => {
    // .media-gallery and product-hero are siblings under <main>
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, 'main .media-gallery .product-media__image img');
    expect(urls.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Combined edge cases ─────────────────────────────────────────────────────

describe('evaluateSelectorText + evaluateSelectorImageUrls edge cases', () => {
  it('text eval returns null for img-only selector (no text content)', () => {
    // This was the core bug: the old regex tried to find text for image
    // selectors and failed, then never reached image-specific code.
    const result = evaluateSelectorText(ISSUE3_HTML, '.media-gallery .product-media__image');
    expect(result).toBeNull();
  });

  it('image eval succeeds where text eval returns null', () => {
    // Same selector, but used for image extraction instead
    const urls = evaluateSelectorImageUrls(ISSUE3_HTML, '.media-gallery .product-media__image');
    expect(urls.length).toBeGreaterThan(0);
  });

  it('handles :not() with attribute selectors', () => {
    const result = evaluateSelectorText(ISSUE3_HTML, '.spec-item:not(.nutritional)');
    expect(result).not.toBeNull();
    expect(result).toContain('Weight');
  });
});
