/**
 * Product Intelligence runtime feature flags (PI-1).
 *
 * Normal onboarding must continue to work when every flag is disabled
 * (the default). Flags can be flipped at runtime without a redeploy:
 * - environment variables are re-read on every `loadProductIntelligenceFlags()`
 *   call, so a process restart or env change applies without code changes;
 * - `overrideProductIntelligenceFlags()` swaps the effective values in memory
 *   (used by tests today, by a settings surface later).
 *
 * Flag names mirror the issue's naming: productIntelligence.*
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */

export interface ProductIntelligenceFlags {
  /** Master switch: when false, all Product Intelligence paths are disabled. */
  productIntelligenceEnabled: boolean;
  /** Allow Pi-backed execution. When false, only the legacy executor may run. */
  piEnabled: boolean;
  /** Shadow mode: runs may execute but results can never be imported/promoted. */
  shadowOnly: boolean;
  /** Allow importing reviewed Agent Lab results into onboarding items. */
  allowOnboardingImport: boolean;
  /** Allow batch runs (multiple products in one launch). */
  allowBatchRuns: boolean;
  /** Global kill switch: forces the legacy pipeline everywhere (PI-9). */
  killSwitch: boolean;
}

export const DEFAULT_PRODUCT_INTELLIGENCE_FLAGS: ProductIntelligenceFlags = {
  productIntelligenceEnabled: false,
  piEnabled: false,
  shadowOnly: true,
  allowOnboardingImport: false,
  allowBatchRuns: false,
  killSwitch: false,
};

export const PRODUCT_INTELLIGENCE_FLAG_ENV: Record<keyof ProductIntelligenceFlags, string> = {
  productIntelligenceEnabled: 'BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED',
  piEnabled: 'BAYSTATE_CMS_PI_ENABLED',
  shadowOnly: 'BAYSTATE_CMS_PI_SHADOW_ONLY',
  allowOnboardingImport: 'BAYSTATE_CMS_PI_ALLOW_ONBOARDING_IMPORT',
  allowBatchRuns: 'BAYSTATE_CMS_PI_ALLOW_BATCH_RUNS',
  killSwitch: 'BAYSTATE_CMS_PI_KILL_SWITCH',
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

export function loadProductIntelligenceFlags(
  env: Record<string, string | undefined> = process.env,
): ProductIntelligenceFlags {
  const flags: ProductIntelligenceFlags = {
    productIntelligenceEnabled: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.productIntelligenceEnabled],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.productIntelligenceEnabled,
    ),
    piEnabled: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.piEnabled],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.piEnabled,
    ),
    shadowOnly: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.shadowOnly],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.shadowOnly,
    ),
    allowOnboardingImport: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.allowOnboardingImport],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.allowOnboardingImport,
    ),
    allowBatchRuns: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.allowBatchRuns],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.allowBatchRuns,
    ),
    killSwitch: parseBooleanEnv(
      env[PRODUCT_INTELLIGENCE_FLAG_ENV.killSwitch],
      DEFAULT_PRODUCT_INTELLIGENCE_FLAGS.killSwitch,
    ),
  };
  return flags;
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<ProductIntelligenceFlags> | null = null;

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideProductIntelligenceFlags(
  next: Partial<ProductIntelligenceFlags>,
): ProductIntelligenceFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getProductIntelligenceFlags();
}

/** Clear any in-memory override. */
export function resetProductIntelligenceFlagsOverride(): void {
  runtimeOverride = null;
}

/**
 * Effective flags: env-derived defaults merged with the in-memory override.
 * Read per call so a config change applies without a redeploy.
 */
export function getProductIntelligenceFlags(): ProductIntelligenceFlags {
  const base = loadProductIntelligenceFlags();
  return runtimeOverride ? { ...base, ...runtimeOverride } : base;
}
