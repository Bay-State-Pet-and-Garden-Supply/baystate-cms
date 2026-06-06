import { describe, it, expect } from 'vitest';
import { deterministicStringify, hashJson, parseJsonFile } from '../../git/deterministic-json';

describe('deterministicStringify', () => {
  it('should produce stable key ordering', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    const resultA = deterministicStringify(a);
    const resultB = deterministicStringify(b);
    expect(resultA).toBe(resultB);
  });

  it('should use 2-space indentation', () => {
    const obj = { name: 'test', price: '10.00' };
    const result = deterministicStringify(obj);
    expect(result).toContain('\n  ');
  });

  it('should handle nested objects deterministically', () => {
    const a = { core: { z: 1, a: 2 }, meta: { b: 3 } };
    const b = { meta: { b: 3 }, core: { a: 2, z: 1 } };
    expect(deterministicStringify(a)).toBe(deterministicStringify(b));
  });

  it('should handle arrays without reordering', () => {
    const obj = { items: ['b', 'a', 'c'], id: 1 };
    const result = deterministicStringify(obj);
    expect(result).toContain('"b"');
    expect(result).toContain('"a"');
    expect(result).toContain('"c"');
  });

  it('should replace NaN and Infinity with null', () => {
    const obj = { nan: NaN, inf: Infinity, negInf: -Infinity, normal: 42 };
    const result = deterministicStringify(obj);
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });
});

describe('hashJson', () => {
  it('should produce stable hashes for identical objects', () => {
    const a = { sku: 'ABC', name: 'Test' };
    const b = { name: 'Test', sku: 'ABC' };
    expect(hashJson(a)).toBe(hashJson(b));
  });

  it('should produce different hashes for different objects', () => {
    const a = { sku: 'ABC' };
    const b = { sku: 'DEF' };
    expect(hashJson(a)).not.toBe(hashJson(b));
  });

  it('should return a non-empty string', () => {
    const hash = hashJson({ test: true });
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
  });
});

describe('parseJsonFile', () => {
  it('should parse valid JSON', () => {
    const result = parseJsonFile<{ name: string }>('{"name": "test"}');
    expect(result).toEqual({ name: 'test' });
  });
});
