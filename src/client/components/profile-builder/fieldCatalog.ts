/**
 * Field catalog for the profile builder.
 *
 * Defines every extractable product field the system knows about.
 * This is the single source of truth for field rendering, validation
 * hints, and save mapping within the profile builder feature.
 *
 * Mirrors the canonical catalog in `src/shared/profile-fields.ts` but
 * is local to the feature to avoid importing Bun-only modules and to
 * allow feature-specific metadata.
 *
 * No Bun-only imports — safe for Vite/React frontend.
 */

import type { FieldCategory } from './profileBuilderTypes';

// ─── Types ──────────────────────────────────────────────────────────────────

export type OutputTarget = 'core' | 'customFields';

export type FieldValueType =
  | 'text'
  | 'image'
  | 'numeric'
  | 'array'
  | 'structured';

export interface FieldDefinition {
  key: string;
  label: string;
  outputTarget: OutputTarget;
  valueType: FieldValueType;
  cardinality: 'single' | 'multiple';
  category: FieldCategory;
  requiredForMvp?: boolean;
  deprecated?: boolean;
  validationHints?: {
    minLength?: number;
    minMatchCount?: number;
    maxMatchCount?: number;
    expectedFormat?: 'currency' | 'number' | 'image-url' | 'text';
  };
}

// ─── Core Fields (dedicated DB columns) ─────────────────────────────────────

export const CORE_FIELDS: readonly FieldDefinition[] = [
  {
    key: 'titleSelector',
    label: 'Product title',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    category: 'identity',
    requiredForMvp: true,
    validationHints: { minLength: 3, minMatchCount: 1, maxMatchCount: 1 },
  },
  {
    key: 'titleOptionalSelectors',
    label: 'Additional title parts',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'multiple',
    category: 'identity',
  },

  {
    key: 'descriptionSelector',
    label: 'Description',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    category: 'description',
    validationHints: { minLength: 20 },
  },
  {
    key: 'imagesSelector',
    label: 'Images',
    outputTarget: 'core',
    valueType: 'image',
    cardinality: 'multiple',
    category: 'media',
    validationHints: { minMatchCount: 1 },
  },
];

// ─── Standard Custom Fields (stored in customSelectors JSON) ─────────────────

export const STANDARD_CUSTOM_FIELDS: readonly FieldDefinition[] = [
  { key: 'skuSelector', label: 'SKU', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'identity' },
  { key: 'ingredientsSelector', label: 'Ingredients', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'nutrition' },
  { key: 'guaranteedAnalysisSelector', label: 'Guaranteed analysis', outputTarget: 'customFields', valueType: 'structured', cardinality: 'single', category: 'nutrition' },
  { key: 'caloriesSelector', label: 'Calories', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'nutrition' },
  { key: 'dietaryLabelsSelector', label: 'Dietary labels', outputTarget: 'customFields', valueType: 'array', cardinality: 'multiple', category: 'nutrition' },
  { key: 'weightSelector', label: 'Weight', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'details' },
  { key: 'dimensionsSelector', label: 'Dimensions', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'details' },
  { key: 'flavorSelector', label: 'Flavor', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'details' },
  { key: 'lifeStageSelector', label: 'Life stage', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'details' },
  { key: 'speciesSelector', label: 'Species', outputTarget: 'customFields', valueType: 'text', cardinality: 'single', category: 'details' },
  { key: 'healthConcernsSelector', label: 'Health concerns', outputTarget: 'customFields', valueType: 'array', cardinality: 'multiple', category: 'details' },
];

// ─── Derived collections ────────────────────────────────────────────────────

export const ALL_STANDARD_FIELDS: readonly FieldDefinition[] = [
  ...CORE_FIELDS,
  ...STANDARD_CUSTOM_FIELDS,
];

export const FIELD_GROUP_ORDER: readonly FieldCategory[] = [
  'identity',
  'media',
  'description',
  'nutrition',
  'details',
  'variants',
];

// ─── Label map ──────────────────────────────────────────────────────────────

// fallow-ignore-next-line unused-export — used by tests
export const FIELD_LABEL_BY_KEY: Record<string, string> = {};
for (const field of ALL_STANDARD_FIELDS) {
  FIELD_LABEL_BY_KEY[field.key] = field.label;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const fieldByKey = new Map<string, FieldDefinition>(
  ALL_STANDARD_FIELDS.map((f) => [f.key, f]),
);

/**
 * Look up a field definition by its selector key (e.g. `'titleSelector'`).
 * Returns `null` for unknown / arbitrary custom fields.
 */
export function getFieldDefinition(key: string): FieldDefinition | null {
  return fieldByKey.get(key) ?? null;
}

/**
 * Normalize an arbitrary custom field name to a stable selector-style key.
 *
 * Examples:
 *   normalizeCustomFieldKey('Flavor')         → 'flavorSelector'
 *   normalizeCustomFieldKey('flavorSelector') → 'flavorSelector' (no double suffix)
 *   normalizeCustomFieldKey('ingredients')    → 'ingredientsSelector'
 *   normalizeCustomFieldKey('SKU Number')     → 'skuNumberSelector'
 *   normalizeCustomFieldKey('')               → 'customFieldSelector'
 */
// fallow-ignore-next-line unused-export — used by tests
export function normalizeCustomFieldKey(input: string): string {
  const raw = input.trim();
  if (!raw) return 'customFieldSelector';

  // Normalize to camelCase words.
  const cleaned = raw
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (index === 0) {
        return part.charAt(0).toLowerCase() + part.slice(1);
      }
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');

  // If already ends with 'Selector', use as-is.
  if (cleaned.endsWith('Selector')) {
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }

  return `${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}Selector`;
}

/**
 * Create a FieldDefinition for an arbitrary custom field.
 * The key is normalized via `normalizeCustomFieldKey`.
 */
export function createArbitraryCustomField(key: string): FieldDefinition {
  const normalized = normalizeCustomFieldKey(key);
  const label = normalized
    .replace(/Selector$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (s) => s.toUpperCase());

  return {
    key: normalized,
    label,
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    category: 'details',
  };
}
