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

    // Media fields normalized
    expect(product.core.media.primary).toBe('media/cat-toy.jpg');
    expect(product.core.media.additional).toEqual([
      'media/cat-toy-2.jpg',
      'media/cat-toy-3.jpg',
    ]);

    // Additional images should be filtered out of unknownElements
    expect(product.shopsite.preserved.unknownElements['MoreInfoImage1']).toBeUndefined();
    expect(product.shopsite.preserved.unknownElements['MoreInfoImage2']).toBeUndefined();

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

    // Verify first product (no additional images — MoreInfoImage tags should not be emitted)
    const { product: dogFood } = normalizeProduct(result.products[0], workspaceId);
    const denorm1 = denormalizeProduct(dogFood);
    expect(denorm1.xml).not.toContain('<MoreInfoImage1>');
    expect(denorm1.xml).not.toContain('<MoreInfoImage20>');

    // Verify second product (with additional images — only populated slots emit)
    const { product: catToy } = normalizeProduct(result.products[1], workspaceId);
    const denorm2 = denormalizeProduct(catToy);
    expect(denorm2.xml).toContain('<MoreInfoImage1>media/cat-toy-2.jpg</MoreInfoImage1>');
    expect(denorm2.xml).toContain('<MoreInfoImage2>media/cat-toy-3.jpg</MoreInfoImage2>');
    expect(denorm2.xml).not.toContain('<MoreInfoImage3>');
    expect(denorm2.xml).not.toContain('<MoreInfoImage20>');

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

  it('should include GTIN tag for numeric SKUs (v15 schema field)', () => {
    const customXml = `<Product>
      <SKU>0123456789012</SKU>
      <Name>Test Product</Name>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<GTIN>0123456789012</GTIN>');
  });

  it('should include ProductType by default', () => {
    const customXml = `<Product>
      <SKU>TYPE-TEST</SKU>
      <Name>Type Test</Name>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<ProductType>Tangible</ProductType>');
  });

  it('should put the product name in ProductDescription and the description in MoreInformationText', () => {
    const customXml = `<Product>
      <SKU>DESC-TEST</SKU>
      <Name>Desc Test</Name>
      <ProductDescription><![CDATA[Test description here]]></ProductDescription>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    expect(product.core.description).toBe('Test description here');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<ProductDescription><![CDATA[Desc Test]]></ProductDescription>');
    expect(denorm.xml).toContain('<MoreInformationText><![CDATA[Test description here]]></MoreInformationText>');
    expect(denorm.xml).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
  });

  it('should omit MoreInformationText and the More Info flag when there is no description', () => {
    const customXml = `<Product>
      <SKU>NODESC</SKU>
      <Name>No Description</Name>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    expect(product.core.description).toBeNull();
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).not.toContain('<MoreInformationText>');
    expect(denorm.xml).not.toContain('<DisplayMoreInformationPage>');
    // ProductDescription still carries the product name per upload convention.
    expect(denorm.xml).toContain('<ProductDescription><![CDATA[No Description]]></ProductDescription>');
  });

  it('should honor an explicit preserved DisplayMoreInformationPage_ opt-out', () => {
    const customXml = `<Product>
      <SKU>OPTOUT</SKU>
      <Name>Opt Out</Name>
      <MoreInformationText><![CDATA[Copy that stays hidden.]]></MoreInformationText>
      <DisplayMoreInformationPage>uncheck</DisplayMoreInformationPage>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<MoreInformationText><![CDATA[Copy that stays hidden.]]></MoreInformationText>');
    expect(denorm.xml).toContain('<DisplayMoreInformationPage>uncheck</DisplayMoreInformationPage>');
  });

  it('should emit MoreInformationText exactly once (no double-emission from preserved elements)', () => {
    const customXml = `<Product>
      <SKU>SINGLE-EMIT</SKU>
      <Name>Single Emit</Name>
      <ProductDescription><![CDATA[Legacy description text]]></ProductDescription>
      <MoreInformationText><![CDATA[Legacy description text]]></MoreInformationText>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml.match(/<MoreInformationText>/g)?.length ?? 0).toBe(1);
    expect(denorm.xml.match(/<DisplayMoreInformationPage>/g)?.length ?? 0).toBe(1);
  });

  it('should not treat a ProductDescription that equals the Name as a description on import', () => {
    const customXml = `<Product>
      <SKU>ECHO</SKU>
      <Name>Echo Prod</Name>
      <ProductDescription><![CDATA[Echo Prod]]></ProductDescription>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    expect(product.core.description).toBeNull();
  });

  it('should omit empty Price tag when price is null', () => {
    const customXml = `<Product>
      <SKU>NO-PRICE</SKU>
      <Name>No Price Product</Name>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).not.toContain('<Price>');
  });

  it('should preserve MoreInformationGraphic when it is different from Graphic', () => {
    const customXml = `<Product>
      <SKU>TEST-123</SKU>
      <Graphic>media/cat-toy.jpg</Graphic>
      <MoreInformationGraphic>media/cat-toy-detail.jpg</MoreInformationGraphic>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    expect(product.core.media.primary).toBe('media/cat-toy.jpg');
    expect(product.shopsite.preserved.unknownElements['MoreInformationGraphic']).toBe('media/cat-toy-detail.jpg');
    
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<Graphic>media/cat-toy.jpg</Graphic>');
    expect(denorm.xml).toContain('<MoreInformationGraphic>media/cat-toy-detail.jpg</MoreInformationGraphic>');
  });

  it('should serialize QuantityOnHand when present', () => {
    const customXml = `<Product>
      <SKU>TEST-QTY</SKU>
      <QuantityOnHand>42</QuantityOnHand>
    </Product>`;
    const parsed = parseProductsXml(customXml).products[0];
    const { product } = normalizeProduct(parsed, 'test-workspace');
    expect(product.core.inventory.quantityOnHand).toBe(42);
    
    const denorm = denormalizeProduct(product);
    expect(denorm.xml).toContain('<QuantityOnHand>42</QuantityOnHand>');
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
