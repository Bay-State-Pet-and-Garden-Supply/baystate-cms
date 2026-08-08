import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  getCachedSitemapUrls,
  insertSitemapCache,
  clearSitemapCache,
  listAllSitemapCaches,
  SITEMAP_CACHE_DEFAULT_TTL_MS,
} from '../../db/repositories/sitemap-cache-repo';

describe('Sitemap Cache Repository', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-cache-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should return null when cache is empty', () => {
    const cached = getCachedSitemapUrls('non-existent-domain.com');
    expect(cached).toBeNull();
  });

  it('should insert and retrieve cached sitemap urls', () => {
    const domain = 'shopone.com';
    const urls = [
      'https://shopone.com/products/widget',
      'https://shopone.com/products/gizmo',
      'https://shopone.com/blog/post-1',
    ];
    const sourceUrl = 'https://shopone.com/sitemap.xml';

    insertSitemapCache(domain, urls, sourceUrl);

    const cached = getCachedSitemapUrls(domain);
    expect(cached).not.toBeNull();
    expect(cached).toEqual(urls);
  });

  it('should default to a 24h TTL', () => {
    expect(SITEMAP_CACHE_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('should overwrite existing cache when the same domain is inserted again', () => {
    const domain = 'shoptwo.com';
    const first = ['https://shoptwo.com/a', 'https://shoptwo.com/b'];
    const second = ['https://shoptwo.com/c'];

    insertSitemapCache(domain, first, 'https://shoptwo.com/sitemap.xml');
    insertSitemapCache(domain, second, 'https://shoptwo.com/sitemap.xml');

    const cached = getCachedSitemapUrls(domain);
    expect(cached).toEqual(second);
  });

  it('should normalize domains by lowercasing and stripping www.', () => {
    const domain = 'ShopThree.com';
    const urls = ['https://shopthree.com/x'];

    insertSitemapCache(`www.${domain}`, urls, 'https://shopthree.com/sitemap.xml');

    // mixed-case input and the www. form should both hit the same row
    const cached = getCachedSitemapUrls(domain);
    expect(cached).toEqual(urls);
  });

  it('should treat expired entries as cache misses and delete them', () => {
    const domain = 'shopexpired.com';
    insertSitemapCache(
      domain,
      ['https://shopexpired.com/a'],
      'https://shopexpired.com/sitemap.xml',
      1, // 1ms TTL — immediately expired
    );

    // Wait briefly to ensure the row has expired.
    const start = Date.now();
    while (Date.now() - start < 5) {
      // small spin
    }

    const cached = getCachedSitemapUrls(domain);
    expect(cached).toBeNull();

    // Subsequent lookups should still miss (the expired row was cleaned up).
    const cached2 = getCachedSitemapUrls(domain);
    expect(cached2).toBeNull();
  });

  it('should respect a custom TTL on insert', () => {
    const domain = 'shopfast.com';
    insertSitemapCache(
      domain,
      ['https://shopfast.com/a'],
      'https://shopfast.com/sitemap.xml',
      60_000, // 60s TTL
    );

    const cached = getCachedSitemapUrls(domain);
    expect(cached).toEqual(['https://shopfast.com/a']);
  });

  it('should store an empty URL list', () => {
    const domain = 'shopempty.com';
    insertSitemapCache(domain, [], 'https://shopempty.com/sitemap.xml');

    const cached = getCachedSitemapUrls(domain);
    expect(cached).toEqual([]);
  });

  it('should clear all cached sitemaps', () => {
    insertSitemapCache('cleara.com', ['https://cleara.com/1'], 'https://cleara.com/sitemap.xml');
    insertSitemapCache('clearb.com', ['https://clearb.com/1'], 'https://clearb.com/sitemap.xml');

    expect(getCachedSitemapUrls('cleara.com')).not.toBeNull();
    expect(getCachedSitemapUrls('clearb.com')).not.toBeNull();

    clearSitemapCache();

    expect(getCachedSitemapUrls('cleara.com')).toBeNull();
    expect(getCachedSitemapUrls('clearb.com')).toBeNull();
  });

  describe('listAllSitemapCaches (read-only diagnostics)', () => {
    it('returns rows sorted by domain ascending with parsed URL counts', () => {
      clearSitemapCache();
      insertSitemapCache(
        'zeta.example.com',
        ['https://zeta.example.com/p1', 'https://zeta.example.com/p2', 'https://zeta.example.com/p3'],
        'https://zeta.example.com/sitemap.xml',
      );
      insertSitemapCache(
        'alpha.example.com',
        ['https://alpha.example.com/only'],
        'https://alpha.example.com/sitemap.xml',
      );

      const all = listAllSitemapCaches();
      const domains = all.map((r) => r.domain);
      expect(domains).toEqual([...domains].sort());
      const alpha = all.find((r) => r.domain === 'alpha.example.com');
      const zeta = all.find((r) => r.domain === 'zeta.example.com');
      expect(alpha?.sitemapUrlsCount).toBe(1);
      expect(alpha?.urls).toEqual(['https://alpha.example.com/only']);
      expect(alpha?.sitemapSourceUrl).toBe('https://alpha.example.com/sitemap.xml');
      expect(zeta?.sitemapUrlsCount).toBe(3);
      expect(zeta?.sitemapFetchedAt).toBeTruthy();
      expect(zeta?.sitemapExpiresAt).toBeTruthy();
    });

    it('returns expired rows without deleting them', () => {
      clearSitemapCache();
      const domain = 'expired.example.com';
      insertSitemapCache(
        domain,
        ['https://expired.example.com/p1'],
        'https://expired.example.com/sitemap.xml',
        1, // 1ms TTL — already expired
      );

      // Spin briefly to ensure the row has expired.
      const start = Date.now();
      while (Date.now() - start < 5) {
        // small spin
      }

      const all = listAllSitemapCaches();
      const found = all.find((r) => r.domain === domain);
      expect(found).toBeDefined();
      expect(found?.sitemapUrlsCount).toBe(1);
      expect(found?.urls).toEqual(['https://expired.example.com/p1']);

      // Critical: the row must still be in the table.
      const db = getDb();
      const stillThere = db
        .query('SELECT COUNT(*) as count FROM sitemap_cache WHERE domain = ?')
        .get(domain) as { count: number };
      expect(stillThere.count).toBe(1);

      // For contrast: getCachedSitemapUrls() WOULD have deleted it.
      const evicted = getCachedSitemapUrls(domain);
      expect(evicted).toBeNull();
      const after = db
        .query('SELECT COUNT(*) as count FROM sitemap_cache WHERE domain = ?')
        .get(domain) as { count: number };
      expect(after.count).toBe(0);
    });

    it('handles malformed urls_json gracefully with count 0', () => {
      clearSitemapCache();
      const domain = 'broken.example.com';
      const db = getDb();
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      db.query(
        `INSERT INTO sitemap_cache (domain, urls_json, fetched_at, expires_at, source_url)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(domain, 'not-valid-json', now, future, 'https://broken.example.com/sitemap.xml');

      // Suppress the expected console.error from the parser.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const all = listAllSitemapCaches();
      const found = all.find((r) => r.domain === domain);
      expect(found).toBeDefined();
      expect(found?.urls).toEqual([]);
      expect(found?.sitemapUrlsCount).toBe(0);
      expect(found?.sitemapSourceUrl).toBe('https://broken.example.com/sitemap.xml');

      // Row must remain in the table — diagnostics never deletes.
      const stillThere = db
        .query('SELECT COUNT(*) as count FROM sitemap_cache WHERE domain = ?')
        .get(domain) as { count: number };
      expect(stillThere.count).toBe(1);

      errorSpy.mockRestore();
    });
  });
});
