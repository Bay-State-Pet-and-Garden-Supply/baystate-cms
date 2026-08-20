import { describe, it, expect } from 'vitest';
// story: e35s10 — Commits 5-7 RED: schema type does not yet exist
import {
  BrandHubRowSchema,
  BrandHubOverviewResponseSchema,
} from '../../shared/schemas/onboarding';

describe('brand hub schema — domain-keyed + profile enrichment', () => {
  it('parses a domain-keyed row with profile fields', () => {
    const row = {
      domain: 'purina.com',
      normalizedDomain: 'purina.com',
      profile: {
        exists: true,
        status: 'complete' as const,
        sitemapProductUrlPattern: '/products/',
        runtime: 'rendered' as const,
      },
      sitemap: {
        status: 'healthy',
        needsAttention: false,
        attentionReasons: [],
        lastRefreshedAt: '2026-08-10T10:00:00.000Z',
      },
      urlCounts: { totalCount: 10, activeCount: 8, inactiveCount: 2, productCount: 5 },
      brandAssociations: [
        { id: '1', brandName: 'purina', domain: 'purina.com', urlPattern: null, successCount: 5, lastUsedAt: null, sourceStrategy: 'official_first' as const, createdAt: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const parsed = BrandHubRowSchema.parse(row);
    expect(parsed.domain).toBe('purina.com');
    expect(parsed.normalizedDomain).toBe('purina.com');
    expect(parsed.profile.exists).toBe(true);
    expect(parsed.profile.status).toBe('complete');
    expect(parsed.profile.sitemapProductUrlPattern).toBe('/products/');
    expect(parsed.profile.runtime).toBe('rendered');
  });

  it('parses overview response that mirrors sitemaps shape plus profile enrichment', () => {
    const overview = {
      rows: [
        {
          domain: 'purina.com',
          normalizedDomain: 'purina.com',
          profile: { exists: false, status: 'missing' as const, sitemapProductUrlPattern: null, runtime: null },
          sitemap: null,
          urlCounts: { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0 },
          brandAssociations: [],
        },
      ],
      totals: { totalDomains: 1, healthyCount: 0, needsAttentionCount: 0, totalProductUrls: 0 },
      generatedAt: new Date().toISOString(),
    };
    const parsed = BrandHubOverviewResponseSchema.parse(overview);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].domain).toBe('purina.com');
  });
});
