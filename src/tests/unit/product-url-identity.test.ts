import { describe, it, expect } from 'vitest';
import { productUrlIdentityKey, parentProductKey, buildVariantDeepLink } from '../../onboarding/product-url-identity';

describe('productUrlIdentity', () => {
  it('retains ?variant= distinctness', () => {
    const a = productUrlIdentityKey('https://example.com/products/test?variant=4123456001');
    const b = productUrlIdentityKey('https://example.com/products/test?variant=4123456002');
    expect(a).not.toEqual(b);
  });
  it('removes tracking params but keeps variant', () => {
    const url = productUrlIdentityKey('https://example.com/products/test?variant=1&utm_source=google&gclid=abc');
    expect(url).toContain('variant=1');
    expect(url).not.toContain('utm_source');
    expect(url).not.toContain('gclid');
  });
  it('preserves unknown query params', () => {
    const url = productUrlIdentityKey('https://example.com/products/test?variant=1&custom=keep');
    expect(url).toContain('custom=keep');
  });
  it('parent key removes variant', () => {
    const parent = parentProductKey('https://example.com/products/test?variant=1&custom=keep');
    expect(parent).not.toContain('variant=');
    expect(parent).toContain('custom=keep');
  });
  it('buildVariantDeepLink replaces variant', () => {
    const out = buildVariantDeepLink('https://example.com/products/test?variant=1&foo=bar', { deepLink: 'https://example.com/products/test?variant=2' });
    expect(out).toContain('variant=2');
    expect(out).toContain('foo=bar');
    expect(out).not.toContain('variant=1');
  });
  it('preserves non-empty fragment', () => {
    const url = productUrlIdentityKey('https://example.com/products/test?variant=1#section');
    expect(url).toContain('#section');
  });
});
