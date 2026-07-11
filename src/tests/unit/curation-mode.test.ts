import { describe, it, expect } from 'vitest';
import { isModularCurationEnabled } from '../../onboarding/curation-mode';

describe('Curation Mode Feature Flag', () => {
  it('always returns true since modular curation is the only path', () => {
    expect(isModularCurationEnabled({})).toBe(true);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '' })).toBe(true);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'false' })).toBe(true);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: '0' })).toBe(true);
    expect(isModularCurationEnabled({ SHOPSITE_CMS_MODULAR_CURATION_ENABLED: 'true' })).toBe(true);
  });
});

