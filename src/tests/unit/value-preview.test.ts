// story: e07s03 — click→ranked recipes + value previews
import { describe, it, expect } from 'vitest';
import { rankCandidates, evaluateValuesInstant } from '../../client/components/profile-builder/hooks/useProfileBuilderController';

describe('rankCandidates', () => {
  it('ranks css-stable > shopify > semantic > generic (jsonld no longer a ranked candidate source)', () => {
    const capture = {
      dom: '<div data-testid="product"><h1 class="product-title">Hello</h1><script type="application/ld+json">{\"@type\":\"Product\",\"name\":\"Hello\"}</script></div><div id="shopify-section-1"></div>',
      html: '<div data-testid="product"><h1 class="product-title">Hello</h1><script type="application/ld+json">{\"@type\":\"Product\"}</script><div>cdn.shopify</div></div>',
    };
    const ranked = rankCandidates(capture, 'title');
    const sources = ranked.map(r => r.source);
    // Profile-builder wave contract: css-stable wins when a stable attribute is
    // present; jsonld paths are evaluated at value-extraction time, not ranked.
    expect(sources[0]).toBe('css-stable');
    expect(sources).not.toContain('jsonld');
    expect(sources).toContain('shopify');
    expect(sources).toContain('generic');
    // scores descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].score).toBeLessThanOrEqual(ranked[i - 1].score);
    }
    // stability high for first, low for last
    expect(ranked[0].stability).toBe('high');
    expect(ranked[ranked.length - 1].stability).toBe('low');
    expect(ranked[ranked.length - 1].source).toBe('generic');
  });

  it('produces only generic when no hints', () => {
    const capture = { dom: '<h1>Plain</h1>', html: '<h1>Plain</h1>' };
    const ranked = rankCandidates(capture, 'title');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].source).toBe('generic');
    expect(ranked[0].selector).toBe('h1');
  });

  it('is deterministic', () => {
    const cap = { dom: '<div data-testid=\"x\">', html: '<div data-testid=\"x\"> shopify' };
    const a = rankCandidates(cap, 'title');
    const b = rankCandidates(cap, 'title');
    expect(a).toEqual(b);
  });
});

describe('evaluateValuesInstant', () => {
  it('extracts text for matching selector', () => {
    const capture = { html: '<h1 class="product-title">  Cool Product  </h1>' };
    expect(evaluateValuesInstant(capture, 'h1.product-title')).toBe('Cool Product');
  });

  it('returns null for no match (no match cell)', () => {
    const capture = { html: '<div>No title</div>' };
    expect(evaluateValuesInstant(capture, 'h1.product-title')).toBeNull();
  });

  it('handles generic h1', () => {
    const capture = { html: '<h1>Generic Title</h1>' };
    expect(evaluateValuesInstant(capture, 'h1')).toBe('Generic Title');
  });
});
