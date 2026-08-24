/**
 * Client feature flags for the onboarding operator + review surfaces.
 *
 * - `batchWorkspaceEnabled`: the Batch Workspace (Needs Attention / Review /
 *   Approved operating model) is the default operator surface. Enabled unless
 *   `VITE_BATCH_WORKSPACE_ENABLED` is explicitly 'false'.
 * - `pipelineDiagnosticsEnabled`: the legacy six-stage Pipeline Board remains
 *   reachable as a diagnostics/admin surface (`?board=pipeline`). Enabled
 *   unless `VITE_PIPELINE_DIAGNOSTICS_ENABLED` is explicitly 'false'.
 *   e10s05 retirement policy: the board itself STAYS; only the legacy
 *   ReviewDrawerShell is frozen bug-fix-only and retired post-default-on.
 * - `reviewUiV2`: gates the full-field review form, readiness checklist, and
 *   confirmation step (e10s02/s03, epic #review-final-gate). Flag OFF ⇒ the
 *   review workspace renders exactly the pre-V2 component tree and sends the
 *   legacy update payload PLUS curatedWeight write-back (the V1 Weight editor
 *   must persist; convertToLbs is idempotent so rollback stays safe). Default
 *   OFF.
 *
 * Env values are computed once at module load so the SPA cannot flip
 * mid-session. Kill-switch values ('false' | '0' | 'no') disable; any other
 * non-empty value enables; empty/undefined ⇒ per-flag default.
 * Tests can force values with `overrideOnboardingFeatureFlags`.
 */
export interface OnboardingFeatureFlags {
  /** Batch Workspace is the primary operator surface. */
  batchWorkspaceEnabled: boolean;
  /** Raw six-stage pipeline board stays available for diagnostics. */
  pipelineDiagnosticsEnabled: boolean;
  /** Full-field review form + readiness gating + confirm step (e10s02/s03). */
  reviewUiV2: boolean;
}

function readViteEnv(): Record<string, string | undefined> {
  // Guarded: unit tests may run outside Vite's import.meta.env injection.
  try {
    return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
  } catch {
    return {};
  }
}

/**
 * Kill-switch parser. Exported for the plan-mandated truth-table test
 * (specs/review-ui-rebuild-plan.md §tests): 'false'|'0'|'no' disable,
 * any other non-empty value enables, empty/undefined ⇒ default.
 */
export function parseEnvFlag(raw: string | undefined | null, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) return defaultValue;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === '') return defaultValue;
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
  return true;
}

const ENV = readViteEnv();

/** Env-derived defaults — computed once at module load (SPA cannot flip mid-session). */
const CACHED_ENV_FLAGS: OnboardingFeatureFlags = {
  batchWorkspaceEnabled: parseEnvFlag(ENV.VITE_BATCH_WORKSPACE_ENABLED, true),
  pipelineDiagnosticsEnabled: parseEnvFlag(ENV.VITE_PIPELINE_DIAGNOSTICS_ENABLED, true),
  reviewUiV2: parseEnvFlag(ENV.VITE_REVIEW_UI_V2, false),
};

let overrides: Partial<OnboardingFeatureFlags> = {};

/** Force flag values for tests / emergency in-session overrides. */
export function overrideOnboardingFeatureFlags(patch: Partial<OnboardingFeatureFlags>): void {
  overrides = { ...overrides, ...patch };
}

/** Clear any forced flag values (test cleanup). */
export function resetOnboardingFeatureFlags(): void {
  overrides = {};
}

export function getOnboardingFeatureFlags(): OnboardingFeatureFlags {
  return {
    batchWorkspaceEnabled: overrides.batchWorkspaceEnabled ?? CACHED_ENV_FLAGS.batchWorkspaceEnabled,
    pipelineDiagnosticsEnabled:
      overrides.pipelineDiagnosticsEnabled ?? CACHED_ENV_FLAGS.pipelineDiagnosticsEnabled,
    reviewUiV2: overrides.reviewUiV2 ?? CACHED_ENV_FLAGS.reviewUiV2,
  };
}
