/**
 * Packaging-OCR stage flag tests (P2-T3): defaults are fail-closed; env
 * parsing is strict; runtime overrides work without a redeploy; the PI kill
 * switch dominates every other setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OCR_STAGE_FLAGS,
  getOcrStageFlags,
  loadOcrStageFlags,
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';

describe('loadOcrStageFlags', () => {
  it('defaults to fail-closed (stage disabled, shadow on, no dual-run, no retries)', () => {
    expect(loadOcrStageFlags({})).toEqual(DEFAULT_OCR_STAGE_FLAGS);
    expect(DEFAULT_OCR_STAGE_FLAGS).toEqual({
      packagingOcrStageEnabled: false,
      packagingOcrStageShadowOnly: true,
      packagingOcrDualRunCompare: false,
      packagingOcrRetriesEnabled: false,
    });
  });

  it('parses true/1/yes and false/0/no env values', () => {
    const flags = loadOcrStageFlags({
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'true',
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY: '0',
      BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN: 'yes',
      BAYSTATE_CMS_OCR_RETRIES_ENABLED: '1',
    });
    expect(flags.packagingOcrStageEnabled).toBe(true);
    expect(flags.packagingOcrStageShadowOnly).toBe(false);
    expect(flags.packagingOcrDualRunCompare).toBe(true);
    expect(flags.packagingOcrRetriesEnabled).toBe(true);

    const off = loadOcrStageFlags({
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'false',
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY: 'no',
      BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN: '0',
      BAYSTATE_CMS_OCR_RETRIES_ENABLED: 'no',
    });
    expect(off.packagingOcrStageEnabled).toBe(false);
    expect(off.packagingOcrStageShadowOnly).toBe(false);
    expect(off.packagingOcrDualRunCompare).toBe(false);
    expect(off.packagingOcrRetriesEnabled).toBe(false);
  });

  it('fails closed to defaults on unparseable values', () => {
    const flags = loadOcrStageFlags({
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'maybe',
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY: 'sometimes',
      BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN: '2',
      BAYSTATE_CMS_OCR_RETRIES_ENABLED: 'on',
    });
    expect(flags.packagingOcrStageEnabled).toBe(false);
    expect(flags.packagingOcrStageShadowOnly).toBe(true);
    expect(flags.packagingOcrDualRunCompare).toBe(false);
    expect(flags.packagingOcrRetriesEnabled).toBe(false);
  });

  it('re-reads the environment on every call', () => {
    const env: Record<string, string | undefined> = {};
    expect(loadOcrStageFlags(env).packagingOcrStageEnabled).toBe(false);
    env.BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED = 'true';
    expect(loadOcrStageFlags(env).packagingOcrStageEnabled).toBe(true);
  });
});

describe('kill switch dominance', () => {
  afterEach(() => resetOcrStageFlagsOverride());

  it('forces packagingOcrStageEnabled false when the OCR kill switch is set', () => {
    const flags = loadOcrStageFlags({
      BAYSTATE_CMS_OCR_KILL_SWITCH: 'true',
      BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'true',
    });
    expect(flags.packagingOcrStageEnabled).toBe(false);
  });

  it('honors the deprecated BAYSTATE_CMS_PI_KILL_SWITCH alias (ADR-0030 window)', () => {
    // Alias alone still dominates.
    expect(
      loadOcrStageFlags({
        BAYSTATE_CMS_PI_KILL_SWITCH: 'true',
        BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'true',
      }).packagingOcrStageEnabled,
    ).toBe(false);
    // Alias falsey does NOT arm the switch when the primary var is unset.
    expect(
      loadOcrStageFlags({
        BAYSTATE_CMS_PI_KILL_SWITCH: 'false',
        BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'true',
      }).packagingOcrStageEnabled,
    ).toBe(true);
  });

  it('accepts the same truthy spellings as product-intelligence flags.ts', () => {
    for (const value of ['true', '1', 'yes']) {
      expect(
        loadOcrStageFlags({ BAYSTATE_CMS_OCR_KILL_SWITCH: value })
          .packagingOcrStageEnabled,
      ).toBe(false);
    }
    // Falsey/unset/garbage kill-switch values are never treated as "set",
    // so normal precedence applies and the stage env stays authoritative.
    for (const value of ['false', '0', 'no', '', 'garbage', undefined]) {
      const env: Record<string, string | undefined> = {
        BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED: 'true',
      };
      if (value !== undefined) env.BAYSTATE_CMS_OCR_KILL_SWITCH = value;
      expect(loadOcrStageFlags(env).packagingOcrStageEnabled).toBe(true);
    }
  });

  it('dominates an in-memory override via getOcrStageFlags', () => {
    vi.stubEnv('BAYSTATE_CMS_OCR_KILL_SWITCH', 'true');
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);
    vi.unstubAllEnvs();
    // Kill switch cleared → the override's normal precedence is restored.
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(true);
  });
});

describe('runtime override', () => {
  beforeEach(() => {
    resetOcrStageFlagsOverride();
    // Stub ambient OCR-stage env so process.env leakage cannot skew defaults.
    vi.stubEnv('BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED', '');
    vi.stubEnv('BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY', '');
    vi.stubEnv('BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN', '');
    vi.stubEnv('BAYSTATE_CMS_OCR_RETRIES_ENABLED', '');
    vi.stubEnv('BAYSTATE_CMS_OCR_KILL_SWITCH', '');
  });
  afterEach(() => {
    resetOcrStageFlagsOverride();
    vi.unstubAllEnvs();
  });

  it('applies and clears an in-memory override without a redeploy', () => {
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(true);
    resetOcrStageFlagsOverride();
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);
  });

  it('merges partial overrides without disturbing other flags', () => {
    overrideOcrStageFlags({ packagingOcrDualRunCompare: true });
    const flags = getOcrStageFlags();
    expect(flags.packagingOcrDualRunCompare).toBe(true);
    expect(flags.packagingOcrStageEnabled).toBe(false);
    expect(flags.packagingOcrStageShadowOnly).toBe(true);
    expect(flags.packagingOcrRetriesEnabled).toBe(false);
  });

  it('accumulates successive overrides like the flags.ts pattern', () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    const flags = getOcrStageFlags();
    expect(flags.packagingOcrStageEnabled).toBe(true);
    expect(flags.packagingOcrRetriesEnabled).toBe(true);
  });
});
