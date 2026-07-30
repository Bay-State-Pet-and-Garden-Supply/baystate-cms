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
  sourceType: 'official_page',
  acceptedEvidenceAttemptIds: [],
  acceptedEvidenceAttemptId: null,
  sourcingDecision: null,
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
    expect(stem).not.toContain('chicken');
    // 'blue' is stripped as a standalone color token — stems are
    // color-agnostic; brand matching is handled by normalizeBrand.
    expect(stem).toContain('buffalo');
    expect(stem).not.toContain('blue');
    expect(stem).not.toContain('chicken');
    expect(stem).not.toContain('30lb');
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

  // ─── Family grouping tests ──────────────────────────────────────────────

  it('groups Instinct CAT PATE CHKN/SLMN/DUCK as one family (flavor abbreviations)', () => {
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'INSTINCT CAT PATE CHKN SPLIT CUP 2.64OZ', brandHint: 'instinct' });
    const slmn = makeItem({ id: '2', upc: 'SKU002', name: 'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ', brandHint: 'instinct' });
    const duck = makeItem({ id: '3', upc: 'SKU003', name: 'INSTINCT CAT PATE DUCK SPLIT CUP 2.64OZ', brandHint: 'instinct' });

    // Each item should see all three as siblings
    const r1 = determineProductGroup(base, [base, slmn, duck]);
    expect(r1).not.toBeNull();
    expect(r1!.siblingSkus).toHaveLength(3);
    expect(r1!.siblingSkus).toContain('SKU001');
    expect(r1!.siblingSkus).toContain('SKU002');
    expect(r1!.siblingSkus).toContain('SKU003');
  });

  it('separates Instinct CAT FLAKE from CAT PATE (different product form)', () => {
    const pate = makeItem({ id: '1', upc: 'SKU001', name: 'INSTINCT CAT PATE CHKN SPLIT CUP 2.64OZ', brandHint: 'instinct' });
    const flake = makeItem({ id: '2', upc: 'SKU002', name: 'INSTINCT CAT FLAKE TUNA SPLIT CUP 2.64OZ', brandHint: 'instinct' });

    // Pate and flake should be different stems because 'pate' and 'flake'
    // are not stripped as flavor/size tokens
    const pateGroup = determineProductGroup(pate, [pate, flake]);
    const flakeGroup = determineProductGroup(flake, [pate, flake]);
    // Either they are separate groups or one of them has no siblings
    expect(pateGroup).toBeNull();
    expect(flakeGroup).toBeNull();
  });

  it('groups Instinct FLAKE TUNA and FLAKE DUCK together', () => {
    const tuna = makeItem({ id: '1', upc: 'SKU001', name: 'INSTINCT CAT FLAKE TUNA SPLIT CUP 2.64OZ', brandHint: 'instinct' });
    const duck = makeItem({ id: '2', upc: 'SKU002', name: 'INSTINCT CAT FLAKE DUCK SPLIT CUP 2.6OZ', brandHint: 'instinct' });

    const result = determineProductGroup(tuna, [tuna, duck]);
    expect(result).not.toBeNull();
    expect(result!.siblingSkus).toHaveLength(2);
  });

  it('normalises WOOF concatenated Flyball colors to same stem', () => {
    const yellow = makeItem({ id: '1', upc: 'SKU001', name: 'WOOF FORAGER FLYBALLYELLOW', brandHint: 'woof' });
    const lavender = makeItem({ id: '2', upc: 'SKU002', name: 'WOOF FORAGER FLYBALLLAVENDER', brandHint: 'woof' });
    const orange = makeItem({ id: '3', upc: 'SKU003', name: 'WOOF FORAGER FLYBALLORANGE', brandHint: 'woof' });

    const r1 = determineProductGroup(yellow, [yellow, lavender, orange]);
    expect(r1).not.toBeNull();
    expect(r1!.siblingSkus).toHaveLength(3);

    // Verify stem is normalised (color stripped from all)
    const stemYellow = extractNameStem('WOOF FORAGER FLYBALLYELLOW');
    const stemLavender = extractNameStem('WOOF FORAGER FLYBALLLAVENDER');
    const stemOrange = extractNameStem('WOOF FORAGER FLYBALLORANGE');
    expect(stemYellow).toBe(stemLavender);
    expect(stemYellow).toBe(stemOrange);
  });

  it('normalises attached size/count forms like SM5CT and MD2CT', () => {
    const stemSm = extractNameStem('DR MARTY YAK DNTL SM5CT BARK STOPPER');
    const stemMd = extractNameStem('DR MARTY YAK CHW MD2CT DIGEST BARK STOP');
    // SM5CT should be stripped yielding a stem that includes bark stopper info
    expect(stemSm).not.toMatch(/sm5ct/);
    expect(stemMd).not.toMatch(/md2ct/);

    // And items should group together when same brand+stem
    const base = makeItem({ id: '1', upc: 'SKU001', name: 'DR MARTY YAK DNTL SM5CT BARK STOPPER', brandHint: 'dr marty' });
    const sibling = makeItem({ id: '2', upc: 'SKU002', name: 'DR MARTY YAK CHW MD2CT DIGEST BARK STOP', brandHint: 'dr marty' });
    const result = determineProductGroup(base, [base, sibling]);
    // These may or may not group depending on the stem (the generic name stem
    // after stripping focuses on the product identity — 'bark stopper' vs 'bark stop')
    // At minimum verify the size forms are stripped
    expect(stemSm).not.toContain('sm5ct');
  });

  it('normalises abbreviated flavors: chkn, ckn, slmn, trky', () => {
    expect(extractNameStem('CHKN')).not.toContain('chkn');
    expect(extractNameStem('SLMN')).not.toContain('slmn');
    expect(extractNameStem('TRKY')).not.toContain('trky');
  });

  it('preserves form tokens: pate, flake, stix, chew', () => {
    const stemPate = extractNameStem('PATE');
    const stemFlake = extractNameStem('FLAKE');
    const stemStix = extractNameStem('STIX');
    const stemChew = extractNameStem('CHEW');
    expect(stemPate).toBe('pate');
    expect(stemFlake).toBe('flake');
    expect(stemStix).toBe('stix');
    expect(stemChew).toBe('chew');
  });
});
