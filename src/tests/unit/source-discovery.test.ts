import { describe, it, expect } from 'vitest';
import { scoreResult } from '../../onboarding/source-discovery';
import { isKnownRetailerOrDistributorDomain } from '../../onboarding/discovery/retailer-domain-list';

describe('Source Discovery URL Scoring', () => {
  const upc = '850067859598';
  const name = 'WOOF POOMERGENCY LAVENDER';
  const brandHint = 'woof';
  const domain = 'mywoof.com';
  const knownBrandDomains = ['mywoof.com'];

  it('should score a direct product detail URL highly', () => {
    const result = {
      title: 'Poomergency - Woof',
      link: 'https://mywoof.com/products/poomergency',
      snippet: 'Official poomergency bags',
      position: 1
    };

    const score = scoreResult(result, upc, name, brandHint, domain, knownBrandDomains);
    // Base 0.3 + Brand Domain 0.35 + Brand hint 0.2 + Product path boost 0.1 + Word matches
    // Should be near 1.0 (or capped at 1.0)
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it('should score a nested product URL under a collection page highly', () => {
    const result = {
      title: 'Poomergency - Woof',
      link: 'https://mywoof.com/collections/refill-pops/products/poomergency',
      snippet: 'Official poomergency bags',
      position: 1
    };

    const score = scoreResult(result, upc, name, brandHint, domain, knownBrandDomains);
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it('should heavily penalize collection/listing URLs without product indicators', () => {
    const result = {
      title: 'Refills - Woof Dog Products',
      link: 'https://mywoof.com/collections/refill-pops',
      snippet: 'Listing of all refills',
      position: 1
    };

    const score = scoreResult(result, upc, name, brandHint, domain, knownBrandDomains);
    // Base 0.3 + Brand Domain 0.35 + Brand hint 0.2 - Listing page penalty 0.35 + Word match (woof) 0.033
    // Should be around 0.533, well below the product page score
    expect(score).toBeLessThan(0.7);
  });

  it('should heavily penalize generic shop/collections listing URLs', () => {
    const result = {
      title: 'Shop All Woof Dog Toys & Treats',
      link: 'https://mywoof.com/collections/all-products',
      snippet: 'Listing of all products',
      position: 1
    };

    const score = scoreResult(result, upc, name, brandHint, domain, knownBrandDomains);
    expect(score).toBeLessThan(0.7);
  });

  it('should penalize blog and CMS pages', () => {
    const blogResult = {
      title: '4th of July With Your Dog - Woof',
      link: 'https://mywoof.com/blogs/articles/4th-of-july-with-your-dog',
      snippet: 'How to keep your dog calm during fireworks',
      position: 1
    };

    const pageResult = {
      title: 'About Woof - Woof',
      link: 'https://mywoof.com/pages/about-us',
      snippet: 'Our story and mission',
      position: 1
    };

    const blogScore = scoreResult(blogResult, upc, name, brandHint, domain, knownBrandDomains);
    const pageScore = scoreResult(pageResult, upc, name, brandHint, domain, knownBrandDomains);

    expect(blogScore).toBeLessThan(0.8);
    expect(pageScore).toBeLessThan(0.8);
  });

  it('should heavily penalize support/help subdomains even if the name matches', () => {
    const result = {
      title: 'Poomergency Help - Woof Support',
      link: 'https://support.mywoof.com/poomergency-faq',
      snippet: 'Official poomergency help page',
      position: 1
    };

    const score = scoreResult(result, upc, name, brandHint, 'support.mywoof.com', knownBrandDomains);
    // Phase 6 (epic #46 follow-up) adds a +0.1 strong brand-domain boost
    // ("woof" in "mywoof"); the support-subdomain penalty still dominates.
    expect(score).toBeLessThan(0.7);
  });

  it('should ignore variant keywords in base matching and use them as tie-breakers', () => {
    const expectedName = 'WOOF PUPSICLE LAVENDER LG';
    const resultWithoutVariant = {
      title: 'Woof Pupsicle - Classic Toy',
      link: 'https://mywoof.com/products/pupsicle',
      snippet: 'The pupsicle dog toy',
      position: 1
    };
    const resultWithVariant = {
      title: 'Woof Pupsicle Lavender Edition',
      link: 'https://mywoof.com/products/pupsicle-lavender',
      snippet: 'The lavender pupsicle dog toy',
      position: 1
    };

    const scoreWithout = scoreResult(resultWithoutVariant, '860012493746', expectedName, 'woof', 'mywoof.com', ['mywoof.com']);
    const scoreWith = scoreResult(resultWithVariant, '860012493746', expectedName, 'woof', 'mywoof.com', ['mywoof.com']);

    expect(scoreWithout).toBeGreaterThanOrEqual(0.8);
    expect(scoreWith).toBeGreaterThanOrEqual(0.8);
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });

  it('should match concatenated words bidirectionally', () => {
    const expectedName = 'WOOF FORAGER FLYBALLYELLOW';
    const result = {
      title: 'Flyball Launcher - Woof',
      link: 'https://mywoof.com/products/flyball',
      snippet: 'Flyball toys and launchers',
      position: 1
    };

    const score = scoreResult(result, '850067859833', expectedName, 'woof', 'mywoof.com', ['mywoof.com']);
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('should recognize seeded retailer/distributor domains (ADR 0017)', () => {
    const seeded = [
      'farmtopaw.ca',
      'torontopets.ca',
      'mypetshoponyonge.ca',
      'woofmeownh.com',
      'shop.allpetsconsidered.com',
    ];
    for (const domain of seeded) {
      expect(isKnownRetailerOrDistributorDomain(domain)).toBe(true);
    }
    // A bare brand domain is not a known retailer.
    expect(isKnownRetailerOrDistributorDomain('frommfamily.com')).toBe(false);
    // Lookup is normalized: leading www is stripped.
    expect(isKnownRetailerOrDistributorDomain('www.farmtopaw.ca')).toBe(true);
  });

  it('should demote known retailer domains relative to otherwise-identical neutral domains', () => {
    const result = {
      title: 'Butchers Puppy Frozen Sausage Range',
      link: 'https://example.com/products/butchers-pup',
      snippet: 'Official distributor range',
      position: 1
    };

    const retailerScore = scoreResult(result, upc, name, null, 'farmtopaw.ca', []);
    const neutralScore = scoreResult(result, upc, name, null, 'neutralstore.ca', []);

    expect(retailerScore).toBeLessThan(neutralScore);
    // Demotion is a bias, never a discard: a retailer page keeps a positive
    // base score so it can still surface as a reviewed fallback.
    expect(retailerScore).toBeGreaterThan(0);
  });
});
