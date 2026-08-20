// story: e06s02
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';

describe('sitemap inventory freshness', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-inv-test.db';
  beforeAll(() => {
    try { resetDb(); } catch {}
    initDb(testDbPath);
    runMigrations();
  });
  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
  });
  beforeEach(() => {
    const db = getDb();
    try { db.exec('DELETE FROM domain_representative_suite'); } catch {}
    try { db.exec('DELETE FROM domain_waiver'); } catch {}
  });

  it('exposes freshness via domain profile state', () => {
    const state = getDomainProfileState('example.com');
    expect(state).toHaveProperty('freshness');
    expect(state).toHaveProperty('productCount');
    expect(state).toHaveProperty('activeProductCount');
  });

  it('sitemap service returns candidate vs confirmed counts', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    reconcileSitemapUrls('example.com', [
      { url: 'https://example.com/products/x', pageType: 'product' },
    ], 'https://example.com/sitemap.xml');
    const { getSitemapInventory } = await import('../../onboarding/sitemap-inventory-service');
    const inv = getSitemapInventory('example.com');
    expect(inv).toHaveProperty('candidateCount');
    expect(inv).toHaveProperty('confirmedCount');
    expect(inv).toHaveProperty('freshness');
    expect(inv.candidateCount).toBeGreaterThanOrEqual(1);
  });
});
