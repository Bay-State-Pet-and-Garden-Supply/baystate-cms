// story: e35s10 — Commit 16 RED: flag-free brands tab shrink-wrap
import { describe, it, expect } from 'vitest';

describe('brand hub flag cleanup — shrink-wrap parallel tabs (e35s10)', () => {
  it('ONBOARDING_SETTINGS_TABS is flag-free and contains only primary tabs (5)', async () => {
    const mod = await import('../../client/components/onboarding-settings/tabRegistry');
    const { ONBOARDING_SETTINGS_TABS } = mod as any;
    const ids: string[] = ONBOARDING_SETTINGS_TABS.map((t: any) => t.id);
    // e08: Brands Hub keeps sitemaps as raw inventory (5 tabs); legacy alias via resolver only for profiles
    expect(ids).toEqual(['general', 'curation', 'brands', 'sitemaps', 'distributors']);
    expect(ids).not.toContain('profiles');
    expect(ids).toContain('sitemaps');
  });

  it('primaryOnboardingSettingsTabs renders Brands without flag env', async () => {
    const { primaryOnboardingSettingsTabs } = await import('../../client/components/onboarding-settings/tabRegistry');
    const primary = primaryOnboardingSettingsTabs();
    const ids = primary.map((t: any) => t.id);
    expect(ids).toEqual(['general', 'curation', 'brands', 'sitemaps', 'distributors']);
    expect(ids).toContain('brands');
  });

  it('tabRegistry has no feature-flag conditional for brands', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding-settings/tabRegistry.ts', 'utf8');
    expect(content).not.toMatch(/BAYSTATE_CMS_BRAND_HUB|feature.*flag|process\.env/i);
    expect(content).toContain('LEGACY_TO_BRANDS');
  });
});
