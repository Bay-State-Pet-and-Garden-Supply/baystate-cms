/**
 * Canonical variant-axis authority (Amendment A).
 *
 * This module is the SINGLE source of truth for variant-axis normalization
 * and canonical-form validation. It is shared by:
 *
 * - `src/onboarding/sourcing/contracts.ts` (connector-declared axis registry
 *   and unknown-axis detection) — re-exports these symbols;
 * - `src/shared/schemas/distributor-evidence.ts` (persisted
 *   `variantAxisDeclarations` schema) — validates `normalizedAxis` with
 *   `isCanonicalDeclaredAxis`.
 *
 * Historical home: `src/onboarding/sourcing/contracts.ts` defined these
 * symbols inline. They were extracted here so the evidence schema and the
 * connector registry can never drift apart (a mirror that omits the
 * built-in alias mapping would reject canonical axes emitted by the
 * registry and accept noncanonical spellings — see certification defect
 * 49ce3e65).
 *
 * Pure module: no imports, no DB, no env, no network.
 */

/** Built-in normalized variant axes the CMS can reason about without a connector declaration. */
export const VARIANT_AXIS_ALLOWLIST = ['size', 'count', 'packCount', 'flavor', 'formula'] as const;
export type VariantAxisName = (typeof VARIANT_AXIS_ALLOWLIST)[number];

/**
 * Raw attribute key → canonical axis name. Case-insensitive with common
 * spelling variants (pack count / pack_count / pack-count, flavour).
 */
const VARIANT_AXIS_ALIASES: Record<string, VariantAxisName> = {
  size: 'size',
  count: 'count',
  packcount: 'packCount',
  'pack count': 'packCount',
  pack_count: 'packCount',
  'pack-count': 'packCount',
  flavor: 'flavor',
  flavour: 'flavor',
  formula: 'formula',
};

/**
 * Normalize a raw attribute key to a canonical built-in variant axis.
 * Returns null when the key is not a recognized built-in axis (it may still
 * be a valid connector-declared axis — see `isUnknownVariantAxis`).
 */
export function normalizeVariantAxis(raw: string): VariantAxisName | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return VARIANT_AXIS_ALIASES[key] ?? null;
}

/**
 * Normalize a connector-declared axis name. Declared axes must be bounded
 * (≤64 chars) and normalize deterministically; invalid declarations return
 * null and are ignored (fail closed).
 */
export function normalizeDeclaredVariantAxis(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (key.length > 64) return null;
  return VARIANT_AXIS_ALIASES[key] ?? key;
}

/**
 * True when a value is already in canonical declared-axis form — i.e.
 * normalizing it yields the identical string. Non-canonical spellings
 * (`'pack count'`, `'flavour'`, `'Pack Count'`) return false. A value that
 * cannot normalize at all (empty, whitespace, >64 chars) is never canonical.
 */
export function isCanonicalDeclaredAxis(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = normalizeDeclaredVariantAxis(value);
  return normalized !== null && normalized === value;
}
