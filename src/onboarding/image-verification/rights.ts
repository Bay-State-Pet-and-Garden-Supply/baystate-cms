/**
 * Image rights resolution and commerce approval (PI-6).
 *
 * The issue's source and rights rules, enforced deterministically:
 * - unknown rights blocks automatic commerce approval;
 * - an exact-product match does not imply reuse permission;
 * - a rights-approved source does not imply exact-variant match;
 * - network-discovered URLs inherit no rights approval;
 * - retailer reuse requires an explicit approved basis;
 * - generated imagery is never authoritative product photography;
 * - a basis string alone (no evidence reference) is not approved.
 *
 * Pure module: no imports beyond types (vitest-runnable).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import type { AssetRightsStatus } from './schema';

const SOURCE_TIERS = [
  'supplier',
  'manufacturer',
  'licensed_dataset',
  'manual_photography',
  'retailer',
  'network_discovered',
  'generated',
] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export interface RightsResolution {
  rightsStatus: AssetRightsStatus;
  reason: string;
}

/**
 * Resolve rights from the DECLARED source tier and its evidence. Rights can
 * never be inferred from pixels or from the mere fact that an API returned a
 * URL — a source tier plus a referenced basis is what establishes reuse.
 */
export function resolveRights(
  sourceType: string | null | undefined,
  basis: string | null | undefined,
  evidenceRef: string | null | undefined,
): RightsResolution {
  const tier = normalizeTier(sourceType);

  switch (tier) {
    case 'supplier':
    case 'manufacturer': {
      if (basis && evidenceRef) {
        return { rightsStatus: 'approved', reason: `${tier} authorized asset with referenced reuse basis` };
      }
      return { rightsStatus: 'restricted', reason: `${tier} reuse requires a rights basis with an evidence reference` };
    }
    case 'licensed_dataset': {
      if (evidenceRef) {
        return { rightsStatus: 'approved', reason: 'licensed product-data provider under implemented license terms' };
      }
      return { rightsStatus: 'restricted', reason: 'licensed dataset reuse requires a license reference' };
    }
    case 'manual_photography': {
      return { rightsStatus: 'approved', reason: 'manual product photography' };
    }
    case 'retailer': {
      if (basis && evidenceRef) {
        return { rightsStatus: 'approved', reason: 'retailer image reuse with explicit approved basis' };
      }
      return { rightsStatus: 'restricted', reason: 'retailer images require an explicit approved reuse basis' };
    }
    case 'generated': {
      return { rightsStatus: 'restricted', reason: 'generated imagery is not authoritative product photography' };
    }
    case 'network_discovered':
    default: {
      return { rightsStatus: 'unknown', reason: 'network-discovered image URL inherits no rights approval' };
    }
  }
}

function normalizeTier(sourceType: string | null | undefined): SourceTier | null {
  if (!sourceType) return null;
  const normalized = sourceType.trim().toLowerCase().replace(/[^a-z_]/g, '_');
  if ((SOURCE_TIERS as readonly string[]).includes(normalized)) return normalized as SourceTier;
  // Fuzzy: "supplier asset" / "manufacturer media library" still classify.
  if (normalized.includes('supplier')) return 'supplier';
  if (normalized.includes('manufacturer') || normalized.includes('media_library')) return 'manufacturer';
  if (normalized.includes('licensed') || normalized.includes('dataset')) return 'licensed_dataset';
  if (normalized.includes('manual') || normalized.includes('photography')) return 'manual_photography';
  if (normalized.includes('retail')) return 'retailer';
  if (normalized.includes('generated') || normalized.includes('ai')) return 'generated';
  return 'network_discovered';
}

/**
 * The deterministic commerce-approval formula. This is the single rule the
 * pipeline computes AND the bundle validator recomputes from the agent's
 * assertion — an agent cannot claim commerce approval that the fields do not
 * support.
 */
export function computeCommerceApproved(fields: {
  rightsStatus: AssetRightsStatus;
  exactProductMatch: boolean;
  exactVariantMatch: boolean | null;
  qualityStatus: 'usable' | 'low_quality' | 'invalid';
  conflicts: string[];
}): boolean {
  return (
    fields.rightsStatus === 'approved' &&
    fields.exactProductMatch === true &&
    fields.exactVariantMatch !== false &&
    fields.qualityStatus === 'usable' &&
    fields.conflicts.length === 0
  );
}
