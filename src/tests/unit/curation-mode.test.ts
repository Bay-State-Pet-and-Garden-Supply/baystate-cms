import { describe, it, expect } from 'vitest';
import { isModularCurationEnabled } from '../../onboarding/curation-mode';

describe('Curation Mode Feature Flag', () => {
  it('returns false when env var is unset', () => {
    expect(isModularCurationEnabled({})).toBe(false);
  });

  it('returns false when env var is empty', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '' })).toBe(false);
  });

  it('returns false when env var is only whitespace', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '   ' })).toBe(false);
  });

  it('returns true for "true"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'true' })).toBe(true);
  });

  it('returns true for "1"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '1' })).toBe(true);
  });

  it('returns true for "yes"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'yes' })).toBe(true);
  });

  it('returns true for "on"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'on' })).toBe(true);
  });

  it('returns true for uppercase "TRUE"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'TRUE' })).toBe(true);
  });

  it('returns true for mixed case "YeS"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'YeS' })).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'false' })).toBe(false);
  });

  it('returns false for "0"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '0' })).toBe(false);
  });

  it('returns false for "no"', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'no' })).toBe(false);
  });

  it('returns false for unrecognized values', () => {
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'maybe' })).toBe(false);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '2' })).toBe(false);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'enabled' })).toBe(false);
  });
});
