import { describe, it, expect } from 'vitest';
import { normalizeAndValidateCustomFields, normalizeCustomFieldKey } from '../../server/services/profile-builder/customFieldNormalizer';

// ─── Helpers ────────────────────────────────────────────────────────────────────

const SIMPLE_PRODUCT_HTML = `<!DOCTYPE html>
<html>
<body>
  <main>
    <h1 class="product-title">Premium Dog Food</h1>
    <span class="brand-name">Acme Pets</span>
    <div class="ingredients">
      <ul class="ingredient-list">
        <li>Chicken</li>
        <li>Rice</li>
      </ul>
    </div>
    <div class="product-weight">2.64 oz</div>
    <div class="flavor-name">Chicken Flavored</div>
    <div class="sku-value">SKU-12345</div>
  </main>
</body>
</html>`;

const EMPTY_HTML = '<html><body></body></html>';

function makeRawField(overrides: Record<string, unknown> = {}) {
  return {
    proposedKey: 'ingredientList',
    label: 'Ingredients',
    valueType: 'text',
    multiple: false,
    candidates: [{ selector: '.ingredient-list', evidence: 'Found ingredient list.' }],
    ...overrides,
  };
}

// ─── Key normalization tests ─────────────────────────────────────────────────

describe('normalizeCustomFieldKey', () => {
  it('normalizes simple input to camelCase + Selector', () => {
    expect(normalizeCustomFieldKey('ingredient list')).toBe('ingredientListSelector');
  });

  it('normalizes underscores to camelCase', () => {
    expect(normalizeCustomFieldKey('product_weight')).toBe('productWeightSelector');
  });

  it('handles mixed case', () => {
    expect(normalizeCustomFieldKey('Flavor / Variety')).toBe('flavorVarietySelector');
  });

  it('does not double-suffix Selector', () => {
    expect(normalizeCustomFieldKey('flavorSelector')).toBe('flavorSelector');
  });

  it('handles single word', () => {
    expect(normalizeCustomFieldKey('weight')).toBe('weightSelector');
  });

  it('adds Selector suffix when missing', () => {
    expect(normalizeCustomFieldKey('ingredient')).toBe('ingredientSelector');
  });

  it('handles empty input', () => {
    expect(normalizeCustomFieldKey('')).toBe('customFieldSelector');
  });

  it('handles special characters', () => {
    expect(normalizeCustomFieldKey('S.K.U. Number!')).toBe('sKUNumberSelector');
  });

  it('handles already-correct keys', () => {
    expect(normalizeCustomFieldKey('lifeStageSelector')).toBe('lifeStageSelector');
  });

  it('handles multi-word with spaces', () => {
    expect(normalizeCustomFieldKey('Guaranteed Analysis')).toBe('guaranteedAnalysisSelector');
  });
});

// ─── Full normalization + validation tests ──────────────────────────────────

describe('normalizeAndValidateCustomFields', () => {
  const requestedKeys = ['titleSelector', 'brandSelector'];
  const existingKeys: string[] = [];

  it('normalizes and validates a valid custom field', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField()],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('ingredientListSelector');
    expect(result[0].fieldKey).toBe('ingredientListSelector');
    expect(result[0].label).toBe('Ingredients');
    expect(result[0].valueType).toBe('text');
    expect(result[0].status).toBe('suggested');
  });

  it('rejects reserved keys', () => {
    // Must use Object.assign to avoid __proto__ object-literal special behavior
    const rawField = Object.assign(makeRawField(), { proposedKey: '__proto__' });
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [rawField],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('rejects constructor key', () => {
    const rawField = Object.assign(makeRawField(), { proposedKey: 'constructor' });
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [rawField],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('rejects collisions with requested fields', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ proposedKey: 'title' })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('rejects collisions with existing custom fields', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ proposedKey: 'existingField' })],
      requestedKeys,
      ['existingFieldSelector'],
    );

    expect(result).toHaveLength(0);
  });

  it('rejects semantic aliases of catalog fields', () => {
    // "manufacturer" should map to brandSelector
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ proposedKey: 'manufacturer', label: 'Manufacturer' })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('rejects semantic aliases of catalog fields by label', () => {
    // "Product Name" should map to titleSelector
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ proposedKey: 'customName', label: 'Product Name' })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('deduplicates identical proposals', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField(), makeRawField()],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(1);
  });

  it('rejects proposals with no candidates', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ candidates: [] })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('rejects proposals whose selector gets zero matches', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ candidates: [{ selector: '.does-not-exist', evidence: 'not found' }] })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('caps at 8 custom fields', () => {
    const fields = Array.from({ length: 12 }, (_, i) => makeRawField({
      proposedKey: `field${i}`,
      label: `Field ${i}`,
      candidates: [{ selector: '.ingredient-list', evidence: 'exists' }],
    }));

    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      fields,
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(8);
  });

  it('handles image value type', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ valueType: 'image' })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(1);
    expect(result[0].valueType).toBe('image');
  });

  it('falls back to text for unsupported value types', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({ valueType: 'rgb' })],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(1);
    expect(result[0].valueType).toBe('text');
  });

  it('handles empty HTML gracefully', () => {
    const result = normalizeAndValidateCustomFields(
      EMPTY_HTML,
      [makeRawField()],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('handles empty proposals array', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [],
      requestedKeys,
      existingKeys,
    );

    expect(result).toHaveLength(0);
  });

  it('flavour is duplicate of flavor', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({
        proposedKey: 'flavour',
        label: 'Flavour',
        candidates: [{ selector: '.flavor-name', evidence: 'found flavor' }],
      })],
      requestedKeys,
      existingKeys,
    );

    // "flavour" maps to "flavorSelector" which is in SEMANTIC_ALIASES under flavorSelector
    // But it's not in requestedKeys, so it depends on semantic alias detection
    // The alias "flavour" → flavorSelector is in SEMANTIC_ALIASES
    expect(result).toHaveLength(0);
  });

  it('accepts a valid weight field', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({
        proposedKey: 'packageWeight',
        label: 'Container Weight',
        candidates: [{ selector: '.product-weight', evidence: 'found weight' }],
      })],
      requestedKeys,
      existingKeys,
    );

    // "packageWeight" doesn't match weightSelector's alias list exactly
    // It should pass through if not a semantic duplicate
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('packageWeightSelector');
    expect(result[0].status).toBe('suggested');
  });

  it('accepts an SKU field', () => {
    const result = normalizeAndValidateCustomFields(
      SIMPLE_PRODUCT_HTML,
      [makeRawField({
        proposedKey: 'productSku',
        label: 'Product SKU',
        candidates: [{ selector: '.sku-value', evidence: 'found sku' }],
      })],
      ['titleSelector'],
      [],
    );

    // "SKU" is in SEMANTIC_ALIASES under skuSelector, but "Product SKU" label and
    // "productSku" key may or may not match. Check result.
    // The alias check is: if requestedKeys includes skuSelector, it's a duplicate.
    // skuSelector is NOT in requestedKeys, so it should pass through.
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('productSkuSelector');
  });
});
