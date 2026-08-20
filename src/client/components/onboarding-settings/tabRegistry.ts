// story: e35s10 — single source for onboarding settings tab shell (Brands merge)
export type OnboardingSettingsTabId = 'general' | 'curation' | 'profiles' | 'sitemaps' | 'distributors' | 'brands';

export interface OnboardingSettingsTabDef {
  id: OnboardingSettingsTabId;
  label: string;
}

// story: e35s10 — shrink-wrapped registry; only primary tabs defined (legacy alias via resolver)
export const ONBOARDING_SETTINGS_TABS: readonly OnboardingSettingsTabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'curation', label: 'Curation' },
  { id: 'brands', label: 'Brands' },
  { id: 'distributors', label: 'Distributors' },
] as const;

const LEGACY_TO_BRANDS: Record<string, OnboardingSettingsTabId> = {
  profiles: 'brands',
  sitemaps: 'brands',
};

export function isOnboardingSettingsTabId(value: string): value is OnboardingSettingsTabId {
  return ONBOARDING_SETTINGS_TABS.some((t) => t.id === value);
}

export function resolveOnboardingSettingsTab(input: string | null | undefined): OnboardingSettingsTabId {
  if (!input) return 'general';
  const trimmed = input.trim();
  if (!trimmed) return 'general';
  if (LEGACY_TO_BRANDS[trimmed]) return LEGACY_TO_BRANDS[trimmed];
  if (isOnboardingSettingsTabId(trimmed)) return trimmed as OnboardingSettingsTabId;
  return 'general';
}

export function primaryOnboardingSettingsTabs(): readonly OnboardingSettingsTabDef[] {
  return ONBOARDING_SETTINGS_TABS;
}
