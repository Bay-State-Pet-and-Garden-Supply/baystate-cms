import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// story: e35s10 — single canonical helper for domain normalization (shared between Add Site + Open Profile Builder)
describe('brand hub domain normalization (e35s10)', () => {
  it('canonical helper normalizes scheme/www/path/whitespace identically', async () => {
    const { normalizeBrandHubDomain } = await import('../../onboarding/brand-hub/normalizeDomain');
    expect(normalizeBrandHubDomain('WWW.Example.COM/')).toBe('example.com');
    expect(normalizeBrandHubDomain('https://www.acmepet.com/products/1')).toBe('acmepet.com');
    expect(normalizeBrandHubDomain('  https://www.Foo-Bar.COM/sitemap.xml  ')).toBe('foo-bar.com');
    expect(normalizeBrandHubDomain('acmepet.com')).toBe('acmepet.com');
    expect(normalizeBrandHubDomain('')).toBe('');
  });

  it('OnboardingSettings Open Profile Builder uses shared helper, not inline replace', () => {
    const file = resolve(process.cwd(), 'src/client/components/OnboardingSettings.tsx');
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('normalizeBrandHubDomain');
    // inline duplicate should be gone after GREEN
    // we expect no direct inline lowerCase+replace for workspaceDomain assignment that isn't via helper
    // This assertion checks that the helper is imported from brand-hub
    expect(src).toMatch(/from ['\"].*brand-hub.*normalizeDomain['\"]/);
  });

  it('SitemapHealthView AddSite flow uses shared helper or delegates to same canonical normalization', async () => {
    const file = resolve(process.cwd(), 'src/client/components/sitemap-health/SitemapHealthView.tsx');
    const src = readFileSync(file, 'utf8');
    // AddSite modal should either import helper or at least not duplicate inline normalization diverge
    // Minimal assertion: source contains normalizeBrandHubDomain or at minimum contains domain.trim pattern via helper delegation
    const usesHelper = src.includes('normalizeBrandHubDomain');
    const hasAddSite = src.includes('AddSiteModal') || src.includes('addSitemapDomain');
    expect(hasAddSite).toBe(true);
    // After GREEN this should be true; RED fails because helper not imported
    expect(usesHelper).toBe(true);
  });
});
