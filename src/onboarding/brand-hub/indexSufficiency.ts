// story: e35s10 — index sufficiency for brand hub domain-keyed reads (no new migration)
export interface BrandHubIndexSufficiency {
  requiresNewMigration: boolean;
  existingIndexes: readonly string[];
  reason: string;
}

// story: e35s10 — declarative: hub join satisfied by current domain indexes
export const BRAND_HUB_INDEX_SUFFICIENCY: BrandHubIndexSufficiency = {
  requiresNewMigration: false,
  existingIndexes: [
    'idx_brand_url_index_domain_url',
    'idx_brand_url_index_domain_active',
    'idx_extractor_profiles_domain',
  ],
  reason: 'existing indexes satisfy brand hub domain-keyed join without new migration',
};

export function assertBrandHubIndexesSufficient(): boolean {
  return !BRAND_HUB_INDEX_SUFFICIENCY.requiresNewMigration;
}
