import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { reconcileSitemapUrls } from '../../db/repositories/brand-url-index-repo';
import { recordRefreshRun } from '../../db/repositories/sitemap-telemetry-repo';
import app from '../../server/app';
import { unlinkSync } from 'node:fs';

// story: e35s10 — Commits 5-7 RED: brand-hub route not yet registered

describe('Brand Hub Routes (/api/onboarding/brand-hub)', () => {
  const testDbPath = '/tmp/baystate-cms-brand-hub-routes-test.db';

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
    db.query('DELETE FROM sitemap_cache').run();
    db.query('DELETE FROM domain_status').run();
    db.query('DELETE FROM extractor_profiles').run();
  });

  it('GET /api/onboarding/brand-hub returns domain-keyed rows with profile enrichment and keeps /sitemaps alive', async () => {
    upsertBrandSite('Purina', 'purina.com');
    upsertProfile('purina.com', {
      titleSelector: '.title',
      descriptionSelector: '.desc',
      imagesSelector: null,
      sitemapProductUrlPattern: '/products/',
      runtime: 'rendered',
    });
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
      started_at: new Date(Date.now() - 2000).toISOString(),
      completed_at: new Date().toISOString(),
      status: 'success',
      source_url: 'https://purina.com/sitemap.xml',
      total_urls_observed: 2,
      product_urls_eligible: 2,
      added_count: 2,
      updated_count: 0,
      inactivated_count: 0,
      duration_ms: 1500,
      error_message: null,
      http_status: 200,
    });

    const resHub = await app.request('/api/onboarding/brand-hub');
    expect(resHub.status).toBe(200);
    const bodyHub = await resHub.json() as any;
    expect(bodyHub.rows).toBeDefined();
    expect(Array.isArray(bodyHub.rows)).toBe(true);
    const purinaRow = bodyHub.rows.find((r: any) => r.domain === 'purina.com');
    expect(purinaRow).toBeDefined();
    expect(purinaRow.normalizedDomain).toBe('purina.com');
    expect(purinaRow.profile.exists).toBe(true);
    expect(purinaRow.profile.status).toBe('complete');
    expect(purinaRow.profile.sitemapProductUrlPattern).toBe('/products/');
    expect(purinaRow.profile.runtime).toBe('rendered');

    // legacy alias still works
    const resLegacy = await app.request('/api/onboarding/sitemaps');
    expect(resLegacy.status).toBe(200);
    const bodyLegacy = await resLegacy.json() as any;
    expect(bodyLegacy.domains).toBeDefined();
  });
});
