// story: e35s10 — Commit 14 RED: unified domain+brand search with health+profile-status facets not yet implemented
import { describe, it, expect } from 'vitest';
import { filterBrandHubRows } from '../../onboarding/brand-hub/filter';
import type { BrandHubRow } from '../../onboarding/brand-hub/view-model';

function row(overrides: Partial<BrandHubRow> & { domain: string }): BrandHubRow {
  return {
    domain: overrides.domain,
    normalizedDomain: overrides.domain,
    profile: { exists: false, status: 'missing', sitemapProductUrlPattern: null, runtime: null, ...(overrides.profile ?? {}) },
    sitemap: overrides.sitemap ?? null,
    urlCounts: { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0, ...(overrides.urlCounts ?? {}) },
    brandAssociations: overrides.brandAssociations ?? [],
  } as BrandHubRow;
}

describe('brand hub filter — single domain+brand search with health+profile facets', () => {
  const rows: BrandHubRow[] = [
    row({
      domain: 'purina.com',
      profile: { exists: true, status: 'complete', sitemapProductUrlPattern: '/p/', runtime: 'rendered' },
      sitemap: { status: 'healthy', needsAttention: false, attentionReasons: [], lastRefreshedAt: '2026-08-10T00:00:00.000Z' },
      brandAssociations: [{ id: '1', brandName: 'purina', domain: 'purina.com', urlPattern: null, successCount: 5, lastUsedAt: null, sourceStrategy: 'official_first', createdAt: '' } as any],
    }),
    row({
      domain: 'kongcompany.com',
      profile: { exists: false, status: 'missing', sitemapProductUrlPattern: null, runtime: null },
      sitemap: { status: 'stale', needsAttention: true, attentionReasons: ['stale_sitemap'], lastRefreshedAt: '2026-07-01T00:00:00.000Z' },
      brandAssociations: [{ id: '2', brandName: 'kong', domain: 'kongcompany.com', urlPattern: null, successCount: 3, lastUsedAt: null, sourceStrategy: 'official_first', createdAt: '' } as any],
    }),
    row({
      domain: 'example.com',
      profile: { exists: true, status: 'partial', sitemapProductUrlPattern: null, runtime: 'rendered' },
      sitemap: { status: 'error', needsAttention: true, attentionReasons: ['error'], lastRefreshedAt: null },
      brandAssociations: [],
    }),
  ];

  it('filters by domain substring single input', () => {
    expect(filterBrandHubRows(rows, { search: 'purina' }).map((r) => r.domain)).toEqual(['purina.com']);
  });

  it('filters by brand association name via same single search input', () => {
    expect(filterBrandHubRows(rows, { search: 'kong' }).map((r) => r.domain)).toEqual(['kongcompany.com']);
  });

  it('filters by health status facet uniformly', () => {
    expect(filterBrandHubRows(rows, { healthStatus: 'healthy' }).map((r) => r.domain)).toEqual(['purina.com']);
    expect(filterBrandHubRows(rows, { healthStatus: 'stale' }).map((r) => r.domain)).toEqual(['kongcompany.com']);
  });

  it('filters by profile status facet', () => {
    expect(filterBrandHubRows(rows, { profileStatus: 'missing' }).map((r) => r.domain)).toEqual(['kongcompany.com']);
    expect(filterBrandHubRows(rows, { profileStatus: 'complete' }).map((r) => r.domain)).toEqual(['purina.com']);
    expect(filterBrandHubRows(rows, { profileStatus: 'partial' }).map((r) => r.domain)).toEqual(['example.com']);
  });

  it('combines domain search + health + profile + attentionOnly uniformly', () => {
    const res = filterBrandHubRows(rows, { search: 'com', healthStatus: 'error', profileStatus: 'partial', attentionOnly: true });
    expect(res.map((r) => r.domain)).toEqual(['example.com']);
  });

  it('attentionOnly filters needsAttention uniformly', () => {
    expect(filterBrandHubRows(rows, { attentionOnly: true }).map((r) => r.domain).sort()).toEqual(['example.com', 'kongcompany.com']);
  });
});
