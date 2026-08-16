/**
 * Taxonomy Freeze Guard (P0 — "set-in-stone taxonomy").
 *
 * Enforces the active-taxonomy invariant BELOW the HTTP layer: ordinary
 * production code cannot mutate the live taxonomy, even by importing a
 * lower-level function directly (seed sync, bundle activation, editors, or
 * the transitional legacy writer).
 *
 * The freeze is active by default. Tests that need to exercise a mutator's
 * implementation must explicitly opt out with `setTaxonomyFreezeForTests`.
 * Production code must never call that override.
 */

export class TaxonomyFrozenError extends Error {
  readonly code = 'taxonomy_frozen';

  constructor(operation: string) {
    super(
      `Taxonomy is frozen: ${operation} is read-only until a new immutable taxonomy release is deployed.`,
    );
    this.name = 'TaxonomyFrozenError';
  }
}

/** Whether the taxonomy freeze is currently enforced (default: frozen). */
let taxonomyFreezeActive = true;

/**
 * True when taxonomy mutations are blocked. Defaults to true.
 */
export function isTaxonomyFrozen(): boolean {
  return taxonomyFreezeActive;
}

/**
 * Test-only override. Production code must never call this.
 *
 * Tests exercising mutator implementations call `setTaxonomyFreezeForTests(false)`
 * in setup and restore `true` in teardown so the freeze stays enforced
 * everywhere else.
 */
export function setTaxonomyFreezeForTests(active: boolean): void {
  taxonomyFreezeActive = active;
}

/**
 * Assert that taxonomy mutation is currently permitted. Throws
 * `TaxonomyFrozenError` (code `taxonomy_frozen`) when the freeze is active.
 * Every active-taxonomy mutator must call this FIRST, before any work.
 */
export function assertTaxonomyMutable(operation: string): void {
  if (taxonomyFreezeActive) {
    throw new TaxonomyFrozenError(operation);
  }
}
