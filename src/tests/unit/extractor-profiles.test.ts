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

    // Update selectors
    const updated = upsertProfile(domain, {
      titleSelector: 'h2.new-title',
    });
    expect(updated.titleSelector).toBe('h2.new-title');
    expect(updated.priceSelector).toBeNull();
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
});
