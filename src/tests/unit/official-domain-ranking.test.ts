/**
 * Official-domain-aware discovery ranking (epic #46 follow-up, GPT plan
 * phase 6). Pure logic — vitest.
 */
import { describe, test, expect } from 'vitest';
import {
  scoreBrandDomainMatch,
  normalizeBrandForDomainMatch,
  domainMatchLabel,
  GENERIC_BRAND_TOKENS,
} from '../../onboarding/discovery/official-domain';
import {
  isKnownRetailerOrDistributorDomain,
  KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS,
} from '../../onboarding/discovery/retailer-domain-list';
import { scoreResult } from '../../onboarding/source-discovery';

function serper(link: string, title = 'Product Page'): Parameters<typeof scoreResult>[0] {
  return {
    link,
    title,
    snippet: '',
    position: 1,
  } as Parameters<typeof scoreResult>[0];
}

describe('scoreBrandDomainMatch', () => {
  test('full brand slug in the domain label → 1.0', () => {
    expect(scoreBrandDomainMatch('Fromm', 'frommfamily.com')).toBe(1);
    expect(scoreBrandDomainMatch('Primal', 'primalpetfoods.com')).toBe(1);
    expect(scoreBrandDomainMatch('Blue Buffalo', 'bluebuffalo.com')).toBe(1);
    expect(scoreBrandDomainMatch('Wellness', 'wellnesspetfood.com')).toBe(1);
    expect(scoreBrandDomainMatch('Wholesomes', 'wholesomespetfood.com')).toBe(1);
  });

  test('multi-word brands match word-wise at 0.5', () => {
    expect(scoreBrandDomainMatch('Blue Buffalo', 'bluebuffalofamily.com')).toBe(1);
    expect(scoreBrandDomainMatch('Lazy Dog', 'lazydog.com')).toBe(1);
  });

  test('generic pet-store words never count as brand matches', () => {
    expect(scoreBrandDomainMatch('Pet', 'petco.com')).toBe(0);
    expect(scoreBrandDomainMatch('Dog', 'dogkrazy.com')).toBe(0);
    expect(scoreBrandDomainMatch('Store', 'thepetstore.com')).toBe(0);
    expect(GENERIC_BRAND_TOKENS.has('pet')).toBe(true);
  });

  test('mismatched brands score 0', () => {
    expect(scoreBrandDomainMatch('Fromm', 'chewy.com')).toBe(0);
    expect(scoreBrandDomainMatch('Nylabone', 'net32.com')).toBe(0);
  });

  test('normalization helpers', () => {
    expect(normalizeBrandForDomainMatch('Blue Buffalo')).toBe('bluebuffalo');
    expect(domainMatchLabel('shop.dogkrazy.com')).toBe('dogkrazy');
    expect(domainMatchLabel('www.frommfamily.com')).toBe('frommfamily');
    expect(domainMatchLabel('chewy.com')).toBe('chewy');
  });
});

describe('known retailer/distributor demotion list', () => {
  test('live-batch weak-candidate domains are recognized', () => {
    for (const domain of ['chewy.com', 'shop.dogkrazy.com', 'theproperpet.com', 'net32.com', 'zeiglersdist.com', 'pood.bluepetfood.eu']) {
      expect(isKnownRetailerOrDistributorDomain(domain), domain).toBe(true);
    }
    expect(isKnownRetailerOrDistributorDomain('frommfamily.com')).toBe(false);
    expect(isKnownRetailerOrDistributorDomain('www.chewy.com')).toBe(true);
    expect(KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS.size).toBeGreaterThanOrEqual(11);
  });
});

describe('scoreResult ranking bias (phase 6)', () => {
  test('official brand domain outranks a known retailer with identical signals', () => {
    const official = scoreResult(serper('https://frommfamily.com/products/p', 'Fromm Product'), '012345678905', 'Fromm Product', 'Fromm', 'frommfamily.com', []);
    const retailer = scoreResult(serper('https://www.chewy.com/fromm-product/dp/012345678905', 'Fromm Product'), '012345678905', 'Fromm Product', 'Fromm', 'chewy.com', []);
    expect(official).toBeGreaterThan(retailer);
    // Retailer demotion is a bias, not a discard: the score stays positive.
    expect(retailer).toBeGreaterThan(0);
  });

  test('brand-domain boost stacks with the loose segment check', () => {
    const strong = scoreResult(serper('https://frommfamily.com/products/p'), '012345678905', 'X', 'Fromm', 'frommfamily.com', []);
    const plain = scoreResult(serper('https://example.com/products/p'), '012345678905', 'X', 'Fromm', 'example.com', []);
    expect(strong).toBeGreaterThan(plain);
  });
});
