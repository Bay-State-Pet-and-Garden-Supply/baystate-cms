/**
 * Cohort-centric Curation V2 runtime feature flags (issue #30, PR3 M1).
 *
 * Rollout: v0.3.0 default was OFF (shadow uses legacy per-item path).
 * After shadow validation (#30 PR12), new batches default to cohort-active
 * (issue #30 rollout commitment) — byte-identical legacy remains available
 * via flags OFF / kill-switch for rollback. Flags can be flipped at
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
 * PR5 note (issue #30): the effective-type path is active-mode-only BY
 * CONSTRUCTION, so no new flag is added. Only active runs
 * (`cohortCurationV2Enabled && !cohortShadowOnly`) freeze a cohort Execution
 * Product Type; the two attribute-applicability stages then fall back to it
 * behind the reviewed Primary Product Type (reviewed-first / execution
 * fallback), and the executor stamps type dependency rows with separate kinds
 * on `field_assignment` proposals only — `execution_product_type` for
 * execution-driven members, `reviewed_product_type` for reviewed-driven ones
 * (PR5 hardening, issue #30 P2). Flag OFF and shadow runs never carry a
 * cohort execution type, so stage gating, dependency rows, and
 * `curation_data_json` stay byte-identical to PR4/legacy.
 *
 * PR6 note (issue #30): the durable parent title op
 * (`ensureCohortTitlesCoordinated`) runs ONLY inside `processCohort`, which
 * is active-mode-only by construction — no new flag is added. Prepared
 * members consume the persisted `classification_cohort_outputs`
 * (`curated_title`) at the `preComputedTitle` seam and NEVER call the
 * coordinator; `cohortCache` remains the legacy/flag-OFF/shadow authority
 * (byte-identical there). Flag OFF and shadow runs never create cohort
 * output rows and never run the parent op.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/30
 */

export interface CohortCurationFlags {
  /** Master switch: when false, all cohort V2 Curation paths are disabled. */
  cohortCurationV2Enabled: boolean;
  /** Shadow mode: observe cohort claiming/readiness without installing the
   *  per-item claim barrier. Only meaningful while the master switch is ON. */
  cohortShadowOnly: boolean;
  /**
   * PR4 C5: cohort Execution Product Type confidence floor (0..1). A member's
   * resolved type contribution must clear this floor to count as a confident
   * cohort contribution (the per-member matcher's own
   * `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies first). Default 0.7 —
   * matches the per-SKU keyword floor. Env-overridable via
   * `BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR`; parsed per call, so
   * a restart/env change applies without a redeploy. The resolver invocation
   * sites (`src/onboarding/cohort-curator.ts` freeze + shadow observer) read
   * the effective value here instead of a hardcoded constant.
   */
  cohortProductTypeConfidenceFloor: number;
}

export const DEFAULT_COHORT_CURATION_FLAGS: CohortCurationFlags = {
  cohortCurationV2Enabled: true,
  cohortShadowOnly: false,
  cohortProductTypeConfidenceFloor: 0.7,
};

const COHORT_CURATION_FLAG_ENV: Record<keyof CohortCurationFlags, string> = {
  cohortCurationV2Enabled: 'BAYSTATE_CMS_COHORT_CURATION_V2',
  cohortShadowOnly: 'BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY',
  cohortProductTypeConfidenceFloor: 'BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR',
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

/**
 * Parse the env-derived numeric flags (PR4 C5 `cohortProductTypeConfidenceFloor`).
 * Unparseable values fall back to the default (fail closed); parseable values
 * are clamped to [0,1] — a confidence floor outside the unit interval is
 * meaningless and would silently distort aggregation.
 */
function parseNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
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
    cohortProductTypeConfidenceFloor: parseNumberEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortProductTypeConfidenceFloor],
      DEFAULT_COHORT_CURATION_FLAGS.cohortProductTypeConfidenceFloor,
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
