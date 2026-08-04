/**
 * Feature flag tests (PI-1): defaults are fail-closed; env parsing is strict;
 * runtime overrides work without a redeploy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PRODUCT_INTELLIGENCE_FLAGS,
  getProductIntelligenceFlags,
  loadProductIntelligenceFlags,
  overrideProductIntelligenceFlags,
  resetProductIntelligenceFlagsOverride,
} from '../../../product-intelligence/flags';

describe('loadProductIntelligenceFlags', () => {
  it('defaults to fail-closed (all disabled, shadow mode on)', () => {
    expect(loadProductIntelligenceFlags({})).toEqual(DEFAULT_PRODUCT_INTELLIGENCE_FLAGS);
  });

  it('parses true/1/yes and false/0/no env values', () => {
    const flags = loadProductIntelligenceFlags({
      BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED: 'true',
      BAYSTATE_CMS_PI_ENABLED: '1',
      BAYSTATE_CMS_PI_SHADOW_ONLY: 'no',
      BAYSTATE_CMS_PI_ALLOW_ONBOARDING_IMPORT: 'yes',
      BAYSTATE_CMS_PI_ALLOW_BATCH_RUNS: '0',
    });
    expect(flags.productIntelligenceEnabled).toBe(true);
    expect(flags.piEnabled).toBe(true);
    expect(flags.shadowOnly).toBe(false);
    expect(flags.allowOnboardingImport).toBe(true);
    expect(flags.allowBatchRuns).toBe(false);
  });

  it('fails closed on unparseable values', () => {
    const flags = loadProductIntelligenceFlags({
      BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED: 'maybe',
    });
    expect(flags.productIntelligenceEnabled).toBe(false);
  });
});

describe('runtime override', () => {
  afterEach(() => resetProductIntelligenceFlagsOverride());

  it('applies and clears an in-memory override without a redeploy', () => {
    expect(getProductIntelligenceFlags().piEnabled).toBe(false);
    overrideProductIntelligenceFlags({ piEnabled: true });
    expect(getProductIntelligenceFlags().piEnabled).toBe(true);
    resetProductIntelligenceFlagsOverride();
    expect(getProductIntelligenceFlags().piEnabled).toBe(false);
  });

  it('merges partial overrides', () => {
    overrideProductIntelligenceFlags({ productIntelligenceEnabled: true });
    const flags = getProductIntelligenceFlags();
    expect(flags.productIntelligenceEnabled).toBe(true);
    expect(flags.shadowOnly).toBe(true);
  });
});
