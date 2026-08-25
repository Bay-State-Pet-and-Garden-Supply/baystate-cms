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

describe('scoreBrandDomainMatch', () => {
  test('full brand slug in the domain label → 1.0', () => {
    expect(scoreBrandDomainMatch('Fromm', 'frommfamily.com')).toBe(1);
    expect(scoreBrandDomainMatch('Primal', 'primalpetfoods.com')).toBe(1);
    expect(scoreBrandDomainMatch('Blue Buffalo', 'bluebuffalo.com')).toBe(1);
    expect(scoreBrandDomainMatch('Wellness', 'wellnesspetfood.com')).toBe(1);
    expect(scoreBrandDomainMatch('Wholesomes', 'wholesomespetfood.com')).toBe(1);
  });

  test('full brand slug matches at 1.0 (multi-word slugs included)', () => {
    expect(scoreBrandDomainMatch('Blue Buffalo', 'bluebuffalofamily.com')).toBe(1);
    expect(scoreBrandDomainMatch('Lazy Dog', 'lazydog.com')).toBe(1);
  });

  test('word-wise-only matches score 0.5 (order-insensitive, no full slug)', () => {
    expect(scoreBrandDomainMatch('Blue Buffalo', 'buffalobluepet.com')).toBe(0.5);
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
