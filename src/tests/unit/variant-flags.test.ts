import { describe, it, expect, afterEach } from 'vitest';
import { parseVariantResolutionMode, parseVariantInteractionEnabled, overrideVariantFlags, resetVariantFlagsOverride, getEffectiveVariantResolutionMode } from '../../onboarding/variant-flags';

describe('variant-flags', () => {
  afterEach(() => resetVariantFlagsOverride());
  it('defaults to off', () => {
    expect(parseVariantResolutionMode(undefined)).toBe('off');
    expect(parseVariantResolutionMode('')).toBe('off');
    expect(parseVariantResolutionMode('   ')).toBe('off');
    expect(parseVariantResolutionMode('invalid')).toBe('off');
  });
  it('parses active/observe', () => {
    expect(parseVariantResolutionMode('active')).toBe('active');
    expect(parseVariantResolutionMode('observe')).toBe('observe');
    expect(parseVariantResolutionMode('OFF')).toBe('off');
  });
  it('interaction defaults false', () => {
    expect(parseVariantInteractionEnabled(undefined)).toBe(false);
    expect(parseVariantInteractionEnabled('')).toBe(false);
    expect(parseVariantInteractionEnabled('true')).toBe(true);
    expect(parseVariantInteractionEnabled('1')).toBe(true);
    expect(parseVariantInteractionEnabled('false')).toBe(false);
  });
  it('override works', () => {
    overrideVariantFlags({ mode: 'active' });
    expect(getEffectiveVariantResolutionMode()).toBe('active');
  });
});
