import { describe, it, expect } from 'vitest';
import { WeakLabelRules, buildWeakLabelConfigFromBundle, type WeakLabelConfig } from '../../classification/datasets/weak-label-rules';

/**
 * Active canonical config fixture mirroring the activated Bay State v2 bundle
 * (storage/catalog/store/classification, activation commit 6e5684f97).
 */
const ACTIVE_CONFIG_FIXTURE: WeakLabelConfig = {
  productTypes: [
    { id: 'dog-toys', name: 'Dog Toys' },
    { id: 'cat-toys', name: 'Cat Toys' },
    { id: 'grooming', name: 'Grooming' },
    { id: 'dog-waste-bags', name: 'Dog Waste Bags' },
    { id: 'dog-food-dry', name: 'Dry Dog Food' },
    { id: 'dog-food-wet', name: 'Wet Dog Food' },
    { id: 'dog-treats', name: 'Dog Treats' },
    { id: 'cat-food-dry', name: 'Dry Cat Food' },
    { id: 'cat-food-wet', name: 'Wet Cat Food' },
    { id: 'cat-treats', name: 'Cat Treats' },
    { id: 'cat-litter', name: 'Cat Litter' },
    { id: 'supplements', name: 'Supplements' },
    { id: 'collars-leashes', name: 'Collars & Leashes' },
    { id: 'flea-tick-treatment', name: 'Flea & Tick Treatment' },
    { id: 'bird-food', name: 'Bird Food' },
    { id: 'lawn-fertilizer', name: 'Lawn Fertilizer' },
    { id: 'grass-seed', name: 'Grass Seed' },
    { id: 'weed-control', name: 'Weed Control' },
    { id: 'insect-control', name: 'Insect Control' },
    { id: 'potting-soil', name: 'Potting Soil' },
    { id: 'hand-tools', name: 'Hand Tools' },
  ],
  attributes: [
    { id: 'brand', name: 'Brand', valueMode: 'freeText' },
    { id: 'species', name: 'Animal Species', valueMode: 'freeText' },
    { id: 'life-stage', name: 'Life Stage', valueMode: 'controlled' },
    { id: 'breed-size', name: 'Breed Size', valueMode: 'controlled' },
    { id: 'dietary-features', name: 'Dietary Features', valueMode: 'freeText' },
    { id: 'health-benefits', name: 'Health Benefits', valueMode: 'freeText' },
    { id: 'food-form', name: 'Food Form', valueMode: 'controlled' },
    { id: 'flavor', name: 'Flavor', valueMode: 'controlled' },
    { id: 'department', name: 'Department', valueMode: 'freeText' },
    { id: 'category', name: 'Category', valueMode: 'freeText' },
  ],
  speciesAttributeId: 'species',
  foodFormAttributeId: 'food-form',
  lifeStageAttributeId: 'life-stage',
};

describe('weak-label rules bound to the active canonical configuration', () => {
  const rules = new WeakLabelRules(ACTIVE_CONFIG_FIXTURE);

  it('resolves product types against active config IDs', () => {
    const dogDry = rules.resolveProductType({ title: 'Blue Buffalo Life Protection Adult Dry Dog Food' });
    expect(dogDry).toEqual({ id: 'dog-food-dry', name: 'Dry Dog Food', confidence: 0.8 });

    const catWet = rules.resolveProductType({ title: 'Fancy Feast Pate Salmon Wet Cat Food' });
    expect(catWet?.id).toBe('cat-food-wet');

    const weed = rules.resolveProductType({ title: 'Bonide Weed Beater Ultra Herbicide' });
    expect(weed?.id).toBe('weed-control');
  });

  it('uses joint species+form rules (never labels from absence)', () => {
    // Species present, no form → species resolved, food-form abstains.
    const attrs = rules.resolveAttributes({ title: 'Purina Adult Dog Chow' });
    expect(attrs.species).toContain('dog');
    expect(attrs.foodForm).toBeUndefined();

    // Joint phrase resolves both.
    const joint = rules.resolveAttributes({ title: 'IAMS Dry Kibble for Cats' });
    expect(joint.species).toContain('cat');
    expect(joint.foodForm).toContain('dry');
  });

  it('abstains entirely when no positive evidence exists', () => {
    const type = rules.resolveProductType({ title: 'Pitcher Plant Figurine' });
    expect(type).toBeNull();

    const attrs = rules.resolveAttributes({ title: 'Pitcher Plant Figurine' });
    expect(attrs.species).toBeUndefined();
    expect(attrs.lifeStage).toBeUndefined();
    expect(attrs.foodForm).toBeUndefined();
  });

  it('never labels from absence of evidence', () => {
    // Absence of "cat" in text must NOT produce a negative species label.
    const attrs = rules.resolveAttributes({ title: 'Dry Dog Food' });
    expect(attrs.species).toEqual(['dog']);
    expect(attrs.species).not.toContain('cat');
  });

  it('abstains when the matched target is absent from the active config', () => {
    const partial = new WeakLabelRules({
      ...ACTIVE_CONFIG_FIXTURE,
      productTypes: ACTIVE_CONFIG_FIXTURE.productTypes.filter((pt) => pt.id !== 'grass-seed'),
    });
    const result = partial.resolveProductType({ title: 'Scotts Turf Builder Grass Seed' });
    expect(result).toBeNull();
  });

  it('only emits attribute values for attributes present in the active config', () => {
    const withoutLifeStage = new WeakLabelRules({
      ...ACTIVE_CONFIG_FIXTURE,
      attributes: ACTIVE_CONFIG_FIXTURE.attributes.filter((a) => a.id !== 'life-stage'),
    });
    const attrs = withoutLifeStage.resolveAttributes({ title: 'Senior Puppy Food' });
    expect(attrs.lifeStage).toBeUndefined();
    expect(attrs.species).toBeDefined();
  });

  it('never emits guessed category pages or ProductField24/25 type mappings', () => {
    const record = rules.resolveProductType({ title: 'Purina One Dry Dog Food' });
    // Weak rules only return a typed match — no pages, no ShopSite field mapping.
    expect(record?.id).toBe('dog-food-dry');
  });

  it('builds a config from an active v2 bundle shape', () => {
    const bundle = {
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food' }],
      attributes: [{ id: 'species', name: 'Animal Species', valueMode: 'freeText' }],
    };
    const built = buildWeakLabelConfigFromBundle(bundle);
    expect(built.productTypes).toHaveLength(1);
    expect(built.speciesAttributeId).toBe('species');
    const rules2 = new WeakLabelRules(built);
    expect(rules2.hasProductType('dog-food-dry')).toBe(true);
    expect(rules2.hasAttribute('species')).toBe(true);
  });

  it('resolves the approved 21-type expansion targets', () => {
    expect(rules.resolveProductType({ title: 'Ortho Home Defense Insect Killer' })?.id).toBe('insect-control');
    expect(rules.resolveProductType({ title: 'Miracle-Gro Potting Mix' })?.id).toBe('potting-soil');
    expect(rules.resolveProductType({ title: 'Felco Pruning Shears Hand Pruner' })?.id).toBe('hand-tools');
    expect(rules.resolveProductType({ title: 'Wild Bird Suet Cake' })?.id).toBe('bird-food');
  });
});
