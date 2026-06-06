import { describe, it, expect } from 'vitest';
import {
  encodeSkuForFilename,
  decodeSkuFromFilename,
  skuToProductFilePath,
  productFilePathToSku,
} from '../../git/product-file-path';

describe('encodeSkuForFilename', () => {
  it('should keep simple SKUs unchanged', () => {
    expect(encodeSkuForFilename('ABC-123')).toBe('ABC-123');
    expect(encodeSkuForFilename('DOG_FOOD')).toBe('DOG_FOOD');
    expect(encodeSkuForFilename('simple.sku')).toBe('simple.sku');
  });

  it('should encode SKUs with spaces', () => {
    const encoded = encodeSkuForFilename('ABC 123');
    expect(encoded).not.toContain(' ');
    expect(typeof encoded).toBe('string');
  });

  it('should encode SKUs with slashes', () => {
    const encoded = encodeSkuForFilename('A/B/C');
    expect(encoded).not.toContain('/');
  });

  it('should encode SKUs with special characters', () => {
    const encoded = encodeSkuForFilename('100% Organic');
    expect(typeof encoded).toBe('string');
    // % encodes to %25, spaces to %20
    expect(encoded).toMatch(/^100%25%20Organic$/);
  });
});

describe('decodeSkuFromFilename', () => {
  it('should decode percent-encoded strings', () => {
    const original = 'ABC 123';
    const encoded = encodeSkuForFilename(original);
    const decoded = decodeSkuFromFilename(encoded);
    expect(decoded).toBe(original);
  });

  it('should round-trip SKUs with special characters', () => {
    const skus = ['ABC-123', 'DOG FOOD', 'Pet/Supply/Item', '100% Organic', 'simple.sku'];
    for (const sku of skus) {
      const encoded = encodeSkuForFilename(sku);
      const decoded = decodeSkuFromFilename(encoded);
      expect(decoded).toBe(sku);
    }
  });

  it('should handle SKUs with percent in them safely', () => {
    const original = '100% Organic';
    const encoded = encodeSkuForFilename(original);
    const decoded = decodeSkuFromFilename(encoded);
    expect(decoded).toBe(original);
  });
});

describe('skuToProductFilePath', () => {
  it('should generate correct path', () => {
    expect(skuToProductFilePath('ABC-123')).toBe('products/ABC-123.json');
    expect(skuToProductFilePath('DOG FOOD')).toMatch(/^products\/.+\.json$/);
  });
});

describe('productFilePathToSku', () => {
  it('should round-trip simple SKUs', () => {
    const original = 'ABC-123';
    const path = skuToProductFilePath(original);
    const result = productFilePathToSku(path);
    expect(result).toBe(original);
  });

  it('should round-trip complex SKUs', () => {
    const original = 'Cat/Food/Deluxe';
    const path = skuToProductFilePath(original);
    const result = productFilePathToSku(path);
    expect(result).toBe(original);
  });
});
