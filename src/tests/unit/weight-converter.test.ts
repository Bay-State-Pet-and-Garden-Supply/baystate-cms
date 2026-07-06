import { describe, it, expect } from 'vitest';
import { convertToLbs } from '../../shared/weight-converter';

describe('Weight Converter Utility', () => {
  it('should return null for empty, null, or undefined values', () => {
    expect(convertToLbs(null)).toBeNull();
    expect(convertToLbs(undefined)).toBeNull();
    expect(convertToLbs('')).toBeNull();
    expect(convertToLbs('   ')).toBeNull();
  });

  it('should assume values are already in lbs if no unit is detected', () => {
    expect(convertToLbs('15')).toBe('15');
    expect(convertToLbs('30.5')).toBe('30.5');
    expect(convertToLbs('Approx 24')).toBe('24');
  });

  it('should parse and convert lbs / pounds units', () => {
    expect(convertToLbs('15 lb')).toBe('15');
    expect(convertToLbs('15 lbs')).toBe('15');
    expect(convertToLbs('2.5 pound')).toBe('2.5');
    expect(convertToLbs('2.5 pounds')).toBe('2.5');
    expect(convertToLbs('  10.25 LBS  ')).toBe('10.25');
  });

  it('should parse and convert ounces (oz) units', () => {
    expect(convertToLbs('16 oz')).toBe('1');
    expect(convertToLbs('12 oz')).toBe('0.75');
    expect(convertToLbs('6 ounce')).toBe('0.38'); // 6 / 16 = 0.375 -> rounded to 0.38
    expect(convertToLbs('0.8 ounces')).toBe('0.05'); // 0.8 / 16 = 0.05
    expect(convertToLbs('10.5oz')).toBe('0.66'); // 10.5 / 16 = 0.65625 -> rounded to 0.66
  });

  it('should parse and convert kilograms (kg) units', () => {
    expect(convertToLbs('1 kg')).toBe('2.2'); // 1 * 2.2046... = 2.2046... -> rounded to 2.2
    expect(convertToLbs('1.5 kg')).toBe('3.31'); // 1.5 * 2.2046... = 3.3069... -> rounded to 3.31
    expect(convertToLbs('0.45359237 kg')).toBe('1');
  });

  it('should parse and convert grams (g) units', () => {
    expect(convertToLbs('500 g')).toBe('1.1'); // 500 * 0.0022046... = 1.1023... -> rounded to 1.1
    expect(convertToLbs('100g')).toBe('0.22'); // 100 * 0.0022046... = 0.22046... -> rounded to 0.22
    expect(convertToLbs('453.59237 g')).toBe('1');
  });

  it('should handle compound or dual weight strings', () => {
    expect(convertToLbs('2 oz / 56.7 g')).toBe('0.13'); // extracts first: 2 oz -> 0.125 -> 0.13
    expect(convertToLbs('10.5oz (297g)')).toBe('0.66'); // extracts first: 10.5 oz -> 0.65625 -> 0.66
    expect(convertToLbs('Approx. 5 lbs (2.26 kg)')).toBe('5'); // extracts first: 5 lbs
  });
});
