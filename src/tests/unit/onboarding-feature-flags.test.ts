// @vitest-environment node
// story: e10s02/e10s03/e10s05 — client onboarding feature flags
// e10s05 restores the epic #46 sibling flags (batchWorkspaceEnabled,
// pipelineDiagnosticsEnabled) alongside reviewUiV2 and pins the retirement
// policy: VITE_REVIEW_UI_V2=false ⇒ pre-epic behavior exactly; the Pipeline
// Board itself stays as a diagnostics surface behind VITE_PIPELINE_DIAGNOSTICS_ENABLED.
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOnboardingFeatureFlags,
  overrideOnboardingFeatureFlags,
  parseEnvFlag,
  resetOnboardingFeatureFlags,
} from '../../client/onboarding-feature-flags';

afterEach(() => {
  resetOnboardingFeatureFlags();
});

describe('onboarding feature flags // e10s02', () => {
  it('reviewUiV2 defaults to true (retirement: legacy drawer removed, post-default-on)', () => {
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
  });

  // e10s05: sibling epic #46 flags restored — defaults must match HEAD semantics.
  it('batchWorkspaceEnabled defaults to true', () => {
    expect(getOnboardingFeatureFlags().batchWorkspaceEnabled).toBe(true);
  });

  it('pipelineDiagnosticsEnabled defaults to true (board stays diagnostics-only)', () => {
    expect(getOnboardingFeatureFlags().pipelineDiagnosticsEnabled).toBe(true);
  });

  it('override wins over env parsing', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: true });
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
    overrideOnboardingFeatureFlags({ reviewUiV2: false });
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(false);
  });

  it('override works per-flag without disturbing siblings // e10s05', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: true, batchWorkspaceEnabled: false });
    const flags = getOnboardingFeatureFlags();
    expect(flags.reviewUiV2).toBe(true);
    expect(flags.batchWorkspaceEnabled).toBe(false);
    expect(flags.pipelineDiagnosticsEnabled).toBe(true);
  });

  it('reset restores defaults', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: false });
    resetOnboardingFeatureFlags();
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
  });

  // Plan §tests: VITE_REVIEW_UI_V2 parsing incl. kill-switch values.
  describe('parseEnvFlag kill-switch truth table // plan line 197', () => {
    it.each([
      [undefined, false, false], // absent ⇒ default
      ['', false, false], // empty ⇒ default
      ['   ', false, false], // whitespace ⇒ default
      ['false', false, false],
      ['0', false, false],
      ['no', false, false],
      ['FALSE', false, false], // case-insensitive
      ['No', false, false],
      ['true', false, true],
      ['1', false, true],
      ['yes', false, true],
      ['garbage', false, true], // any other non-empty enables
      [undefined, true, true], // default=true honored
      ['', true, true],
    ])('raw=%p default=%p ⇒ %p', (raw, defaultValue, expected) => {
      expect(parseEnvFlag(raw as string | undefined, defaultValue)).toBe(expected);
    });
  });
});
