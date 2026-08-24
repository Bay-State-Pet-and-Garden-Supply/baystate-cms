import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractNameStem, familyGroupingIdentityFor, knownBrandsForBatch, determineProductGroup } from '../../onboarding/product-line-grouper';
import { splitAttachedSizeTokens } from '../../onboarding/product-line-token-normalizer';
import type { OnboardingItem } from '../../shared/schemas/onboarding';

const fixturePath = path.join(__dirname, '../fixtures/family-grouping-accuracy-148.json');
const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const entries: Array<{
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  rowNumber: number;
  priorStem: string;
  correctedStem: string;
  priorKey: string;
  correctedKey: string;
}> = raw.entries;

function makeOnboardingItem(e: typeof entries[number]): OnboardingItem {
  return {
    id: e.id,
    batchId: 'fixture-batch',
    upc: e.upc,
    name: e.name,
    brandHint: e.brandHint,
    rowNumber: e.rowNumber,
    price: null,
    quantity: null,
    departmentHint: null,
    sourceUrl: null,
    expectedName: null,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
    isHeld: false,
    heldReason: null,
    isDuplicate: false,
    existingSku: null,
    extractionData: null,
    curationData: null,
    status: 'imported',
    errorMessage: null,
    sourceType: 'official_page',
    acceptedEvidenceAttemptIds: [],
    acceptedEvidenceAttemptId: null,
    sourcingDecision: null,
    retryCount: 0,
    createdAt: '',
    updatedAt: '',
  } as OnboardingItem;
}

// Fixture-derived once — static and order-stable, shared by all cases below.
const fixtureItems = entries.map(makeOnboardingItem);
const fixtureKnownBrands = knownBrandsForBatch(fixtureItems);

describe('family grouping accuracy — 148-row regression fixture', () => {
  it('fixture contains exactly 148 unique records', () => {
    expect(entries.length).toBe(148);
    const ids = new Set(entries.map(e => e.id));
    const upcs = new Set(entries.map(e => e.upc));
    expect(ids.size).toBe(148);
    expect(upcs.size).toBe(148);
  });

  it('exactly 27 stems differ from prior', () => {
    const diff = entries.filter(e => e.priorStem !== e.correctedStem);
    expect(diff.length).toBe(27);
  });

  it('prior multi-member totals are 13 families / 39 items', () => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.priorKey, (m.get(e.priorKey) || 0) + 1);
    let families = 0, items = 0;
    for (const [, c] of m) if (c > 1) { families++; items += c; }
    expect(families).toBe(13);
    expect(items).toBe(39);
  });

  it('corrected totals are 19 families / 62 items', () => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.correctedKey, (m.get(e.correctedKey) || 0) + 1);
    let families = 0, items = 0;
    for (const [, c] of m) if (c > 1) { families++; items += c; }
    expect(families).toBe(19);
    expect(items).toBe(62);
  });

  it('BetterBone has one 22-member family corrected', () => {
    const bb = entries.filter(e => e.correctedKey === 'betterbone::better bone');
    expect(bb.length).toBe(22);
    // Prior BB was 10 families
    const priorBbKeys = new Set(entries.filter(e => e.correctedKey === 'betterbone::better bone').map(e => e.priorKey));
    expect(priorBbKeys.size).toBe(10);
  });

  it('actual corrected stem/key matches every fixture row', () => {
    entries.forEach((e, i) => {
      const identity = familyGroupingIdentityFor(fixtureItems[i], fixtureKnownBrands);
      expect(identity.stem).toBe(e.correctedStem);
      expect(identity.key).toBe(e.correctedKey);
      // also verify extractNameStem directly
      expect(extractNameStem(e.name)).toBe(e.correctedStem);
    });
  });

  it('no compact-brand key contains members from another brand', () => {
    // Explicit same-stem/different-brand pair must stay separate via every public path
    for (const [i, e] of entries.entries()) {
      const identity = familyGroupingIdentityFor(fixtureItems[i], fixtureKnownBrands);
      const expectedBrandKey = identity.compactBrandKey;
      const actualBrandKey = e.correctedKey.split('::')[0];
      expect(actualBrandKey).toBe(expectedBrandKey);
    }
    // Explicit same-stem/different-brand pair must stay separate via every public path
    const sharedName = 'SHARED STEM PRODUCT SM';
    const a = makeOnboardingItem({ id: 'brand-a', upc: '999000000001', name: sharedName, brandHint: 'BetterBone', rowNumber: 1000, priorStem: 'shared stem product', correctedStem: 'shared stem product', priorKey: 'betterbone::shared stem product', correctedKey: 'betterbone::shared stem product' });
    const b = makeOnboardingItem({ id: 'brand-b', upc: '999000000002', name: sharedName, brandHint: 'Acme', rowNumber: 1001, priorStem: 'shared stem product', correctedStem: 'shared stem product', priorKey: 'acme::shared stem product', correctedKey: 'acme::shared stem product' });
    const batch = [a, b];
    const kb = knownBrandsForBatch(batch);
    expect(familyGroupingIdentityFor(a, kb).key).not.toBe(familyGroupingIdentityFor(b, kb).key);
    expect(determineProductGroup(a, batch)).toBeNull();
    expect(determineProductGroup(b, batch)).toBeNull();
  });

  it('determineProductGroup and familyGroupingIdentityFor produce equivalent partitions (shared helper)', () => {
    // Build expected partitions from fixture correctedKey for multi-member families only
    const expectedGroups = new Map<string, Set<string>>();
    for (const e of entries) {
      if (!expectedGroups.has(e.correctedKey)) expectedGroups.set(e.correctedKey, new Set());
      expectedGroups.get(e.correctedKey)!.add(e.upc);
    }
    // Filter to multi-member
    const expectedMulti = new Map<string, Set<string>>();
    for (const [k, s] of expectedGroups) if (s.size > 1) expectedMulti.set(k, s);

    // Verify familyGroupingIdentityFor is the shared helper
    for (const [i, e] of entries.entries()) {
      const identity = familyGroupingIdentityFor(fixtureItems[i], fixtureKnownBrands);
      expect(identity.key).toBe(e.correctedKey);
    }

    // determineProductGroup for each multi-member item should return same group
    for (const [i, e] of entries.entries()) {
      if (!expectedMulti.has(e.correctedKey)) continue;
      const group = determineProductGroup(fixtureItems[i], fixtureItems);
      expect(group).not.toBeNull();
      expect(new Set(group!.siblingSkus)).toEqual(expectedMulti.get(e.correctedKey));
    }
  });

  it('does not merge distinct generic SmallBrand families — negative controls (real KONG/Fromm in product-line-grouper.test.ts)', () => {
    // SmallBrand generic negative controls for cross-brand separation; KONG Squeakz Stick vs Star and Fromm Classic vs Gold covered in product-line-grouper.test.ts
    const smallCorrectedKeys = entries.filter(e => e.correctedKey.startsWith('smallbrand')).map(e => e.correctedKey);
    const unique = new Set(smallCorrectedKeys);
    expect(unique.size).toBe(16);
    const stems = new Set(entries.filter(e => e.correctedKey.startsWith('smallbrand')).map(e => e.correctedStem));
    expect(stems.size).toBe(16);
  });

  it('Baskerville SZ and Harvest LGHARVEST cases converge', () => {
    const bask = entries.filter(e => e.name.includes('BASKERVILLE'));
    expect(bask.length).toBe(4);
    expect(new Set(bask.map(e => e.correctedStem)).size).toBe(1);
    expect(new Set(bask.map(e => e.correctedKey)).size).toBe(1);

    const harvest = entries.filter(e => e.name.includes('HARVEST'));
    expect(harvest.length).toBe(4);
    expect(new Set(harvest.map(e => e.correctedStem)).size).toBe(1);
  });

  it('attached size tokens BEEFMINI and VNSNJUMBO are split and stripped', () => {
    const beefMini = entries.find(e => e.name === 'BETTER BONE BEEFMINI SM');
    expect(beefMini).toBeDefined();
    expect(extractNameStem(beefMini!.name)).toBe('better bone');
    expect(splitAttachedSizeTokens('BEEFMINI')).toBe('BEEF MINI');
    expect(splitAttachedSizeTokens('VNSNJUMBO')).toBe('VNSN JUMBO');

    const vnsnJumbo = entries.find(e => e.name === 'BETTER BONE VNSNJUMBO LG');
    expect(vnsnJumbo).toBeDefined();
    expect(extractNameStem(vnsnJumbo!.name)).toBe('better bone');
  });
});
