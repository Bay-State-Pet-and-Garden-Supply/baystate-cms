/**
 * Unit tests for the shared CSS selector utility module.
 *
 * These tests verify the extraction of buildStableSelector and
 * related utilities from profile-generator.ts has preserved
 * the exact same behavior.
 */

import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import {
  buildStableSelector,
  isLikelyGeneratedId,
  isSupportedSelectorSyntax,
  classSet,
  attrSelector,
  snippetOf,
} from '../../shared/selector-utils';

// ─── isLikelyGeneratedId ────────────────────────────────────────────────────

describe('isLikelyGeneratedId', () => {
  it('returns true for React/Vue/Svelte underscores', () => {
    expect(isLikelyGeneratedId('_reactKey123')).toBe(true);
    expect(isLikelyGeneratedId('_')).toBe(true);
  });

  it('returns true for CSS module double underscores', () => {
    expect(isLikelyGeneratedId('header__title__abc')).toBe(true);
  });

  it('returns true for Tailwind arbitrary values with --', () => {
    expect(isLikelyGeneratedId('foo--bar')).toBe(true);
  });

  it('returns true for hex-only hashes (6+ chars)', () => {
    expect(isLikelyGeneratedId('a1b2c3d4')).toBe(true);
    expect(isLikelyGeneratedId('123abc')).toBe(true);
  });

  it('returns true for pure numeric IDs', () => {
    expect(isLikelyGeneratedId('123456')).toBe(true);
  });

  it('returns true for Shopify section IDs', () => {
    expect(isLikelyGeneratedId('section-1')).toBe(true);
    expect(isLikelyGeneratedId('section-12345')).toBe(true);
  });

  it('returns true for empty strings and short IDs', () => {
    expect(isLikelyGeneratedId('')).toBe(true);
    expect(isLikelyGeneratedId('a')).toBe(true);
  });

  it('returns false for semantic IDs', () => {
    expect(isLikelyGeneratedId('product-title')).toBe(false);
    expect(isLikelyGeneratedId('main')).toBe(false);
    expect(isLikelyGeneratedId('content')).toBe(false);
    expect(isLikelyGeneratedId('price-123')).toBe(false);
  });
});

// ─── classSet ───────────────────────────────────────────────────────────────

describe('classSet', () => {
  it('returns an empty set for undefined input', () => {
    const result = classSet(undefined);
    expect(result.size).toBe(0);
  });

  it('splits space-separated classes and lowercases them', () => {
    const result = classSet('Product-Title Main-Heading');
    expect(result.has('product-title')).toBe(true);
    expect(result.has('main-heading')).toBe(true);
    expect(result.has('Product-Title')).toBe(false);
    expect(result.size).toBe(2);
  });

  it('handles empty strings', () => {
    expect(classSet('').size).toBe(0);
  });

  it('handles multiple consecutive spaces', () => {
    const result = classSet('foo   bar');
    expect(result.size).toBe(2);
    expect(result.has('foo')).toBe(true);
    expect(result.has('bar')).toBe(true);
  });
});

// ─── attrSelector ───────────────────────────────────────────────────────────

describe('attrSelector', () => {
  it('builds a simple attribute selector', () => {
    expect(attrSelector('data-testid', 'product-title')).toBe('[data-testid="product-title"]');
  });

  it('escapes double quotes in values', () => {
    expect(attrSelector('data-value', 'hello"world')).toBe('[data-value="hello\\"world"]');
  });
});

// ─── isSupportedSelectorSyntax ──────────────────────────────────────────────

describe('isSupportedSelectorSyntax', () => {
  it('accepts valid CSS selectors', () => {
    expect(isSupportedSelectorSyntax('h1')).toBe(true);
    expect(isSupportedSelectorSyntax('.product-title')).toBe(true);
    expect(isSupportedSelectorSyntax('[itemprop="name"]')).toBe(true);
    expect(isSupportedSelectorSyntax('div:nth-of-type(2)')).toBe(true);
    expect(isSupportedSelectorSyntax('div.price span')).toBe(true);
    expect(isSupportedSelectorSyntax('#main .product-title')).toBe(true);
  });

  it('rejects XPath selectors', () => {
    expect(isSupportedSelectorSyntax('//div[@class="price"]')).toBe(false);
    expect(isSupportedSelectorSyntax('(//div)[1]')).toBe(false);
    expect(isSupportedSelectorSyntax('xpath://div')).toBe(false);
  });

  it('rejects JS execution selectors', () => {
    expect(isSupportedSelectorSyntax('() => document.title')).toBe(false);
    expect(isSupportedSelectorSyntax('function() { return 1; }')).toBe(false);
  });

  it('rejects browser-only pseudo-selectors Cheerio cannot evaluate', () => {
    expect(isSupportedSelectorSyntax('div:has(span)')).toBe(false);
    expect(isSupportedSelectorSyntax('div:is(.foo, .bar)')).toBe(false);
    expect(isSupportedSelectorSyntax('div:where(.foo)')).toBe(false);
    expect(isSupportedSelectorSyntax('a:focus')).toBe(false);
    expect(isSupportedSelectorSyntax('a:hover')).toBe(false);
  });

  it('rejects empty or whitespace-only strings', () => {
    expect(isSupportedSelectorSyntax('')).toBe(false);
    expect(isSupportedSelectorSyntax('   ')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isSupportedSelectorSyntax(null as unknown as string)).toBe(false);
    expect(isSupportedSelectorSyntax(undefined as unknown as string)).toBe(false);
  });
});

// ─── snippetOf ──────────────────────────────────────────────────────────────

describe('snippetOf', () => {
  it('extracts and trims text from an element', () => {
    const $ = cheerio.load('<div class="title">  Hello World  </div>');
    const el = $('.title').get(0)!;
    expect(snippetOf($, el)).toBe('Hello World');
  });

  it('caps text at the default max length', () => {
    const $ = cheerio.load(`<div class="t">${'A'.repeat(150)}</div>`);
    const el = $('.t').get(0)!;
    const result = snippetOf($, el);
    expect(result.length).toBe(121); // 120 + '…'
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles elements with no text', () => {
    const $ = cheerio.load('<div class="empty"></div>');
    const el = $('.empty').get(0)!;
    expect(snippetOf($, el)).toBe('');
  });
});

// ─── Helper for tests ───────────────────────────────────────────────────────

/** Get the first element from a Cheerio selection, asserting it's a tag element. */
function el($: cheerio.CheerioAPI, selector: string): Element {
  const node = $(selector).get(0);
  if (!node || node.type !== 'tag') throw new Error(`Expected element for selector: ${selector}`);
  return node;
}

// ─── buildStableSelector ────────────────────────────────────────────────────

describe('buildStableSelector', () => {
  it('returns a high-stability #id selector for a unique, semantic ID', () => {
    const html = '<div id="product-title"><h1>My Product</h1></div><div id="footer">...</div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '#product-title'));
    expect(result.selector).toBe('#product-title');
    expect(result.stability).toBe('high');
  });

  it('returns a high-stability data-testid selector when no semantic id', () => {
    const html = '<div data-testid="product-title"><h1>My Product</h1></div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '[data-testid="product-title"]'));
    expect(result.selector).toBe('div[data-testid="product-title"]');
    expect(result.stability).toBe('high');
  });

  it('returns a high-stability itemprop selector when present', () => {
    const html = '<span itemprop="name">Product Name</span>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '[itemprop="name"]'));
    expect(result.selector).toBe('span[itemprop="name"]');
    expect(result.stability).toBe('high');
  });

  it('returns medium stability for semantic class names', () => {
    const html = '<h1 class="product-title">Product</h1><h1 class="other">Other</h1>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '.product-title'));
    expect(result.selector).toBe('h1.product-title');
    expect(result.stability).toBe('medium');
  });

  it('returns medium stability for ancestor+child with semantic parent id', () => {
    const html = '<div id="product-content"><h2>Title</h2></div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '#product-content h2'));
    expect(result.selector).toBe('#product-content h2');
    expect(result.stability).toBe('medium');
  });

  it('returns low stability nth-of-type as last resort', () => {
    const html = '<div><span>1</span><span>2</span><span class="target">3</span></div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '.target'));
    expect(result.stability).toBe('low');
    expect(result.selector).toBe('span:nth-of-type(3)');
  });

  it('skips auto-generated IDs, falling through to lower tiers', () => {
    const html = '<div id="__react-key-1"><h1>Title</h1></div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '#__react-key-1'));
    // Should not return the generated ID — should fall through to lower tiers.
    expect(result.selector).not.toBe('#__react-key-1');
    // With no semantic class or parent context, falls to nth-of-type (low).
    expect(result.stability).toBe('low');
  });

  it('handles data-cy and data-qa attributes', () => {
    const html = '<button data-cy="add-to-cart">Add</button>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, '[data-cy="add-to-cart"]'));
    expect(result.selector).toBe('button[data-cy="add-to-cart"]');
    expect(result.stability).toBe('high');
  });

  it('falls back when no match at all', () => {
    const html = '<div><section><article><p>Text</p></article></section></div>';
    const $ = cheerio.load(html);
    const result = buildStableSelector($, el($, 'p'));
    expect(result.stability).toBe('low');
    expect(result.selector).toMatch(/p:nth-of-type/);
  });
});
