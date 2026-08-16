/**
 * Identity normalization (epic #46 batch-analysis follow-up).
 *
 * The operator rule: the structured weight field is ALWAYS pounds, stored to
 * exactly two decimals, converted from any accepted unit — and NEVER applied
 * to the product name/title. Brand + packCount normalize for comparison only.
 */
import { describe, test, expect } from 'vitest';
import { normalizeWeightToLbs, parseWeightToLbs, roundToTwoDecimals } from '../../onboarding/normalization/weight';
import { normalizeBrandForComparison } from '../../onboarding/normalization/brand';
import { normalizePackCountForComparison } from '../../onboarding/normalization/pack-count';
import { normalizeIdentityValueForComparison } from '../../onboarding/normalization/identity';

describe('normalizeWeightToLbs — canonical pounds, two decimals', () => {
  const cases: Array<[string, string]> = [
    // Live-batch formats
    ['0.0600 lb', '0.06'],
    ['0.06 lb', '0.06'],
    ['0.1700 lb', '0.17'],
    ['0.17 lb', '0.17'],
    ['0.3771 lb', '0.38'],
    ['0.25', '0.25'],
    ['0.01 lb', '0.01'],
    ['0.1000 lb', '0.10'],
    ['0.2080 lb', '0.21'],
    ['0.2800 lb', '0.28'],
    ['0.4330 lb', '0.43'],
    ['0.5116 lb', '0.51'],
    ['0.4380 lb', '0.44'],
    ['0.1100 lb', '0.11'],
    ['0.4100 lb', '0.41'],
    ['0.4200 lb', '0.42'],
    ['0.3900 lb', '0.39'],
    ['0.3600 lb', '0.36'],
    ['0.4400 lb', '0.44'],
    ['0.3100 lb', '0.31'],
    ['0.3 lb', '0.30'],
    ['0.4 lb', '0.40'],
    // Unit conversions
    ['16 oz', '1.00'],
    ['16 ounce', '1.00'],
    ['16 ounces', '1.00'],
    ['453.59237 g', '1.00'],
    ['0.45359237 kg', '1.00'],
    ['1 kg', '2.20'],
    // Case/whitespace tolerance
    ['1 LB', '1.00'],
    ['1 lbs', '1.00'],
    ['1 pound', '1.00'],
    ['1 pounds', '1.00'],
    ['  0.0600   lb  ', '0.06'],
    // Unitless → pounds (operator rule)
    ['1', '1.00'],
    ['1.5', '1.50'],
    ['.5 lb', '0.50'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(normalizeWeightToLbs(input)).toBe(expected);
    });
  }

  test('accepts every observed live-batch decimal-pound shape (GPT review NIT)', () => {
    const liveBatch = [
      '0.0600 lb', '0.06 lb', '0.1700 lb', '0.17 lb', '0.3771 lb', '0.25',
      '0.01 lb', '0.1000 lb', '0.2080 lb', '0.2800 lb', '0.4330 lb', '0.5116 lb',
      '0.4380 lb', '0.1100 lb', '0.4100 lb', '0.4200 lb', '0.3900 lb', '0.3600 lb',
      '0.4400 lb', '0.3100 lb', '0.21 lb', '0.27 lb', '0.3 lb', '0.31 lb',
      '0.36 lb', '0.38 lb', '0.39 lb', '0.4 lb', '0.41 lb', '0.42 lb',
      '0.43 lb', '0.44 lb', '0.51 lb', '0.5116 lb', '0.01 lb', '0.06 lb',
      '0.17 lb', '0.25',
    ];
    const expected = [
      '0.06', '0.06', '0.17', '0.17', '0.38', '0.25', '0.01', '0.10', '0.21',
      '0.28', '0.43', '0.51', '0.44', '0.11', '0.41', '0.42', '0.39', '0.36',
      '0.44', '0.31', '0.21', '0.27', '0.30', '0.31', '0.36', '0.38', '0.39',
      '0.40', '0.41', '0.42', '0.43', '0.44', '0.51', '0.51', '0.01', '0.06',
      '0.17', '0.25',
    ];
    for (let i = 0; i < liveBatch.length; i++) {
      expect(normalizeWeightToLbs(liveBatch[i]), liveBatch[i]).toBe(expected[i]);
    }
  });
});

describe('normalizeWeightToLbs — fail closed on unparseable values', () => {
  const rejects = ['', ' ', 'unknown', 'N/A', 'varies', 'approx 1 lb', 'about 1 lb', '1-2 lb', '1 to 2 lb', '1/2 lb', '½ lb', '6 x 4 oz', 'case of 12', '12 ct', 'lb', 'oz', '-1 lb', '0 lb', '0', 'NaN', 'Infinity', '1,000 g', '1,5 lb'];
  for (const input of rejects) {
    test(`${JSON.stringify(input)} → null`, () => {
      expect(normalizeWeightToLbs(input)).toBeNull();
    });
  }
});

test('roundToTwoDecimals rounds half away from zero', () => {
  expect(roundToTwoDecimals(0.3771)).toBe('0.38');
  expect(roundToTwoDecimals(0.375)).toBe('0.38');
  expect(roundToTwoDecimals(1.004)).toBe('1.00');
  expect(roundToTwoDecimals(2.205)).toBe('2.21');
});

test('parseWeightToLbs exposes unit + numeric details for diagnostics', () => {
  const parsed = parseWeightToLbs('16 oz')!;
  expect(parsed.unit).toBe('oz');
  expect(parsed.numericInput).toBe(16);
  expect(parsed.pounds).toBeCloseTo(1, 5);
  expect(parsed.normalized).toBe('1.00');
  expect(parseWeightToLbs('0.25')!.unit).toBe('unitless');
});

describe('normalizeBrandForComparison — case/whitespace only, never merges distinct brands', () => {
  test('casing + whitespace collapse for comparison', () => {
    expect(normalizeBrandForComparison('WHOLESOMES')).toBe('wholesomes');
    expect(normalizeBrandForComparison('Wholesomes')).toBe('wholesomes');
    expect(normalizeBrandForComparison('  Whole   Somes  ')).toBe('whole somes');
  });
  test('distinct strings stay distinct (no fuzzy matching, no aliasing)', () => {
    expect(normalizeBrandForComparison('WholesomesFlavor')).toBe('wholesomesflavor');
    expect(normalizeBrandForComparison('Wholesomes') !== normalizeBrandForComparison('WholesomesFlavor')).toBe(true);
  });
  test('blank fails closed', () => {
    expect(normalizeBrandForComparison('')).toBeNull();
    expect(normalizeBrandForComparison('   ')).toBeNull();
  });
});

describe('normalizePackCountForComparison — unsigned integers only', () => {
  test('whitespace and leading zeroes canonicalize', () => {
    expect(normalizePackCountForComparison(' 1 ')).toBe('1');
    expect(normalizePackCountForComparison('01')).toBe('1');
    expect(normalizePackCountForComparison('12')).toBe('12');
  });
  test('non-integer shapes fail closed', () => {
    expect(normalizePackCountForComparison('12 ct')).toBeNull();
    expect(normalizePackCountForComparison('1.0')).toBeNull();
    expect(normalizePackCountForComparison('1-2')).toBeNull();
  });
  test('zero is preserved (never silently equated with positive counts)', () => {
    expect(normalizePackCountForComparison('0')).toBe('0');
  });
});

describe('normalizeIdentityValueForComparison — field routing', () => {
  test('weight normalizes to canonical pounds', () => {
    const r = normalizeIdentityValueForComparison('weight', '0.0600 lb');
    expect(r.status).toBe('normalized');
    expect(r.comparisonValue).toBe('0.06');
    expect(r.rawValue).toBe('0.0600 lb');
  });
  test('brand normalizes for comparison', () => {
    expect(normalizeIdentityValueForComparison('brand', 'WHOLESOMES').comparisonValue).toBe('wholesomes');
  });
  test('packCount normalizes for comparison', () => {
    expect(normalizeIdentityValueForComparison('packCount', '01').comparisonValue).toBe('1');
  });
  test('unknown fields pass through unchanged (existing lowercase comparison)', () => {
    const r = normalizeIdentityValueForComparison('flavor', 'Chicken');
    expect(r.status).toBe('unchanged');
    expect(r.comparisonValue).toBe('Chicken');
  });
  test('malformed weight fails closed: compares as raw, never silently matches', () => {
    const r = normalizeIdentityValueForComparison('weight', 'approx 1 lb');
    expect(r.status).toBe('failed');
    expect(r.comparisonValue).toBe('approx 1 lb');
  });
});
