// story: e35s10 — Commit 15 RED: legacy tabs should be retired to Brands alias
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_SETTINGS_TABS,
  primaryOnboardingSettingsTabs,
  resolveOnboardingSettingsTab,
} from '../../client/components/onboarding-settings/tabRegistry';

describe('brand hub tab retirement — legacy profiles alias to brands (e08s03: sitemaps is primary)', () => {
  it('primary tabs are general|curation|brands|sitemaps|distributors (sitemaps promoted, profiles retired)', () => {
    const primaryIds = primaryOnboardingSettingsTabs().map((t) => t.id);
    expect(primaryIds).toEqual(['general', 'curation', 'brands', 'sitemaps', 'distributors']);
    expect(primaryIds).not.toContain('profiles');
    expect(primaryIds).toContain('sitemaps');
  });

  it('ONBOARDING_SETTINGS_TABS no longer contains legacy profiles (alias-only via resolver)', () => {
    const allIds = ONBOARDING_SETTINGS_TABS.map((t) => t.id);
    expect(allIds).not.toContain('profiles');
    expect(allIds).toContain('sitemaps');
    expect(allIds).toContain('brands');
  });

  it('resolveOnboardingSettingsTab maps legacy profiles to brands; sitemaps is now primary', () => {
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('sitemaps');
    expect(resolveOnboardingSettingsTab('  profiles  ')).toBe('brands');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
  });

  it('resolve keeps general and distributors intact', () => {
    expect(resolveOnboardingSettingsTab('general')).toBe('general');
    expect(resolveOnboardingSettingsTab('distributors')).toBe('distributors');
  });
});
