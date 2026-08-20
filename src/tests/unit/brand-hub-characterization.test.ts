// story: e35s10 — Commit 18 GREEN: hub characterization suite guards tab shell + unified add + discovery ladder
import { describe, it, expect } from 'vitest';

describe('brand hub characterization — tab shell + unified add + discovery ladder (e35s10)', () => {
  it('resolves legacy settingsTab profiles|sitemaps to brands via tabRegistry', async () => {
    const { resolveOnboardingSettingsTab } = await import('../../client/components/onboarding-settings/tabRegistry');
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('brands');
    expect(resolveOnboardingSettingsTab('  profiles  ')).toBe('brands');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
  });

  it('unified Add Brand payload normalizes once and does not fabricate empty profile', async () => {
    const { buildUnifiedAddPayload } = await import('../../onboarding/brand-hub/unifiedAdd');
    const payload = buildUnifiedAddPayload({ rawDomain: '  WWW.Purina.COM  ', brandName: '  Purina  ', fetchNow: true });
    expect(payload.normalizedDomain).toBe('purina.com');
    expect(payload.shouldCreateProfile).toBe(false);
    expect(payload.isValid).toBe(true);
    expect(payload.shouldPersistBrandSite).toBe(true);
  });

  it('discovery ladder seam remains read-only: deriveBrandHubRow does not fabricate profile and preserves counts', async () => {
    const { deriveBrandHubRow } = await import('../../onboarding/brand-hub/view-model');
    const row = deriveBrandHubRow({
      domain: 'WWW.Example.COM',
      profile: null,
      urlCounts: { totalCount: 10, activeCount: 8, inactiveCount: 2, productCount: 5 },
      health: null,
      brandSites: [],
    });
    expect(row.normalizedDomain).toBe('example.com');
    expect(row.profile.exists).toBe(false);
    expect(row.profile.status).toBe('missing');
    expect(row.urlCounts.activeCount).toBe(8);
  });
});
