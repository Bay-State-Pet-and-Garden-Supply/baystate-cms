/**
 * PR9 C1 (issue #30): pure cohort semantic validator — unit tests.
 *
 * Covers every check family of `cohort-semantic-validator.ts`:
 *   - family_invariant: coherent pass; Product Type mismatch blocked; Brand
 *     mismatch blocked; tie-brand blocked;
 *   - coordinated_variant: title correspondence pass/mismatch; page
 *     correspondence (assigned exact, abstained none, missing row); sibling
 *     title/page VARIANT differences always pass (never sibling equality);
 *   - member_local: inapplicable attribute blocked; universal exempt;
 *     cardinality finding (defense-in-depth);
 *   - singleton cohort follows the same validator architecture.
 */
import { describe, it, expect } from 'bun:test';
import {
  validateMemberSemantics,
  validateMemberLocalAttributes,
  validateCohortBrandCoherence,
} from '../../classification/cohort-semantic-validator';

const PARENT_TYPE = { id: 'dry-dog-food', label: 'Dry Dog Food' };

/** A fully coherent member semantics input (group member with durable title
 *  + assigned durable pages). */
function coherentMember(overrides: Record<string, unknown> = {}) {
  return {
    memberSku: '100000000001',
    parentExecutionType: PARENT_TYPE,
    curatedTitle: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
    titleSource: 'cohort_fallback',
    suggestedPages: ['Dog Food Dry'],
    suggestedProductType: 'dry-dog-food',
    durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'cohort_fallback' as const },
    durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    pageOutputExpectedEmpty: false,
    ...overrides,
  };
}

// ─── family_invariant: Primary Product Type ───────────────────────────────────

describe('validateMemberSemantics — family_invariant Product Type', () => {
  it('passes when the member PT matches the parent authority', () => {
    const result = validateMemberSemantics(coherentMember());
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });

  it('blocks a member whose PT mismatches the parent authority', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedProductType: 'dog-treats' }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'family_product_type')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('dry-dog-food');
    expect(finding.message).toContain('dog-treats');
  });

  it('blocks a member with no suggested PT when the parent has one', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedProductType: null }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'family_product_type')).toBe(true);
  });

  it('enforces nothing when the parent has no execution type (abstained/conflicted)', () => {
    const result = validateMemberSemantics(coherentMember({
      parentExecutionType: { id: null, label: null },
      suggestedProductType: 'dog-treats',
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── coordinated_variant: title correspondence ────────────────────────────────

describe('validateMemberSemantics — coordinated_variant title', () => {
  it('passes when the curated title equals the durable output with a cohort source', () => {
    const result = validateMemberSemantics(coherentMember({ titleSource: 'llm_cohort' }));
    expect(result.status).toBe('passed');
  });

  it('blocks a curated title that differs from the durable output', () => {
    const result = validateMemberSemantics(coherentMember({ curatedTitle: 'Some Other Title' }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_title')!;
    expect(finding.message).toContain('Some Other Title');
  });

  it('blocks a non-cohort titleSource on a member with a durable title', () => {
    const result = validateMemberSemantics(coherentMember({ titleSource: 'web' }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_title')).toBe(true);
  });

  it('blocks a cohort-coordinated title that claims a source without a durable output', () => {
    const result = validateMemberSemantics(coherentMember({
      durableTitleOutput: null,
      titleSource: 'cohort_fallback',
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_title')).toBe(true);
  });

  it('passes a singleton-style per-item title (no durable output, non-cohort source)', () => {
    const result = validateMemberSemantics(coherentMember({
      durableTitleOutput: null,
      titleSource: 'ocr',
      curatedTitle: 'Per Item Title',
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── coordinated_variant: page correspondence ─────────────────────────────────

describe('validateMemberSemantics — coordinated_variant pages', () => {
  it('passes when suggestedPages exactly match the assigned durable pages (any order)', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedPages: ['Dog Food Dry'] }));
    expect(result.status).toBe('passed');
    const multi = validateMemberSemantics(coherentMember({
      suggestedPages: ['Brand - Acme', 'Dog Food Dry'],
      durablePageOutput: { status: 'assigned' as const, pages: [
        { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
        { pageId: 'p2', pageName: 'Brand - Acme', confidence: 0.7 },
      ] },
    }));
    expect(multi.status).toBe('passed');
  });

  it('blocks pages that do not exactly match the assigned durable pages', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedPages: ['Dog Treats'] }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.message).toContain('Dog Treats');
    expect(finding.message).toContain('Dog Food Dry');
  });

  it('passes when an abstained durable row corresponds to zero pages', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: [],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(result.status).toBe('passed');
  });

  it('blocks pages on an abstained durable row', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(true);
  });

  it('blocks a missing durable page row without the expected-empty marker', () => {
    const result = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: false,
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(true);
  });

  it('passes a missing row when the parent chose expected-empty', () => {
    const result = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: [],
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── coordinated_variant: sibling VARIANT differences pass ───────────────────

describe('validateMemberSemantics — sibling VARIANT differences never fail', () => {
  it('title variant differences between siblings pass (each matches its own durable output)', () => {
    // Sibling A: Chicken variant; Sibling B: Beef variant. Different titles,
    // each corresponding to its OWN durable output → PASS.
    const siblingA = validateMemberSemantics(coherentMember({
      memberSku: '100000000001',
      curatedTitle: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
      titleSource: 'cohort_fallback',
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'cohort_fallback' },
    }));
    const siblingB = validateMemberSemantics(coherentMember({
      memberSku: '100000000002',
      curatedTitle: 'Purina Pro Plan Dry Dog Food Beef 10 lb',
      titleSource: 'cohort_fallback',
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', source: 'cohort_fallback' },
    }));
    expect(siblingA.status).toBe('passed');
    expect(siblingB.status).toBe('passed');
  });

  it('page differences between siblings pass (each matches its own durable output)', () => {
    // Sibling A pages=[Dog Food Dry], Sibling B pages=[Dog Food Dry, Brand - Acme].
    // The MIGRATION TEST: the new validator passes this coordinated_variant
    // case (the legacy validateSiblingConsistency still warns on the same data).
    const siblingA = validateMemberSemantics(coherentMember({
      memberSku: '100000000001',
      suggestedPages: ['Dog Food Dry'],
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    const siblingB = validateMemberSemantics(coherentMember({
      memberSku: '100000000002',
      suggestedPages: ['Dog Food Dry', 'Brand - Acme'],
      durablePageOutput: { status: 'assigned' as const, pages: [
        { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
        { pageId: 'p2', pageName: 'Brand - Acme', confidence: 0.7 },
      ] },
    }));
    expect(siblingA.status).toBe('passed');
    expect(siblingB.status).toBe('passed');
  });
});

// ─── member_local: profile applicability + cardinality ───────────────────────

const ATTRIBUTE_CONFIG = [
  { id: 'brand', isUniversal: true },
  { id: 'flavor', isUniversal: false },
  { id: 'species', isUniversal: false },
];

function localInput(overrides: Record<string, unknown> = {}) {
  return {
    memberSku: '100000000001',
    proposals: [{ targetId: 'flavor' }],
    effectiveTypeId: 'dry-dog-food',
    attributeConfig: ATTRIBUTE_CONFIG,
    universalAttributeIds: ['brand'],
    profileAttributeIds: new Set(['flavor']),
    cardinalityByAttributeId: new Map<string, 'single' | 'multiple'>([['flavor', 'single']]),
    ...overrides,
  };
}

describe('validateMemberLocalAttributes — profile applicability', () => {
  it('passes a profile-applicable non-universal proposal', () => {
    const result = validateMemberLocalAttributes(localInput());
    expect(result.status).toBe('passed');
  });

  it('blocks a non-universal proposal outside the effective type profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'species' }],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_attribute_applicability')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('species');
    expect(finding.message).toContain('dry-dog-food');
  });

  it('exempts universal attribute proposals regardless of the profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'brand' }],
      profileAttributeIds: new Set(['flavor']),
    }));
    expect(result.status).toBe('passed');
  });

  it('blocks a non-universal proposal when there is no effective type', () => {
    const result = validateMemberLocalAttributes(localInput({
      effectiveTypeId: null,
      profileAttributeIds: null,
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'member_attribute_applicability')).toBe(true);
  });

  it('blocks a non-universal proposal under a legitimately EMPTY profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      profileAttributeIds: new Set<string>(),
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'member_attribute_applicability')).toBe(true);
  });

  it('records a cardinality finding for a single-cardinality attribute with >1 proposals', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor' }, { targetId: 'flavor' }],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_cardinality')!;
    expect(finding.message).toContain('flavor');
    expect(finding.message).toContain('2');
  });

  it('passes multiple proposals for a multiple-cardinality attribute', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor' }, { targetId: 'flavor' }],
      cardinalityByAttributeId: new Map([['flavor', 'multiple']]),
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── family_invariant: mutual Brand coherence ─────────────────────────────────

describe('validateCohortBrandCoherence — mutual Brand coherence', () => {
  it('passes when all members normalize to one canonical brand', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Acme Inc.', 'Acme'] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('blocks the minority member whose brand conflicts with the canonical brand', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Generic', 'Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'family_brand')!;
    expect(finding.memberSku).toBe('100000000003');
    expect(finding.message).toContain('generic');
    expect(finding.message).toContain('acme');
    expect(result.findings).toHaveLength(1);
  });

  it('blocks every member on a brand-evidence tie and lists the tied brands', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    expect(result.findings.every(f => f.code === 'family_brand')).toBe(true);
    expect(result.findings.some(f => f.memberSku === '100000000001')).toBe(true);
    expect(result.findings.some(f => f.memberSku === '100000000002')).toBe(true);
    expect(result.findings[0].message).toContain('acme');
    expect(result.findings[0].message).toContain('generic');
  });

  it('passes when no member carries brand evidence (nothing to compare)', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: [null, null] },
      { sku: '100000000002', frozenBrandEvidence: [undefined, ''] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('singleton cohort follows the same architecture: self-coherent evidence passes', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme Inc.'] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('singleton cohort with internally conflicting brand evidence blocks', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    expect(result.findings.every(f => f.code === 'family_brand')).toBe(true);
  });
});
