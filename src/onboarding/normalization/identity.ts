/**
 * Central identity normalization for sourcing conflict classification
 * (epic #46 batch-analysis follow-up, GPT plan).
 *
 * `normalizeIdentityValueForComparison(field, rawValue)` returns the
 * canonical comparison string for a candidate value:
 * - `weight` → pounds, two decimals (operator rule; NEVER the title/name)
 * - `brand` → trimmed/collapsed/lowercased (comparison only)
 * - `packCount` → unsigned integer canonical form
 * - anything else → unchanged (caller falls back to its existing
 *   case-insensitive comparison)
 *
 * Raw provider evidence is preserved everywhere; normalization only
 * determines whether values AGREE. Values that fail normalization return
 * status 'failed' and compare as their raw form (fail closed: a malformed
 * value never silently matches a valid one).
 */
import { normalizeWeightToLbs } from './weight';
import { normalizeBrandForComparison } from './brand';
import { normalizePackCountForComparison } from './pack-count';

/** Bump when normalization rules change (audit/explainability). */
export const IDENTITY_NORMALIZATION_VERSION = 1;

export interface NormalizedIdentityValue {
  field: string;
  rawValue: string;
  comparisonValue: string;
  status: 'normalized' | 'failed' | 'unchanged';
}

export function normalizeIdentityValueForComparison(field: string, rawValue: string): NormalizedIdentityValue {
  switch (field) {
    case 'weight': {
      const normalized = normalizeWeightToLbs(rawValue);
      return normalized
        ? { field, rawValue, comparisonValue: normalized, status: 'normalized' }
        : { field, rawValue, comparisonValue: rawValue, status: 'failed' };
    }
    case 'brand': {
      const normalized = normalizeBrandForComparison(rawValue);
      return normalized
        ? { field, rawValue, comparisonValue: normalized, status: 'normalized' }
        : { field, rawValue, comparisonValue: rawValue, status: 'failed' };
    }
    case 'packCount': {
      const normalized = normalizePackCountForComparison(rawValue);
      return normalized
        ? { field, rawValue, comparisonValue: normalized, status: 'normalized' }
        : { field, rawValue, comparisonValue: rawValue, status: 'failed' };
    }
    default:
      return { field, rawValue, comparisonValue: rawValue, status: 'unchanged' };
  }
}
