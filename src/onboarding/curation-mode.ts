/**
 * Feature flag for modular (classification pipeline) curation.
 *
 * Controls whether `OnboardingWorker.processCuration()` calls the legacy
 * `curateItem()` or the modular `curateItemWithPipeline()` path.
 *
 * Default: disabled (legacy path).
 * Enabled values (case-insensitive): true, 1, yes, on
 * Disabled values: unset, empty, false, 0, no, any unrecognized value
 */

const ENABLED_VALUES = new Set(['true', '1', 'yes', 'on']);

/**
 * Check whether modular curation is enabled via environment variable.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns true if modular curation should be used
 */
export function isModularCurationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SHOPSITE_CMS_MODULAR_CURATION_ENABLED;
  if (!raw || raw.trim().length === 0) return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}
