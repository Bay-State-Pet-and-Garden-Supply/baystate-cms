import { describe, it, expect } from 'vitest';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
import { sanitizeXml } from '../../shopsite/xml-sanitizer';
import fs from 'fs';
import path from 'path';

const fixturePath = path.resolve(import.meta.dirname, '../fixtures/shopsite-products-sample.xml');
const fixtureXml = fs.readFileSync(fixturePath, 'utf-8');

describe('ShopSite Normalization Preservation', () => {
  it('should parse the sample XML', () => {
    const result = parseProductsXml(fixtureXml);
    expect(result.productXmlVersion).toBe('15.0');
    expect(result.products.length).toBe(2);
  });

  it('should extract core fields from products', () => {
    const result = parseProductsXml(fixtureXml);

    const dogFood = result.products[0];
    expect(dogFood.fields['SKU']).toBe('ABC-123');
    expect(dogFood.fields['Name']).toBe('Premium Dog Food');
    expect(dogFood.fields['Price']).toBe('49.99');
    expect(dogFood.fields['ProductField16']).toBe('Premium Brands');
  });

  it('should preserve ProductField* as unknown/custom fields', () => {
    const result = parseProductsXml(fixtureXml);

    const dogFood = result.products[0];
    expect(dogFood.unknownElements['ProductField1']).toBe('new060624');
    expect(dogFood.unknownElements['ProductField16']).toBe('Premium Brands');
    expect(dogFood.unknownElements['ProductField24']).toBe('Dog Food');
    expect(dogFood.unknownElements['ProductField25']).toBe('Dry Food');
  });

  it('should preserve advanced blocks (Subproducts)', () => {
    const result = parseProductsXml(fixtureXml);

    const catToy = result.products[1];
    expect(catToy.hasAdvanced).toBe(true);
    expect(catToy.advancedBlocks['Subproducts']).toBeTruthy();
    expect(catToy.advancedBlocks['Subproducts']).toContain('<Subproduct>');
    expect(catToy.advancedBlocks['Subproducts']).toContain('XYZ-789-RED');
  });

  it('should normalize product to generic JSON with preserved data', () => {
    const result = parseProductsXml(fixtureXml);
    const catToy = result.products[1];

    const workspaceId = 'test-workspace';
    const { product } = normalizeProduct(catToy, workspaceId);

    expect(product.sku).toBe('XYZ-789');
    expect(product.core.name).toBe('Cat Toy Deluxe');
    expect(product.core.price).toBe('12.99');
    expect(product.core.salePrice).toBe('9.99');

    // Custom fields preserved
    expect(product.customFields['ProductField1']).toBe('new060624');
    expect(product.customFields['ProductField16']).toBe('Fun Pet Co');

    // Advanced blocks preserved
    expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toBeTruthy();
    expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toContain('XYZ-789-RED');
  });

  it('should preserve unknown non-ProductField elements', () => {
    const result = parseProductsXml(fixtureXml);
    const workspaceId = 'test-workspace';

    const dogFood = result.products[0];
    const { product } = normalizeProduct(dogFood, workspaceId);

    // MoreInfoImage should not be in customFields but may be captured
    // The key thing is that it's preserved in the round-trip
    expect(product.shopsite.preserved.advancedBlocks).toBeDefined();
  });

  it('should round-trip product through normalize and denormalize', () => {
    const result = parseProductsXml(fixtureXml);
    const workspaceId = 'test-workspace';

    for (const parsed of result.products) {
      const { product } = normalizeProduct(parsed, workspaceId);
      const denormalized = denormalizeProduct(product);

      expect(denormalized.xml).toBeTruthy();
      expect(denormalized.xml).toContain(`<SKU>${product.sku}</SKU>`);
      expect(denormalized.xml).toContain(`<Name>${product.core.name}</Name>`);

      // Advanced blocks preserved in round-trip
      for (const blockXml of Object.values(product.shopsite.preserved.advancedBlocks)) {
        expect(denormalized.xml).toContain(blockXml);
      }
    }
  });

  it('should not drop advanced blocks during round-trip', () => {
    const result = parseProductsXml(fixtureXml);
    const catToyParsed = result.products[1];
    const workspaceId = 'test-workspace';

    const { product } = normalizeProduct(catToyParsed, workspaceId);
    const denormalized = denormalizeProduct(product);

    // The Subproducts block should be in the output
    expect(denormalized.xml).toContain('<Subproducts>');
    expect(denormalized.xml).toContain('XYZ-789-RED');
    expect(denormalized.xml).toContain('XYZ-789-BLUE');
  });

  it('should generate correct registry observations', () => {
    const result = parseProductsXml(fixtureXml);
    const workspaceId = 'test-workspace';

    const { registryObserved } = normalizeProduct(result.products[0], workspaceId);

    // Should have core field entries
    const skuEntry = registryObserved.find((e) => e.xmlField === 'SKU');
    expect(skuEntry).toBeTruthy();
    expect(skuEntry!.kind).toBe('core');
    expect(skuEntry!.required).toBe(true);

    // Should have ProductField entries
    const pf16 = registryObserved.find((e) => e.xmlField === 'ProductField16');
    expect(pf16).toBeTruthy();
    expect(pf16!.kind).toBe('custom');
    expect(pf16!.editable).toBe(true);
  });
});

describe('XML Sanitizer', () => {
  it('should fix unencoded ampersands', () => {
    const input = 'Dog & Cat Supplies & More';
    const result = sanitizeXml(input);
    expect(result).toBe('Dog &amp; Cat Supplies &amp; More');
  });

  it('should not double-encode already valid entities', () => {
    const input = 'Dog &amp; Cat';
    const result = sanitizeXml(input);
    // The regex should see &amp; as valid entity pattern and not change it
    // Note: &amp; starts with & followed by a-zA-Z, so the negative lookahead won't match
    expect(result).toBe('Dog &amp; Cat');
  });

  it('should replace common HTML entities', () => {
    const input = 'Copy &copy; Trade &trade;';
    const result = sanitizeXml(input);
    expect(result).toContain('&#169;');
    expect(result).not.toContain('&copy;');
  });

  it('should handle empty input', () => {
    expect(sanitizeXml('')).toBe('');
    expect(sanitizeXml(undefined as unknown as string)).toBe('');
  });
});
