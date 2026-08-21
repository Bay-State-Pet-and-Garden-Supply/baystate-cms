// story: e08s01 — deriveBrandStrategies exact authority + diagnostics
import { describe, it, expect } from 'vitest';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';

describe('deriveBrandStrategies', () => {
  it('audit shows tier, domain, and distributor-only as profile_bypass_eligible', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Fromm', domain: 'frommfamily.com' }],
      advisoryProfiles: [
        { brand: 'Fromm', aliases: ['fromm family'], preferredDistributorIds: ['phillips', 'bradley'], sourcingPolicy: 'preferred_then_fallback' },
        { brand: "Butcher's", aliases: [], preferredDistributorIds: ['phillips'], sourcingPolicy: 'preferred_only' },
      ],
      sitemapByDomain: new Map([['frommfamily.com', { totalUrls: 142, lastRefreshAt: new Date().toISOString(), activeCount: 142 }]]),
      readinessByDomain: new Map([['frommfamily.com', 'active']]),
    });
    const fromm = strategies.find((s) => s.normalizedBrand === 'fromm');
    expect(fromm).toBeDefined();
    expect(fromm!.preferredDistributorIds).toEqual(['phillips', 'bradley']);
    expect(fromm!.officialDomains[0].domain).toBe('frommfamily.com');
    expect(fromm!.officialDomains[0].sitemap.totalUrls).toBe(142);
    expect(fromm!.extractorReadiness).toBe('active');
    const butchers = strategies.find((s) => s.normalizedBrand === "butcher's");
    expect(butchers).toBeDefined();
    expect(butchers!.officialDomains.length).toBe(0);
    expect(butchers!.extractorReadiness).toBe('profile_bypass_eligible');
  });

  it('ambiguous whitespace/punct not silently joined, surfaced as diagnostic', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'three dog', domain: 'threedog.com' }],
      advisoryProfiles: [{ brand: 'threedog', aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory' }],
    });
    // Exact keys are "three dog" and "threedog" — distinct
    expect(strategies.map((s) => s.normalizedBrand).sort()).toEqual(['three dog', 'threedog']);
    const threeDog = strategies.find((s) => s.normalizedBrand === 'three dog')!;
    const threedog = strategies.find((s) => s.normalizedBrand === 'threedog')!;
    // Both should have ambiguous diagnostic pointing to the other
    expect(threeDog.ambiguous.length).toBe(1);
    expect(threeDog.ambiguous[0].candidateBrand).toBe('threedog');
    expect(threedog.ambiguous.length).toBe(1);
    expect(threedog.ambiguous[0].candidateBrand).toBe('three dog');
  });

  it('unmatched surfaced, not hidden', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [],
      advisoryProfiles: [{ brand: 'Solo', aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory' }],
    });
    expect(strategies.length).toBe(1);
    expect(strategies[0].unmatched).toBe(true);
  });

  it('preserves original advisory spelling in brandKey, normalizedBrand is lower', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'FROMM', domain: 'frommfamily.com' }],
      advisoryProfiles: [{ brand: 'Fromm', aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory' }],
    });
    const s = strategies.find((x) => x.normalizedBrand === 'fromm')!;
    expect(s.brandKey).toBe('Fromm');
    expect(s.normalizedBrand).toBe('fromm');
  });

  it('fallbackTier is enabled minus preferred, not always empty', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Acana', domain: 'acana.com' }],
      advisoryProfiles: [{ brand: 'Acana', aliases: [], preferredDistributorIds: ['phillips'], sourcingPolicy: 'preferred_then_fallback' }],
      enabledDistributorIds: ['phillips', 'bradley', 'central_pet'],
    });
    const acana = strategies.find((s) => s.normalizedBrand === 'acana')!;
    expect(acana.fallbackTier).toEqual(['bradley', 'central_pet']);
  });

  it('distributor-only with no preferred stays not_configured, not eligible', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [],
      advisoryProfiles: [{ brand: 'Solo', aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory' }],
    });
    expect(strategies[0].extractorReadiness).toBe('not_configured');
  });
});
