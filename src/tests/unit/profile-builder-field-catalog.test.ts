/**
 * Unit tests for `src/client/components/profile-builder/fieldCatalog.ts`.
 *
 * Pure field definitions and normalization — no DOM, no API, no React.
 * Runs under vitest.
 */

import { describe, it, expect } from 'vitest';
import {
  getFieldDefinition,
  normalizeCustomFieldKey,
  createArbitraryCustomField,
  CORE_FIELDS,
  STANDARD_CUSTOM_FIELDS,
  FIELD_GROUP_ORDER,
  ALL_STANDARD_FIELDS,
  FIELD_LABEL_BY_KEY,
} from '@/client/components/profile-builder/fieldCatalog';

// ─── CORE_FIELDS ─────────────────────────────────────────────────────────────

describe('CORE_FIELDS', () => {
  it('includes titleSelector', () => {
    const field = CORE_FIELDS.find((f) => f.key === 'titleSelector');
    expect(field).toBeDefined();
    expect(field!.label).toBe('Product title');
    expect(field!.category).toBe('identity');
    expect(field!.requiredForMvp).toBe(true);
  });

  it('includes titleOptionalSelectors', () => {
    const field = CORE_FIELDS.find((f) => f.key === 'titleOptionalSelectors');
    expect(field).toBeDefined();
    expect(field!.cardinality).toBe('multiple');
  });

  it('includes brandSelector, descriptionSelector, imagesSelector', () => {
    expect(CORE_FIELDS.find((f) => f.key === 'brandSelector')).toBeDefined();
    expect(CORE_FIELDS.find((f) => f.key === 'descriptionSelector')).toBeDefined();
    expect(CORE_FIELDS.find((f) => f.key === 'imagesSelector')).toBeDefined();
  });

  it('includes priceSelector as deprecated', () => {
    const field = CORE_FIELDS.find((f) => f.key === 'priceSelector');
    expect(field).toBeDefined();
    expect(field!.deprecated).toBe(true);
    expect(field!.category).toBe('details');
  });

  it('has all core fields with outputTarget core', () => {
    for (const field of CORE_FIELDS) {
      expect(field.outputTarget).toBe('core');
    }
  });

  it('has 6 core fields', () => {
    expect(CORE_FIELDS).toHaveLength(6);
  });
});

// ─── STANDARD_CUSTOM_FIELDS ──────────────────────────────────────────────────

describe('STANDARD_CUSTOM_FIELDS', () => {
  it('includes expected custom fields', () => {
    const keys = STANDARD_CUSTOM_FIELDS.map((f) => f.key);
    expect(keys).toContain('skuSelector');
    expect(keys).toContain('ingredientsSelector');
    expect(keys).toContain('guaranteedAnalysisSelector');
    expect(keys).toContain('caloriesSelector');
    expect(keys).toContain('dietaryLabelsSelector');
    expect(keys).toContain('weightSelector');
    expect(keys).toContain('dimensionsSelector');
    expect(keys).toContain('flavorSelector');
    expect(keys).toContain('lifeStageSelector');
    expect(keys).toContain('speciesSelector');
    expect(keys).toContain('healthConcernsSelector');
  });

  it('all have outputTarget customFields', () => {
    for (const field of STANDARD_CUSTOM_FIELDS) {
      expect(field.outputTarget).toBe('customFields');
    }
  });

  it('has 11 standard custom fields', () => {
    expect(STANDARD_CUSTOM_FIELDS).toHaveLength(11);
  });

  it('categorizes nutrition fields correctly', () => {
    for (const field of STANDARD_CUSTOM_FIELDS) {
      if (['ingredientsSelector', 'guaranteedAnalysisSelector', 'caloriesSelector', 'dietaryLabelsSelector'].includes(field.key)) {
        expect(field.category).toBe('nutrition');
      }
    }
  });
});

// ─── ALL_STANDARD_FIELDS ─────────────────────────────────────────────────────

describe('ALL_STANDARD_FIELDS', () => {
  it('combines core and custom fields', () => {
    expect(ALL_STANDARD_FIELDS).toHaveLength(CORE_FIELDS.length + STANDARD_CUSTOM_FIELDS.length);
  });
});

// ─── FIELD_GROUP_ORDER ───────────────────────────────────────────────────────

describe('FIELD_GROUP_ORDER', () => {
  it('has the correct order of categories', () => {
    expect(FIELD_GROUP_ORDER).toEqual([
      'identity',
      'media',
      'description',
      'nutrition',
      'details',
      'variants',
    ]);
  });
});

// ─── FIELD_LABEL_BY_KEY ──────────────────────────────────────────────────────

describe('FIELD_LABEL_BY_KEY', () => {
  it('maps known field keys to labels', () => {
    expect(FIELD_LABEL_BY_KEY['titleSelector']).toBe('Product title');
    expect(FIELD_LABEL_BY_KEY['weightSelector']).toBe('Weight');
    expect(FIELD_LABEL_BY_KEY['unknownKey']).toBeUndefined();
  });
});

// ─── getFieldDefinition ──────────────────────────────────────────────────────

describe('getFieldDefinition', () => {
  it('returns field definition for known key', () => {
    const field = getFieldDefinition('titleSelector');
    expect(field).not.toBeNull();
    expect(field!.key).toBe('titleSelector');
  });

  it('returns field definition for standard custom field', () => {
    const field = getFieldDefinition('weightSelector');
    expect(field).not.toBeNull();
    expect(field!.label).toBe('Weight');
  });

  it('returns null for unknown key', () => {
    const field = getFieldDefinition('unknownFieldSelector');
    expect(field).toBeNull();
  });
});

// ─── normalizeCustomFieldKey ─────────────────────────────────────────────────

describe('normalizeCustomFieldKey', () => {
  it('lowercases first character of simple input and appends Selector', () => {
    expect(normalizeCustomFieldKey('Flavor')).toBe('flavorSelector');
  });

  it('does not double-suffix when input already ends with Selector', () => {
    expect(normalizeCustomFieldKey('flavorSelector')).toBe('flavorSelector');
  });

  it('handles multi-word input with camelCase', () => {
    // First word is lowercased only on first character
    expect(normalizeCustomFieldKey('SKU Number')).toBe('sKUNumberSelector');
  });

  it('handles already-proper camelCase with Selector suffix', () => {
    expect(normalizeCustomFieldKey('caloriesSelector')).toBe('caloriesSelector');
  });

  it('handles empty string with fallback', () => {
    expect(normalizeCustomFieldKey('')).toBe('customFieldSelector');
  });

  it('handles whitespace-only input', () => {
    expect(normalizeCustomFieldKey('   ')).toBe('customFieldSelector');
  });

  it('handles special characters', () => {
    expect(normalizeCustomFieldKey('guaranteed_analysis')).toBe('guaranteedAnalysisSelector');
  });

  it('handles lowercase word', () => {
    expect(normalizeCustomFieldKey('ingredients')).toBe('ingredientsSelector');
  });

  it('handles multi-word with spaces and mixed case', () => {
    expect(normalizeCustomFieldKey('Health Concerns')).toBe('healthConcernsSelector');
  });

  it('handles Selector already in middle of word', () => {
    expect(normalizeCustomFieldKey('Calorie Selector')).toBe('calorieSelector');
  });
});

// ─── createArbitraryCustomField ──────────────────────────────────────────────

describe('createArbitraryCustomField', () => {
  it('creates a field definition with normalized key', () => {
    const field = createArbitraryCustomField('flavor');
    expect(field.key).toBe('flavorSelector');
    expect(field.outputTarget).toBe('customFields');
    expect(field.valueType).toBe('text');
    expect(field.cardinality).toBe('single');
    expect(field.category).toBe('details');
  });

  it('generates a human-readable label from the key', () => {
    const field = createArbitraryCustomField('myCustomField');
    expect(field.label).toBe('My Custom Field');
  });

  it('handles already-normalized key', () => {
    const field = createArbitraryCustomField('weightSelector');
    expect(field.key).toBe('weightSelector');
    expect(field.label).toBe('Weight');
  });
});
