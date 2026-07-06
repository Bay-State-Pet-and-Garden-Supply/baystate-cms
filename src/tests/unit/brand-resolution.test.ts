import { describe, it, expect } from 'vitest';
import { resolveBrand } from '../../classification/brand-resolution';
import type { BrandConfig } from '../../shared/schemas/classification';

const testBrands: BrandConfig[] = [
  { id: 'dr-marty', name: 'Dr. Marty', aliases: ['Dr Marty', 'DR MARTY', 'dr marty'], oldIdAliases: [] },
  { id: 'stella-chewy', name: 'Stella & Chewy\'s', aliases: ['Stella and Chewy', 'Stella & Chewy'], oldIdAliases: [] },
  { id: 'acana', name: 'Acana', aliases: ['Acana Pet Foods', 'ACANA'], oldIdAliases: ['old-acana'] },
  { id: 'orijen', name: 'Orijen', aliases: ['Orijen Pet Foods'], oldIdAliases: ['old-orijen'] },
  { id: 'blue-buffalo', name: 'Blue Buffalo', aliases: ['Blue', 'BB'], oldIdAliases: [] },
];

describe('Brand Resolution', () => {
  it('resolves exact canonical name match', () => {
    const result = resolveBrand('Dr. Marty', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('dr-marty');
    expect(result!.brandName).toBe('Dr. Marty');
    expect(result!.confidence).toBe(1.0);
    expect(result!.matchedBy).toBe('exact');
  });

  it('resolves exact canonical name match (case-insensitive)', () => {
    const result = resolveBrand('dr. marty', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('dr-marty');
    expect(result!.matchedBy).toBe('exact');
  });

  it('resolves alias match', () => {
    const result = resolveBrand('Stella and Chewy', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('stella-chewy');
    expect(result!.brandName).toBe("Stella & Chewy's");
    expect(result!.confidence).toBe(1.0);
    expect(result!.matchedBy).toBe('alias');
  });

  it('resolves alias match (case-insensitive)', () => {
    const result = resolveBrand('stella and chewy', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('stella-chewy');
    expect(result!.matchedBy).toBe('alias');
  });

  it('resolves alias match with different alias string', () => {
    const result = resolveBrand('Acana Pet Foods', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('acana');
    expect(result!.matchedBy).toBe('alias');
  });

  it('resolves longest-prefix match', () => {
    const result = resolveBrand('Blue Buffalo Wilderness Chicken Recipe', testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('blue-buffalo');
    expect(result!.brandName).toBe('Blue Buffalo');
    expect(result!.confidence).toBe(0.8);
    expect(result!.matchedBy).toBe('prefix');
  });

  it('resolves longest-prefix match with ampersand brand', () => {
    const result = resolveBrand("Stella & Chewy's Surf n Turf", testBrands);
    expect(result).not.toBeNull();
    expect(result!.brandId).toBe('stella-chewy');
    expect(result!.brandName).toBe("Stella & Chewy's");
    expect(result!.confidence).toBe(0.8);
    expect(result!.matchedBy).toBe('prefix');
  });

  it('returns null for empty input', () => {
    expect(resolveBrand('', testBrands)).toBeNull();
    expect(resolveBrand('   ', testBrands)).toBeNull();
  });

  it('returns null for no match', () => {
    const result = resolveBrand('Unknown Generic Brand', testBrands);
    expect(result).toBeNull();
  });

  it('returns null when no brands configured', () => {
    const result = resolveBrand('Dr. Marty', []);
    expect(result).toBeNull();
  });

  it('prefers exact match over prefix match', () => {
    // "Blue" is both an alias for Blue Buffalo AND could prefix-match "Blue Buffalo"
    const result = resolveBrand('Blue', testBrands);
    expect(result).not.toBeNull();
    // Should match via alias (confidence 1.0) not prefix (confidence 0.8)
    expect(result!.matchedBy).toBe('alias');
    expect(result!.confidence).toBe(1.0);
  });
});
