// story: e35s10 — Commit 16 RED: flag-free brands tab shrink-wrap
import { describe, it, expect } from 'vitest';

describe('brand hub flag cleanup — shrink-wrap parallel tabs (e35s10)', () => {
  it('ONBOARDING_SETTINGS_TABS is flag-free and contains only primary tabs (4)', async () => {
    const mod = await import('../../client/components/onboarding-settings/tabRegistry');
    const { ONBOARDING_SETTINGS_TABS } = mod as any;
    const ids: string[] = ONBOARDING_SETTINGS_TABS.map((t: any) => t.id);
    // shrink-wrap: after parallel phase, only 4 definitions remain; legacy alias via resolver only
    expect(ids).toEqual(['general', 'curation', 'brands', 'distributors']);
    expect(ids).not.toContain('profiles');
    expect(ids).not.toContain('sitemaps');
  });

  it('primaryOnboardingSettingsTabs renders Brands without flag env', async () => {
    const { primaryOnboardingSettingsTabs } = await import('../../client/components/onboarding-settings/tabRegistry');
    const primary = primaryOnboardingSettingsTabs();
    const ids = primary.map((t: any) => t.id);
    expect(ids).toEqual(['general', 'curation', 'brands', 'distributors']);
    expect(ids).toContain('brands');
  });

  it('tabRegistry has no feature-flag conditional for brands', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding-settings/tabRegistry.ts', 'utf8');
    expect(content).not.toMatch(/BAYSTATE_CMS_BRAND_HUB|feature.*flag|process\.env/i);
    expect(content).toContain('LEGACY_TO_BRANDS');
  });
});
