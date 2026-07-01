import { describe, it, expect } from 'vitest';
import { matchExistingBrand } from '../../shared/brand-matcher';

describe('Brand Matcher Utility', () => {
  const existingBrands = [
    'Stella',
    "Stella & Chewy's",
    'Dr. Marty',
    'Orijen',
    'Acana'
  ];

  it('should match exact brand at the start of product name case-insensitively', () => {
    expect(matchExistingBrand('Orijen Fit & Trim Grain-Free', existingBrands)).toBe('Orijen');
    expect(matchExistingBrand('orijen fit & trim', existingBrands)).toBe('Orijen');
    expect(matchExistingBrand('ORIJEN Fit & Trim', existingBrands)).toBe('Orijen');
  });

  it('should prioritize the longest matching brand first', () => {
    // Stella & Chewy's is longer than Stella and should be matched first
    expect(matchExistingBrand("Stella & Chewy's Freeze-Dried Dinner Patties", existingBrands)).toBe("Stella & Chewy's");
    expect(matchExistingBrand("Stella Freeze-Dried Dinner Patties", existingBrands)).toBe("Stella");
  });

  it('should match multiple words in brand name (e.g. Dr. Marty)', () => {
    expect(matchExistingBrand("Dr. Marty Bark Stoppers Formula", existingBrands)).toBe("Dr. Marty");
  });

  it('should respect word boundaries and reject partial word matches', () => {
    // "Organic Dog Food" starts with "Or", but "Or" is part of "Organic", so it shouldn't match
    expect(matchExistingBrand("Organic Dog Food", existingBrands)).toBeNull();
    // "Stellart treats" starts with "Stella", but next char is 'r' (alphanumeric), so no match
    expect(matchExistingBrand("Stellart treats", existingBrands)).toBeNull();
  });

  it('should match brand names followed by punctuation', () => {
    // "Dr. Marty's treats" -> next char after "dr. marty" is "'", which is non-alphanumeric, so it should match "Dr. Marty"
    expect(matchExistingBrand("Dr. Marty's Bark Stoppers Formula", existingBrands)).toBe("Dr. Marty");
    // "Acana, wild prairie" -> next char is "," (non-alphanumeric), so it should match "Acana"
    expect(matchExistingBrand("Acana, wild prairie", existingBrands)).toBe("Acana");
  });

  it('should return null if product name is empty or has no brand match', () => {
    expect(matchExistingBrand('', existingBrands)).toBeNull();
    expect(matchExistingBrand('Dental Chews Small 10ct', existingBrands)).toBeNull();
  });
});
