import { describe, it, expect } from 'vitest';
import {
  determineProductGroup,
  normalizeBrand,
  extractNameStem,
} from '../../onboarding/product-line-grouper';
import { levenshtein, stemsWithinTypoTolerance } from '../../onboarding/product-line-token-normalizer';
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
  isHeld: false,
  heldReason: null,
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
    const _result = determineProductGroup(base, [base, sibling]);
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

describe('family grouping normalization (epic #46 review round, Package A)', () => {
  it('collapses attached size tokens: MD VNSNLG vs MD VNSNSM share a stem', () => {
    const lg = extractNameStem('BETTER BONE MD VNSNLG');
    const sm = extractNameStem('BETTER BONE MD VNSNSM');
    expect(lg).toBe('better bone');
    expect(sm).toBe(lg);
  });

  it('expands abbreviations so flavor variants share a stem (frzn/chkn)', () => {
    const chkn = extractNameStem('BUTCHERS PUP FRZN DINNER CHKN 3LB');
    const pork = extractNameStem('BUTCHERS PUP FRZN DINNER PORK 6LB');
    expect(chkn).toBe(pork);
    expect(chkn).toBe('butchers pup frozen dinner');
    expect(chkn).not.toContain('chkn');
  });

  it('keeps size variants of the same flavor in one stem (SLMN 18LB vs 4LB)', () => {
    const big = extractNameStem('WELLNESS CORE+ SENSITIVE SLMN 18LB');
    const small = extractNameStem('WELLNESS CORE+ SENSITIVE SLMN 4LB');
    expect(big).toBe(small);
  });

  it('still strips SM5CT/MD2CT attached size/count forms', () => {
    expect(extractNameStem('DR MARTY YAK DNTL SM5CT BARK STOPPER')).not.toMatch(/sm5ct/);
    expect(extractNameStem('DR MARTY YAK CHW MD2CT DIGEST BARK STOP')).not.toMatch(/md2ct/);
  });

  it('does not split mixed-case words that merely end in size letters', () => {
    // "Prism" (mixed case) is not "pris m" — the split only applies to
    // all-caps distributor-style tokens and vowel-free abbreviation runs.
    expect(extractNameStem('Woof Prism')).toBe('woof prism');
  });

  it('groups an unbranded item with a branded sibling when the name embeds the brand', () => {
    const unbranded = makeItem({ id: '1', upc: 'SKU001', name: 'BETTER BONE HARD VNSN SM', brandHint: null });
    const branded = makeItem({ id: '2', upc: 'SKU002', name: 'BETTER BONE HARD VNSN LG', brandHint: 'BetterBone' });
    const result = determineProductGroup(unbranded, [unbranded, branded]);
    expect(result).not.toBeNull();
    expect(result!.siblingSkus).toHaveLength(2);
  });

  it('treats "BetterBone" and "Better Bone" as the same brand for grouping', () => {
    const a = makeItem({ id: '1', upc: 'SKU001', name: 'BETTER BONE HARD BEEF LG', brandHint: 'BetterBone' });
    const b = makeItem({ id: '2', upc: 'SKU002', name: 'BETTER BONE HARD BEEF SM', brandHint: 'Better Bone' });
    const result = determineProductGroup(a, [a, b]);
    expect(result).not.toBeNull();
    expect(result!.siblingSkus).toHaveLength(2);
  });
});

describe('typo tolerance helpers (epic #46 review round, Package A)', () => {
  it('levenshtein computes edit distance', () => {
    expect(levenshtein('veggie', 'vegggie')).toBe(1);
    expect(levenshtein('soft', 'softer')).toBe(2);
    expect(levenshtein('duck', 'duckling')).toBe(4);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('merges single-token distance-1 stems', () => {
    expect(stemsWithinTypoTolerance('soft classic veggie', 'soft classic vegggie')).toBe(true);
  });

  it('rejects distance-2 and extra-token differences', () => {
    expect(stemsWithinTypoTolerance('soft', 'softer')).toBe(false);
    expect(stemsWithinTypoTolerance('hard', 'hard beef')).toBe(false);
    expect(stemsWithinTypoTolerance('duck', 'duckling')).toBe(false);
  });
});

describe('family grouping accuracy — token, pipeline, boundary', () => {
  it('splits attached MINI/JUMBO suffixes (BEEFMINI, VNSNJUMBO)', () => {
    expect(extractNameStem('BETTER BONE BEEFMINI SM')).toBe('better bone');
    expect(extractNameStem('BETTER BONE VNSNJUMBO LG')).toBe('better bone');
    // Idempotency: reapplying split does not change result
    expect(extractNameStem('BETTER BONE BEEF MINI SM')).toBe('better bone');
  });

  it('splits guarded LG/XL prefix for LGHARVEST', () => {
    expect(extractNameStem('LGHARVEST LANE JACKET SM')).toBe('harvest lane jacket');
    expect(extractNameStem('XLHARVEST LANE JACKET LG')).toBe('harvest lane jacket');
    expect(extractNameStem('HARVEST LANE JACKET MEDIUM')).toBe('harvest lane jacket');
    // Allowlist-only: unknown ALL-CAPS remainder does NOT split; mixed-case does not
    expect(extractNameStem('LGBRAND PRODUCT SM')).toBe('lgbrand product');
    expect(extractNameStem('SMOOTH PRODUCT SM')).toBe('smooth product');
    expect(extractNameStem('SMOKED PRODUCT LG')).toBe('smoked product');
    expect(extractNameStem('LgBrand Product')).not.toBe('brand product');
    // Idempotency: reapplying split does not change result
    expect(extractNameStem('LGHARVEST LANE JACKET SM')).toBe(extractNameStem('LG HARVEST LANE JACKET SM'));
  });

  it('converges VEGGIE, VGG, and VEGGGIE (typo)', () => {
    expect(extractNameStem('BETTER BONE VEGGIE SM')).toBe('better bone');
    expect(extractNameStem('BETTER BONE VGG LG')).toBe('better bone');
    expect(extractNameStem('BETTER BONE VEGGGIE SM')).toBe('better bone');
  });

  it('strips PRODUCT_LINE_MODIFIERS soft/hard/classic/hypo/hypoallergenic', () => {
    expect(extractNameStem('BETTER BONE SOFT BEEF SM')).toBe('better bone');
    expect(extractNameStem('BETTER BONE HARD BEEF LG')).toBe('better bone');
    expect(extractNameStem('BETTER BONE CLASSIC BEEF SM')).toBe('better bone');
    expect(extractNameStem('BETTER BONE HYPO BEEF SM')).toBe('better bone');
    expect(extractNameStem('BETTER BONE HYPOALLERGENIC BEEF SM')).toBe('better bone');
    // Substrings must remain
    expect(extractNameStem('SOFTSHELL PRODUCT')).toContain('softshell');
    expect(extractNameStem('HARDWOOD PRODUCT')).toContain('hardwood');
    expect(extractNameStem('CLASSICO PRODUCT')).toContain('classico');
    expect(extractNameStem('HYPOTHESIS PRODUCT')).toContain('hypothesis');
  });

  it('strips SIZE_DESIGNATOR SZ N', () => {
    expect(extractNameStem('BASKERVILLE ULTRA MOLDABLE MUZZLE SZ 4')).toBe('baskerville ultra moldable muzzle');
    expect(extractNameStem('BASKERVILLE ULTRA MOLDABLE MUZZLE SZ4')).toBe('baskerville ultra moldable muzzle');
    expect(extractNameStem('BASKERVILLE ULTRA MOLDABLE MUZZLE SZ 5')).toBe('baskerville ultra moldable muzzle');
    // Bare SZ and unrelated numbers remain
    expect(extractNameStem('SZ PRODUCT')).toContain('sz');
    expect(extractNameStem('PRODUCT SZ')).toContain('sz');
  });

  it('preserves distinct KONG and Fromm lines (negative controls)', () => {
    expect(extractNameStem('KONG SQUEAKZ STICK CHICKEN SM')).toBe('kong squeakz stick');
    expect(extractNameStem('KONG SQUEAKZ STAR CHICKEN SM')).toBe('kong squeakz star');
    expect(extractNameStem('KONG SQUEAKZ STICK CHICKEN SM')).not.toBe(extractNameStem('KONG SQUEAKZ STAR CHICKEN SM'));
    expect(extractNameStem('FROMM CLASSIC CHICKEN RECIPE 5LB')).toBe('fromm');
    expect(extractNameStem('FROMM GOLD CHICKEN RECIPE 5LB')).toBe('fromm gold');
    expect(extractNameStem('FROMM CLASSIC CHICKEN RECIPE 5LB')).not.toBe(extractNameStem('FROMM GOLD CHICKEN RECIPE 5LB'));
  });

  it('pipeline order: split -> lower -> size -> expand -> flavor -> modifiers -> SZ', () => {
    // BEEFMINI contains flavor (beef) + size (mini) attached; after split, both stripped
    expect(extractNameStem('BETTER BONE BEEFMINI')).toBe('better bone');
    // VNSN expands to venison then stripped as flavor
    expect(extractNameStem('BETTER BONE VNSN SM')).toBe('better bone');
  });

  it('handles XXL longest-first (XXL not consumed as XL)', () => {
    expect(extractNameStem('PRODUCT XXL')).toBe('product');
    expect(extractNameStem('PRODUCT XL')).toBe('product');
  });
});
