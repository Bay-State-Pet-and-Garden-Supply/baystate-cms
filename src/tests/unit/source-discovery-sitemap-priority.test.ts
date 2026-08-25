import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { reconcileSitemapUrls, enrichUrlMetadata } from '../../db/repositories/brand-url-index-repo';
import { getDiscoveryEconomics } from '../../db/repositories/sitemap-telemetry-repo';
import { discoverSources } from '../../onboarding/source-discovery';

describe('Source Discovery - Local Brand URL Index Priority', () => {
  const testDbPath = '/tmp/baystate-cms-source-discovery-priority-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    const db = getDb();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM brand_url_index').run();
    db.query('DELETE FROM brand_url_fts').run();
    db.query('DELETE FROM sitemap_refresh_history').run();
    db.query('DELETE FROM sitemap_discovery_events').run();
  });

  it('should satisfy discovery locally and short-circuit via high-confidence UPC match in brand_url_index', async () => {
    // 1. Map brand domain
    upsertBrandSite('Purina', 'purina.com');

    // 2. Populate brand_url_index with sitemap URLs
    reconcileSitemapUrls(
      'purina.com',
      [
        { url: 'https://purina.com/pro-plan/puppy-chicken-rice-038100130839' },
        { url: 'https://purina.com/pro-plan/adult-salmon' },
      ],
      'https://purina.com/sitemap.xml',
    );

    // Mock network fetch for validation HEAD/GET check
    const mockFetch = async (input: RequestInfo | URL | string) => {
      const urlStr = String(input);
      if (urlStr.includes('038100130839')) {
        return new Response('<html><head><title>Puppy Chicken & Rice</title></head></html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    // 3. Execute discoverSources with no external search dependency
    const result = await discoverSources(
      '038100130839',
      'Purina Pro Plan Puppy Chicken & Rice',
      'Purina',
      { networkFetch: mockFetch as any },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe('https://purina.com/pro-plan/puppy-chicken-rice-038100130839');
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(result.candidates[0].sourceMethod).toBe('local_upc');

    // 4. Verify discovery economics recorded the local hit
    const economics = getDiscoveryEconomics('purina.com');
    expect(economics.totalLookups).toBe(1);
    expect(economics.localHitCount).toBe(1);
  });

  it('should satisfy discovery locally using enriched metadata without any external search API', async () => {
    upsertBrandSite('KONG', 'kongcompany.com');

    reconcileSitemapUrls(
      'kongcompany.com',
      [{ url: 'https://www.kongcompany.com/products/classic-red-medium' }],
      'https://www.kongcompany.com/sitemap.xml',
    );

    enrichUrlMetadata('https://www.kongcompany.com/products/classic-red-medium', {
      title: 'KONG Classic Dog Toy Medium',
      upc: '035585111116',
      sku: 'T1',
    });

    const mockFetch = async () => new Response('OK', { status: 200 });

    const result = await discoverSources(
      '035585111116',
      'KONG Classic Dog Toy',
      'KONG',
      { networkFetch: mockFetch as any },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe('https://www.kongcompany.com/products/classic-red-medium');
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(result.candidates[0].sourceMethod).toBe('local_upc');

    const economics = getDiscoveryEconomics('kongcompany.com');
    expect(economics.localHitCount).toBe(1);
  });

  it('searches EVERY configured official domain of a brand, not just the first', async () => {
    // A brand may legitimately own several official domains. The product
    // lives only on the SECOND configured domain — discovery must still
    // find it instead of parking at needs_input_no_candidates.
    upsertBrandSite('TwoDomain', 'first-domain.com');
    upsertBrandSite('TwoDomain', 'second-domain.com');

    reconcileSitemapUrls(
      'second-domain.com',
      [{ url: 'https://second-domain.com/shop/two-domain-toy-012345678903' }],
      'https://second-domain.com/sitemap.xml',
    );
    // first-domain.com deliberately gets an EMPTY index — nothing to find.
    reconcileSitemapUrls('first-domain.com', [], 'https://first-domain.com/sitemap.xml');

    const mockFetch = async (input: RequestInfo | URL | string) => {
      if (String(input).includes('second-domain.com')) {
        return new Response('<html><title>Two Domain Toy</title></html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const result = await discoverSources(
      '012345678903',
      'TwoDomain Toy Large',
      'TwoDomain',
      { networkFetch: mockFetch as any },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe('https://second-domain.com/shop/two-domain-toy-012345678903');
    expect(result.candidates[0].domain).toBe('second-domain.com');
    expect(result.candidates[0].sourceMethod).toBe('local_upc');
  });
});
