// story: e35s10 — Commit 15 RED: legacy tabs should be retired to Brands alias
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_SETTINGS_TABS,
  primaryOnboardingSettingsTabs,
  resolveOnboardingSettingsTab,
} from '../../client/components/onboarding-settings/tabRegistry';

describe('brand hub tab retirement — legacy profiles|sitemaps alias to brands', () => {
  it('primary tabs are only general|curation|brands|distributors (legacy retired from bar)', () => {
    const primaryIds = primaryOnboardingSettingsTabs().map((t) => t.id);
    expect(primaryIds).toEqual(['general', 'curation', 'brands', 'distributors']);
    expect(primaryIds).not.toContain('profiles');
    expect(primaryIds).not.toContain('sitemaps');
  });

  it('ONBOARDING_SETTINGS_TABS no longer contains legacy entries (alias-only via resolver)', () => {
    // shrink-wrapped: legacy tabs removed from registry; alias via LEGACY_TO_BRANDS only
    const allIds = ONBOARDING_SETTINGS_TABS.map((t) => t.id);
    expect(allIds).not.toContain('profiles');
    expect(allIds).not.toContain('sitemaps');
    expect(allIds).toContain('brands');
  });

  it('resolveOnboardingSettingsTab maps legacy to brands before state init', () => {
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('brands');
    expect(resolveOnboardingSettingsTab('  profiles  ')).toBe('brands');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
  });

  it('resolve keeps general and distributors intact', () => {
    expect(resolveOnboardingSettingsTab('general')).toBe('general');
    expect(resolveOnboardingSettingsTab('distributors')).toBe('distributors');
  });
});
