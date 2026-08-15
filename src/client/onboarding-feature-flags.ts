/**
 * Epic #46 Phase 9 — rollout feature flags for the onboarding operator UX.
 *
 * - `batchWorkspaceEnabled`: the Batch Workspace (Needs Attention / Review /
 *   Approved operating model) is the default operator surface. Enabled unless
 *   `VITE_BATCH_WORKSPACE_ENABLED` is explicitly 'false'.
 * - `pipelineDiagnosticsEnabled`: the legacy six-stage Pipeline Board remains
 *   reachable as a diagnostics/admin surface (`?board=pipeline`). Enabled
 *   unless `VITE_PIPELINE_DIAGNOSTICS_ENABLED` is explicitly 'false'.
 *
 * Computed once at module load so the SPA cannot flip mid-session.
 */
export interface OnboardingFeatureFlags {
  /** Batch Workspace is the primary operator surface. */
  batchWorkspaceEnabled: boolean;
  /** Raw six-stage pipeline board stays available for diagnostics. */
  pipelineDiagnosticsEnabled: boolean;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = import.meta.env?.[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return raw !== 'false' && raw !== '0' && raw.toLowerCase() !== 'no';
}

const CACHED_FLAGS: OnboardingFeatureFlags = {
  batchWorkspaceEnabled: envFlag('VITE_BATCH_WORKSPACE_ENABLED', true),
  pipelineDiagnosticsEnabled: envFlag('VITE_PIPELINE_DIAGNOSTICS_ENABLED', true),
};

/** Feature flags that gate the onboarding operator surfaces (computed once). */
export function getOnboardingFeatureFlags(): OnboardingFeatureFlags {
  return CACHED_FLAGS;
}