import { sha256 } from './hash';

export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends TypeError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

function childPath(parent: string, key: string | number): string {
  return typeof key === 'number'
    ? `${parent}[${key}]`
    : `${parent}.${JSON.stringify(key)}`;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError('Lone UTF-16 surrogates are not valid canonical JSON', path);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalJsonError('Lone UTF-16 surrogates are not valid canonical JSON', path);
    }
  }
}

/**
 * Validate and clone a JSON-domain value. Canonical emitters sort object keys
 * explicitly because JavaScript object enumeration reorders integer-like keys.
 *
 * This deliberately rejects values that native JSON.stringify silently drops or
 * rewrites (undefined, non-finite numbers, sparse arrays, accessors, symbols,
 * cycles, and class instances). Repeated non-cyclic references are permitted and
 * are serialized by value. Object key order is canonical; array order is not
 * changed. Negative zero is normalized to JSON's canonical numeric zero.
 */
function canonicalizeJson(
  value: unknown,
  path = '$',
  ancestors: Set<object> = new Set(),
): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    assertValidUnicode(value, path);
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('Non-finite numbers are not valid canonical JSON', path);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalJsonError('Unsafe integers are not valid canonical JSON', path);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (value === undefined) {
    throw new CanonicalJsonError('undefined is not valid canonical JSON', path);
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new CanonicalJsonError(`${typeof value} is not valid canonical JSON`, path);
  }
  if (typeof value !== 'object') {
    throw new CanonicalJsonError('Unsupported value is not valid canonical JSON', path);
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Cyclic values are not valid canonical JSON', path);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new CanonicalJsonError('Only plain arrays are valid canonical JSON', path);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key === 'symbol' || !/^(?:0|[1-9]\d*)$/.test(key)) {
          throw new CanonicalJsonError('Extra array properties are not valid canonical JSON', path);
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index >= value.length) {
          throw new CanonicalJsonError('Invalid array index is not valid canonical JSON', childPath(path, key));
        }
      }
      const result: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new CanonicalJsonError('Sparse arrays are not valid canonical JSON', childPath(path, index));
        }
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new CanonicalJsonError('Array accessors are not valid canonical JSON', childPath(path, index));
        }
        result.push(canonicalizeJson(descriptor.value, childPath(path, index), ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Only plain objects are valid canonical JSON', path);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key === 'symbol')) {
      throw new CanonicalJsonError('Symbol keys are not valid canonical JSON', path);
    }

    const result = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of (ownKeys as string[]).sort()) {
      assertValidUnicode(key, childPath(path, key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        throw new CanonicalJsonError('Non-enumerable properties are not valid canonical JSON', childPath(path, key));
      }
      if (!('value' in descriptor)) {
        throw new CanonicalJsonError('Accessor properties are not valid canonical JSON', childPath(path, key));
      }
      result[key] = canonicalizeJson(descriptor.value, childPath(path, key), ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function serializeCanonicalJson(value: CanonicalJsonValue, indent: number, depth = 0): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  const compact = indent === 0;
  const currentPadding = ' '.repeat(indent * depth);
  const childPadding = ' '.repeat(indent * (depth + 1));
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const serialized = value.map(entry => serializeCanonicalJson(entry, indent, depth + 1));
    return compact
      ? `[${serialized.join(',')}]`
      : `[\n${childPadding}${serialized.join(`,\n${childPadding}`)}\n${currentPadding}]`;
  }

  // Do not delegate object emission to JSON.stringify: ECMAScript reorders
  // array-index-like keys numerically even when they were inserted lexically.
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return '{}';
  const separator = compact ? ':' : ': ';
  const serialized = keys.map(key => `${JSON.stringify(key)}${separator}${serializeCanonicalJson(value[key], indent, depth + 1)}`);
  return compact
    ? `{${serialized.join(',')}}`
    : `{\n${childPadding}${serialized.join(`,\n${childPadding}`)}\n${currentPadding}}`;
}

/** Canonical compact JSON bytes represented as a JavaScript string. */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonicalJson(canonicalizeJson(value), 0);
}

/** Canonical, human-readable JSON file content with exactly one final LF. */
export function canonicalJsonFileString(value: unknown, indent = 2): string {
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) {
    throw new RangeError('JSON indentation must be an integer from 0 through 10.');
  }
  return `${serializeCanonicalJson(canonicalizeJson(value), indent)}\n`;
}

function canonicalJsonUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  return sha256(input);
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJsonUtf8(value));
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
