// story: e35s10 — Commit 13 RED: row CTA should navigate to ProfileBuilder with normalized domain
import { describe, it, expect } from 'vitest';
import { getBrandHubProfileBuilderTarget } from '../../onboarding/brand-hub/navigation';

describe('brand hub navigation — row Edit Profile target', () => {
  it('normalizes https + www + path to bare domain for builder', () => {
    expect(getBrandHubProfileBuilderTarget('https://www.Purina.com/products/x')).toBe('purina.com');
  });

  it('normalizes bare www with mixed case', () => {
    expect(getBrandHubProfileBuilderTarget('WWW.EXAMPLE.COM///')).toBe('example.com');
  });

  it('trims whitespace and lowercases', () => {
    expect(getBrandHubProfileBuilderTarget('  VonShef.com  ')).toBe('vonshef.com');
  });

  it('returns empty when domain is blank', () => {
    expect(getBrandHubProfileBuilderTarget('   ')).toBe('');
  });

  it('uses canonical brand-hub normalization (single source)', () => {
    // canonical helper strips scheme/www/path — ensure builder target matches addBrand normalization
    const withScheme = getBrandHubProfileBuilderTarget('https://www.kongcompany.com/shop/item?x=1');
    const bare = getBrandHubProfileBuilderTarget('kongcompany.com');
    expect(withScheme).toBe(bare);
    expect(withScheme).toBe('kongcompany.com');
  });
});
