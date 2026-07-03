import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import {
  recordDomainStatus,
  getDomainStatus,
  listAllDomainStatuses,
} from '../../db/repositories/domain-status-repo';
import {
  insertSitemapCache,
  getCachedSitemapUrls,
  listAllSitemapCaches,
} from '../../db/repositories/sitemap-cache-repo';
import {
  insertProfileGeneration,
  listAllProfileGenerations,
} from '../../db/repositories/profile-generation-repo';
import {
  buildDomainDiagnostics,
  getDomainDiagnosticsResponse,
} from '../../onboarding/domain-diagnostics-service';

describe('Domain Diagnostics Aggregation Service', () => {
  const testDbPath = 'src/tests/unit/domain-diagnostics-service-test.db';
  const pinnedNow = new Date('2026-06-01T12:00:00.000Z');

  beforeAll(() => {
    try {
      resetDb();
    } catch {
      // ok
    }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(testDbPath);
    } catch {
      // ok
    }
  });

  test('returns [] for an empty database without mutating anything', () => {
    // Wipe all source tables to validate the empty case.
    const db = getDb();
    db.query('DELETE FROM extractor_profiles').run();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM domain_status').run();
    db.query('DELETE FROM sitemap_cache').run();
    db.query('DELETE FROM profile_generations').run();

    const entries = buildDomainDiagnostics(pinnedNow);
    expect(entries).toEqual([]);

    // And the response envelope shape is what the route returns.
    const response = getDomainDiagnosticsResponse(pinnedNow);
    expect(response.entries).toEqual([]);
    expect(response.generatedAt).toBe(pinnedNow.toISOString());
  });

  test('union includes domains that exist in only one source table', () => {
    // Reset to a known state.
    const db = getDb();
    db.query('DELETE FROM extractor_profiles').run();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM domain_status').run();
    db.query('DELETE FROM sitemap_cache').run();
    db.query('DELETE FROM profile_generations').run();

    // Only profile: alpha
    upsertProfile('alpha.example.com', { titleSelector: 'h1.a' });
    // Only sitemap: bravo
    insertSitemapCache(
      'bravo.example.com',
      ['https://bravo.example.com/p1'],
      'https://bravo.example.com/sitemap.xml',
    );
    // Only domain_status: charlie
    recordDomainStatus('charlie.example.com', 'ok', 'reachable');
    // Only brand_sites: delta
    upsertBrandSite('delta corp', 'delta.example.com');
    // Only profile_generations: echo
    insertProfileGeneration({
      domain: 'echo.example.com',
      sourceUrl: 'https://echo.example.com/p1',
      selectors: { titleSelector: 'h1' },
      status: 'proposed',
      confidence: 0.3,
    });

    const entries = buildDomainDiagnostics(pinnedNow);
    const domains = entries.map((e) => e.domain).sort();
    expect(domains).toEqual([
      'alpha.example.com',
      'bravo.example.com',
      'charlie.example.com',
      'delta.example.com',
      'echo.example.com',
    ]);

    const alpha = entries.find((e) => e.domain === 'alpha.example.com');
    expect(alpha?.hasActiveProfile).toBe(true);
    expect(alpha?.sitemapUrlsCount).toBe(0);
    expect(alpha?.sitemapStale).toBe(false);
    expect(alpha?.healthStatus).toBe('unknown');
    expect(alpha?.brandAssociations).toEqual([]);
    expect(alpha?.generationCount).toBe(0);

    const bravo = entries.find((e) => e.domain === 'bravo.example.com');
    expect(bravo?.hasActiveProfile).toBe(false);
    expect(bravo?.sitemapUrlsCount).toBe(1);
    expect(bravo?.sitemapFetchedAt).toBeTruthy();
    expect(bravo?.healthStatus).toBe('unknown');

    const charlie = entries.find((e) => e.domain === 'charlie.example.com');
    expect(charlie?.hasActiveProfile).toBe(false);
    expect(charlie?.sitemapUrlsCount).toBe(0);
    expect(charlie?.healthStatus).toBe('ok');
    expect(charlie?.healthReason).toBe('reachable');

    const delta = entries.find((e) => e.domain === 'delta.example.com');
    expect(delta?.brandAssociations.length).toBe(1);
    expect(delta?.brandAssociations[0]?.brandName).toBe('delta corp');

    const echo = entries.find((e) => e.domain === 'echo.example.com');
    expect(echo?.generationCount).toBe(1);
    expect(echo?.latestGenerationStatus).toBe('proposed');
    expect(echo?.latestGenerationAt).toBeTruthy();
  });

  test('one domain with all sources populates every field', () => {
    const db = getDb();
    db.query('DELETE FROM extractor_profiles').run();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM domain_status').run();
    db.query('DELETE FROM sitemap_cache').run();
    db.query('DELETE FROM profile_generations').run();

    const domain = 'full.example.com';
    const profile = upsertProfile(domain, {
      titleSelector: 'h1.title',
      priceSelector: 'span.price',
    });
    upsertBrandSite('full brand', domain);
    recordDomainStatus(domain, 'ok', '200 OK');
    insertSitemapCache(
      domain,
      ['https://full.example.com/p1', 'https://full.example.com/p2'],
      'https://full.example.com/sitemap.xml',
    );
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://full.example.com/p1',
      selectors: { titleSelector: 'h1' },
      status: 'validated',
      confidence: 0.8,
    });

    const entries = buildDomainDiagnostics(pinnedNow);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.domain).toBe(domain);
    expect(entry.hasActiveProfile).toBe(true);
    expect(entry.activeProfileId).toBe(profile.id);
    expect(entry.profileUpdatedAt).toBeTruthy();
    expect(entry.sitemapUrlsCount).toBe(2);
    expect(entry.sitemapFetchedAt).toBeTruthy();
    expect(entry.sitemapExpiresAt).toBeTruthy();
    expect(entry.sitemapSourceUrl).toBe('https://full.example.com/sitemap.xml');
    // The cache TTL is 24h, and pinnedNow is well before expiry.
    expect(entry.sitemapStale).toBe(false);
    expect(entry.healthStatus).toBe('ok');
    expect(entry.healthReason).toBe('200 OK');
    // The recorded checked_at is "now" (== pinnedNow), so freshness
    // is well within the 7-day window.
    expect(entry.healthStale).toBe(false);
    expect(entry.brandAssociations.length).toBe(1);
    expect(entry.brandAssociations[0]?.brandName).toBe('full brand');
    expect(entry.generationCount).toBe(1);
    expect(entry.latestGenerationStatus).toBe('validated');
    expect(entry.latestGenerationAt).toBeTruthy();
  });

  test('stale sitemap and stale health rows are flagged but remain in the DB', () => {
    const db = getDb();
    db.query('DELETE FROM extractor_profiles').run();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM domain_status').run();
    db.query('DELETE FROM sitemap_cache').run();
    db.query('DELETE FROM profile_generations').run();

    const domain = 'stale.example.com';

    // Sitemap row: insert with 1ms TTL (already expired) and
    // rewind fetched_at/expires_at so it is clearly old relative
    // to the pinned `now` used in the diagnostics call.
    insertSitemapCache(
      domain,
      ['https://stale.example.com/p1', 'https://stale.example.com/p2'],
      'https://stale.example.com/sitemap.xml',
      1,
    );
    const oneDayBeforePinnedNow = new Date(
      pinnedNow.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    db.query(
      'UPDATE sitemap_cache SET fetched_at = ?, expires_at = ? WHERE domain = ?',
    ).run(oneDayBeforePinnedNow, oneDayBeforePinnedNow, domain);

    // Health row: rewind checked_at to 30 days ago relative to pinnedNow.
    recordDomainStatus(domain, 'blocked', 'old block');
    const thirtyDaysAgo = new Date(pinnedNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.query('UPDATE domain_status SET checked_at = ? WHERE domain = ?').run(
      thirtyDaysAgo,
      domain,
    );

    // Run the diagnostics service — must be a no-op for these rows.
    const entries = buildDomainDiagnostics(pinnedNow);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.domain).toBe(domain);
    expect(entry.sitemapStale).toBe(true);
    expect(entry.sitemapUrlsCount).toBe(2);
    expect(entry.healthStale).toBe(true);
    expect(entry.healthStatus).toBe('blocked');
    expect(entry.healthReason).toBe('old block');

    // Critical: neither table lost its row.
    const sitemapRows = listAllSitemapCaches();
    expect(sitemapRows.find((r) => r.domain === domain)).toBeDefined();
    const healthRows = listAllDomainStatuses();
    expect(healthRows.find((r) => r.domain === domain)).toBeDefined();

    // For contrast: getCachedSitemapUrls() WOULD have deleted the
    // sitemap row, and getDomainStatus() WOULD have deleted the
    // health row. The test proves the diagnostics path does not.
    // Use the real wall-clock `new Date()` so the destructive
    // getters see the row as expired (expires_at is 1 day before
    // pinnedNow, which is also well in the past vs. real time).
    expect(getCachedSitemapUrls(domain)).toBeNull();
    expect(getDomainStatus(domain)).toBeNull();

    // And after the destructive getters, the diagnostics snapshot
    // no longer surfaces the deleted domain (which is expected
    // because the data really is gone now). We re-run diagnostics
    // for completeness.
    const afterEvict = buildDomainDiagnostics(pinnedNow);
    expect(afterEvict.find((e) => e.domain === domain)).toBeUndefined();

    // Sanity: the generation table is still untouched.
    expect(listAllProfileGenerations().length).toBe(0);
  });
});
