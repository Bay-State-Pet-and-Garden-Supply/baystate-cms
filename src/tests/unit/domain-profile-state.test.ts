import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection';
import { normalizeBrandHubDomain } from '../../onboarding/brand-hub/normalizeDomain';

// story: e06s01
describe('domain profile state (e06s01)', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM brand_url_index');
    db.exec('DELETE FROM extractor_profiles');
    db.exec('DELETE FROM brand_sites');
  });

  it('normalizes WWW, scheme, path variants identically', async () => {
    const { normalizeBrandHubDomain: n } = await import('../../onboarding/brand-hub/normalizeDomain');
    expect(n('WWW.EXAMPLE.COM/')).toBe('example.com');
    expect(n('https://www.example.com/path')).toBe('example.com');
    expect(n('https://EXAMPLE.com')).toBe('example.com');
    expect(n('example.com')).toBe('example.com');
  });

  it('GET profile-state returns identical header for variant domains', async () => {
    const { getDomainProfileState } = await import('../../db/repositories/domain-profile-state-repo');
    const db = getDb();
    // seed brand_site and profile and urls
    db.exec(`INSERT INTO brand_sites (id, brand_name, domain, success_count, created_at) VALUES ('b1','acme','example.com',1, datetime('now'))`);
    db.exec(`INSERT INTO extractor_profiles (id, domain, created_at, updated_at) VALUES ('p1','example.com', datetime('now'), datetime('now'))`);
    db.exec(`INSERT INTO brand_url_index (id, domain, url, path, slug, page_type, active, first_seen_at, last_seen_at, last_sitemap_refresh_at) VALUES ('u1','example.com','https://example.com/a','/a','a','product',1, datetime('now'), datetime('now'), datetime('now'))`);
    const a = getDomainProfileState('WWW.EXAMPLE.COM');
    const b = getDomainProfileState('https://www.example.com/path');
    expect(a.domain).toBe('example.com');
    expect(b.domain).toBe('example.com');
    expect(a.domain).toBe(b.domain);
    expect(a.activeVersion).toBe(b.activeVersion);
    expect(a.productCount).toBe(1);
  });

  it('returns header with brandAssociations, activeVersion, freshness, blockedCount', async () => {
    const { getDomainProfileState } = await import('../../db/repositories/domain-profile-state-repo');
    const db = getDb();
    db.exec(`INSERT INTO brand_sites (id, brand_name, domain, success_count, created_at) VALUES ('b2','acme','example.com',1, datetime('now'))`);
    db.exec(`INSERT INTO extractor_profiles (id, domain, title_selector, created_at, updated_at) VALUES ('p2','example.com','h1', datetime('now'), datetime('now'))`);
    db.exec(`INSERT INTO brand_url_index (id, domain, url, path, slug, page_type, active, first_seen_at, last_seen_at, last_sitemap_refresh_at) VALUES ('u2','example.com','https://example.com/p1','/p1','p1','product',1, datetime('now'), datetime('now'), datetime('now'))`);
    const state = getDomainProfileState('example.com');
    expect(state.domain).toBe('example.com');
    expect(state.brandAssociations).toContain('acme');
    expect(state.activeVersion).not.toBeNull();
    expect(state.freshness).not.toBeNull();
    expect(typeof state.blockedCount).toBe('number');
    expect(typeof state.productCount).toBe('number');
  });
});
