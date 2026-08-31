import { describe, it, expect } from 'vitest';
import { VariantMatrixSchema, computeIdentityMatrixHash, VARIANT_PARSER_VERSION, VariantSelectionReceiptSchema, VariantSelectionRequestSchema } from '../../shared/schemas/variant-resolution';
import { createHash } from 'node:crypto';

describe('variant-resolution-schema', () => {
  it('rejects oversized candidate payload', () => {
    const tooMany = Array.from({ length: 251 }, (_, i) => ({
      variantKey: `k-${i}`,
      platformId: `${i}`,
      title: `Variant ${i}`,
      identifiers: [],
      options: [],
      available: true,
      price: null,
      currency: null,
      weight: null,
      dimensions: null,
      images: [],
      deepLink: `https://example.com/products/test?variant=${i}`,
      sourcePaths: {},
    }));
    const result = VariantMatrixSchema.safeParse({
      parserVersion: VARIANT_PARSER_VERSION,
      platform: 'shopify',
      canonicalParentUrl: 'https://example.com/products/test',
      sourceFinalUrl: 'https://example.com/products/test',
      sourceContentHash: null,
      candidates: tooMany,
      warnings: [],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
  it('computes stable hash', () => {
    const matrix: any = {
      parserVersion: 1,
      platform: 'shopify',
      canonicalParentUrl: 'https://example.com/products/test',
      sourceFinalUrl: 'https://example.com/products/test',
      sourceContentHash: null,
      candidates: [
        { variantKey: 'b', platformId: '2', title: 'B', identifiers: [], options: [], available: true, price: null, currency: null, weight: null, dimensions: null, images: [], deepLink: 'https://example.com/products/test?variant=2', sourcePaths: {} },
        { variantKey: 'a', platformId: '1', title: 'A', identifiers: [], options: [], available: true, price: null, currency: null, weight: null, dimensions: null, images: [], deepLink: 'https://example.com/products/test?variant=1', sourcePaths: {} },
      ],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    const h1 = computeIdentityMatrixHash(matrix);
    const h2 = computeIdentityMatrixHash({ ...matrix, candidates: [...matrix.candidates].reverse() });
    expect(h1).toEqual(h2);
    expect(h1).toHaveLength(64);
  });
  it('hash is SHA256 and excludes volatile fields', () => {
    const base: any = {
      parserVersion: 1,
      platform: 'shopify',
      canonicalParentUrl: 'https://example.com/products/test',
      sourceFinalUrl: 'https://example.com/products/test?variant=1',
      sourceContentHash: 'abc',
      candidates: [
        { variantKey: 'a', platformId: '1', title: 'A', identifiers: [{ kind: 'sku', value: 'SKU1', normalizedValue: 'sku1', sourcePath: 'x' }], options: [{ axis: 'Size', value: 'Small', normalizedAxis: 'size', normalizedValue: 'small', sourcePath: 'x' }], available: true, price: '10.00', currency: 'USD', weight: '100g', dimensions: null, images: [{ url: 'https://example.com/a.jpg', role: 'primary', sourcePath: 'x' }], deepLink: 'https://example.com/products/test?variant=1', sourcePaths: {} },
      ],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    const hBase = computeIdentityMatrixHash(base);
    expect(hBase).toMatch(/^[a-f0-9]{64}$/);
    // Volatile price/stock/image change must not change hash
    const altered = { ...base, candidates: [{ ...base.candidates[0], price: '99.99', available: false, images: [{ url: 'https://example.com/other.jpg', role: 'primary', sourcePath: 'x' }] }] };
    expect(computeIdentityMatrixHash(altered)).toBe(hBase);
    // Volatile field exclusion already verified above; ensure hash is deterministic 64 hex
    expect(hBase).toHaveLength(64);
  });
  it('rejects non-64-hex identity hash in schemas', () => {
    const bad = { resolutionId: 'r1', identityMatrixHash: 'abc123', parserVersion: 1, selectedVariantKey: 'k', decisionOrigin: 'automatic' as const, selectedDeepLink: 'https://example.com', matchedBy: 'gtin', evidencePaths: [], createdAt: new Date().toISOString() };
    expect(VariantSelectionReceiptSchema.safeParse(bad).success).toBe(false);
    expect(VariantSelectionRequestSchema.safeParse({ resolutionId: 'r', identityMatrixHash: 'ZZZ', variantKey: 'k' }).success).toBe(false);
    const goodHash = createHash('sha256').update('test').digest('hex');
    expect(VariantSelectionReceiptSchema.safeParse({ ...bad, identityMatrixHash: goodHash }).success).toBe(true);
  });
});
