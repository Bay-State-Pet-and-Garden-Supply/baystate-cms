import { describe, it, expect } from 'vitest';
import {
  determineProductGroup,
  normalizeBrand,
  extractNameStem,
} from '../../onboarding/product-line-grouper';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

const makeItem = (overrides: Partial<OnboardingItem> & { id: string; upc: string; name: string }): OnboardingItem => ({
  batchId: 'test-batch',
  price: null,
  quantity: null,
  brandHint: null,
  departmentHint: null,
  sourceUrl: null,
  expectedName: null,
  stage: 'curation' as const,
  stageStatus: 'pending' as const,
  rowNumber: 0,
  isDuplicate: false,
  existingSku: null,
  extractionData: null,
  curationData: null,
  status: 'active' as any,
  errorMessage: null,
  retryCount: 0,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('normalizeBrand', () => {
  it('lowercases and trims', () => {
    expect(normalizeBrand('  Dr. Marty  ')).toBe('dr. marty');
  });

  it('strips trademark/registered symbols', () => {
    expect(normalizeBrand('Blue Buffalo®')).toBe('blue buffalo');
    expect(normalizeBrand('Happy Dog™')).toBe('happy dog');
  });

  it('strips common suffixes', () => {
    expect(normalizeBrand('Acme Pet Foods Inc')).toBe('acme pet foods');
    expect(normalizeBrand('Premium Brands LLC')).toBe('premium brands');
  });

  it('returns empty for null/undefined', () => {
    expect(normalizeBrand(null)).toBe('');
    expect(normalizeBrand(undefined)).toBe('');
    expect(normalizeBrand('')).toBe('');
  });
});

describe('extractNameStem', () => {
  it('strips size/weight patterns', () => {
    const stem = extractNameStem('Blue Buffalo Chicken Recipe 30lb');
    expect(stem).not.toContain('30lb');
    expect(stem).toContain('blue buffalo');
  });

  it('strips flavor words', () => {
    const stem = extractNameStem('Taste of the Wild Salmon Dry Dog Food');
    expect(stem).not.toContain('salmon');
  });

  it('strips pet-audience suffixes', () => {
    const stem = extractNameStem('Wellness Complete Health for Dogs');
    expect(stem).not.toContain('for dogs');
  });
});

describe('determineProductGroup', () => {
  it('groups same product with size variants', () => {
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'Blue Buffalo Chicken Recipe 30lb', brandHint: 'Blue Buffalo' });
    const sibling = makeItem({ id: '2', upc: 'SKU002', name: 'Blue Buffalo Chicken Recipe 15lb', brandHint: 'Blue Buffalo' });
    const result = determineProductGroup(base, [base, sibling]);
    expect(result).not.toBeNull();
    expect(result!.siblingNames.length).toBe(2);
    expect(result!.siblingSkus).toContain('SKU001');
    expect(result!.siblingSkus).toContain('SKU002');
    expect(result!.sizeVariantCount).toBeGreaterThanOrEqual(1);
  });

  it('groups same product with flavor variants', () => {
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'Acme Dry Dog Food Chicken', brandHint: 'Acme' });
    const sibling = makeItem({ id: '2', upc: 'SKU002', name: 'Acme Dry Dog Food Beef', brandHint: 'Acme' });
    const result = determineProductGroup(base, [base, sibling]);
    expect(result).not.toBeNull();
    expect(result!.siblingNames.length).toBe(2);
    expect(result!.flavorVariantCount).toBeGreaterThanOrEqual(1);
  });

  it('does not group different brands', () => {
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'Blue Buffalo Chicken Recipe', brandHint: 'Blue Buffalo' });
    const other = makeItem({ id: '2', upc: 'SKU002', name: 'Acme Chicken Recipe', brandHint: 'Acme' });
    const result = determineProductGroup(base, [base, other]);
    expect(result).toBeNull();
  });

  it('returns null for single item with no siblings', () => {
    const item = makeItem({ id: '1', upc: 'SKU001', name: 'Solo Product', brandHint: 'Test Brand' });
    const result = determineProductGroup(item, [item]);
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    const item = makeItem({ id: '1', upc: 'SKU001', name: '', brandHint: null });
    const result = determineProductGroup(item, [item]);
    expect(result).toBeNull();
  });

  it('groups with sibling web/OCR titles in metadata', () => {
    const base = makeItem({
      id: '1', upc: 'SKU001', name: 'Brand Product 30lb', brandHint: 'Brand',
      extractionData: { title: 'Brand Product 30lb', packagingOcrData: { productName: 'Brand Product 30 Pound' } } as any,
    });
    const sibling = makeItem({
      id: '2', upc: 'SKU002', name: 'Brand Product 15lb', brandHint: 'Brand',
      extractionData: { title: 'Brand Product 15lb' } as any,
    });
    const result = determineProductGroup(base, [base, sibling]);
    expect(result).not.toBeNull();
    expect(result!.siblingWebTitles).toContain('Brand Product 30lb');
    expect(result!.siblingOcrTitles).toContain('Brand Product 30 Pound');
  });

  it('groups when one item has no brand but same name stem', () => {
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'Generic Product Large', brandHint: 'Generic' });
    const sibling = makeItem({ id: '2', upc: 'SKU002', name: 'Generic Product Small', brandHint: 'Generic' });
    const result = determineProductGroup(base, [base, sibling]);
    expect(result).not.toBeNull();
  });
});
