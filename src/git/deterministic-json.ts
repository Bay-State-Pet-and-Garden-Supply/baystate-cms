/**
 * Deterministic JSON serialization with stable key ordering.
 * Ensures product files produce consistent diffs regardless of object key insertion order.
 */

export function deterministicStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, stableKeyReplacer, indent) + '\n';
}

function stableKeyReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) {
      ordered[k] = value[k as keyof typeof value];
    }
    return ordered;
  }
  if (typeof value === 'number' && (Number.isNaN(value) || !Number.isFinite(value))) {
    return null;
  }
  return value;
}

export function hashJson(value: unknown): string {
  const str = deterministicStringify(value);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function parseJsonFile<T>(content: string): T {
  return JSON.parse(content) as T;
}
