// @vitest-environment node
/**
 * Epic #46 Phase 9 — onboarding rollout feature-flag tests.
 *
 * Defaults are ON (enabled unless the env var is explicitly 'false'), so the
 * Batch Workspace is the operator surface out of the box and the Pipeline
 * diagnostics escape hatch stays reachable.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const FLAG_MODULE = '../../client/onboarding-feature-flags';

async function loadFlags() {
  vi.resetModules();
  const mod = await import(FLAG_MODULE);
  return mod.getOnboardingFeatureFlags() as {
    batchWorkspaceEnabled: boolean;
    pipelineDiagnosticsEnabled: boolean;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getOnboardingFeatureFlags', () => {
  it('defaults both surfaces to enabled (no env vars set)', async () => {
    const flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(true);
    expect(flags.pipelineDiagnosticsEnabled).toBe(true);
  });

  it('respects explicit "false" for the batch workspace flag', async () => {
    vi.stubEnv('VITE_BATCH_WORKSPACE_ENABLED', 'false');
    const flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(false);
    expect(flags.pipelineDiagnosticsEnabled).toBe(true);
  });

  it('respects explicit "false" for the pipeline diagnostics flag', async () => {
    vi.stubEnv('VITE_PIPELINE_DIAGNOSTICS_ENABLED', 'false');
    const flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(true);
    expect(flags.pipelineDiagnosticsEnabled).toBe(false);
  });

  it('treats empty / "0" / "no" as disabled and anything else as enabled', async () => {
    vi.stubEnv('VITE_BATCH_WORKSPACE_ENABLED', '0');
    let flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(false);

    vi.stubEnv('VITE_BATCH_WORKSPACE_ENABLED', 'no');
    flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(false);

    vi.stubEnv('VITE_BATCH_WORKSPACE_ENABLED', '');
    flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(true);

    vi.stubEnv('VITE_BATCH_WORKSPACE_ENABLED', '1');
    flags = await loadFlags();
    expect(flags.batchWorkspaceEnabled).toBe(true);
  });
});