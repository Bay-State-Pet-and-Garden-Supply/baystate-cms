import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJsonFileString,
  canonicalJsonStringify,
  hashCanonicalJson,
  sha256Hex,
} from '../../shared/stable-id';
import { deterministicStringify } from '../../git/deterministic-json';

describe('canonical JSON and SHA-256 identities', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const left = { z: [{ b: 2, a: 1 }, 'second'], a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }, 'second'] };
    expect(canonicalJsonStringify(left)).toBe('{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},"second"]}');
    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(hashCanonicalJson(left)).toBe(hashCanonicalJson(right));
    expect(hashCanonicalJson({ values: [1, 2] })).not.toBe(hashCanonicalJson({ values: [2, 1] }));
  });

  it('uses fixed lexical-key and SHA-256 vectors including integer-like keys', () => {
    const value = { '10': 'ten', '2': 'two', nested: { '1': 'one', '01': 'leading' }, emoji: '🐾' };
    expect(canonicalJsonStringify(value)).toBe('{"10":"ten","2":"two","emoji":"🐾","nested":{"01":"leading","1":"one"}}');
    expect(hashCanonicalJson(value)).toBe('e7ee6ec1203f970e9959920de7469e68af79ee58e62629d330722556c433f2b4');
    expect(canonicalJsonFileString(value)).toBe('{\n  "10": "ten",\n  "2": "two",\n  "emoji": "🐾",\n  "nested": {\n    "01": "leading",\n    "1": "one"\n  }\n}\n');
  });

  it('uses deterministic Unicode, escaping, UTF-8 hashing, and one final LF', () => {
    const value = { emoji: '🐾', quote: '"\\\n', café: 'é' };
    expect(canonicalJsonStringify(value)).toBe('{"café":"é","emoji":"🐾","quote":"\\"\\\\\\n"}');
    const file = canonicalJsonFileString(value);
    expect(file.endsWith('\n')).toBe(true);
    expect(file.endsWith('\n\n')).toBe(false);
    expect(deterministicStringify(value)).toBe(file);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashCanonicalJson(value)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes negative zero, preserves __proto__ as data, and permits repeated non-cyclic references', () => {
    const shared = { value: -0 };
    expect(canonicalJsonStringify({ left: shared, right: shared })).toBe('{"left":{"value":0},"right":{"value":0}}');
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as unknown;
    expect(canonicalJsonStringify(prototypeKey)).toBe('{"__proto__":{"polluted":true},"safe":1}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    ['undefined', { bad: undefined }],
    ['non-finite', { bad: Number.NaN }],
    ['infinity', { bad: Number.POSITIVE_INFINITY }],
    ['class instance', { bad: new Date('2026-01-01T00:00:00.000Z') }],
    ['function', { bad: () => true }],
    ['bigint', { bad: 1n }],
    ['unsafe integer', { bad: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s instead of silently changing it', (_label, value) => {
    expect(() => canonicalJsonStringify(value)).toThrow(CanonicalJsonError);
  });

  it('rejects array subclasses and lone UTF-16 surrogates', () => {
    class FancyArray extends Array<unknown> {}
    expect(() => canonicalJsonStringify(new FancyArray('value'))).toThrow(/plain arrays/);
    expect(() => canonicalJsonStringify({ value: '\ud800' })).toThrow(/Lone UTF-16/);
    expect(() => canonicalJsonStringify({ '\udfff': 'value' })).toThrow(/Lone UTF-16/);
  });

  it('rejects cycles, sparse arrays, accessors, and symbol keys', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJsonStringify(cycle)).toThrow(/Cyclic/);

    const sparse = new Array(2);
    sparse[1] = 'value';
    expect(() => canonicalJsonStringify(sparse)).toThrow(/Sparse/);

    const decoratedArray = ['value'] as unknown[] & { extra?: boolean };
    decoratedArray.extra = true;
    expect(() => canonicalJsonStringify(decoratedArray)).toThrow(/Extra array properties/);

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'side effect' });
    expect(() => canonicalJsonStringify(accessor)).toThrow(/Accessor/);

    const symbolKey = { valid: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = true;
    expect(() => canonicalJsonStringify(symbolKey)).toThrow(/Symbol keys/);
  });
});
