// story: e35s10 — single source for onboarding settings tab shell (Brands merge)
// story: e08s03 — tab labels finalized: Brands = Strategy Hub, Sitemaps = raw inventory, Distributors = Connections infra
export type OnboardingSettingsTabId = 'curation' | 'profiles' | 'sitemaps' | 'distributors' | 'brands';

export interface OnboardingSettingsTabDef {
  id: OnboardingSettingsTabId;
  label: string;
}

export const ONBOARDING_SETTINGS_TABS: readonly OnboardingSettingsTabDef[] = [
  { id: 'curation', label: 'Curation' },
  { id: 'brands', label: 'Brands & Sourcing Strategy Hub' },
  { id: 'sitemaps', label: 'Sitemaps & Brand URL Index' },
  { id: 'distributors', label: 'Distributors' },
] as const;

const LEGACY_TO_BRANDS: Record<string, OnboardingSettingsTabId> = {
  profiles: 'brands',
};

export function isOnboardingSettingsTabId(value: string): value is OnboardingSettingsTabId {
  return ONBOARDING_SETTINGS_TABS.some((t) => t.id === value);
}

export function resolveOnboardingSettingsTab(input: string | null | undefined): OnboardingSettingsTabId {
  if (!input) return 'curation';
  const trimmed = input.trim();
  if (!trimmed) return 'curation';
  if (LEGACY_TO_BRANDS[trimmed]) return LEGACY_TO_BRANDS[trimmed];
  if (isOnboardingSettingsTabId(trimmed)) return trimmed as OnboardingSettingsTabId;
  return 'curation';
}

export function primaryOnboardingSettingsTabs(): readonly OnboardingSettingsTabDef[] {
  return ONBOARDING_SETTINGS_TABS;
}
