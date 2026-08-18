import { describe, it, expect } from 'vitest';
import {
  evaluateDomainSitemapHealth,
  SITEMAP_STALE_THRESHOLD_MS,
  type SitemapHealthStatus,
} from '../../onboarding/sitemap-health-evaluator';

describe('Sitemap Health Evaluator', () => {
  const pinnedNow = new Date('2026-08-18T14:00:00Z');

  it('should derive healthy status for freshly refreshed sitemaps with product URLs', () => {
    const health = evaluateDomainSitemapHealth(
      'purina.com',
      { totalCount: 100, activeCount: 95, inactiveCount: 5, productCount: 90 },
      {
        id: '1',
        domain: 'purina.com',
        started_at: '2026-08-18T10:00:00Z',
        completed_at: '2026-08-18T10:00:02Z',
        status: 'success',
        source_url: 'https://purina.com/sitemap.xml',
        total_urls_observed: 100,
        product_urls_eligible: 90,
        added_count: 5,
        updated_count: 90,
        inactivated_count: 5,
        duration_ms: 2000,
        error_message: null,
        http_status: 200,
      },
      [],
      { totalLookups: 10, localHitCount: 8, paidSearchFallbackCount: 2, localHitRate: 0.8, serperCallsAvoided: 16 },
      null,
      pinnedNow,
    );

    expect(health.status).toBe('healthy');
    expect(health.needsAttention).toBe(false);
    expect(health.activeUrlsCount).toBe(95);
    expect(health.productUrlsCount).toBe(90);
    expect(health.localHitRate).toBe(0.8);
  });

  it('should derive stale status when refresh is older than 14 days', () => {
    const oldDate = new Date(pinnedNow.getTime() - SITEMAP_STALE_THRESHOLD_MS - 24 * 3600 * 1000).toISOString();

    const health = evaluateDomainSitemapHealth(
      'stale-brand.com',
      { totalCount: 50, activeCount: 50, inactiveCount: 0, productCount: 45 },
      {
        id: '2',
        domain: 'stale-brand.com',
        started_at: oldDate,
        completed_at: oldDate,
        status: 'success',
        source_url: 'https://stale-brand.com/sitemap.xml',
        total_urls_observed: 50,
        product_urls_eligible: 45,
        added_count: 0,
        updated_count: 50,
        inactivated_count: 0,
        duration_ms: 1500,
        error_message: null,
        http_status: 200,
      },
      [],
      { totalLookups: 0, localHitCount: 0, paidSearchFallbackCount: 0, localHitRate: 0, serperCallsAvoided: 0 },
      null,
      pinnedNow,
    );

    expect(health.status).toBe('stale');
    expect(health.needsAttention).toBe(true);
    expect(health.attentionReasons).toContain('stale_sitemap');
  });

  it('should derive error status when last refresh failed', () => {
    const health = evaluateDomainSitemapHealth(
      'error-brand.com',
      { totalCount: 0, activeCount: 0, inactiveCount: 0, productCount: 0 },
      {
        id: '3',
        domain: 'error-brand.com',
        started_at: '2026-08-18T10:00:00Z',
        completed_at: '2026-08-18T10:00:05Z',
        status: 'failed',
        source_url: null,
        total_urls_observed: 0,
        product_urls_eligible: 0,
        added_count: 0,
        updated_count: 0,
        inactivated_count: 0,
        duration_ms: 5000,
        error_message: 'HTTP 403 Forbidden',
        http_status: 403,
      },
      [],
      { totalLookups: 0, localHitCount: 0, paidSearchFallbackCount: 0, localHitRate: 0, serperCallsAvoided: 0 },
      null,
      pinnedNow,
    );

    expect(health.status).toBe('error');
    expect(health.needsAttention).toBe(true);
    expect(health.attentionReasons).toContain('refresh_failed');
  });

  it('should flag large URL count drops as attention signal', () => {
    const currentRun = {
      id: 'c',
      domain: 'delta.com',
      started_at: '2026-08-18T10:00:00Z',
      completed_at: '2026-08-18T10:00:02Z',
      status: 'success' as const,
      source_url: 'https://delta.com/sitemap.xml',
      total_urls_observed: 20, // Dropped from 100 to 20
      product_urls_eligible: 18,
      added_count: 0,
      updated_count: 20,
      inactivated_count: 80,
      duration_ms: 2000,
      error_message: null,
      http_status: 200,
    };

    const previousRun = {
      id: 'p',
      domain: 'delta.com',
      started_at: '2026-08-15T10:00:00Z',
      completed_at: '2026-08-15T10:00:02Z',
      status: 'success' as const,
      source_url: 'https://delta.com/sitemap.xml',
      total_urls_observed: 100,
      product_urls_eligible: 95,
      added_count: 10,
      updated_count: 90,
      inactivated_count: 0,
      duration_ms: 2000,
      error_message: null,
      http_status: 200,
    };

    const health = evaluateDomainSitemapHealth(
      'delta.com',
      { totalCount: 100, activeCount: 20, inactiveCount: 80, productCount: 18 },
      currentRun,
      [currentRun, previousRun],
      { totalLookups: 5, localHitCount: 4, paidSearchFallbackCount: 1, localHitRate: 0.8, serperCallsAvoided: 8 },
      null,
      pinnedNow,
    );

    expect(health.needsAttention).toBe(true);
    expect(health.attentionReasons).toContain('large_url_drop');
  });
});
