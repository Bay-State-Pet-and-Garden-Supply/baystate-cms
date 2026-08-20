// story: e35s10 — Commit 17 RED: hub reads use existing indexes, no new migration
import { describe, it, expect } from 'vitest';

describe('brand hub index sufficiency — no new migration needed (e35s10)', () => {
  it('documents that hub domain-keyed join is satisfied by existing indexes', async () => {
    const mod = await import('../../onboarding/brand-hub/indexSufficiency');
    expect(mod.BRAND_HUB_INDEX_SUFFICIENCY).toBeDefined();
    expect(mod.BRAND_HUB_INDEX_SUFFICIENCY.requiresNewMigration).toBe(false);
    expect(mod.BRAND_HUB_INDEX_SUFFICIENCY.existingIndexes).toEqual(
      expect.arrayContaining([
        'idx_brand_url_index_domain_url',
        'idx_brand_url_index_domain_active',
        'idx_extractor_profiles_domain',
      ]),
    );
    expect(mod.BRAND_HUB_INDEX_SUFFICIENCY.reason).toMatch(/existing indexes.*satisfy/i);
  });

  it('view-model reads do not introduce new table or missing index requirement', async () => {
    const mod = await import('../../onboarding/brand-hub/indexSufficiency');
    expect(mod.assertBrandHubIndexesSufficient()).toBe(true);
  });
});
