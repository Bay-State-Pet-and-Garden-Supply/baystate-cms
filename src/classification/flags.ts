/**
 * Cohort-centric Curation V2 runtime feature flags (issue #30, PR3 M1).
 *
 * Normal onboarding must continue to work when every flag is disabled
 * (the default — byte-identical legacy behavior). Flags can be flipped at
 * runtime without a redeploy:
 * - environment variables are re-read on every `loadCohortCurationFlags()`
 *   call, so a process restart or env change applies without code changes;
 * - `overrideCohortCurationFlags()` swaps the effective values in memory
 *   (used by tests today, by a settings surface later).
 *
 * Flag semantics (implementation-plan section A):
 * - OFF: the legacy per-SKU Curation path runs unchanged; every new cohort
 *   read is gated per-call and inert.
 * - ON: Curation is cohort-claimed EXCLUSIVELY (M3) — `poll()` stops calling
 *   `claimItemsForProcessing('curation', ...)`; ownership flows
 *   refreshCandidateCohorts → reconcile → claimReadyCurationCohorts →
 *   processCohort. `cohortShadowOnly` observes without installing the claim
 *   barrier.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/30
 */

export interface CohortCurationFlags {
  /** Master switch: when false, all cohort V2 Curation paths are disabled. */
  cohortCurationV2Enabled: boolean;
  /** Shadow mode: observe cohort claiming/readiness without installing the
   *  per-item claim barrier. Only meaningful while the master switch is ON. */
  cohortShadowOnly: boolean;
}

export const DEFAULT_COHORT_CURATION_FLAGS: CohortCurationFlags = {
  cohortCurationV2Enabled: false,
  cohortShadowOnly: true,
};

const COHORT_CURATION_FLAG_ENV: Record<keyof CohortCurationFlags, string> = {
  cohortCurationV2Enabled: 'BAYSTATE_CMS_COHORT_CURATION_V2',
  cohortShadowOnly: 'BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY',
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

export function loadCohortCurationFlags(
  env: Record<string, string | undefined> = process.env,
): CohortCurationFlags {
  return {
    cohortCurationV2Enabled: parseBooleanEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortCurationV2Enabled],
      DEFAULT_COHORT_CURATION_FLAGS.cohortCurationV2Enabled,
    ),
    cohortShadowOnly: parseBooleanEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortShadowOnly],
      DEFAULT_COHORT_CURATION_FLAGS.cohortShadowOnly,
    ),
  };
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<CohortCurationFlags> | null = null;

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideCohortCurationFlags(next: Partial<CohortCurationFlags>): CohortCurationFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getCohortCurationFlags();
}

/** Clear any in-memory override. */
export function resetCohortCurationFlagsOverride(): void {
  runtimeOverride = null;
}

/**
 * Effective flags: env-derived defaults merged with the in-memory override.
 * Read per call so a config change applies without a redeploy.
 */
export function getCohortCurationFlags(): CohortCurationFlags {
  const base = loadCohortCurationFlags();
  return runtimeOverride ? { ...base, ...runtimeOverride } : base;
}
