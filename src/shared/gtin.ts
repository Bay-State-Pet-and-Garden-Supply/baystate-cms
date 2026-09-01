/**
 * Canonical GTIN/UPC/EAN normalization, checksum validation, and equivalence.
 * Complies with GS1 General Specifications and Google Merchant Center GTIN standards.
 */

export const VALID_GTIN_LENGTHS = [8, 12, 13, 14] as const;
export type ValidGtinLength = (typeof VALID_GTIN_LENGTHS)[number];

/**
 * Strips all non-digit characters from a raw string or number.
 */
export function normalizeGtinDigits(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Normalizes a UPC/GTIN to digits only, enforcing standard GS1 lengths (8, 12, 13, 14).
 * Returns null for malformed or non-standard lengths.
 */
export function normalizeGtin(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const digits = normalizeGtinDigits(raw);
  return (VALID_GTIN_LENGTHS as readonly number[]).includes(digits.length) ? digits : null;
}

/**
 * GS1 Mod-10 checksum validation.
 * Accepts 8, 12, 13, or 14-digit codes; verifies the check digit using
 * right-to-left alternating weights (3 and 1), starting with 3 for the rightmost body digit.
 */
export function validateGtin(code: unknown): boolean {
  if (code === null || code === undefined) return false;
  const digits = normalizeGtinDigits(code);
  if (!(VALID_GTIN_LENGTHS as readonly number[]).includes(digits.length)) {
    return false;
  }
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === check;
}

/**
 * Alias for `validateGtin`.
 */
export const validateGtinChecksum = validateGtin;

/**
 * Pads an 8, 12, or 13 digit GTIN to a canonical 14-digit representation with leading zeros.
 * Returns null if the code does not normalize to a valid GTIN length.
 */
export function padGtinTo14(code: unknown): string | null {
  const norm = normalizeGtin(code);
  if (!norm) return null;
  return norm.padStart(14, '0');
}

/**
 * Canonical GTIN equivalence comparison with 0-padding support.
 * Evaluates whether two GTINs refer to the identical physical product identity:
 * - Exact digit equality (e.g. "017800010009" === "017800010009")
 * - 12-digit UPC vs 13-digit EAN ("017800010009" <=> "0017800010009")
 * - 12-digit UPC vs 14-digit GTIN ("017800010009" <=> "00017800010009")
 * - 13-digit EAN vs 14-digit GTIN ("0017800010009" <=> "00017800010009")
 */
export function canonicalGtinMatch(gtinA: unknown, gtinB: unknown): boolean {
  const normA = normalizeGtinDigits(gtinA);
  const normB = normalizeGtinDigits(gtinB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  // 12-digit UPC padded to 13/14-digit GTIN
  if (normA.length === 12 && (normB === `0${normA}` || normB === `00${normA}`)) return true;
  if (normB.length === 12 && (normA === `0${normB}` || normA === `00${normB}`)) return true;

  // 13-digit EAN padded to 14-digit GTIN
  if (normA.length === 13 && normB === `0${normA}`) return true;
  if (normB.length === 13 && normA === `0${normB}`) return true;

  return false;
}
