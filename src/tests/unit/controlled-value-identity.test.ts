import { describe, expect, it } from 'vitest';
import {
  canonicalForm,
  canonicalOption,
  canonicalOptions,
  comparisonKey,
  findCanonicalCollisions,
  matchCanonicalValue,
  resolveAlias,
  validateCanonicalValue,
  type CanonicalValueValidation,
} from '../../classification/controlled-value-identity';

describe('controlled-value-identity', () => {
  describe('comparisonKey', () => {
    it('NFC-normalizes, trims, and case-folds', () => {
      expect(comparisonKey('  Dog  ')).toBe('dog');
      // Combining form of é (e + U+0301) and precomposed é fold to the same key.
      expect(comparisonKey('café')).toBe(comparisonKey('cafe\u0301'));
      expect(comparisonKey('CAFÉ')).toBe(comparisonKey('cafe\u0301'));
    });
  });

  describe('canonicalForm', () => {
    it('NFC-normalizes and trims WITHOUT case folding (case is identity)', () => {
      expect(canonicalForm('  Dog  ')).toBe('Dog');
      expect(canonicalForm('cafe\u0301')).toBe('café');
    });
  });

  describe('validateCanonicalValue', () => {
    it('accepts a canonical value', () => {
      expect(validateCanonicalValue('Dog')).toEqual({ ok: true });
    });

    it('rejects empty/whitespace values', () => {
      expect((validateCanonicalValue('') as CanonicalValueValidation).reason).toBe('empty');
      expect((validateCanonicalValue('   ') as CanonicalValueValidation).reason).toBe('empty');
    });

    it('rejects control characters', () => {
      expect((validateCanonicalValue('Dog\u0007') as CanonicalValueValidation).reason).toBe('control-character');
      expect((validateCanonicalValue('Dog\tFood') as CanonicalValueValidation).reason).toBe('control-character');
    });

    it('rejects non-NFC values', () => {
      // e + combining acute is not NFC (precomposed é is canonical).
      expect((validateCanonicalValue('cafe\u0301') as CanonicalValueValidation).reason).toBe('non-nfc');
    });

    it('rejects untrimmed values', () => {
      expect((validateCanonicalValue(' Dog') as CanonicalValueValidation).reason).toBe('not-trimmed');
      expect((validateCanonicalValue('Dog ') as CanonicalValueValidation).reason).toBe('not-trimmed');
    });
  });

  describe('findCanonicalCollisions', () => {
    it('detects exact duplicates', () => {
      const collisions = findCanonicalCollisions(['Dog', 'Dog']);
      expect(collisions.some(c => c.kind === 'exact')).toBe(true);
    });

    it('detects normalized collisions (NFC/trim equivalence)', () => {
      const collisions = findCanonicalCollisions(['Dog', 'Dog ']);
      expect(collisions.some(c => c.kind === 'normalized')).toBe(true);
    });

    it('detects case-fold collisions', () => {
      const collisions = findCanonicalCollisions(['Dog', 'dog']);
      expect(collisions.some(c => c.kind === 'case-fold')).toBe(true);
    });

    it('returns no collisions for a distinct canonical set', () => {
      expect(findCanonicalCollisions(['Dog', 'Cat', 'Salmon'])).toEqual([]);
    });
  });

  describe('matchCanonicalValue', () => {
    it('resolves a candidate to the exact canonical allowed ID', () => {
      expect(matchCanonicalValue('CHICKEN', ['Chicken', 'Beef'])).toBe('Chicken');
      expect(matchCanonicalValue(' chicken ', ['Chicken', 'Beef'])).toBe('Chicken');
    });

    it('returns null for unknown values', () => {
      expect(matchCanonicalValue('Turkey', ['Chicken', 'Beef'])).toBeNull();
    });

    it('fails closed on ambiguity (two allowed values share the key)', () => {
      // 'Dog' and 'dog' collide on the comparison key — ambiguous, never a guess.
      expect(matchCanonicalValue('DOG', ['Dog', 'dog'])).toBeNull();
    });

    it('returns null for empty/null/undefined candidates', () => {
      expect(matchCanonicalValue('', ['Dog'])).toBeNull();
      expect(matchCanonicalValue(null, ['Dog'])).toBeNull();
      expect(matchCanonicalValue(undefined, ['Dog'])).toBeNull();
    });
  });

  describe('resolveAlias', () => {
    const aliases = [
      { alias: 'chicken', mapsTo: 'Chicken' },
      { alias: 'poultry', mapsTo: 'Chicken' },
    ];

    it('resolves a known alias to its exact allowed ID', () => {
      expect(resolveAlias('CHICKEN', aliases, ['Chicken', 'Beef'])).toBe('Chicken');
      expect(resolveAlias('poultry', aliases, ['Chicken', 'Beef'])).toBe('Chicken');
    });

    it('returns null for an unknown alias string', () => {
      expect(resolveAlias('beefy', aliases, ['Chicken', 'Beef'])).toBeNull();
    });

    it('returns null when mapsTo is not an exact allowed ID (fail closed)', () => {
      expect(resolveAlias('chicken', aliases, ['Beef'])).toBeNull();
    });

    it('returns null when more than one alias shares the candidate key (ambiguous)', () => {
      const ambiguous = [
        { alias: 'dog', mapsTo: 'Dog' },
        { alias: 'DOG', mapsTo: 'Canine' },
      ];
      expect(resolveAlias('DOG', ambiguous, ['Dog', 'Canine'])).toBeNull();
    });

    it('returns null for empty candidates', () => {
      expect(resolveAlias('', aliases, ['Chicken'])).toBeNull();
      expect(resolveAlias(null, aliases, ['Chicken'])).toBeNull();
    });
  });

  describe('canonicalOption / canonicalOptions', () => {
    it('builds {value: id, label: id} — label equals ID by v2 policy', () => {
      expect(canonicalOption('Dog')).toEqual({ value: 'Dog', label: 'Dog' });
    });

    it('maps an ID list to canonical options', () => {
      expect(canonicalOptions(['Dog', 'Cat'])).toEqual([
        { value: 'Dog', label: 'Dog' },
        { value: 'Cat', label: 'Cat' },
      ]);
    });
  });
});
