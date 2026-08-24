/**
 * e09 Phase C — pure category page correctness validator tests (P1-P12).
 *
 * Contract under test: src/classification/category-page-correctness.ts
 * Adjudicated decisions (Plan §1a): evidenced dual-species co-primary allowed
 * (encoded dog-primary + cat-secondary); brand Pages optional secondary only;
 * child supersedes Shop All; confidence never read (P8).
 * No DB — small in-file catalog fixtures only.
 */
import { describe, it, expect } from 'vitest';
import {
  validateCategoryPageAssignment,
  CATEGORY_PAGE_CORRECTNESS_VERSION,
} from '../../classification/category-page-correctness';
import type { PageCorrectnessInput } from '../../classification/category-page-correctness';

/** In-file frozen verified catalog fixture covering every P5/P6/P7 distinction. */
const CATALOG: PageCorrectnessInput['verifiedPageCatalog'] = [
  { id: 'page_dog_food_dry', name: 'Dog Food Dry', parentId: null, species: null },
  { id: 'page_dog_food_canned', name: 'Dog Food Canned', parentId: null, species: null },
  { id: 'page_jerky_dog_treats', name: 'Jerky Dog Treats', parentId: null, species: null },
  { id: 'page_bones_bully_sticks_natural_chews', name: 'Dog Treats — Bones, Bully Sticks & Natural Chews', parentId: null, species: null },
  { id: 'page_dog_treats_general', name: 'Dog Treats', parentId: null, species: null },
  { id: 'page_cat_treats', name: 'Cat Treats', parentId: null, species: null },
  { id: 'page_cat_food_dry', name: 'Cat Food Dry', parentId: null, species: null },
  { id: 'page_dog_toys_chew', name: 'Dog Toys — Chew Toys', parentId: null, species: null },
  { id: 'page_shop_all_dog_treats', name: 'Dog Treats Shop All', parentId: null, species: null },
  { id: 'page_shop_all_generic', name: 'Pet Supplies Shop All', parentId: null, species: null },
  { id: 'page_brand_acme', name: 'Brand - Acme', parentId: null, species: null },
];

const IMPORT_HASH = 'import-hash-N1';

function memberInput(overrides: {
  species?: string[];
  title?: string;
  description?: string;
  productType?: string | null;
  form?: string | null;
  productTypeContext?: string | null;
}): PageCorrectnessInput['member'] {
  return {
    onboardingItemId: 'item-1',
    frozenEvidenceHash: 'evidence-hash-1',
    frozenEvidence: {
      species: overrides.species ?? ['Dog'],
      productType: overrides.productType ?? null,
      form: overrides.form ?? null,
      title: overrides.title ?? null,
      description: overrides.description ?? null,
      extraction: undefined,
    },
    frozenProductTypeContext: overrides.productTypeContext ?? null,
  };
}

function input(overrides: {
  member?: PageCorrectnessInput['member'];
  primaryPageId?: string | null;
  secondaryPageIds?: string[];
  primaryPageName?: string | null;
  expectedHash?: string | null;
  catalog?: PageCorrectnessInput['verifiedPageCatalog'];
}): PageCorrectnessInput {
  // Explicit null primaryPageId must survive — the P3/P10 missing-primary
  // branch is under test; do NOT coalesce it away.
  const primaryPageId = 'primaryPageId' in overrides ? (overrides.primaryPageId ?? null) : 'page_dog_food_dry';
  return {
    member: overrides.member ?? memberInput({}),
    candidate: {
      primaryPageId,
      secondaryPageIds: overrides.secondaryPageIds ?? [],
      primaryPageName: overrides.primaryPageName ?? null,
    },
    verifiedPageCatalog: overrides.catalog ?? CATALOG,
    activePageImportHash: IMPORT_HASH,
    expectedActivePageImportHash: overrides.expectedHash === undefined ? null : overrides.expectedHash,
  };
}

describe('e09 Phase C — validateCategoryPageAssignment (P1-P12)', () => {
  it('exports a durable version constant', () => {
    expect(CATEGORY_PAGE_CORRECTNESS_VERSION).toBe('v1');
  });

  // ── P1 / P2: verified frozen catalog only; stable identity ──
  it('P1: empty catalog → blocked, no assignment', () => {
    const result = validateCategoryPageAssignment(input({ catalog: [] }));
    expect(result.outcome).toBe('blocked');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/P1/);
  });

  it('P2: unknown Page ID → blocked', () => {
    const result = validateCategoryPageAssignment(input({ primaryPageId: 'page_nonexistent' }));
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toMatch(/P2/);
  });

  it('P2: mismatched ID/name pair → blocked', () => {
    const result = validateCategoryPageAssignment(
      input({ primaryPageId: 'page_dog_food_dry', primaryPageName: 'Some Other Page' }),
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toMatch(/P2|mismatch/i);
  });

  it('P2/P10: name-only output (no stable ID) is refused as missing primary — identity never inferred from a display name', () => {
    // NOTE: at validator level this manifests as needs_input (manual selection),
    // NOT blocked: the promotion gate is the component that refuses name-only
    // acceptance with stale_page_assignment (see promotion-gate.test.ts).
    const result = validateCategoryPageAssignment(input({ primaryPageId: null, primaryPageName: 'Dog Food Dry' }));
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/P3|P10|manual/i);
  });

  // ── P3: required primary ──
  it('P3: null primary → needs_input; a secondary alone cannot satisfy the primary requirement', () => {
    const withSecondaryOnly = validateCategoryPageAssignment(input({ primaryPageId: null, secondaryPageIds: ['page_brand_acme'] }));
    expect(withSecondaryOnly.outcome).toBe('needs_input');
    const secondaryBrandAlone = validateCategoryPageAssignment(
      input({
        primaryPageId: null,
        secondaryPageIds: ['page_dog_food_dry'],
        member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
      }),
    );
    expect(secondaryBrandAlone.outcome).toBe('needs_input');
    expect(secondaryBrandAlone.reason).toMatch(/primary/i);
  });

  // ── P5: semantic compatibility (same-species wrong category) ──
  it('P5: dry dog FOOD evidence on Dog Treats page → needs_input (food vs treat)', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', productTypeContext: 'Dry Dog Food' }),
        primaryPageId: 'page_dog_treats_general',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/food.*treat|treat.*food/i);
  });

  it('P5: converse — treat evidence on food-only page → needs_input', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Chicken Jerky Dog Treats' }),
        primaryPageId: 'page_dog_food_dry',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/P5/i);
  });

  it('P5: chew-vs-jerky contradiction → needs_input (BetterBone chew on Jerky page)', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({
          title: 'BETTER BONE SOFT BEEF SM',
          description: 'Natural beef flavor soft dog chew',
          productType: 'Dog Chew',
        }),
        primaryPageId: 'page_jerky_dog_treats',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/chew.*jerky|jerky/i);
  });

  it('P5: toy-vs-treat contradiction → needs_input even with matching species', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Chew Toy Beef Small' }),
        primaryPageId: 'page_dog_treats_general',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/toy/i);
  });

  it('P5: correct chew lands on the bones/bully chews page → assigned', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({
          title: 'BETTER BONE SOFT BEEF SM',
          description: 'Natural beef flavor soft dog chew',
          productType: 'Dog Chew',
        }),
        primaryPageId: 'page_bones_bully_sticks_natural_chews',
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  // ── P6: specificity and hierarchy ──
  it('P6: specific child as primary passes alongside its Shop All ancestor in catalog', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
        primaryPageId: 'page_dog_food_dry',
        secondaryPageIds: [],
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  it('P6: Shop All as primary while a matching specific child exists → needs_input', () => {
    // Treat-type evidence keeps the P5 food↔treat rule out of the way so the
    // dedicated P6 specificity branch is what rejects the generic primary.
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Dog Treats Chicken' }),
        primaryPageId: 'page_shop_all_dog_treats',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/P6|child/i);
  });

  it('P6 regression: an UNRELATED alternative does not force needs_input for a legitimate Shop All primary', () => {
    // No evidence species + no shared category token between the core
    // "Pet Supplies" and "Dog Food Dry"/"Dog Treats" alternatives → the bare
    // fallback that over-blocked was removed (B2 review F2).
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ species: [], title: 'Generic Pet Supply Item' }),
        primaryPageId: 'page_shop_all_generic',
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  // ── P7: brand page separation ──
  it('P7: brand landing page as PRIMARY → refused', () => {
    const result = validateCategoryPageAssignment(input({ primaryPageId: 'page_brand_acme' }));
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/P7|secondary only/i);
  });

  it('P7: brand landing page as SECONDARY is valid', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
        primaryPageId: 'page_dog_food_dry',
        secondaryPageIds: ['page_brand_acme'],
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  // ── P8: confidence is non-authoritative — the API has no confidence input ──
  it('P8: extra properties (including injected confidence fields) cannot change the outcome', () => {
    const base = input({
      member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
      primaryPageId: 'page_dog_food_dry',
    });
    const decorated = input({
      member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
      primaryPageId: 'page_dog_food_dry',
    });
    // Simulate a caller smuggling confidence onto inputs: the validator's
    // contract reads none of these, so results must be identical.
    (decorated.candidate as Record<string, unknown>).confidence = 0.99;
    (decorated.member.frozenEvidence as Record<string, unknown>).confidence = 0.99;
    expect(validateCategoryPageAssignment(decorated)).toEqual(validateCategoryPageAssignment(base));
  });

  // ── Dual-species co-primary (Plan §1a #3/#3a) ──
  it('dual-species: evidenced dog+cat use encodes co-primary as dog primary + cat secondary → assigned', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({
          species: ['dog', 'cat'],
          title: 'Acme Dual Species Treat Chicken 5 lb',
          description: 'For dogs and cats',
        }),
        primaryPageId: 'page_dog_treats_general',
        secondaryPageIds: ['page_cat_treats'],
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  it('single-species evidence with a cross-species secondary → needs_input (no unevidenced co-primary)', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ species: ['dog'], title: 'Acme Dog Treat Chicken' }),
        primaryPageId: 'page_dog_treats_general',
        secondaryPageIds: ['page_cat_treats'],
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/dual|cross-species|P3/i);
  });

  it('P5: single-species evidence against the other species-only page → needs_input', () => {
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ species: ['Dog'], title: 'Acme Dog Treat Chicken' }),
        primaryPageId: 'page_cat_treats',
      }),
    );
    expect(result.outcome).toBe('needs_input');
    expect(result.reason).toMatch(/species|P5/i);
  });

  // ── Ambiguity contract (P9 pin) ──
  it('P9 pin (lenient): evidence containing BOTH members of the guarded pair (food AND treat) deliberately passes — ambiguity resolves at manual review', () => {
    // The food↔treat rules are explicitly guarded with !evTokens.has(other);
    // mixed evidence does not fail either exclusive rule. Deliberate leniency:
    // per P9 ambiguity becomes a review decision, not a silent guess.
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Meal Mixing Dog Food and Treat Blend' }),
        primaryPageId: 'page_dog_food_dry',
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  it('P9 pin (strict): chew+jerky mixed evidence against a chew-only page still refuses — asymmetric rule documented', () => {
    // Unlike food↔treat, the chew↔jerky rules carry no both-present guard, so
    // mixed evidence on an exclusive page refuses. Pin current behavior.
    const result = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Chew and Jerky Bites' }),
        primaryPageId: 'page_bones_bully_sticks_natural_chews',
      }),
    );
    expect(result.outcome).toBe('needs_input');
  });

  // ── Stale import defense-in-depth ──
  it('expectedActivePageImportHash mismatch → blocked (stale import)', () => {
    const result = validateCategoryPageAssignment(
      input({ member: memberInput({ title: 'Acme Dry Dog Food Beef' }), expectedHash: 'import-hash-N0' }),
    );
    expect(result.outcome).toBe('blocked');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/[Ss]tale/);
  });

  it('absent expectedActivePageImportHash → stale check skipped (promotion gate remains the P11 enforcement point)', () => {
    const result = validateCategoryPageAssignment(
      input({ member: memberInput({ title: 'Acme Dry Dog Food Beef' }), expectedHash: null }),
    );
    expect(result.outcome).toBe('assigned');
  });

  // ── Per-member isolation (P9) ──
  it('per-member isolation: one ambiguous member result does not alter a sibling result', () => {
    const ambiguous = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'BETTER BONE SOFT BEEF SM', description: 'soft dog chew', productType: 'Dog Chew' }),
        primaryPageId: 'page_jerky_dog_treats',
      }),
    );
    const sibling = validateCategoryPageAssignment(
      input({
        member: memberInput({ title: 'Acme Dry Dog Food Beef' }),
        primaryPageId: 'page_dog_food_dry',
      }),
    );
    expect(ambiguous.outcome).toBe('needs_input');
    expect(sibling.outcome).toBe('assigned');
  });
});
