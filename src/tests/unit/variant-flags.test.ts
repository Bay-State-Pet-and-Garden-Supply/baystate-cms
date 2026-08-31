import { describe, it, expect, afterEach } from 'vitest';
import { parseVariantResolutionMode, parseVariantInteractionEnabled, overrideVariantFlags, resetVariantFlagsOverride, getEffectiveVariantResolutionMode, getEffectiveVariantInteractionEnabled } from '../../onboarding/variant-flags';

describe('variant-flags (always-on since #90)', () => {
  afterEach(() => resetVariantFlagsOverride());
  it('always active regardless of input (off/observe deprecated)', () => {
    expect(parseVariantResolutionMode(undefined)).toBe('active');
    expect(parseVariantResolutionMode('')).toBe('active');
    expect(parseVariantResolutionMode('   ')).toBe('active');
    expect(parseVariantResolutionMode('invalid')).toBe('active');
    expect(parseVariantResolutionMode('off')).toBe('active');
    expect(parseVariantResolutionMode('observe')).toBe('active');
    expect(parseVariantResolutionMode('active')).toBe('active');
    expect(parseVariantResolutionMode('OFF')).toBe('active');
    expect(getEffectiveVariantResolutionMode()).toBe('active');
  });
  it('interaction always false without override (env ignored)', () => {
    expect(parseVariantInteractionEnabled(undefined)).toBe(false);
    expect(parseVariantInteractionEnabled('')).toBe(false);
    expect(parseVariantInteractionEnabled('true')).toBe(false);
    expect(parseVariantInteractionEnabled('1')).toBe(false);
    expect(parseVariantInteractionEnabled('false')).toBe(false);
    expect(getEffectiveVariantInteractionEnabled()).toBe(false);
  });
  it('override still works for isolated tests', () => {
    overrideVariantFlags({ mode: 'off' });
    expect(getEffectiveVariantResolutionMode()).toBe('off');
    overrideVariantFlags({ mode: 'active' });
    expect(getEffectiveVariantResolutionMode()).toBe('active');
    overrideVariantFlags({ interactionEnabled: true });
    expect(getEffectiveVariantInteractionEnabled()).toBe(true);
  });
});
