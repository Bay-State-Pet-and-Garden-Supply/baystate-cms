import {
  canonicalJsonFileString,
  hashCanonicalJson,
} from '../shared/stable-id';

/**
 * Deterministic JSON serialization with stable recursive key ordering and a
 * single trailing LF. Unsupported non-JSON values fail instead of being
 * silently dropped or converted.
 */
export function deterministicStringify(value: unknown, indent = 2): string {
  return canonicalJsonFileString(value, indent);
}

function legacyStableKeyReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = value[key as keyof typeof value];
    }
    return ordered;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function legacyDeterministicStringify(value: unknown): string {
  return `${JSON.stringify(value, legacyStableKeyReplacer, 2)}\n`;
}

/**
 * Legacy product/workspace hash retained byte-for-byte for persisted
 * compatibility. It intentionally uses the pre-v2 JSON.stringify replacer,
 * including ECMAScript numeric-key ordering and non-finite-number coercion.
 * New content-addressed identities use hashJsonSha256 instead.
 */
export function hashJson(value: unknown): string {
  const str = legacyDeterministicStringify(value);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Canonical SHA-256 for new identities. */
export const hashJsonSha256 = hashCanonicalJson;

// fallow-ignore-next-line unused-export
export function parseJsonFile<T>(content: string): T {
  return JSON.parse(content) as T;
}
