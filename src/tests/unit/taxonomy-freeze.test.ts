/**
 * P0 taxonomy freeze regression tests.
 *
 * Verifies the active-taxonomy invariant BELOW the HTTP layer: every mutator
 * fails closed with TaxonomyFrozenError while the freeze is active, and the
 * narrow test-only override lifts the freeze only when explicitly requested.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  assertTaxonomyMutable,
  isTaxonomyFrozen,
  setTaxonomyFreezeForTests,
  TaxonomyFrozenError,
} from '../../classification/taxonomy-freeze';
import { syncSeedToWorkspace } from '../../classification/seed-sync';
import { activateBundle } from '../../classification/config-store';
import { applyFieldMappingEdits } from '../../classification/field-mapping-editor';
import { applyAttributeProfileEdits } from '../../classification/attribute-profile-editor';
import { applyCurationTargetEdits } from '../../classification/curation-target-editor';
import { applyAttributeEdits } from '../../classification/attribute-editor';
import { saveClassificationConfig } from '../../classification/config-loader';

afterEach(() => {
  // Always restore the freeze so later suites/tests run under the invariant.
  setTaxonomyFreezeForTests(true);
});

describe('taxonomy freeze guard', () => {
  it('assertTaxonomyMutable throws TaxonomyFrozenError with code taxonomy_frozen while active', () => {
    setTaxonomyFreezeForTests(true);
    expect(isTaxonomyFrozen()).toBe(true);
    try {
      assertTaxonomyMutable('seed sync');
      throw new Error('expected assertTaxonomyMutable to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaxonomyFrozenError);
      expect((err as TaxonomyFrozenError).code).toBe('taxonomy_frozen');
      expect(String(err).toLowerCase()).toContain('taxonomy is frozen');
      expect(String(err)).toContain('seed sync');
    }
  });

  it('assertTaxonomyMutable does not throw when the test override lifts the freeze', () => {
    setTaxonomyFreezeForTests(false);
    expect(isTaxonomyFrozen()).toBe(false);
    expect(() => assertTaxonomyMutable('seed sync')).not.toThrow();
  });

  it('syncSeedToWorkspace fails closed while frozen (before any mutation)', async () => {
    setTaxonomyFreezeForTests(true);
    await expect(
      syncSeedToWorkspace('/nonexistent/workspace-path', 'workspace-id'),
    ).rejects.toBeInstanceOf(TaxonomyFrozenError);
  });

  it('activateBundle fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    // The guard throws synchronously, before enqueueActivation/performActivation.
    expect(() => activateBundle('staging-hash', null, {} as never))
      .toThrow(TaxonomyFrozenError);
  });

  it('applyFieldMappingEdits fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    expect(() => applyFieldMappingEdits('/ws', 'wsid', [], { gitEnabled: false }))
      .toThrow(TaxonomyFrozenError);
  });

  it('applyAttributeProfileEdits fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    expect(() => applyAttributeProfileEdits('/ws', 'wsid', 'dog-food-dry', [], { gitEnabled: false }))
      .toThrow(TaxonomyFrozenError);
  });

  it('applyCurationTargetEdits fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    expect(() => applyCurationTargetEdits('/ws', 'wsid', [], { gitEnabled: false }))
      .toThrow(TaxonomyFrozenError);
  });

  it('applyAttributeEdits fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    expect(() => applyAttributeEdits('/ws', 'wsid', 'brand', {} as never, { gitEnabled: false }))
      .toThrow(TaxonomyFrozenError);
  });

  it('saveClassificationConfig fails closed while frozen', () => {
    setTaxonomyFreezeForTests(true);
    expect(() => saveClassificationConfig('/ws', {} as never))
      .toThrow(TaxonomyFrozenError);
  });

  it('guard is restored: isTaxonomyFrozen() is true at the end', () => {
    expect(isTaxonomyFrozen()).toBe(true);
  });
});
