import { describe, it, expect } from 'vitest';

// story: e35s10 — tab registry is single source for Brands merge (profiles|sitemaps → brands)

describe('onboarding settings tab registry (e35s10)', () => {
  it('contains Brands tab and maps legacy profiles/sitemaps to brands', async () => {
    const mod = await import('../../client/components/onboarding-settings/tabRegistry');
    const { ONBOARDING_SETTINGS_TABS, resolveOnboardingSettingsTab } = mod as any;

    expect(Array.isArray(ONBOARDING_SETTINGS_TABS)).toBe(true);
    const ids = ONBOARDING_SETTINGS_TABS.map((t: any) => t.id);
    expect(ids).toContain('brands');
    // legacy tabs no longer primary but alias to brands via resolver
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('brands');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
    // non-legacy passthrough
    expect(resolveOnboardingSettingsTab('general')).toBe('general');
    expect(resolveOnboardingSettingsTab('distributors')).toBe('distributors');
  });

  it('brands tab is labeled for domain-centric hub', async () => {
    const { ONBOARDING_SETTINGS_TABS } = await import('../../client/components/onboarding-settings/tabRegistry') as any;
    const brands = ONBOARDING_SETTINGS_TABS.find((t: any) => t.id === 'brands');
    expect(brands).toBeDefined();
    expect(typeof brands.label).toBe('string');
    expect(brands.label.length).toBeGreaterThan(0);
  });
});
