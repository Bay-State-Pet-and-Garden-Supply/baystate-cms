/**
 * Structured weight normalization (epic #46 batch-analysis follow-up).
 *
 * OPERATOR RULE (authoritative): the numerical weight identity field is
 * ALWAYS pounds (Lbs) and is stored to exactly two decimal places. Every
 * candidate value is converted to pounds and normalized before hard-conflict
 * classification and before distributor-record materialization.
 *
 * Scope boundaries:
 * - The product NAME/TITLE is NEVER normalized — "Butcher's Pup 16 oz" stays
 *   exactly as supplied. Only the structured weight field is canonicalized.
 * - Raw provider evidence is never rewritten; this module produces the
 *   canonical comparison/materialization value.
 * - Fail-closed: unparseable values return `null` and keep the existing
 *   manual/conflict path — a false parse is worse than a manual conflict.
 */
const LB = 1;
const OZ = 1 / 16;
const G = 1 / 453.59237;
const KG = 2.20462262185;

/** Round half away from zero to two decimals (business rounding). */
export function roundToTwoDecimals(pounds: number): string {
  const sign = pounds < 0 ? -1 : 1;
  const rounded = Math.round((Math.abs(pounds) + Number.EPSILON) * 100) / 100;
  return (sign * rounded).toFixed(2);
}

export type WeightUnit = 'lb' | 'oz' | 'g' | 'kg' | 'unitless';

export interface WeightNormalizationResult {
  normalized: string;
  unit: WeightUnit;
  numericInput: number;
  pounds: number;
}

const UNIT_FACTORS: Array<{ re: RegExp; unit: WeightUnit; factor: number }> = [
  { re: /^(?:lbs?|pounds?|pound)$/i, unit: 'lb', factor: LB },
  { re: /^(?:oz|ounce|ounces)$/i, unit: 'oz', factor: OZ },
  { re: /^(?:g|gram|grams)$/i, unit: 'g', factor: G },
  { re: /^(?:kg|kilogram|kilograms)$/i, unit: 'kg', factor: KG },
];

/** Strict scalar weight parse. Accepts unitless (assumed pounds) or a
 *  recognized unit suffix. Rejects ranges, fractions, multipacks, text,
 *  zero, and negatives. */
export function parseWeightToLbs(value: string): WeightNormalizationResult | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  const match = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)\s*([a-zA-Z]*)$/.exec(trimmed);
  if (!match) return null;

  const numericInput = parseFloat(match[1]);
  if (!Number.isFinite(numericInput) || numericInput <= 0) return null;

  const unitRaw = match[2];
  if (!unitRaw) {
    // Unitless → pounds per operator rule.
    return { normalized: roundToTwoDecimals(numericInput), unit: 'unitless', numericInput, pounds: numericInput };
  }

  for (const { re, unit, factor } of UNIT_FACTORS) {
    if (re.test(unitRaw)) {
      const pounds = numericInput * factor;
      return { normalized: roundToTwoDecimals(pounds), unit, numericInput, pounds };
    }
  }
  return null; // Unknown unit token → fail closed.
}

/** Canonical structured weight: pounds with exactly two decimals, no unit
 *  suffix (the field IS pounds). Returns null when unparseable. */
export function normalizeWeightToLbs(value: string): string | null {
  const parsed = parseWeightToLbs(value);
  return parsed ? parsed.normalized : null;
}
