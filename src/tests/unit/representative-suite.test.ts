// story: e06s02
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

describe('representative suite 3-10', () => {
  const testDbPath = '/tmp/baystate-cms-rep-suite-test.db';
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
    try { db.exec('DELETE FROM brand_url_index'); } catch {}
    try { db.exec('DELETE FROM brand_url_fts'); } catch {}
  });

  it('persists 3 representative products and enforces minimum', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    const { setRepresentativeSuite, getRepresentativeSuite, isSuiteSatisfied } = await import('../../db/repositories/representative-suite-repo');
    reconcileSitemapUrls('test-suite.com', [
      { url: 'https://test-suite.com/products/1', pageType: 'product' },
      { url: 'https://test-suite.com/products/2', pageType: 'product' },
      { url: 'https://test-suite.com/products/3', pageType: 'product' },
      { url: 'https://test-suite.com/products/4', pageType: 'product' },
    ], 'https://test-suite.com/sitemap.xml');
    const urls = [
      'https://test-suite.com/products/1',
      'https://test-suite.com/products/2',
      'https://test-suite.com/products/3',
    ];
    setRepresentativeSuite('test-suite.com', urls, 'tester');
    const suite = getRepresentativeSuite('test-suite.com');
    expect(suite.length).toBe(3);
    expect(isSuiteSatisfied('test-suite.com')).toBe(true);
  });

  it('rejects suite with less than 3 without waiver', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    const { setRepresentativeSuite, isSuiteSatisfied } = await import('../../db/repositories/representative-suite-repo');
    reconcileSitemapUrls('test-suite.com', [
      { url: 'https://test-suite.com/products/a', pageType: 'product' },
      { url: 'https://test-suite.com/products/b', pageType: 'product' },
    ], 'https://test-suite.com/sitemap.xml');
    setRepresentativeSuite('test-suite.com', ['https://test-suite.com/products/a'], 'tester');
    expect(isSuiteSatisfied('test-suite.com')).toBe(false);
  });

  it('caps suite at 10', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    const { setRepresentativeSuite } = await import('../../db/repositories/representative-suite-repo');
    const urls = Array.from({ length: 11 }, (_, i) => `https://test-suite.com/products/${i}`);
    reconcileSitemapUrls('test-suite.com', urls.map(u => ({ url: u, pageType: 'product' as const })), 'https://test-suite.com/sitemap.xml');
    expect(() => setRepresentativeSuite('test-suite.com', urls, 'tester')).toThrow();
  });
});
