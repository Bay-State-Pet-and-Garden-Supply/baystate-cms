import { describe, it, expect } from 'vitest';
import {
  normalizeBrandHubDomain,
  deriveBrandHubRow,
  type BrandHubRow,
} from '../../onboarding/brand-hub/view-model';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { DomainUrlCounts } from '../../db/repositories/brand-url-index-repo';
import type { DomainSitemapHealthSummary } from '../../onboarding/sitemap-health-evaluator';
import type { BrandSite } from '../../shared/schemas/onboarding';

// story: e35s10 — thin view-model domain-keyed join, invariant preserved

describe('brand hub view-model — normalization', () => {
  it('normalizes https + www + path to bare lowercased domain', () => {
    expect(normalizeBrandHubDomain('https://www.Purina.com/')).toBe('purina.com');
  });

  it('normalizes bare www with mixed case and trailing slashes', () => {
    expect(normalizeBrandHubDomain('WWW.EXAMPLE.COM///')).toBe('example.com');
  });

  it('normalizes URL with path and query to domain only', () => {
    expect(normalizeBrandHubDomain('https://www.kongcompany.com/products/classic-red?x=1')).toBe('kongcompany.com');
  });

  it('trims whitespace and lowercases', () => {
    expect(normalizeBrandHubDomain('  VonShef.com  ')).toBe('vonshef.com');
  });
});

describe('brand hub view-model — profile presence/completeness', () => {
  const baseCounts: DomainUrlCounts = { totalCount: 10, activeCount: 8, inactiveCount: 2, productCount: 5 };

  const healthyHealth: DomainSitemapHealthSummary = {
    domain: 'purina.com',
    status: 'healthy',
    statusReason: null,
    needsAttention: false,
    attentionReasons: [],
    totalUrlsCount: 10,
    productUrlsCount: 5,
    activeUrlsCount: 8,
    inactiveUrlsCount: 2,
    sitemapSourceUrl: 'https://purina.com/sitemap.xml',
    lastRefreshedAt: '2026-08-10T10:00:00.000Z',
    lastRefreshDurationMs: 1200,
    lastRefreshStatus: 'success',
    lastRefreshAddedCount: 2,
    lastRefreshRemovedCount: 0,
    localHitRate: 0.8,
    totalLookups: 10,
  } as DomainSitemapHealthSummary;

  function profile(overrides: Partial<ExtractorProfile> = {}): ExtractorProfile {
    return {
      id: 'p1',
      domain: 'purina.com',
      titleSelector: '.title',
      titleOptionalSelectors: [],
      priceSelector: null,
      descriptionSelector: '.desc',
      brandSelector: null,
      imagesSelector: '.images',
      customSelectors: {},
      sitemapProductUrlPattern: '/products/',
      shopifyJSONPath: false,
      variantSelectionStrategy: null,
      customSelectorMetadata: {},
      runtime: 'rendered',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    } as ExtractorProfile;
  }

  it('derives missing when no profile exists', () => {
    const row = deriveBrandHubRow({
      domain: 'purina.com',
      profile: null,
      urlCounts: baseCounts,
      health: healthyHealth,
      brandSites: [],
    });
    expect(row.profile.exists).toBe(false);
    expect(row.profile.status).toBe('missing');
    expect(row.profile.sitemapProductUrlPattern).toBeNull();
    expect(row.profile.runtime).toBeNull();
  });

  it('derives partial when profile exists but titleSelector is null', () => {
    const row = deriveBrandHubRow({
      domain: 'purina.com',
      profile: profile({ titleSelector: null, descriptionSelector: null, imagesSelector: null }),
      urlCounts: baseCounts,
      health: healthyHealth,
      brandSites: [],
    });
    expect(row.profile.exists).toBe(true);
    expect(row.profile.status).toBe('partial');
  });

  it('derives complete when titleSelector plus description or images present', () => {
    const row = deriveBrandHubRow({
      domain: 'purina.com',
      profile: profile({ titleSelector: '.t', descriptionSelector: '.d', imagesSelector: null }),
      urlCounts: baseCounts,
      health: healthyHealth,
      brandSites: [],
    });
    expect(row.profile.exists).toBe(true);
    expect(row.profile.status).toBe('complete');
    expect(row.profile.sitemapProductUrlPattern).toBe('/products/');
    expect(row.profile.runtime).toBe('rendered');
  });

  it('exposes sitemap health passthrough and attentionReasons', () => {
    const staleHealth: DomainSitemapHealthSummary = {
      ...healthyHealth,
      status: 'stale',
      needsAttention: true,
      attentionReasons: ['stale_sitemap'],
      statusReason: 'Sitemap has not been refreshed in 20 days',
    } as DomainSitemapHealthSummary;

    const row = deriveBrandHubRow({
      domain: 'purina.com',
      profile: profile(),
      urlCounts: baseCounts,
      health: staleHealth,
      brandSites: [],
    });
    expect(row.sitemap?.status).toBe('stale');
    expect(row.sitemap?.needsAttention).toBe(true);
    expect(row.sitemap?.attentionReasons).toEqual(['stale_sitemap']);
  });

  it('carries brand associations and shows unassigned when none', () => {
    const sites: BrandSite[] = [
      { id: '1', brandName: 'purina', domain: 'purina.com', urlPattern: null, successCount: 5, lastUsedAt: null, sourceStrategy: 'official_first', createdAt: '2026-08-01T00:00:00.000Z' } as BrandSite,
      { id: '2', brandName: 'pro plan', domain: 'purina.com', urlPattern: null, successCount: 2, lastUsedAt: null, sourceStrategy: 'official_first', createdAt: '2026-08-01T00:00:00.000Z' } as BrandSite,
    ];
    const row = deriveBrandHubRow({
      domain: 'purina.com',
      profile: profile(),
      urlCounts: baseCounts,
      health: healthyHealth,
      brandSites: sites,
    });
    expect(row.brandAssociations).toHaveLength(2);
    expect(row.brandAssociations.map((b) => b.brandName)).toEqual(['purina', 'pro plan']);

    const empty = deriveBrandHubRow({
      domain: 'example.com',
      profile: null,
      urlCounts: { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0 },
      health: null,
      brandSites: [],
    });
    expect(empty.brandAssociations).toHaveLength(0);
  });

  it('is domain-keyed: normalizedDomain is canonical and row.domain is normalized', () => {
    const row = deriveBrandHubRow({
      domain: 'https://www.Purina.com/',
      profile: profile(),
      urlCounts: baseCounts,
      health: healthyHealth,
      brandSites: [],
    });
    expect(row.normalizedDomain).toBe('purina.com');
    expect(row.domain).toBe('purina.com');
  });
});
