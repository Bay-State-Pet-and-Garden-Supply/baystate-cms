import { describe, expect, it } from 'vitest';
import {
  BatchContextSchema,
  ProductResearchV2InputSchema,
  ProductSeedSchema,
  identifierRoleForSeedSku,
  priceEvidenceStrength,
  productSeedToLegacyInput,
} from '../../../product-intelligence/product-seed';
import { ProductResearchInputSchema } from '../../../product-intelligence/contracts';

const seed = { sku: 'SUP-001', name: 'Acme Treats', price: 4.99 };

describe('ProductSeed v2 input contract (#50)', () => {
  it('accepts a missing GTIN and fails closed for legacy compatibility', () => {
    expect(ProductSeedSchema.safeParse(seed).success).toBe(true);
    expect(ProductSeedSchema.safeParse({ ...seed, sku: '123456789012' }).success).toBe(true);
    expect(productSeedToLegacyInput(seed)).toBeNull();
    expect(productSeedToLegacyInput(seed, '123')).toBeNull();
    expect(identifierRoleForSeedSku('123456789012')).toBe('sku');
  });

  it('converts only an explicitly discovered valid GTIN to historical input', () => {
    const legacy = productSeedToLegacyInput(seed, '036000291452');
    expect(legacy).toMatchObject({
      gtin: '036000291452',
      registerName: 'Acme Treats',
      price: '4.99',
    });
    expect(ProductResearchInputSchema.safeParse(legacy).success).toBe(true);
    expect(productSeedToLegacyInput({ ...seed, sku: '036000291452' })).toBeNull();
  });

  it('keeps the historical GTIN-first input contract valid and readable', () => {
    expect(ProductResearchInputSchema.safeParse({
      gtin: '036000291452',
      registerName: 'Historical Treats',
    }).success).toBe(true);
  });

  it('rejects weak/empty names but does not require a GTIN', () => {
    expect(ProductSeedSchema.safeParse({ ...seed, name: '' }).success).toBe(false);
    expect(ProductResearchV2InputSchema.safeParse({ productSeed: seed }).success).toBe(true);
  });

  it('keeps price-only differences in the immutable seed and treats price as weak without semantics', () => {
    const a = ProductSeedSchema.parse(seed);
    const b = ProductSeedSchema.parse({ ...seed, price: 5.49 });
    expect(a.price).not.toBe(b.price);
    expect(priceEvidenceStrength()).toBe('weak');
    expect(priceEvidenceStrength('register_sale_price')).toBe('contextual');
  });

  it('requires batch context to be versioned and explicitly non-authoritative', () => {
    expect(BatchContextSchema.parse({ batchId: 'batch-1' })).toMatchObject({ schemaVersion: 1, authoritative: false });
    expect(BatchContextSchema.safeParse({ batchId: 'batch-1', authoritative: true }).success).toBe(false);
  });
});
