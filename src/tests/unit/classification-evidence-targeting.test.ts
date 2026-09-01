import { describe, expect, it } from 'vitest';
import {
  buildEvidenceTargetPacket,
  buildPageEvidencePacket,
  canonicalAssertionValue,
  evidenceMatchesTarget,
  resolveCanonicalAssertion,
  tokenGroundingSupport,
} from '../../classification/evidence-targeting';
import type { ClassificationEvidence } from '../../shared/types';

function ev(overrides: Partial<ClassificationEvidence> & { id: string }) {
  return {
    runId: 'run-1',
    stageName: 'evidence_extraction' as const,
    productSku: 'SKU',
    source: 'official_product_page' as const,
    reliability: 'high' as const,
    capturedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  } as ClassificationEvidence;
}

describe('evidence-targeting (issue #17 H)', () => {
  it('selects target-matching evidence by explicit attributeId first', () => {
    const flavor = ev({ id: 'e1', attributeId: 'flavor', value: 'Chicken' });
    const color = ev({ id: 'e2', attributeId: 'color', value: 'Red' });
    expect(evidenceMatchesTarget(flavor, { attributeId: 'flavor', sourceField: null })).toBe(true);
    expect(evidenceMatchesTarget(color, { attributeId: 'flavor', sourceField: null })).toBe(false);
  });

  it('selects target-matching evidence by reviewed source-field mapping second', () => {
    const text = ev({ id: 'e1', attributeId: null, sourceField: 'flavor', value: 'Chicken' });
    expect(evidenceMatchesTarget(text, { attributeId: 'flavor', sourceField: 'flavor' })).toBe(true);
    const unrelated = ev({ id: 'e2', attributeId: null, sourceField: 'weight', value: '5 lb' });
    expect(evidenceMatchesTarget(unrelated, { attributeId: 'flavor', sourceField: 'flavor' })).toBe(false);
  });

  it('never infers target membership from a human label', () => {
    const labeled = ev({ id: 'e1', attributeId: null, sourceField: null, snippet: 'flavor: Chicken' });
    expect(evidenceMatchesTarget(labeled, { attributeId: 'flavor', sourceField: 'flavor' })).toBe(false);
  });

  it('denies a record with an explicit DISAGREEING attributeId even when its sourceField matches (issue #17 pass 5b)', () => {
    // attributeId=color + sourceField=flavor must NOT match a flavor target:
    // the explicit attribute identity is authoritative and fail-closed.
    const record = ev({ id: 'e1', attributeId: 'color', sourceField: 'flavor', value: 'Chicken' });
    expect(evidenceMatchesTarget(record, { attributeId: 'flavor', sourceField: 'flavor' })).toBe(false);
    // A record with NO attributeId falls back to the source-field mapping.
    const noAttr = ev({ id: 'e2', attributeId: null, sourceField: 'flavor', value: 'Chicken' });
    expect(evidenceMatchesTarget(noAttr, { attributeId: 'flavor', sourceField: 'flavor' })).toBe(true);
  });

  it('never grounds an unrelated (color) record into a flavor proposal (issue #17 pass 5b)', () => {
    const colorChicken = ev({ id: 'c1', attributeId: 'color', value: 'Chicken' });
    const packet = buildEvidenceTargetPacket([colorChicken], {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
      isGroundingSupport: tokenGroundingSupport,
    });
    // The color record is excluded entirely — never supporting, never context.
    expect(packet.supportingEvidenceIds).toEqual([]);
    expect(packet.context.map(r => r.id)).toEqual([]);
    expect(packet.evidenceIds).toEqual([]);
  });

  it('token grounding applies ONLY to general title/description evidence (issue #17 pass 5b)', () => {
    const title = ev({ id: 't1', attributeId: null, sourceField: 'name', value: 'Chicken and rice formula' });
    const weight = ev({ id: 'w1', attributeId: null, sourceField: 'weight', value: 'Chicken 5 lb' });
    expect(tokenGroundingSupport(title, 'Chicken')).toBe(true);
    expect(tokenGroundingSupport(weight, 'Chicken')).toBe(false);
  });

  it('page packet includes category page_name and explicit attributeId species records (issue #17 pass 5b)', () => {
    const pageName = ev({ id: 'pn1', attributeId: null, sourceField: 'page_name', value: 'Dog Food' });
    const speciesAttr = ev({ id: 'sp1', attributeId: 'species', value: 'Dog' });
    const speciesField = ev({ id: 'sp2', attributeId: null, sourceField: 'species', value: 'Dog' });
    const weight = ev({ id: 'w1', attributeId: null, sourceField: 'weight', value: '5 lb' });
    const packet = buildPageEvidencePacket(
      [pageName, speciesAttr, speciesField, weight],
      {
        pageContextSourceFields: ['name', 'title', 'page_name', 'category', 'species', 'productForm', 'productType'],
        pageContextAttributeIds: ['species'],
        sourceField: null,
        speciesValue: 'Dog',
      },
    );
    expect(packet.context.map(r => r.id).sort()).toEqual(['pn1', 'sp1', 'sp2'].sort());
    expect(packet.contradictingEvidenceIds).toEqual([]);
    expect(packet.evidenceIds.includes('w1')).toBe(false);
  });

  it('species contradiction direction is order-INDEPENDENT and driven by the reviewed species value (issue #17 pass 5b)', () => {
    const dog = ev({ id: 'sp-dog', attributeId: 'species', value: 'Dog' });
    const cat = ev({ id: 'sp-cat', attributeId: 'species', value: 'Cat' });
    const opts = {
      pageContextSourceFields: ['species'],
      pageContextAttributeIds: ['species'],
      sourceField: null,
      speciesValue: 'Dog',
    };
    const forward = buildPageEvidencePacket([dog, cat], opts);
    const reversed = buildPageEvidencePacket([cat, dog], opts);
    expect(forward.contradictingEvidenceIds).toEqual(['sp-cat']);
    expect(reversed.contradictingEvidenceIds).toEqual(['sp-cat']);
    expect(forward.context.map(r => r.id)).toContain('sp-dog');
    expect(reversed.context.map(r => r.id)).toContain('sp-dog');
    // WITHOUT a reviewed species value, no contradiction can be labeled at all
    // (order-independent — never first-evidence).
    const noReviewed = buildPageEvidencePacket([dog, cat], { ...opts, speciesValue: undefined });
    expect(noReviewed.contradictingEvidenceIds).toEqual([]);
  });

  it('links only flavor evidence to a flavor proposal and excludes unrelated color/weight entirely (issue #17 pass 5b)', () => {
    const evidence = [
      ev({ id: 'f1', attributeId: 'flavor', value: 'Chicken' }),
      ev({ id: 'f2', attributeId: 'flavor', value: 'Chicken' }),
      ev({ id: 'c1', attributeId: 'color', value: 'Red' }),
      ev({ id: 'w1', attributeId: null, sourceField: 'weight', value: '5 lb' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
    });
    expect(packet.supportingEvidenceIds).toEqual(['f1', 'f2']);
    expect(packet.contradictingEvidenceIds).toEqual([]);
    // Unrelated color/weight records are excluded ENTIRELY — never context,
    // never citable.
    expect(packet.context.map(r => r.id)).toEqual([]);
    expect(packet.evidenceIds.sort()).toEqual(['f1', 'f2'].sort());
  });

  it('detects a spreadsheet vs official-page disagreement as a visible conflict', () => {
    const evidence = [
      ev({ id: 'spread', attributeId: 'flavor', value: 'Beef', source: 'spreadsheet' }),
      ev({ id: 'official', attributeId: 'flavor', value: 'Chicken', source: 'official_product_page' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
    });
    expect(packet.hasConflict).toBe(true);
    expect(packet.conflicts).toHaveLength(1);
    expect(packet.conflicts[0].values.sort()).toEqual(['Beef', 'Chicken'].sort());
    // The proposal value "Chicken" is supported by the official record and
    // contradicted by the spreadsheet record.
    expect(packet.supportingEvidenceIds).toEqual(['official']);
    expect(packet.contradictingEvidenceIds).toEqual(['spread']);
    expect(packet.evidenceIds.sort()).toEqual(['official', 'spread'].sort());
  });

  it('reconciles formatting-equivalent values without a conflict', () => {
    const evidence = [
      ev({ id: 'a1', attributeId: 'flavor', value: 'Chicken' }),
      ev({ id: 'a2', attributeId: 'flavor', value: ' Chicken\u00a0' }), // surrounding space + NBSP
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
    });
    expect(packet.hasConflict).toBe(false);
    expect(packet.supportingEvidenceIds).toEqual(['a1', 'a2']);
  });

  it('treats case-different values as distinct canonical identities (fail closed, no case folding)', () => {
    const evidence = [
      ev({ id: 'c1', attributeId: 'flavor', value: 'Chicken' }),
      ev({ id: 'c2', attributeId: 'flavor', value: 'chicken' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
    });
    expect(packet.hasConflict).toBe(true);
    expect(packet.supportingEvidenceIds).toEqual(['c1']);
    expect(packet.contradictingEvidenceIds).toEqual(['c2']);
  });

  it('does not treat multi-cardinality value differences as contradictions', () => {
    const evidence = [
      ev({ id: 'm1', attributeId: 'dietary', value: 'Grain Free' }),
      ev({ id: 'm2', attributeId: 'dietary', value: 'High Protein' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'dietary',
      sourceField: 'dietary',
      selectionMode: 'multiple',
      proposedValue: ['Grain Free', 'High Protein'],
    });
    expect(packet.hasConflict).toBe(false);
    expect(packet.contradictingEvidenceIds).toEqual([]);
    expect(packet.supportingEvidenceIds.sort()).toEqual(['m1', 'm2'].sort());
  });

  it('bounds prompt text and never leaks unrelated evidence into supporting', () => {
    const evidence = [
      ev({ id: 'f1', attributeId: 'flavor', value: 'Chicken' }),
      ev({ id: 'x1', attributeId: null, sourceField: 'name', value: 'Some completely unrelated title text' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'flavor',
      sourceField: 'flavor',
      selectionMode: 'single',
      proposedValue: 'Chicken',
      promptTextCap: 50,
    });
    expect(packet.supportingEvidenceIds).toEqual(['f1']);
    // Unrelated title evidence is bounded context, not supporting.
    expect(packet.context.map(r => r.id)).toEqual(['x1']);
    expect(packet.promptText.length).toBeLessThanOrEqual(50);
  });

  it('treats general title evidence as supporting only through the deterministic grounding rule', () => {
    const evidence = [
      ev({ id: 't1', attributeId: null, sourceField: 'name', value: 'Purina Dog Food Chicken Recipe' }),
    ];
    const packet = buildEvidenceTargetPacket(evidence, {
      attributeId: 'product-type',
      sourceField: null,
      selectionMode: 'single',
      proposedValue: 'dog-food-dry',
      isGroundingSupport: tokenGroundingSupport,
    });
    // 'dog-food-dry' (id) does not appear in the title text → context only.
    expect(packet.supportingEvidenceIds).toEqual([]);
    expect(packet.context.map(r => r.id)).toEqual(['t1']);
  });

  it('canonical assertions normalize NFC and trim', () => {
    expect(canonicalAssertionValue('  Chicken\u0301 ')).toBe('Chicken\u0301'.normalize('NFC'));
    expect(canonicalAssertionValue('   ')).toBeNull();
    expect(canonicalAssertionValue(null)).toBeNull();
    expect(canonicalAssertionValue(42)).toBe('42');
  });

  it('resolves aliases to their exact canonical value', () => {
    expect(resolveCanonicalAssertion('chix', [{ alias: 'chix', mapsTo: 'Chicken' }])).toBe('Chicken');
    expect(resolveCanonicalAssertion('Chicken', [{ alias: 'chix', mapsTo: 'Chicken' }])).toBe('Chicken');
  });

  it('reconciles controlled species aliases (Dog, dogs, canine, Cat, cats, feline, Horse, horses, equine, Poultry, chicken)', () => {
    const speciesAliases = [
      { alias: 'canine', mapsTo: 'Dog' },
      { alias: 'dogs', mapsTo: 'Dog' },
      { alias: 'dog', mapsTo: 'Dog' },
      { alias: 'feline', mapsTo: 'Cat' },
      { alias: 'cats', mapsTo: 'Cat' },
      { alias: 'cat', mapsTo: 'Cat' },
      { alias: 'equine', mapsTo: 'Horse' },
      { alias: 'horses', mapsTo: 'Horse' },
      { alias: 'horse', mapsTo: 'Horse' },
      { alias: 'chicken', mapsTo: 'Poultry' },
      { alias: 'chickens', mapsTo: 'Poultry' },
    ];

    expect(resolveCanonicalAssertion('canine', speciesAliases)).toBe('Dog');
    expect(resolveCanonicalAssertion('dogs', speciesAliases)).toBe('Dog');
    expect(resolveCanonicalAssertion('feline', speciesAliases)).toBe('Cat');
    expect(resolveCanonicalAssertion('cats', speciesAliases)).toBe('Cat');
    expect(resolveCanonicalAssertion('equine', speciesAliases)).toBe('Horse');
    expect(resolveCanonicalAssertion('chickens', speciesAliases)).toBe('Poultry');
    expect(resolveCanonicalAssertion('Dog', speciesAliases)).toBe('Dog');
  });

  it('flags cross-species evidence as a contradiction in the page packet', () => {
    const evidence = [
      ev({ id: 'spec-dog', sourceField: 'species', value: 'Dog' }),
      ev({ id: 'spec-cat', sourceField: 'species', value: 'Cat' }),
      ev({ id: 'name1', sourceField: 'name', value: 'Some Product' }),
    ];
    const packet = buildPageEvidencePacket(evidence, {
      pageContextSourceFields: ['name', 'species'],
      speciesValue: 'Dog',
    });
    expect(packet.contradictingEvidenceIds).toEqual(['spec-cat']);
    expect(packet.hasConflict).toBe(true);
  });

  it('page packet uses only reviewed page-context fields (identity/species/type/category)', () => {
    const evidence = [
      ev({ id: 'name1', sourceField: 'name', value: 'Some Product' }),
      ev({ id: 'w1', sourceField: 'weight', value: '5 lb' }),
      ev({ id: 'color1', sourceField: 'color', value: 'Red' }),
    ];
    const packet = buildPageEvidencePacket(evidence, {
      pageContextSourceFields: ['name', 'species'],
    });
    expect(packet.context.map(r => r.id)).toEqual(['name1']);
  });
});
