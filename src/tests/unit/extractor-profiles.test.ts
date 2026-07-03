import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  upsertProfile,
  findProfileByDomain,
  listAllProfiles,
  deleteProfile
} from '../../db/repositories/extractor-profile-repo';

describe('Extractor Profiles CRUD', () => {
  const testDbPath = 'src/tests/unit/extractor-profiles-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('should support upserting and finding extractor profiles', () => {
    const domain = 'testwoof.com';
    const profile = upsertProfile(domain, {
      titleSelector: 'h1.test-title',
      priceSelector: '.test-price',
      descriptionSelector: '.test-desc',
      brandSelector: '.test-brand',
      imagesSelector: 'img.test-img',
    });

    expect(profile.id).toBeDefined();
    expect(profile.domain).toBe('testwoof.com');
    expect(profile.titleSelector).toBe('h1.test-title');
    expect(profile.priceSelector).toBe('.test-price');

    const found = findProfileByDomain('www.testwoof.com');
    expect(found).not.toBeNull();
    expect(found?.titleSelector).toBe('h1.test-title');
  });

  test('partial update with undefined selectors must preserve existing values', () => {
    const domain = 'merge-keep.com';
    upsertProfile(domain, {
      titleSelector: 'h1.test-title',
      priceSelector: '.test-price',
      descriptionSelector: '.test-desc',
      brandSelector: '.test-brand',
      imagesSelector: 'img.test-img',
    });

    // Update only one selector; all others must be preserved.
    const updated = upsertProfile(domain, {
      titleSelector: 'h2.new-title',
    });
    expect(updated.titleSelector).toBe('h2.new-title');
    // Existing selectors are preserved, not nulled out.
    expect(updated.priceSelector).toBe('.test-price');
    expect(updated.descriptionSelector).toBe('.test-desc');
    expect(updated.brandSelector).toBe('.test-brand');
    expect(updated.imagesSelector).toBe('img.test-img');

    const refetched = findProfileByDomain(domain);
    expect(refetched?.priceSelector).toBe('.test-price');
    expect(refetched?.imagesSelector).toBe('img.test-img');
  });

  test('explicit null selector clears that selector and preserves others', () => {
    const domain = 'merge-clear.com';
    upsertProfile(domain, {
      titleSelector: 'h1.test-title',
      priceSelector: '.test-price',
      descriptionSelector: '.test-desc',
      brandSelector: '.test-brand',
      imagesSelector: 'img.test-img',
    });

    // Explicitly null out the price selector; everything else must remain.
    const updated = upsertProfile(domain, {
      priceSelector: null,
    });
    expect(updated.priceSelector).toBeNull();
    expect(updated.titleSelector).toBe('h1.test-title');
    expect(updated.descriptionSelector).toBe('.test-desc');
    expect(updated.brandSelector).toBe('.test-brand');
    expect(updated.imagesSelector).toBe('img.test-img');
  });

  test('new profile defaults omitted selectors to null', () => {
    const domain = 'fresh-merge.com';
    const profile = upsertProfile(domain, {
      titleSelector: 'h1.fresh',
    });
    expect(profile.titleSelector).toBe('h1.fresh');
    expect(profile.priceSelector).toBeNull();
    expect(profile.descriptionSelector).toBeNull();
    expect(profile.brandSelector).toBeNull();
    expect(profile.imagesSelector).toBeNull();
  });

  test('should list and delete profiles', () => {
    const list = listAllProfiles();
    expect(list.length).toBeGreaterThan(0);

    const match = list.find(p => p.domain === 'testwoof.com');
    expect(match).toBeDefined();

    const deleted = deleteProfile(match!.id);
    expect(deleted).toBe(true);

    const foundAfter = findProfileByDomain('testwoof.com');
    expect(foundAfter).toBeNull();
  });

  test('sitemapProductUrlPattern defaults to null on a new profile', () => {
    const domain = 'sitemap-fresh.com';
    const profile = upsertProfile(domain, {
      titleSelector: 'h1',
    });
    expect(profile.sitemapProductUrlPattern).toBeNull();
  });

  test('sitemapProductUrlPattern round-trips on insert and update', () => {
    const domain = 'sitemap-rt.com';
    const created = upsertProfile(domain, {
      titleSelector: 'h1',
      sitemapProductUrlPattern: 'https://sitemap-rt.com/products/.*',
    });
    expect(created.sitemapProductUrlPattern).toBe(
      'https://sitemap-rt.com/products/.*',
    );

    const refetched = findProfileByDomain(domain);
    expect(refetched?.sitemapProductUrlPattern).toBe(
      'https://sitemap-rt.com/products/.*',
    );
  });

  test('partial update with undefined sitemapProductUrlPattern preserves the existing value', () => {
    const domain = 'sitemap-keep.com';
    upsertProfile(domain, {
      titleSelector: 'h1',
      sitemapProductUrlPattern: 'https://sitemap-keep.com/p/.*',
    });

    const updated = upsertProfile(domain, {
      titleSelector: 'h2',
      // sitemapProductUrlPattern omitted → must be preserved
    });
    expect(updated.titleSelector).toBe('h2');
    expect(updated.sitemapProductUrlPattern).toBe(
      'https://sitemap-keep.com/p/.*',
    );
  });

  test('explicit null sitemapProductUrlPattern clears the value and preserves other selectors', () => {
    const domain = 'sitemap-clear.com';
    upsertProfile(domain, {
      titleSelector: 'h1',
      priceSelector: '.price',
      sitemapProductUrlPattern: 'https://sitemap-clear.com/x/.*',
    });

    const updated = upsertProfile(domain, {
      sitemapProductUrlPattern: null,
    });
    expect(updated.sitemapProductUrlPattern).toBeNull();
    expect(updated.titleSelector).toBe('h1');
    expect(updated.priceSelector).toBe('.price');
  });
});
