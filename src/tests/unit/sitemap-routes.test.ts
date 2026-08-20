import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { reconcileSitemapUrls, enrichUrlMetadata } from '../../db/repositories/brand-url-index-repo';
import { recordRefreshRun } from '../../db/repositories/sitemap-telemetry-repo';
import app from '../../server/app';

describe('Sitemap API Routes (/api/onboarding/sitemaps)', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-routes-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: 'default',
      name: 'Test Store',
      workspacePath: '/tmp',
      gitPath: '/tmp/.git',
      bootstrapStatus: 'not_started',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baselineCommit: null,
    });
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

  it('GET /api/onboarding/sitemaps should return overview with metrics and totals', async () => {
    upsertBrandSite('Purina', 'purina.com');
    reconcileSitemapUrls(
      'purina.com',
      [
        { url: 'https://purina.com/products/puppy-food' },
        { url: 'https://purina.com/products/cat-food' },
      ],
      'https://purina.com/sitemap.xml',
    );

    recordRefreshRun({
      domain: 'purina.com',
      started_at: '2026-08-18T10:00:00Z',
      completed_at: '2026-08-18T10:00:02Z',
      status: 'success',
      source_url: 'https://purina.com/sitemap.xml',
      total_urls_observed: 2,
      product_urls_eligible: 2,
      added_count: 2,
      updated_count: 0,
      inactivated_count: 0,
      duration_ms: 2000,
      error_message: null,
      http_status: 200,
    });

    const res = await app.request('/api/onboarding/sitemaps?search=purina.com');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].domain).toBe('purina.com');
    expect(body.domains[0].status).toBe('healthy');
    expect(body.domains[0].totalUrlsCount).toBe(2);
    expect(body.totals.totalDomains).toBeGreaterThanOrEqual(1);
    expect(body.totals.healthyCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/onboarding/sitemaps/:domain should return domain details and refresh history', async () => {
    upsertBrandSite('KONG', 'kongcompany.com');
    reconcileSitemapUrls('kongcompany.com', [{ url: 'https://kongcompany.com/products/classic' }], 'https://kongcompany.com/sitemap.xml');

    const res = await app.request('/api/onboarding/sitemaps/kongcompany.com');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.summary.domain).toBe('kongcompany.com');
    expect(Array.isArray(body.history)).toBe(true);
  });

  it('GET /api/onboarding/sitemaps/:domain/urls should paginate and search URLs', async () => {
    reconcileSitemapUrls(
      'wellnesspet.com',
      [
        { url: 'https://wellnesspet.com/products/dog-food-lamb' },
        { url: 'https://wellnesspet.com/products/cat-food-salmon' },
      ],
      'https://wellnesspet.com/sitemap.xml',
    );

    const res = await app.request('/api/onboarding/sitemaps/wellnesspet.com/urls?search=lamb');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.urls).toHaveLength(1);
    expect(body.urls[0].url).toContain('lamb');
    expect(body.total).toBe(1);
  });

  it('POST /api/onboarding/sitemaps/:domain/test-lookup should return ranked candidates and signals', async () => {
    reconcileSitemapUrls(
      'acmepet.com',
      [
        { url: 'https://acmepet.com/products/rubber-chew-toy-012345678905' },
        { url: 'https://acmepet.com/products/plush-bear' },
      ],
      'https://acmepet.com/sitemap.xml',
    );

    const res = await app.request('/api/onboarding/sitemaps/acmepet.com/test-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upc: '012345678905',
        name: 'Rubber Chew Toy',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].url).toContain('rubber-chew-toy');
    expect(body.candidates[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(body.candidates[0].signals.upcMatched).toBe(true);
  });

  it('DELETE /api/onboarding/sitemaps/:domain/urls/:id should delete a single URL', async () => {
    reconcileSitemapUrls(
      'delete-api.com',
      [
        { url: 'https://delete-api.com/products/item1' },
        { url: 'https://delete-api.com/products/item2' },
      ],
      'https://delete-api.com/sitemap.xml',
    );

    const listRes = await app.request('/api/onboarding/sitemaps/delete-api.com/urls');
    const listBody = await listRes.json();
    expect(listBody.urls).toHaveLength(2);
    const targetId = listBody.urls[0].id;

    const delRes = await app.request(`/api/onboarding/sitemaps/delete-api.com/urls/${targetId}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.id).toBe(targetId);

    const afterRes = await app.request('/api/onboarding/sitemaps/delete-api.com/urls');
    const afterBody = await afterRes.json();
    expect(afterBody.urls).toHaveLength(1);
  });

  it('DELETE /api/onboarding/sitemaps/:domain/urls should batch delete URLs', async () => {
    reconcileSitemapUrls(
      'batch-delete-api.com',
      [
        { url: 'https://batch-delete-api.com/products/item1' },
        { url: 'https://batch-delete-api.com/products/item2' },
        { url: 'https://batch-delete-api.com/products/item3' },
      ],
      'https://batch-delete-api.com/sitemap.xml',
    );

    const listRes = await app.request('/api/onboarding/sitemaps/batch-delete-api.com/urls');
    const listBody = await listRes.json();
    const ids = listBody.urls.map((u: any) => u.id);

    const delRes = await app.request('/api/onboarding/sitemaps/batch-delete-api.com/urls', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [ids[0], ids[1]] }),
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.deletedCount).toBe(2);

    const afterRes = await app.request('/api/onboarding/sitemaps/batch-delete-api.com/urls');
    const afterBody = await afterRes.json();
    expect(afterBody.urls).toHaveLength(1);
    expect(afterBody.urls[0].id).toBe(ids[2]);
  });
});

