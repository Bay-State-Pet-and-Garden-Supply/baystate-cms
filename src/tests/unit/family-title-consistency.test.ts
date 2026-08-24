/**
 * e09 Phase C — pure family title consistency validator tests (T1-T10).
 *
 * Contract under test: src/classification/family-title-consistency.ts
 * Adjudicated skeleton (Plan §1a #1): Brand → Line → Form → Flavor → Size/Count;
 * Soft/Hard/Classic/Hypo are ALWAYS visible when evidenced (Plan §1a #2).
 * All-or-nothing (T7); deterministic (same input → deep-equal result).
 * No DB, no grouping calls (T10) — pure function tests only.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFamilyTitleSet,
  FAMILY_TITLE_CONSISTENCY_VERSION,
} from '../../classification/family-title-consistency';
import type { TitleFrozenFacts, TitleValidationInput } from '../../classification/family-title-consistency';

const HASH = 'evidence-hash';

function facts(overrides: {
  brand?: string;
  productLine?: string;
  form?: string;
  flavor?: string;
  size?: string;
  soft?: boolean;
  hard?: boolean;
  classic?: boolean;
  hypo?: boolean;
}): TitleFrozenFacts {
  return {
    brand: overrides.brand ?? 'BetterBone',
    productLine: overrides.productLine ?? 'BetterBone',
    formOrSpecies: overrides.form,
    flavorOrColorOrSubline: overrides.flavor,
    sizeOrCount: overrides.size,
    modifiers: {
      soft: overrides.soft ?? false,
      hard: overrides.hard ?? false,
      classic: overrides.classic ?? false,
      hypoallergenic: overrides.hypo ?? false,
    },
  };
}

function member(upc: string, f: TitleFrozenFacts): TitleValidationInput['members'][number] {
  return { onboardingItemId: `item-${upc}`, upc, frozenEvidenceHash: `${HASH}-${upc}`, frozenFacts: f };
}

/** The adjudicated BetterBone illustrative family (Plan §5 desired output). */
function betterboneInput(titles?: string[]): TitleValidationInput {
  return {
    familyId: 'family_betterbone_illustrative',
    members: [
      member('900000000001', facts({ flavor: 'Beef', size: 'Small', soft: true })),
      member('900000000002', facts({ flavor: 'Venison', size: 'Large', hard: true })),
      member('900000000003', facts({ flavor: 'Veggie', size: 'Medium', classic: true })),
    ],
    candidateTitles: (
      titles ?? ['BetterBone Soft Beef Small', 'BetterBone Hard Venison Large', 'BetterBone Classic Veggie Medium']
    ).map((title, index) => ({ upc: `90000000000${index + 1}`, title })),
  };
}

describe('e09 Phase C — validateFamilyTitleSet (T1-T10)', () => {
  it('exports a durable version constant (T8 authority participation)', () => {
    // v2: deterministic Title Lint (title-lint.ts) added as a post-processing
    // rule before this validator — post-processing change = new authority rev.
    expect(FAMILY_TITLE_CONSISTENCY_VERSION).toBe('v2');
  });

  it('valid family differing only in approved variant slots passes (adjudicated skeleton)', () => {
    const result = validateFamilyTitleSet(betterboneInput());
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    // Shared skeleton: Brand → Mod → Flavor → Size with identical placeholder order.
    expect(result.skeleton).toBe('{brand} {mod} {flavor} {size}');
    expect(result.perMember.every(m => m.valid)).toBe(true);
  });

  it('FAILS: inconsistent slot order across siblings (T2)', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Small', 'BetterBone Venison Hard Large', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/T2|skeleton/i);
  });

  it('FAILS: inconsistent brand rendering ("Better Bone" vs "BetterBone") breaks the shared skeleton (T2/T3)', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Small', 'Better Bone Hard Venison Large', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/T2|skeleton|T3|brand/i);
  });

  it('FAILS: always-visible modifier dropped while frozenFacts says evidenced (T4, Plan §1a #2)', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Beef Small', 'BetterBone Hard Venison Large', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
    expect(result.perMember[0].valid).toBe(false);
    expect(result.perMember[0].reason).toMatch(/soft|T4|skeleton/i);
  });

  it('FAILS: flavor appearing twice (T4 exactly-once)', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Beef Small', 'BetterBone Hard Venison Large', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
    expect(result.perMember[0].reason).toMatch(/Beef.*exactly once|T4/i);
  });

  it('FAILS: sibling leakage — Beef Small member carries the sibling token Large (T5)', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Small Large', 'BetterBone Hard Venison Large', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
    // Either the dedicated leakage branch or the skeleton mismatch catches it —
    // both are correct rejections; assert the member was rejected with a reason.
    expect(result.perMember[0].valid).toBe(false);
    expect(result.perMember[0].reason).toBeDefined();
  });

  it('FAILS: invention to force uniqueness — indistinguishable frozenFacts with differing titles (T6)', () => {
    const input = {
      familyId: 'family-t6',
      members: [
        member('900000000011', facts({ flavor: 'Beef', size: 'Small', soft: true })),
        member('900000000012', facts({ flavor: 'Beef', size: 'Small', soft: true })),
      ],
      candidateTitles: [
        { upc: '900000000011', title: 'BetterBone Soft Beef Small' },
        { upc: '900000000012', title: 'BETTERBONE SOFT BEEF SMALL!' },
      ],
    };
    const result = validateFamilyTitleSet(input);
    // T6 OUTCOME is enforced: indistinguishable facts with distinct titles are
    // rejected, never auto-differentiated. Attribution note (recorded in the
    // acceptance report): the shared-skeleton check (T2) runs BEFORE the
    // dedicated invention branch in the current validator ordering, so the
    // rejection reason cites the skeleton mismatch for this shape.
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/skeleton|T2|invention|T6/i);
  });

  it('FAILS: duplicate titles across members with distinct frozenFacts', () => {
    const result = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Small', 'BetterBone Soft Beef Small', 'BetterBone Classic Veggie Medium']),
    );
    expect(result.valid).toBe(false);
  });

  it('all-or-nothing: one invalid member invalidates the whole set (T7)', () => {
    const result = validateFamilyTitleSet(betterboneInput());
    expect(result.valid).toBe(true);
    const poisoned = validateFamilyTitleSet(
      betterboneInput(['BetterBone Soft Beef Small', 'Broken Title No Facts Here', 'BetterBone Classic Veggie Medium']),
    );
    expect(poisoned.valid).toBe(false);
    expect(poisoned.perMember.some(m => !m.valid)).toBe(true);
  });

  it('singleton family passes with token-safety rules only', () => {
    const result = validateFamilyTitleSet({
      familyId: 'family-singleton',
      members: [member('900000000021', facts({ brand: 'Acme', productLine: 'Chew Toy', form: 'Toy', flavor: 'Beef', size: 'Small' }))],
      candidateTitles: [{ upc: '900000000021', title: 'Acme Chew Toy Beef Small' }],
    });
    expect(result.valid).toBe(true);
  });

  it('round-3 FIX 2: mixed Small/weight family passes skeleton equality — weight does not displace the size word, both share the {size} slot', () => {
    const input: TitleValidationInput = {
      familyId: 'family_mixed_size_weight',
      members: [
        // Sibling A carries a size WORD only; sibling B carries a WEIGHT only.
        member('910000000001', facts({ brand: 'Acme', productLine: 'Acme', flavor: 'Chicken', size: 'Small' })),
        member('910000000002', facts({ brand: 'Acme', productLine: 'Acme', flavor: 'Beef', size: '5 lb' })),
      ],
      candidateTitles: [
        { upc: '910000000001', title: 'Acme Dog Food Chicken Small' },
        { upc: '910000000002', title: 'Acme Dog Food Beef 5 lb' },
      ],
    };
    const result = validateFamilyTitleSet(input);
    expect(result.valid).toBe(true);
    expect(result.skeleton).toBe('{brand} dog food {flavor} {size}');
  });

  it('round-3 FIX 2: co-present size word AND weight normalize into ONE {size} placeholder (same-slot unification)', () => {
    const input: TitleValidationInput = {
      familyId: 'family_both_size_weight',
      members: [
        // Member with BOTH tokens in its slot; sibling with weight only.
        member('920000000001', { ...facts({ brand: 'Acme', productLine: 'Acme', flavor: 'Chicken', size: '5 lb' }), extraSizeTokens: ['Small'] }),
        member('920000000002', facts({ brand: 'Acme', productLine: 'Acme', flavor: 'Beef', size: '10 lb' })),
      ],
      candidateTitles: [
        { upc: '920000000001', title: 'Acme Dog Food Chicken Small 5 lb' },
        { upc: '920000000002', title: 'Acme Dog Food Beef 10 lb' },
      ],
    };
    const result = validateFamilyTitleSet(input);
    expect(result.valid).toBe(true);
    expect(result.skeleton).toBe('{brand} dog food {flavor} {size}');
  });

  it('round-3 FIX 2: X-Large is NOT Large — hyphenated compounds are distinct tokens (boundary consistency)', () => {
    // Facts claim Large but the title only carries X-Large → T4 exactly-once fails.
    const mismatched = validateFamilyTitleSet({
      familyId: 'family_xlarge_boundary',
      members: [member('930000000001', facts({ flavor: 'Beef', size: 'Large' }))],
      candidateTitles: [{ upc: '930000000001', title: 'BetterBone Beef X-Large' }],
    });
    expect(mismatched.valid).toBe(false);
    expect(mismatched.perMember[0].reason).toMatch(/size.*exactly once|T4/i);

    // Skeleton substitution respects the same boundary: X-Large survives Large
    // replacement when facts correctly say X-Large.
    const matched = validateFamilyTitleSet({
      familyId: 'family_xlarge_boundary_ok',
      members: [
        member('930000000001', facts({ flavor: 'Beef', size: 'X-Large' })),
        member('930000000002', facts({ flavor: 'Venison', size: 'Large' })),
      ],
      candidateTitles: [
        { upc: '930000000001', title: 'BetterBone Beef X-Large' },
        { upc: '930000000002', title: 'BetterBone Venison Large' },
      ],
    });
    expect(matched.valid).toBe(true);
    expect(matched.skeleton).toBe('{brand} {flavor} {size}');
  });

  it('round-3 FIX 2: two DISTINCT flavors are both kept via extraFlavorTokens (never silently dropped)', () => {
    const input: TitleValidationInput = {
      familyId: 'family_dual_flavor',
      members: [
        member('940000000001', { ...facts({ flavor: 'Chicken', size: 'Small' }), extraFlavorTokens: ['Beef'] }),
        member('940000000002', facts({ flavor: 'Venison', size: 'Large' })),
      ],
      candidateTitles: [
        { upc: '940000000001', title: 'BetterBone Chicken Beef Small' },
        { upc: '940000000002', title: 'BetterBone Venison Large' },
      ],
    };
    const result = validateFamilyTitleSet(input);
    expect(result.valid).toBe(true);
    // Dropping the second flavor fails T4 exactly-once.
    const droppedSecond = validateFamilyTitleSet({
      ...input,
      candidateTitles: [
        { upc: '940000000001', title: 'BetterBone Chicken Small' },
        { upc: '940000000002', title: 'BetterBone Venison Large' },
      ],
    });
    expect(droppedSecond.valid).toBe(false);
    expect(droppedSecond.perMember[0].reason).toMatch(/Beef.*exactly once|T4/i);
  });

  it('candidate count mismatch refuses closed', () => {
    const input = betterboneInput();
    input.candidateTitles = input.candidateTitles.slice(0, 2);
    const result = validateFamilyTitleSet(input);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/length/i);
  });

  it('determinism: same input produces deep-equal results across runs', () => {
    const first = validateFamilyTitleSet(betterboneInput());
    const second = validateFamilyTitleSet(betterboneInput());
    expect(second).toEqual(first);
  });
});
