// story: e07s02
import { describe, expect, it } from 'vitest';
import { clusterUrls, domFingerprint, jaccard, templateAwarePrefix } from '../../onboarding/template-clustering';

describe('templateAwarePrefix', () => {
  it('strips slug under /products', () => {
    expect(templateAwarePrefix('https://example.com/products/widget-blue')).toBe('/products');
    expect(templateAwarePrefix('https://example.com/products/')).toBe('/products');
    expect(templateAwarePrefix('https://example.com/products')).toBe('/products');
    expect(templateAwarePrefix('https://example.com/products/widget?query=1')).toBe('/products');
    expect(templateAwarePrefix('https://example.com/products/widget#hash')).toBe('/products');
  });

  it('handles /product and /p', () => {
    expect(templateAwarePrefix('https://example.com/product/123')).toBe('/product');
    expect(templateAwarePrefix('https://example.com/p/xyz')).toBe('/p');
  });

  it('keeps /collections/all/products distinct', () => {
    expect(templateAwarePrefix('https://example.com/collections/all/products/widget')).toBe('/collections/all/products');
    expect(templateAwarePrefix('https://example.com/collections/all/products')).toBe('/collections/all/products');
    expect(templateAwarePrefix('https://example.com/products/widget')).toBe('/products');
  });

  it('falls back to first segment for unknown', () => {
    expect(templateAwarePrefix('https://example.com/shop/item/1')).toBe('/shop');
    expect(templateAwarePrefix('https://example.com/')).toBe('/');
  });
});

describe('domFingerprint + jaccard', () => {
  it('extracts tag and tag.class shingles', () => {
    const fp = domFingerprint('<div class="product-title"><h1 class="pdp-title">x</h1></div>');
    expect(fp.has('div')).toBe(true);
    expect(fp.has('div.product-title')).toBe(true);
    expect(fp.has('h1.pdp-title')).toBe(true);
  });

  it('jaccard is 1 for identical and <0.8 for dissimilar', () => {
    const a = new Set(['div', 'h1']);
    const b = new Set(['div', 'h1']);
    expect(jaccard(a, b)).toBe(1);
    const c = new Set(['div']);
    expect(jaccard(a, c)).toBe(0.5);
  });
});

describe('clusterUrls', () => {
  it('groups by prefix and fingerprint, merges same prefix with high Jaccard', () => {
    const htmlSimilar = '<div class="product"><h1 class="title">a</h1></div>';
    const urls = [
      { url: 'https://example.com/products/a', html: htmlSimilar },
      { url: 'https://example.com/products/b', html: htmlSimilar },
      { url: 'https://example.com/products/c', html: htmlSimilar },
      { url: 'https://example.com/product/1', html: '<section><h1>other</h1></section>' },
      { url: 'https://example.com/product/2', html: '<section><h1>other</h1></section>' },
    ];
    const clusters = clusterUrls(urls);
    expect(clusters.length).toBe(2);
    const products = clusters.find((c) => c.prefix === '/products');
    expect(products?.count).toBe(3);
    const product = clusters.find((c) => c.prefix === '/product');
    expect(product?.count).toBe(2);
    expect(products?.suggestedUrl).toBe('https://example.com/products/a');
  });

  it('cross-prefix never merges even with identical DOM', () => {
    const html = '<div><h1>x</h1></div>';
    const clusters = clusterUrls([
      { url: 'https://example.com/products/a', html },
      { url: 'https://example.com/collections/all/products/a', html },
    ]);
    expect(clusters.length).toBe(2);
    expect(clusters.map((c) => c.prefix).sort()).toEqual(['/collections/all/products', '/products']);
  });

  it('same prefix but low Jaccard stays separate', () => {
    const clusters = clusterUrls([
      { url: 'https://example.com/products/a', html: '<div class="a"><h1>a</h1></div>' },
      { url: 'https://example.com/products/b', html: '<section class="b"><span class="c">b</span></section>' },
    ]);
    expect(clusters.length).toBe(2);
  });

  it('spam dedupe hint: identical length with same fingerprint still groups (spam filter is next layer)', () => {
    const spamHtml = '<div>Dating & Hook Up App Tips for Adults</div>'.repeat(10);
    const clusters = clusterUrls([
      { url: 'https://acmepet.com/products/a', html: spamHtml },
      { url: 'https://acmepet.com/products/b', html: spamHtml },
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].count).toBe(2);
  });
});
