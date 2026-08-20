// story: e06s02
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

describe('profile waiver for <3 URLs', () => {
  const testDbPath = '/tmp/baystate-cms-waiver-test.db';
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
    // legacy domain-specific cleanup retained as no-op
  });

  it('requires waiver when product count <3', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    const { setRepresentativeSuite, isSuiteSatisfied } = await import('../../db/repositories/representative-suite-repo');
    const { createWaiver, getWaiver, hasValidWaiver } = await import('../../db/repositories/waiver-repo');
    reconcileSitemapUrls('waiver-test.com', [
      { url: 'https://waiver-test.com/products/1', pageType: 'product' },
    ], 'https://waiver-test.com/sitemap.xml');
    setRepresentativeSuite('waiver-test.com', ['https://waiver-test.com/products/1'], 'tester');
    expect(isSuiteSatisfied('waiver-test.com')).toBe(false);
    expect(hasValidWaiver('waiver-test.com')).toBe(false);
    createWaiver('waiver-test.com', 'single product domain', 'operator-1');
    expect(hasValidWaiver('waiver-test.com')).toBe(true);
    expect(isSuiteSatisfied('waiver-test.com')).toBe(true);
    const w = getWaiver('waiver-test.com');
    expect(w?.reason).toBe('single product domain');
    expect(w?.actor).toBe('operator-1');
    expect(w?.artifactHash).toBeDefined();
  });

  it('allows 1-2 confirmed when waiver present', async () => {
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    const { setRepresentativeSuite, isSuiteSatisfied } = await import('../../db/repositories/representative-suite-repo');
    const { createWaiver } = await import('../../db/repositories/waiver-repo');
    reconcileSitemapUrls('waiver-test.com', [
      { url: 'https://waiver-test.com/products/1', pageType: 'product' },
      { url: 'https://waiver-test.com/products/2', pageType: 'product' },
    ], 'https://waiver-test.com/sitemap.xml');
    const db = getDb();
    try { db.exec('DELETE FROM domain_waiver WHERE domain = "waiver-test.com"'); } catch {}
    try { db.exec('DELETE FROM domain_representative_suite WHERE domain = "waiver-test.com"'); } catch {}
    setRepresentativeSuite('waiver-test.com', ['https://waiver-test.com/products/1', 'https://waiver-test.com/products/2'], 'tester');
    expect(isSuiteSatisfied('waiver-test.com')).toBe(false);
    createWaiver('waiver-test.com', 'two product waiver', 'op2');
    expect(isSuiteSatisfied('waiver-test.com')).toBe(true);
  });
});
