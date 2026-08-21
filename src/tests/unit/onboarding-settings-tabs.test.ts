import { describe, it, expect } from 'vitest';

// story: e35s10 — tab registry is single source for Brands merge (profiles|sitemaps → brands)

describe('onboarding settings tab registry (e35s10)', () => {
  it('contains Brands tab and maps legacy profiles to brands; sitemaps is now primary (e08s03)', async () => {
    const mod = await import('../../client/components/onboarding-settings/tabRegistry');
    const { ONBOARDING_SETTINGS_TABS, resolveOnboardingSettingsTab } = mod as any;

    expect(Array.isArray(ONBOARDING_SETTINGS_TABS)).toBe(true);
    const ids = ONBOARDING_SETTINGS_TABS.map((t: any) => t.id);
    expect(ids).toContain('brands');
    expect(ids).toContain('sitemaps');
    // profiles still aliases to brands; sitemaps is now distinct primary
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('sitemaps');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
    // non-legacy passthrough
    expect(resolveOnboardingSettingsTab('general')).toBe('general');
    expect(resolveOnboardingSettingsTab('distributors')).toBe('distributors');
  });

  it('brands tab is labeled as Strategy Hub and sitemaps as raw inventory (e08s03)', async () => {
    const { ONBOARDING_SETTINGS_TABS } = await import('../../client/components/onboarding-settings/tabRegistry') as any;
    const brands = ONBOARDING_SETTINGS_TABS.find((t: any) => t.id === 'brands');
    expect(brands).toBeDefined();
    expect(brands.label).toContain('Brands');
    expect(brands.label).toContain('Sourcing');
    const sitemaps = ONBOARDING_SETTINGS_TABS.find((t: any) => t.id === 'sitemaps');
    expect(sitemaps.label).toContain('Sitemaps');
    expect(sitemaps.label).toContain('Brand URL Index');
  });
});
